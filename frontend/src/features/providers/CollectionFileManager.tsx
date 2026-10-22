import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { Boxes, ChevronDown, ChevronRight, ListTree, FilePenLine, MoreHorizontal, Plus, Trash2 } from "lucide-react"
import type { ProviderConfigReference } from "@/api/configClient"
import { WorkspaceCategoryTabs, WorkspaceToolbar } from "@/components/patterns/workspace"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { collectionSourceLabel, type CollectionFileRow } from "./collectionFileManagement"
import { CollectionReferenceForm } from "./CollectionReferenceForm"
import type { ProviderCategory } from "./collectionViewModel"
import { managedProviderBodyWritable, type ManagedProviderItem } from "./managedProviderModel"
import type { useManagedProviderWorkspace } from "./useManagedProviderWorkspace"

type Workspace = ReturnType<typeof useManagedProviderWorkspace>
function CollectionBindings({ items, onOpen }: { items: ManagedProviderItem[]; onOpen: (item: ManagedProviderItem) => void }) {
  return <ul className="flex min-w-0 flex-col gap-3" aria-label="集合及所属代理组">{items.map(item => <li key={item.id} className="flex min-w-0 flex-col items-start gap-1">
    <Button variant="link" size="sm" className="h-auto min-h-7 max-w-full justify-start whitespace-normal p-0 text-left" aria-label={"编辑集合 " + item.name} onClick={() => onOpen(item)}><span className="min-w-0 [overflow-wrap:anywhere]">{item.name}</span></Button>
    {item.category === "proxy" && <ul className="flex min-w-0 max-w-full flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={item.name + " 所属代理组"}>{[...new Set([...item.selectedGroups, ...(item.implicitGroups ?? [])])].map(name => <li className="min-w-0 [overflow-wrap:anywhere]" key={name}>{name}</li>)}</ul>}
    {item.category === "rule" && <ul className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-muted-foreground" aria-label={item.name + " 规则引用"}>{item.ruleSetRules.map((rule, index) => <li className="min-w-0 [overflow-wrap:anywhere]" key={index}>{rule}</li>)}</ul>}
  </li>)}</ul>
}
function ConfigReferences({ references, unknown }: { references: ProviderConfigReference[]; unknown: boolean }) {
  return references.length ? <ul className="flex min-w-0 flex-col gap-3 text-xs" aria-label="其他配置引用">{references.map((reference, index) => <li key={index} className="flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]">
    <span>{reference.configName}</span>{reference.path && <span className="text-muted-foreground">{reference.path}</span>}{reference.kind === "unreadable" && <span className="text-muted-foreground">无法读取</span>}
  </li>)}</ul> : <span className="text-xs text-muted-foreground">{unknown ? "未知" : "未发现引用"}</span>
}
function subscribeColumns(listener: () => void) {
  const query = window.matchMedia("(min-width: 1024px)")
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}
export function CollectionFileManager({ category, workspace, historyEntry, visible, discardInputVersion, onCategoryChange, onOpenCollection, onNew, onCleanup, onDirtyChange }: {
  category: ProviderCategory; workspace: Workspace; onCategoryChange: (category: ProviderCategory) => boolean
  historyEntry: string; visible: boolean; discardInputVersion: number
  onOpenCollection: (item: ManagedProviderItem) => void; onNew: () => void; onCleanup: () => void; onDirtyChange: (dirty: boolean) => void
}) {
  const [selection, setSelection] = useState<string[]>([])
  const wide = useSyncExternalStore(subscribeColumns, () => window.matchMedia("(min-width: 1024px)").matches)
  const [reference, setReference] = useState<string | null>(null)
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const detailsId = useId()
  const [deleting, setDeleting] = useState<CollectionFileRow[] | null>(null)
  const rows = workspace.managementRows
  const disabled = workspace.writeDisabled
  const listRef = useRef<HTMLDivElement>(null)
  const snapshots = useRef(new Map<string, { expanded: string | null; selection: string[]; scrollTop: number }>())
  const currentUi = useRef({ expanded, selection, scrollTop: 0 })
  currentUi.current.expanded = expanded
  currentUi.current.selection = selection
  useLayoutEffect(() => {
    if (!visible) return
    const key = historyEntry + ":" + category
    const saved = snapshots.current.get(key) ?? { expanded: null, selection: [], scrollTop: 0 }
    setExpanded(saved.expanded)
    setSelection(saved.selection)
    currentUi.current.scrollTop = saved.scrollTop
    const frame = requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = saved.scrollTop })
    return () => { cancelAnimationFrame(frame); snapshots.current.set(key, { ...currentUi.current, selection: [...currentUi.current.selection] }) }
  }, [category, historyEntry, visible])
  useEffect(() => { setReference(null); setRename(null); setDeleting(null) }, [category, discardInputVersion])
  useEffect(() => { if (!rename) return; onDirtyChange(true); return () => onDirtyChange(false) }, [Boolean(rename), onDirtyChange])
  const currentName = workspace.snapshot?.name
  const others = (row: CollectionFileRow) => row.cleanup?.configReferences?.filter(item => item.configName !== currentName) ?? []
  const status = (row: CollectionFileRow) => row.deleting ? "待删除" : row.draft ? "未保存" : row.bindings.length ? row.savedBindings.length ? "已引用" : "待引用" : row.savedBindings.length ? "待取消引用" : "未引用"
  const writable = (row: CollectionFileRow) => managedProviderBodyWritable(row.item)
  const groupCount = (row: CollectionFileRow) => row.item.category === "rule" ? row.bindings.reduce((count, item) => count + item.ruleSetRules.length, 0) : new Set(row.bindings.flatMap(item => [...item.selectedGroups, ...(item.implicitGroups ?? [])])).size
  const toggleDetails = (id: string) => { if (!reference && !rename) setExpanded(current => current === id ? null : id) }
  const otherCounts = (row: CollectionFileRow) => {
    const references = others(row), known = references.filter(item => item.kind !== "unreadable")
    return { configs: new Set(known.map(item => item.configName)).size, references: known.length, unreadable: new Set(references.filter(item => item.kind === "unreadable").map(item => item.configName)).size }
  }
  return <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col" aria-label="管理集合工作区">
    <WorkspaceToolbar variant="editor">
      <WorkspaceCategoryTabs layout="list" listSpacing="comfortable" value={category} onValueChange={value => onCategoryChange(value as ProviderCategory)} disabled={workspace.busy || Boolean(reference || rename)} items={[{ value: "proxy", label: "代理集合", icon: Boxes }, { value: "rule", label: "规则集合", icon: ListTree }]} />
      <span className="ml-auto hidden text-xs text-muted-foreground lg:block">{rows.length} 项</span>
      <Button variant="outline" size="sm" className="ml-auto lg:ml-2" disabled={disabled || Boolean(reference || rename)} onClick={onNew}><Plus data-icon="inline-start" />新增</Button>
      <Button variant="ghost" size="icon" aria-label="删除所选集合" disabled={disabled || !selection.length || Boolean(reference || rename)} onClick={() => setDeleting(rows.filter(row => selection.includes(row.id)))}><Trash2 /></Button>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="文件管理操作" />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuItem disabled={workspace.busy || workspace.dirty || Boolean(reference || rename)} onClick={onCleanup}>清理文件</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
    </WorkspaceToolbar>
    {workspace.catalogError && <Alert><AlertDescription>{workspace.catalogError}</AlertDescription></Alert>}
    <div ref={listRef} onScroll={event => { currentUi.current.scrollTop = event.currentTarget.scrollTop }} className="min-h-0 flex-1 overflow-y-auto px-3" aria-label="集合管理列表">
      <Table className="table-fixed [&_td]:whitespace-normal [&_td]:[overflow-wrap:anywhere]"><TableHeader className="sticky top-0 bg-background"><TableRow>
        <TableHead className="w-9"><Checkbox aria-label="全选集合" checked={rows.length > 0 && rows.filter(row => !row.deleting).every(row => selection.includes(row.id))} onCheckedChange={checked => setSelection(checked ? rows.filter(row => !row.deleting).map(row => row.id) : [])} /></TableHead>
        <TableHead className="whitespace-normal">文件 / 内嵌集合</TableHead><TableHead className="hidden w-[14%] lg:table-cell">类型 / 来源</TableHead><TableHead className="hidden w-[22%] lg:table-cell">当前配置</TableHead><TableHead className="hidden w-[15%] whitespace-normal lg:table-cell">其他配置引用</TableHead><TableHead className="w-36 text-right">操作</TableHead>
      </TableRow></TableHeader><TableBody>{rows.map(row => <Fragment key={row.id}><TableRow className="h-24 lg:h-20" data-collection-row={row.id}>
        <TableCell><Checkbox aria-label={"选择 " + (row.fileName ?? row.item.name)} checked={selection.includes(row.id)} disabled={row.deleting} onCheckedChange={checked => setSelection(current => checked ? [...current, row.id] : current.filter(id => id !== row.id))} /></TableCell>
        <TableCell className="py-3"><div className="flex min-w-0 items-center gap-1">
          <Button variant="ghost" size="icon" aria-label={(expanded === row.id ? "收起详情" : "展开详情") + " · " + (row.fileName ?? row.item.name)} aria-expanded={expanded === row.id} aria-controls={detailsId + encodeURIComponent(row.id)} disabled={workspace.busy || Boolean(reference || rename)} onClick={() => toggleDetails(row.id)}>{expanded === row.id ? <ChevronDown /> : <ChevronRight />}</Button>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="h-5 truncate">{row.fileName?.split("/").at(-1) ?? row.item.name}</span>
            <span className="hidden h-5 truncate text-xs text-muted-foreground lg:block">{row.referencePath ?? "内嵌于源配置"}</span>
            <span className="h-5 truncate text-xs text-muted-foreground lg:hidden">{row.item.access === "inline" ? "Inline" : row.item.access === "http" ? "HTTP" : "File"} · {collectionSourceLabel(row.item)} · {status(row)}</span>
            <span className="h-5 truncate text-xs text-muted-foreground lg:hidden">{row.bindings.length} 集合 · {groupCount(row)}{row.item.category === "rule" ? " 引用 · " : " 组 · "}{workspace.catalogError || otherCounts(row).unreadable ? "外部未确认" : otherCounts(row).configs + " 配置"}</span>
          </div></div></TableCell>
        <TableCell className="hidden lg:table-cell"><div className="flex min-w-0 flex-col gap-1"><span className="h-5 truncate">{collectionSourceLabel(row.item)}</span><span className="h-5 truncate text-xs text-muted-foreground">{row.item.access === "inline" ? "Inline" : row.item.access === "http" ? "HTTP" : "File"} · {writable(row) ? "可编辑" : "只读"}</span></div></TableCell>
        <TableCell className="hidden lg:table-cell"><div className="flex min-w-0 flex-col gap-1"><div className="flex h-5 min-w-0 items-center gap-2">
          {row.bindings.length === 1 ? <Button variant="link" size="sm" className="h-5 min-w-0 max-w-full shrink justify-start p-0" aria-label={"编辑集合 " + row.bindings[0]!.name} onClick={() => onOpenCollection(row.bindings[0]!)}><span className="truncate">{row.bindings[0]!.name}</span></Button> : <span className="min-w-0 truncate">{row.bindings.length} 个集合</span>}
          <span className="shrink-0 text-xs text-muted-foreground">{status(row)}</span></div>
          <span className="h-5 truncate text-xs text-muted-foreground">{groupCount(row)}{row.item.category === "rule" ? " 条规则引用" : " 个代理组"}</span></div></TableCell>
        <TableCell className="hidden lg:table-cell"><div className="flex min-w-0 flex-col gap-1">
          <span className="h-5 truncate">{workspace.catalogError ? "未知" : otherCounts(row).unreadable && !otherCounts(row).configs ? "引用未确认" : otherCounts(row).configs + " 个配置"}</span>
          <span className="h-5 truncate text-xs text-muted-foreground">{workspace.catalogError ? "引用未确认" : otherCounts(row).unreadable ? otherCounts(row).references + " 条引用 · " + otherCounts(row).unreadable + " 无法读取" : otherCounts(row).references + " 条引用"}</span>
        </div></TableCell>
        <TableCell><div className="flex justify-end gap-1">{row.deleting ? <Badge variant="secondary">待删除</Badge> : row.item.access !== "inline" && <Button variant="secondary" className="min-w-20" disabled={disabled || Boolean(reference || rename)} onClick={() => {
          if (row.bindings.length) workspace.unreferenceFile(row)
          else { setReference(row.id); setExpanded(null) }
        }}>{row.bindings.length ? "取消引用" : "引用"}</Button>}
          <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={(row.fileName ?? row.item.name) + " 管理操作"} disabled={row.deleting || Boolean(reference || rename)} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup>
            {row.fileName && <DropdownMenuItem disabled={disabled || !writable(row) || row.item.fileIssue === "missing"} onClick={() => { setRename({ id: row.id, name: row.fileName!.split("/").at(-1)! }); setExpanded(null) }}><FilePenLine />修改文件名</DropdownMenuItem>}
            <DropdownMenuItem variant="destructive" disabled={disabled || Boolean(row.fileName && !row.cleanup && !row.draft)} onClick={() => setDeleting([row])}><Trash2 />删除</DropdownMenuItem>
          </DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
        </div></TableCell>
      </TableRow>
      {reference === row.id && <TableRow><TableCell colSpan={wide ? 6 : 3} className="p-4"><CollectionReferenceForm row={row} workspace={workspace} onClose={() => setReference(null)} onDirtyChange={onDirtyChange} /></TableCell></TableRow>}
      {rename?.id === row.id && <TableRow><TableCell colSpan={wide ? 6 : 3} className="p-4"><FieldGroup className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start"><Field><FieldLabel htmlFor="rename-collection-file">文件名</FieldLabel><Input id="rename-collection-file" value={rename.name} disabled={disabled} onChange={event => setRename({ ...rename, name: event.target.value })} /><FieldDescription>保留正文并同步当前配置；其他配置或已记录运行版本依赖时保留原文件。</FieldDescription></Field><div className="flex justify-end gap-2 md:pt-6"><Button variant="outline" disabled={workspace.busy} onClick={() => setRename(null)}>取消</Button><Button disabled={disabled} onClick={() => void workspace.renameFile(row, rename.name).then(ok => { if (ok) setRename(null) })}>确认</Button></div></FieldGroup></TableCell></TableRow>}
      {expanded === row.id && <TableRow id={detailsId + encodeURIComponent(row.id)}><TableCell colSpan={wide ? 6 : 3} className="p-4"><dl className="grid min-w-0 grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-x-4 gap-y-3 text-xs sm:grid-cols-[8rem_minmax(0,1fr)] [&>dd]:min-w-0"><dt>文件名称</dt><dd>{row.fileName ?? row.item.name}</dd><dt>来源与权限</dt><dd>{collectionSourceLabel(row.item)} · {writable(row) ? "可编辑" : "正文只读"}</dd><dt>文件路径</dt><dd className="[overflow-wrap:anywhere]">{row.referencePath ?? "内嵌于源配置"}</dd><dt>当前配置</dt><dd>{row.bindings.length ? <CollectionBindings items={row.bindings} onOpen={onOpenCollection} /> : "未引用"}</dd><dt>状态</dt><dd>{status(row)}{row.item.fileIssue && !workspace.itemOperationPending(row.item) ? row.item.fileIssue === "missing" ? " · 缺少文件" : " · 文件需核对" : ""}</dd><dt>其他引用</dt><dd><ConfigReferences references={others(row)} unknown={Boolean(workspace.catalogError)} /></dd><dt>最近加载记录</dt><dd>{row.cleanup?.runtime?.references.length ? "有引用" : row.cleanup?.runtime?.hasSuccessfulRecord ? "未发现引用" : "未知"} · 当前运行依赖{row.cleanup?.runtime?.uncertain === false ? "已核对" : "未知"}</dd>{["local", "subscription"].includes(row.item.access) && <><dt>自动维护</dt><dd>提取功能管理来源与生成文件，正文只读。</dd></>}</dl></TableCell></TableRow>}
      </Fragment>)}</TableBody></Table>
      {!rows.length && <Empty><EmptyHeader><EmptyTitle>暂无集合</EmptyTitle></EmptyHeader><Button variant="outline" disabled={disabled} onClick={onNew}>新增</Button></Empty>}
    </div>
    <Dialog open={Boolean(deleting)} onOpenChange={open => { if (!open) setDeleting(null) }}><DialogContent><DialogHeader><DialogTitle>删除选中的 {deleting?.length} 项？</DialogTitle><DialogDescription>移除当前配置的集合声明及关联引用，成功应用后按实际来源、所有权和引用约束清理文件。</DialogDescription></DialogHeader>
      <div className="flex max-h-72 flex-col gap-4 overflow-y-auto">{deleting?.map(row => <div key={row.id} className="flex flex-col gap-2"><span className="break-all text-sm">{row.fileName ?? row.item.name}</span><span className="text-xs text-muted-foreground">{collectionSourceLabel(row.item)} · 当前引用：{row.bindings.map(item => item.name).join("、") || "无"} · 代理组：{row.bindings.flatMap(item => item.selectedGroups).join("、") || "无"}</span><span className="text-xs text-muted-foreground">其他配置：{others(row).map(item => item.configName).join("、") || "未发现引用"}。自动维护、仍受引用或运行依赖未知的文件继续保留。</span></div>)}</div>
      <DialogFooter><Button variant="outline" onClick={() => setDeleting(null)}>取消</Button><Button variant="destructive" disabled={disabled} onClick={() => { if (deleting && workspace.removeFiles(deleting)) { setDeleting(null); setSelection([]) } }}>加入删除草稿</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>
}
