import { useEffect, useMemo, useState } from "react"
import { closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core"
import { sortableKeyboardCoordinates, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ChevronDown, GripVertical, Trash2 } from "lucide-react"

import { StandardPage } from "@/components/layout/page-frame"
import { EmptyState, Panel } from "@/components/patterns/page-kit"
import { MobileChoiceSheet } from "@/components/patterns/mobile-choice-sheet"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { Notify } from "@/shared/types"
import { RuleListToolbar } from "./RuleListToolbar"
import { RuleChoicePicker } from "./RuleChoicePicker"
import { RuleMetricsStrip } from "./RuleMetricsStrip"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useRuleWorkspace } from "./useRuleWorkspace"
import { parseWebsiteRules } from "./ruleEditorState"
import { filterRuleItems, policyTone, rulePolicyEditable, ruleTypeTone, type RuleItem } from "./ruleViewModel"

const ruleGridColumns = "sm:grid-cols-[32px_36px_120px_104px_minmax(0,1fr)_32px]"


const rulePositionItems = [
  { value: "first", label: "最前" },
  { value: "before-match", label: "MATCH 之前" },
  { value: "last", label: "最后" },
]

export function Rules({ notify }: { notify: Notify }) {
  const workspace = useRuleWorkspace(notify)
  const { runtimeRules, runtimeMessage, source: runtimeSource, sourceLoading, editing, editor, snapshot, editorMessage, editorBusy, saving, pendingApply, loading, refreshing, dirty, change, save, discard, proxyGroups, ruleProviders } = workspace
  const rules = editing ? editor.draft : runtimeRules
  const canEdit = editing || Boolean(runtimeSource)
  const busy = saving || editorBusy
  const [createOpen, setCreateOpen] = useState(false)
  const [newProvider, setNewProvider] = useState("")
  const [newMode, setNewMode] = useState("provider")
  const [newWebsites, setNewWebsites] = useState("")
  const [newDomainType, setNewDomainType] = useState("DOMAIN")
  const [newPolicy, setNewPolicy] = useState("DIRECT")
  const [newPosition, setNewPosition] = useState<"first" | "before-match" | "last">("before-match")
  const [query, setQuery] = useState(() => sessionStorage.getItem("rule-filter") || "")
  const [typeFilter, setTypeFilter] = useState(() => sessionStorage.getItem("rule-type") || "all")
  const [activeDrag, setActiveDrag] = useState<{ id: string; width?: number; context: typeof workspace.actionContext; visibleIds: string[] } | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  useEffect(() => {
    sessionStorage.setItem("rule-filter", query)
    sessionStorage.setItem("rule-type", typeFilter)
  }, [query, typeFilter])

  const ruleTypes = useMemo(() => [...new Set(rules.map((rule) => rule.type))].sort(), [rules])
  const filterItems = useMemo(() => [{ label: "全部类型", value: "all" }, ...ruleTypes.map((type) => ({ label: type, value: type }))], [ruleTypes])
  const visibleRules = useMemo(() => filterRuleItems(rules, query, typeFilter), [query, rules, typeFilter])
  const activeRule = rules.find((rule) => rule.id === activeDrag?.id)
  const policyOptions = useMemo(() => [...new Set(["DIRECT", "REJECT", "REJECT-DROP", ...proxyGroups])].map(value => ({ value, label: value })), [proxyGroups])
  const websiteRules = useMemo(() => parseWebsiteRules(newWebsites), [newWebsites])

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveDrag(null)
    if (busy || !over || !activeDrag || active.id === over.id) return
    void change({ type: "move", id: String(active.id), overId: String(over.id), visibleIds: activeDrag.visibleIds }, activeDrag.context)
  }

  return (
    <StandardPage horizontalOverflow="clip">
      {runtimeMessage && <Alert variant="destructive"><AlertDescription>{runtimeMessage}</AlertDescription></Alert>}
      {!sourceLoading && !runtimeSource && <Alert><AlertDescription>编辑来源尚未确认，请先在代理页明确加载配置；运行规则仍可查看。</AlertDescription></Alert>}
      {editorMessage && <Alert><AlertDescription>{editorMessage}</AlertDescription></Alert>}
      <RuleMetricsStrip total={rules.length} types={ruleTypes.length} visible={visibleRules.length} />
      <Panel title={editing ? "规则草稿 · " + (snapshot?.name || "") : "运行规则"} headerClassName={editing ? undefined : "max-sm:hidden"} meta={query.trim() || typeFilter !== "all" ? visibleRules.length + " / " + rules.length + " 条" : undefined}>
        <RuleListToolbar
          query={query} onQueryChange={setQuery} typeFilter={typeFilter} filterItems={filterItems} onTypeFilterChange={setTypeFilter}
          dirty={dirty} busy={busy} editing={editing} canEdit={canEdit} pendingApply={pendingApply} onDiscard={discard} onSave={() => void save()}
          onCreate={() => { setNewProvider(ruleProviders[0] ?? ""); setNewMode(ruleProviders.length ? "provider" : "website"); setNewWebsites(""); setNewDomainType("DOMAIN"); setNewPolicy("DIRECT"); setNewPosition("before-match"); setCreateOpen(true) }}
        />
        <div className="overflow-x-hidden" aria-busy={loading || refreshing}>
          <RuleHeader />
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(event: DragStartEvent) => setActiveDrag({ id: String(event.active.id), width: event.active.rect.current.initial?.width, context: workspace.actionContext, visibleIds: visibleRules.map((item) => item.id) })} onDragCancel={() => setActiveDrag(null)} onDragEnd={handleDragEnd}>
            <SortableContext disabled={!canEdit || busy} items={visibleRules.map((item) => item.id)} strategy={verticalListSortingStrategy}>
              {visibleRules.map((item) => <SortableRuleRow key={item.id} item={item} index={rules.findIndex((rule) => rule.id === item.id)} disabled={!canEdit || busy} policyOptions={policyOptions} onPolicyChange={(policy) => change({ type: "policy", id: item.id, policy })} onRemove={() => void change({ type: "remove", id: item.id })} />)}
            </SortableContext>
            <DragOverlay>{activeRule ? <div style={{ width: activeDrag?.width }} className="max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border bg-background shadow-xl"><RuleRow item={activeRule} index={rules.findIndex((rule) => rule.id === activeRule.id)} overlay /></div> : null}</DragOverlay>
          </DndContext>
          {!visibleRules.length && loading && <EmptyState>正在读取 Core 规则</EmptyState>}
          {!visibleRules.length && !loading && <EmptyState>{rules.length ? "没有匹配的规则" : "Core 当前没有规则"}</EmptyState>}
        </div>
      </Panel>
      <Dialog open={createOpen} onOpenChange={(open) => { if (!busy) setCreateOpen(open) }}><DialogContent className="max-h-[90dvh] gap-3 overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>新建规则</DialogTitle><DialogDescription className="wrap-anywhere">{editing ? snapshot?.name : runtimeSource?.name} · 保存并加载后生效</DialogDescription></DialogHeader>
      <Tabs value={newMode} onValueChange={(value) => value && setNewMode(value)}><TabsList><TabsTrigger value="provider">引用规则集合</TabsTrigger><TabsTrigger value="website">手动添加网站</TabsTrigger></TabsList></Tabs>
      <FieldGroup className="gap-3 [&>[data-slot=field]]:gap-1.5">
        {newMode === "provider" ? <Field><FieldLabel>规则集合</FieldLabel>
          <MobileChoiceSheet title="选择规则集合" value={newProvider} options={ruleProviders.map(value => ({ value, label: value }))} onChoose={setNewProvider} trigger={<Button variant="outline" disabled={busy} className="h-auto min-h-11 w-full justify-between gap-2 py-2 whitespace-normal sm:hidden" aria-label="规则集合"><span className="min-w-0 text-left wrap-anywhere">{newProvider || "选择规则集合"}</span><ChevronDown data-icon="inline-end" /></Button>} />
          <Select value={newProvider || null} onValueChange={(value) => setNewProvider(String(value ?? ""))}><SelectTrigger aria-label="规则集合" className="hidden w-full sm:flex"><SelectValue placeholder="选择规则集合" /></SelectTrigger><SelectContent><SelectGroup>{ruleProviders.map((provider) => <SelectItem key={provider} value={provider}>{provider}</SelectItem>)}</SelectGroup></SelectContent></Select>{!ruleProviders.length && <FieldDescription>当前配置没有规则集合，可切换到手动添加网站。</FieldDescription>}</Field>
          : <><Field data-invalid={websiteRules.errors.length > 0}><FieldLabel htmlFor="rule-websites">域名或网址（每行一条）</FieldLabel><Textarea id="rule-websites" className="h-20 min-h-20 field-sizing-fixed overflow-y-auto sm:h-28" aria-invalid={websiteRules.errors.length > 0} value={newWebsites} onChange={(event) => setNewWebsites(event.target.value)} placeholder={"example.com\nhttps://www.example.com/path?query=1"} /><FieldDescription>仅匹配域名，保留 www 和子域名。</FieldDescription><FieldError>{websiteRules.errors.map((error) => `第 ${error.line} 行：${error.message}`).join("；")}</FieldError></Field>
            <Field><FieldLabel>匹配范围</FieldLabel><Select value={newDomainType} onValueChange={(value) => value && setNewDomainType(value)}><SelectTrigger aria-label="匹配范围" className="w-full"><SelectValue>{newDomainType === "DOMAIN" ? "仅该域名（DOMAIN）" : "包含子域名（DOMAIN-SUFFIX）"}</SelectValue></SelectTrigger><SelectContent><SelectGroup><SelectItem value="DOMAIN">仅该域名（DOMAIN）</SelectItem><SelectItem value="DOMAIN-SUFFIX">包含子域名（DOMAIN-SUFFIX）</SelectItem></SelectGroup></SelectContent></Select></Field>
            {websiteRules.hosts.length > 0 && <Field><FieldLabel>实际匹配对象 · {websiteRules.hosts.length} 项</FieldLabel><div className="max-h-32 overflow-auto rounded-md border p-2 font-mono text-xs" aria-label="实际匹配对象">{websiteRules.hosts.map((host) => <div key={host}>{newDomainType},{host}</div>)}</div></Field>}</>}
        <FieldGroup className="grid grid-cols-2 gap-3">
          <Field className="min-w-0 gap-1.5"><FieldLabel>策略</FieldLabel><RuleChoicePicker kind="policy" label="策略" value={newPolicy} options={policyOptions} disabled={busy} onChoose={(value) => { setNewPolicy(value); return true }} /></Field>
          <Field className="min-w-0 gap-1.5"><FieldLabel>位置</FieldLabel><Select items={rulePositionItems} value={newPosition} onValueChange={(value) => setNewPosition(value as typeof newPosition)}><SelectTrigger aria-label="位置" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{rulePositionItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
        </FieldGroup>
      </FieldGroup><DialogFooter className="flex-row justify-end"><Button variant="outline" disabled={busy} onClick={() => setCreateOpen(false)}>取消</Button><Button disabled={!canEdit || busy || (newMode === "provider" ? !newProvider : !websiteRules.hosts.length || websiteRules.errors.length > 0)} onClick={async () => { const added = await change({ type: "add", values: newMode === "provider" ? [{ type: "RULE-SET", payload: newProvider, policy: newPolicy }] : websiteRules.hosts.map((payload) => ({ type: newDomainType, payload, policy: newPolicy })), position: newPosition }); if (added) setCreateOpen(false) }}>加入草稿</Button></DialogFooter></DialogContent></Dialog>
    </StandardPage>
  )
}

function SortableRuleRow({ item, index, disabled, policyOptions, onPolicyChange, onRemove }: { item: RuleItem; index: number; disabled: boolean; policyOptions: Array<{ value: string; label: string }>; onPolicyChange: (policy: string) => Promise<boolean>; onRemove: () => void }) {
  const sortable = useSortable({ id: item.id, disabled })
  return <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className={cn("relative border-b last:border-b-0", sortable.isDragging && "opacity-20", sortable.isOver && !sortable.isDragging && "bg-accent/60")}><RuleRow item={item} index={index} disabled={disabled} policyOptions={policyOptions} onPolicyChange={onPolicyChange} onRemove={onRemove} handleProps={{ ...sortable.attributes, ...sortable.listeners, ref: sortable.setActivatorNodeRef }} /></div>
}

function RuleHeader() {
  return <div className={cn("hidden h-9 items-center border-b bg-muted/35 text-xs font-medium text-muted-foreground sm:grid sm:gap-x-2 sm:px-3", ruleGridColumns)}><span /><span>顺序</span><span>类型</span><span>策略</span><span>内容</span><span /></div>
}

function RuleRow({ item, index, overlay = false, disabled = false, policyOptions = [], onPolicyChange, onRemove, handleProps }: { item: RuleItem; index: number; overlay?: boolean; disabled?: boolean; policyOptions?: Array<{ value: string; label: string }>; onPolicyChange?: (policy: string) => Promise<boolean>; onRemove?: () => void; handleProps?: React.ButtonHTMLAttributes<HTMLButtonElement> & { ref?: (node: HTMLButtonElement | null) => void } }) {
  return <div className={cn("grid grid-cols-[44px_minmax(0,1fr)_44px] items-start gap-x-1 gap-y-1 px-1 py-2 text-sm sm:h-12 sm:items-center sm:gap-x-2 sm:gap-y-0 sm:px-3 sm:py-0 md:h-11", ruleGridColumns, overlay && "bg-background")}>
    <Button variant="ghost" size="icon-sm" aria-label={`拖动规则 ${index + 1}`} disabled={disabled || overlay} className="row-span-2 size-11 touch-none self-start sm:row-span-1 sm:size-7 sm:self-auto" {...handleProps}><GripVertical /></Button>
    <div className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:contents">
      <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
      <span className={cn("max-w-full wrap-anywhere text-xs font-medium sm:truncate", ruleTypeTone(item.type))}>{item.type}</span>
      {!overlay && rulePolicyEditable(item) && onPolicyChange ? <RuleChoicePicker kind="policy" label={["规则", index + 1, "策略"].join(" ")} value={item.policy} options={policyOptions} disabled={disabled} inline onChoose={onPolicyChange} /> : <span className={cn("max-w-full justify-self-start wrap-anywhere text-xs font-medium sm:truncate", policyTone(item.policy))}>{item.policy}</span>}
    </div>
    <Tooltip><TooltipTrigger render={<span className="col-span-2 col-start-2 row-start-2 min-w-0 font-mono text-xs leading-relaxed whitespace-normal wrap-anywhere sm:col-span-1 sm:col-auto sm:row-auto sm:truncate sm:leading-normal" />}>{item.payload || "-"}</TooltipTrigger><TooltipContent>{item.payload || "-"}</TooltipContent></Tooltip>
    {!overlay && onRemove ? <Button variant="ghost" size="icon-sm" aria-label={`删除规则 ${index + 1}`} disabled={disabled} className="col-start-3 row-start-1 size-11 sm:col-auto sm:row-auto sm:size-7" onClick={onRemove}><Trash2 /></Button> : <span className="col-start-3 row-start-1 sm:col-auto sm:row-auto" />}
  </div>
}
