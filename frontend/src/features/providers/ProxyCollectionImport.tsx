import { proxyCollectionCount, ruleCollectionCount } from "@/shared/collectionContent"
import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, Upload } from "lucide-react"
import { useUiState } from "@/app/state/uiState"
import { MonacoWorkspace } from "@/components/patterns/monaco-workspace"
import { MobileChoiceSheet } from "@/components/patterns/mobile-choice-sheet"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { StatusBadge } from "@/components/patterns/status-badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { CollectionCategory, ProxyCollectionInput } from "@/api/configClient"
import { cn } from "@/lib/utils"
import { managedProviderDeclarationSnippet, type ManagedProviderItem } from "./managedProviderModel"
import type { useManagedProviderWorkspace } from "./useManagedProviderWorkspace"
import { CollectionHttpFields } from "./CollectionHttpFields"
import { collectionUploadMatches, collectionUploadTargets, createCollectionDraft, latestMissingCollectionDeclaration, patchUploadDeclaration, readUploadDeclaration, proxyCollectionGroups } from "./proxyCollectionImport"

type Workspace = ReturnType<typeof useManagedProviderWorkspace>
type CollectionType = "file" | "inline" | "http"
type ImportDraft = ProxyCollectionInput & { uploadName: string; target: string; targetName?: string; defaultSnippet?: string; policy: string; done?: boolean; error?: string }

function newDraft(): ImportDraft {
  const operationId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("")
  return { operationId, name: "", content: "", groupNames: [], newGroupName: "", uploadName: "", target: "new", behavior: "classical", policy: "DIRECT" }
}

function contentStatus(content: string, category: CollectionCategory) {
  if (!content.trim()) return { count: null, error: null }
  try { return { count: category === "proxy" ? proxyCollectionCount(content) : ruleCollectionCount(content), error: null } }
  catch (error) { return { count: null, error: error instanceof Error ? error.message : "集合 YAML 无效" } }
}

function GroupFields({ groups, selected, newName, onChange, disabled }: {
  groups: ReturnType<typeof proxyCollectionGroups>; selected: string[]; newName?: string
  onChange: (groups: string[], newName: string) => void; disabled?: boolean
}) {
  return <Field>
    <FieldLabel>所属代理组</FieldLabel>
    <div className="flex flex-wrap gap-3">{groups.map((group) => <label className="flex max-md:min-h-11 max-md:px-3.5 items-center gap-1.5 text-sm" key={group.name}>
      <Checkbox checked={group.implicit || selected.includes(group.name)} disabled={disabled || group.implicit}
        onCheckedChange={(checked) => onChange(checked ? [...new Set([...selected, group.name])] : selected.filter((name) => name !== group.name), newName ?? "")} />
      {group.name}{group.implicit ? "（自动包含所有集合）" : ""}
    </label>)}</div>
    <Input aria-label="新建选择组名称" placeholder="或填写新建选择组名称" value={newName ?? ""} disabled={disabled}
      onChange={(event) => onChange(selected, event.target.value)} />
  </Field>
}

function targetFields(item: ManagedProviderItem | undefined): Partial<ImportDraft> {
  return { repair: item?.fileIssue === "missing", replace: Boolean(item && item.fileIssue !== "missing"),
    targetName: item?.name,
    targetFileName: item?.fileName ?? undefined, expectedFileSha256: item?.sha256 ?? undefined,
    groupNames: item?.selectedGroups ?? [], newGroupName: "", behavior: String(item?.declaration?.behavior ?? "classical") }
}

export function ProxyCollectionImportDialog({ mode, category = "proxy", onClose, workspace, onDirtyChange }: {
  mode: "new" | "upload"; category?: CollectionCategory; onClose: () => void; workspace: Workspace; onDirtyChange: (dirty: boolean) => void
}) {
  const { askConfirm } = useUiState()
  const [drafts, setDrafts] = useState<ImportDraft[]>(() => mode === "new" ? [newDraft()] : [])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [collectionType, setCollectionType] = useState<CollectionType>("file")
  const [url, setUrl] = useState("")
  const [interval, setInterval] = useState(0)
  const [intervalValid, setIntervalValid] = useState(true)
  const [selectedFile, setSelectedFile] = useState("")
  const [tab, setTab] = useState("settings")
  const expectedSource = useRef(workspace.snapshot)
  const mounted = useRef(true)
  const readRequest = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readRequest.current?.abort() } }, [])
  const groups = useMemo(() => proxyCollectionGroups(workspace.configContent), [workspace.configContent])
  const active = drafts.find((draft) => draft.operationId === activeId) ?? drafts[0]
  const targets = collectionUploadTargets(workspace.items, category).filter((item) => !workspace.readOnlyFor(item))
  const availableFiles = workspace.files.filter((file) => file.category === category && file.writable && (file.source === "manual" || file.source === "external"))
  const file = availableFiles.find((entry) => entry.fileName === selectedFile)
  const dirty = mode === "upload" ? drafts.some((draft) => !draft.done) : Boolean(url || interval || selectedFile || collectionType !== "file" || active && (
    active.content || active.name || active.groupNames.length || active.newGroupName || active.behavior !== "classical" || active.policy !== "DIRECT"))
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  const disabled = workspace.busy || reading
  const patch = (update: Partial<ImportDraft>) => setDrafts((current) => current.map((draft) => {
    if (draft.operationId !== active?.operationId) return draft
    const next = { ...draft, ...update, error: undefined }
    if (mode === "upload") {
      try {
        if (update.snippet === undefined && (update.name !== undefined || update.behavior !== undefined)) {
          next.snippet = patchUploadDeclaration(draft.snippet ?? "", category, update)
        }
        const parsed = readUploadDeclaration(next.snippet ?? "", category)
        next.name = parsed.name
        next.behavior = String(parsed.declaration.behavior ?? "classical")
      } catch { /* Retain invalid YAML for correction; saving is blocked. */ }
    }
    return next
  }))
  const chooseTarget = (value: string | null) => {
    const item = targets.find(item => item.id === value)
    patch({ ...targetFields(item), target: value ?? "", snippet: item ? managedProviderDeclarationSnippet(item) : active.defaultSnippet,
      name: item?.name ?? active.uploadName.replace(/\.ya?ml$/i, "") })
  }
  const readFiles = async (files: File[]) => {
    if (disabled || !files.length) return
    setFileError(null)
    if (files.some((entry) => !/\.ya?ml$/i.test(entry.name))) { setFileError("请选择 .yaml 或 .yml 文件"); return }
    setReading(true)
    const request = new AbortController()
    readRequest.current = request
    try {
      const next = await Promise.all(files.map(async (entry) => {
        const matches = collectionUploadMatches(entry.name, targets, category)
        const target = matches.length === 1 ? matches[0] : undefined
        const draft = newDraft()
        const name = entry.name.replace(/\.ya?ml$/i, "")
        const { snippet: defaultSnippet } = await workspace.prepareUploadDeclaration(name, draft.operationId, category, request.signal)
        return { ...draft, ...targetFields(target), uploadName: entry.name, content: await entry.text(), defaultSnippet,
          snippet: target ? managedProviderDeclarationSnippet(target) : defaultSnippet,
          name: target?.name ?? name, target: target ? target.id : "" }
      }))
      if (mounted.current) { setDrafts((current) => [...current, ...next]); setActiveId(next[0]!.operationId) }
    } catch { if (mounted.current) setFileError("文件读取失败，原输入已保留") }
    finally { if (mounted.current) setReading(false); if (readRequest.current === request) readRequest.current = null }
  }
  const inputFor = (draft: ImportDraft): ProxyCollectionInput => ({
    operationId: draft.operationId, category, name: draft.targetName ?? draft.name.trim(), content: draft.content, snippet: draft.snippet,
    groupNames: draft.groupNames, newGroupName: draft.newGroupName?.trim(), repair: draft.repair, replace: draft.replace,
    targetFileName: draft.targetFileName, expectedFileSha256: draft.expectedFileSha256, behavior: draft.behavior, format: "yaml", interval,
    ...(category === "rule" && draft.target === "new" ? { ruleSetRules: [`RULE-SET,${draft.name.trim()},${draft.policy}`] } : {}),
  })
  const rowError = (draft: ImportDraft) => {
    if (draft.done) return null
    if (!draft.target) return "请选择目标集合；无精确匹配或存在歧义时需要手动选择"
    if (drafts.some((other) => other !== draft && (other.name.trim() === draft.name.trim() ||
      (draft.targetFileName && other.targetFileName === draft.targetFileName) || (draft.target !== "new" && other.target === draft.target)))) return "多份文件不能对应同一集合文件"
    if (mode === "upload") {
      let declaration: ReturnType<typeof readUploadDeclaration>
      try { declaration = readUploadDeclaration(draft.snippet ?? "", category) } catch (error) { return (error as Error).message }
      if (drafts.some((other) => other !== draft && other.snippet && (() => {
        try { return readUploadDeclaration(other.snippet, category).declaration.path === declaration.declaration.path } catch { return false }
      })())) return "多份文件不能对应同一集合文件"
      const status = contentStatus(draft.content, category)
      if (status.error || !status.count) return status.error ?? "上传文件没有集合正文"
      if (draft.target !== "new") {
        if (!targets.some((item) => item.id === draft.target)) return "目标不可替换，请重新选择"
        if (workspace.items.some((item) => item.name === declaration.name && item.id !== draft.target) ||
          (category === "proxy" && groups.some((group) => group.name === declaration.name))) return "集合名称已存在"
        return null
      }
      try { createCollectionDraft(workspace.configContent, { ...inputFor(draft), name: declaration.name }, "file", "", category, String(declaration.declaration.path)) }
      catch (error) { return (error as Error).message }
      return null
    }
    try {
      createCollectionDraft(workspace.configContent, inputFor(draft), collectionType, url, category, file?.referencePath)
    } catch (error) { return error instanceof Error ? error.message : "请检查集合设置" }
    if (collectionType === "http" && !intervalValid) return "请填写有效的更新周期"
    return null
  }
  const save = async () => {
    if (disabled || workspace.writeDisabled || drafts.some((draft) => rowError(draft))) return
    if (mode === "new" && active) {
      if (workspace.createDeclaredCollection({ ...inputFor(active), targetFileName: file?.referencePath }, collectionType, url, category)) onClose()
      return
    }
    const pending = drafts.filter((draft) => !draft.done)
    if (pending.some((draft) => draft.replace) && !(await askConfirm({ title: "覆盖已有 File 集合？",
      message: "将替换所选普通 File 的正文。所有引用该文件的配置都会读取更新后的内容。", confirmLabel: "覆盖并保存", cancelLabel: "继续编辑", danger: true }))) return
    const saved = await workspace.importCollections(pending.map(inputFor), (id, config) => {
      expectedSource.current = config
      setDrafts((current) => current.map((draft) => draft.operationId === id ? { ...draft, done: true, error: undefined } : draft))
    }, expectedSource.current ?? undefined, (id, error) => {
      setDrafts((current) => current.map((draft) => draft.operationId === id ? { ...draft, error } : draft))
      setActiveId(id)
    })
    if (saved && mounted.current) onClose()
  }
  const close = async () => {
    if (disabled) return
    if (!dirty || await askConfirm({ title: "放弃未保存的修改？", message: "未保存的集合输入将被丢弃。已保存的文件不受影响。", confirmLabel: "放弃修改", cancelLabel: "继续编辑", danger: true })) onClose()
  }
  const existing = active?.target !== "new" ? targets.find((item) => item.id === active?.target) : undefined
  const compact = mode === "upload" && !drafts.length
  return <Dialog open onOpenChange={(open) => { if (!open) void close() }}>
    <DialogContent className={cn("flex w-[calc(100vw-2rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl", compact ? "max-h-[90dvh]" : "h-[min(90dvh,800px)]")}
      onDragOver={mode === "upload" ? (event) => event.preventDefault() : undefined}
      onDrop={mode === "upload" ? (event) => { event.preventDefault(); void readFiles([...event.dataTransfer.files]) } : undefined}>
      <DialogHeader className="px-5 py-4"><DialogTitle>{mode === "new" ? "新建" : "上传"}{category === "proxy" ? "代理" : "规则"}集合</DialogTitle><DialogDescription>来源：{workspace.snapshot?.name}。保存配置后，使用“应用配置”加载变更。</DialogDescription></DialogHeader>
      {mode === "upload" && <div className="flex shrink-0 items-center gap-3 border-y px-5 py-2">
        <input ref={inputRef} type="file" accept=".yaml,.yml" multiple className="sr-only" disabled={disabled} onChange={(event) => { void readFiles([...(event.target.files ?? [])]); event.target.value = "" }} />
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => inputRef.current?.click()}><Upload data-icon="inline-start" />选择文件</Button><span className="text-xs text-muted-foreground">也可拖入多个 YAML 文件</span>
      </div>}
      {fileError && <FieldError className="px-5 py-2">{fileError}</FieldError>}
      {active ? <div className="flex min-h-0 flex-1 flex-col overflow-hidden sm:flex-row">
        {mode === "upload" && <div className="flex max-h-28 shrink-0 flex-col gap-1 overflow-y-auto border-b p-2 sm:max-h-none sm:w-56 sm:border-r sm:border-b-0">{drafts.map((draft) => <Button className="h-auto w-full justify-start py-2" variant={draft === active ? "secondary" : "ghost"} key={draft.operationId} onClick={() => setActiveId(draft.operationId)}>
          <span className="min-w-0 flex-1 truncate text-left">{draft.uploadName}</span><StatusBadge status={draft.error || rowError(draft) ? "error" : draft.done ? "success" : "info"}>{draft.done ? "已保存" : draft.error || rowError(draft) ? "错误" : "待保存"}</StatusBadge>
        </Button>)}</div>}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {mode === "upload" && <Tabs value={tab} onValueChange={(value) => value && setTab(value)} className="shrink-0 border-b px-4"><TabsList variant="line"><TabsTrigger value="settings">设置</TabsTrigger><TabsTrigger value="declaration">集合声明</TabsTrigger></TabsList></Tabs>}
          <div className={cn("min-h-0 flex-1 overflow-y-auto p-5", mode === "upload" && tab !== "settings" && "hidden")}>
            <FieldGroup>
              {mode === "new" && <Field orientation="horizontal"><FieldLabel>集合类型</FieldLabel><Select value={collectionType} disabled={disabled} onValueChange={(value) => { if (value === "file" || value === "inline" || value === "http") setCollectionType(value) }}><SelectTrigger aria-label="集合类型"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="inline">Inline</SelectItem><SelectItem value="file">File</SelectItem><SelectItem value="http">HTTP</SelectItem></SelectGroup></SelectContent></Select></Field>}
              {mode === "upload" && <Field><FieldLabel>目标集合</FieldLabel>
                <MobileChoiceSheet title="选择目标集合" value={active.target} options={[{ value: "new", label: "新建 File 集合" }, ...targets.map(item => ({ value: item.id, label: item.name, description: item.fileIssue === "missing" ? "缺少文件" : "替换普通 File" }))]} onChoose={chooseTarget} trigger={<Button variant="outline" disabled={disabled || active.done} className="h-auto min-h-11 w-full justify-between gap-2 py-2 whitespace-normal sm:hidden" aria-label="目标集合"><span className="min-w-0 text-left wrap-anywhere">{active.target === "new" ? "新建 File 集合" : existing?.name ?? "选择目标集合"}</span><ChevronDown data-icon="inline-end" /></Button>} />
                <Select value={active.target || null} disabled={disabled || active.done} onValueChange={chooseTarget}><SelectTrigger aria-label="目标集合" className="hidden w-full sm:flex"><SelectValue placeholder="选择目标集合">{active.target === "new" ? "新建 File 集合" : existing?.name ?? "选择目标集合"}</SelectValue></SelectTrigger><SelectContent><SelectGroup><SelectItem value="new">新建 File 集合</SelectItem>{targets.map((item) => <SelectItem key={item.id} value={item.id}>{item.name} · {item.fileIssue === "missing" ? "缺少文件" : "替换普通 File"}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>}
              <Field><FieldLabel htmlFor="collection-name">集合名称</FieldLabel><Input id="collection-name" value={active.name} disabled={disabled || active.done} onChange={(event) => patch({ name: event.target.value })} /></Field>
              {mode === "new" && collectionType === "file" && <Field><FieldLabel>已有受控文件</FieldLabel>
                <MobileChoiceSheet title="选择已有受控文件" value={selectedFile} options={availableFiles.map(entry => ({ value: entry.fileName, label: entry.fileName }))} onChoose={setSelectedFile} trigger={<Button variant="outline" disabled={disabled} className="h-auto min-h-11 w-full justify-between gap-2 py-2 whitespace-normal sm:hidden" aria-label="已有受控文件"><span className="min-w-0 text-left wrap-anywhere">{selectedFile || "选择文件"}</span><ChevronDown data-icon="inline-end" /></Button>} />
                <Select value={selectedFile || null} disabled={disabled} onValueChange={(value) => setSelectedFile(value ?? "")}><SelectTrigger className="hidden w-full sm:flex" aria-label="已有受控文件"><SelectValue placeholder="选择文件" /></SelectTrigger><SelectContent><SelectGroup>{availableFiles.map((entry) => <SelectItem value={entry.fileName} key={entry.fileName}>{entry.fileName}</SelectItem>)}</SelectGroup></SelectContent></Select><FieldDescription>如需导入新文件，请使用集合页的“上传”。</FieldDescription></Field>}
              {existing ? <Field><FieldLabel>现有引用</FieldLabel><FieldDescription>{category === "proxy" ? existing.selectedGroups.join("、") || "未被代理组使用" : existing.ruleSetRules.join("；") || "暂无规则引用"}。保存保留这些引用。</FieldDescription></Field>
                : category === "proxy" ? <GroupFields groups={groups} selected={active.groupNames} newName={active.newGroupName} disabled={disabled || active.done} onChange={(groupNames, newGroupName) => patch({ groupNames, newGroupName })} />
                : <><Field><FieldLabel>规则类型</FieldLabel><Select value={active.behavior} disabled={disabled || active.done} onValueChange={(value) => value && patch({ behavior: value })}><SelectTrigger aria-label="规则类型"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="classical">classical · 经典规则</SelectItem><SelectItem value="domain">domain · 域名</SelectItem><SelectItem value="ipcidr">ipcidr · IP 网段</SelectItem></SelectGroup></SelectContent></Select></Field>
                  <Field><FieldLabel>匹配后去向</FieldLabel>
                    <MobileChoiceSheet title="选择匹配后去向" value={active.policy} options={[{ value: "DIRECT", label: "DIRECT · 直连" }, ...groups.filter(group => group.name !== "DIRECT").map(group => ({ value: group.name, label: group.name }))]} onChoose={policy => patch({ policy })} trigger={<Button variant="outline" disabled={disabled || active.done} className="h-auto min-h-11 w-full justify-between gap-2 py-2 whitespace-normal sm:hidden" aria-label="匹配后去向"><span className="min-w-0 text-left wrap-anywhere">{active.policy === "DIRECT" ? "DIRECT · 直连" : active.policy}</span><ChevronDown data-icon="inline-end" /></Button>} />
                    <Select value={active.policy} disabled={disabled || active.done} onValueChange={(value) => value && patch({ policy: value })}><SelectTrigger className="hidden w-full sm:flex" aria-label="匹配后去向"><SelectValue>{active.policy === "DIRECT" ? "DIRECT · 直连" : active.policy}</SelectValue></SelectTrigger><SelectContent><SelectGroup><SelectItem value="DIRECT">DIRECT · 直连</SelectItem>{groups.filter((group) => group.name !== "DIRECT").map((group) => <SelectItem key={group.name} value={group.name}>{group.name}</SelectItem>)}</SelectGroup></SelectContent></Select><FieldDescription>创建规则引用，放在兜底规则前。</FieldDescription></Field></>}
              {mode === "new" && collectionType === "http" && <><Field><FieldLabel htmlFor="collection-url">HTTP 地址</FieldLabel><Input id="collection-url" value={url} disabled={disabled} onChange={(event) => setUrl(event.target.value)} /></Field><CollectionHttpFields interval={interval} disabled={disabled} onChange={setInterval} onValidChange={setIntervalValid} /></>}
            </FieldGroup>
          </div>
          {(mode === "upload" || collectionType === "inline") && <div className={cn("min-h-0 flex-1 overflow-hidden", mode === "new" && "min-h-40 border-t", mode === "upload" && tab !== "declaration" && "hidden")}>
            <MonacoWorkspace path={`collection-import://${active.operationId}${mode === "upload" ? "-declaration" : ""}.yaml`} transientModels value={mode === "upload" ? active.snippet ?? "" : active.content} readOnly={disabled || active.done} onChange={(value) => patch(mode === "upload" ? { snippet: value } : { content: value })} ariaLabel={`${category === "proxy" ? "代理" : "规则"}集合${mode === "upload" ? "声明" : "文件内容"}`} />
          </div>}
          {(active.error || rowError(active)) && <FieldError className="shrink-0 px-5 py-2">{active.error ?? rowError(active)}</FieldError>}
        </div>
      </div> : <Empty className="py-8"><EmptyHeader><EmptyTitle>选择集合文件</EmptyTitle><EmptyDescription>支持选择、拖拽和多文件上传。</EmptyDescription></EmptyHeader></Empty>}
      <DialogFooter className="m-0 shrink-0 flex-row flex-wrap border-t px-5 py-3">
        {(expectedSource.current?.sha256 !== workspace.snapshot?.sha256 || (workspace.hasExplicitTarget && ["error", "stale"].includes(workspace.identityStatus))) && <Button variant="outline" disabled={disabled} onClick={() => void (async () => {
          try { expectedSource.current = await workspace.adoptLatestSource() ?? workspace.snapshot; setFileError("已采用最新源配置版本，请核对目标后保存") }
          catch { setFileError("源配置读取失败，输入已保留") }
        })()}>采用最新配置版本</Button>}
        <Button variant="outline" disabled={disabled} onClick={() => void close()}>取消</Button><Button disabled={disabled || workspace.writeDisabled || !drafts.some((draft) => !draft.done) || drafts.some((draft) => rowError(draft))} onClick={() => void save()}>{workspace.busy ? "正在保存…" : mode === "new" ? "创建集合" : "保存集合与引用"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function MissingProxyCollectionEditor(props: { item: ManagedProviderItem; workspace: Workspace; onDirtyChange: (dirty: boolean) => void; onCancel: () => void }) {
  return <MissingCollectionEditor {...props} />
}
export function MissingRuleCollectionEditor(props: { item: ManagedProviderItem; workspace: Workspace; onDirtyChange: (dirty: boolean) => void; onCancel: () => void }) {
  return <MissingCollectionEditor {...props} />
}
function MissingCollectionEditor({ item, workspace, onDirtyChange, onCancel }: { item: ManagedProviderItem; workspace: Workspace; onDirtyChange: (dirty: boolean) => void; onCancel: () => void }) {
  const { askConfirm } = useUiState()
  const [draft, setDraft] = useState(() => ({ ...newDraft(), category: item.category, name: item.name,
    snippet: managedProviderDeclarationSnippet(item), groupNames: item.selectedGroups, repair: true }))
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const expectedSource = useRef(workspace.snapshot)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const status = contentStatus(draft.content, item.category)
  const groups = proxyCollectionGroups(workspace.configContent)
  useEffect(() => { onDirtyChange(Boolean(draft.content)); return () => onDirtyChange(false) }, [draft.content, onDirtyChange])
  const readFiles = async (files: File[]) => {
    if (workspace.busy) return
    if (files.length !== 1 || !/\.ya?ml$/i.test(files[0]!.name)) { setError("请选择一个 YAML 集合文件"); return }
    try { const content = await files[0]!.text(); if (mounted.current) { setDraft((current) => ({ ...current, content })); setError(null) } } catch { if (mounted.current) setError("文件读取失败，原输入已保留") }
  }
  return <div className="flex min-h-0 flex-1 flex-col gap-3 p-3" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void readFiles([...event.dataTransfer.files]) }}>
    <Alert><AlertDescription>缺少文件：{item.name}。填写或上传 YAML 后补齐集合。</AlertDescription></Alert>
    {item.category === "proxy" && <GroupFields groups={groups} selected={draft.groupNames} newName={draft.newGroupName} disabled={workspace.busy} onChange={(groupNames, newGroupName) => setDraft((current) => ({ ...current, groupNames, newGroupName }))} />}
    <div className="min-h-36 flex-1 overflow-hidden"><MonacoWorkspace value={draft.content} readOnly={workspace.busy} onChange={(content) => setDraft((current) => ({ ...current, content }))} ariaLabel={`${item.name} 缺失集合 YAML`} /></div>
    <FieldError>{error ?? status.error}</FieldError><div className="flex justify-end gap-2"><input ref={inputRef} className="sr-only" type="file" accept=".yaml,.yml" onChange={(event) => { void readFiles([...(event.target.files ?? [])]); event.target.value = "" }} />
      {workspace.hasExplicitTarget && ["error", "stale"].includes(workspace.identityStatus) && <Button variant="outline" disabled={workspace.busy} onClick={() => void (async () => {
        try {
          const fresh = await workspace.adoptLatestSource()
          if (!fresh) return
          const snippet = latestMissingCollectionDeclaration(draft, fresh)
          expectedSource.current = fresh
          setDraft((current) => ({ ...current, snippet }))
          setError("已采用最新源配置版本和集合路径，输入已保留，请核对后重试")
        } catch (error) { setError(error instanceof Error ? error.message : "源配置读取失败，输入已保留") }
      })()}>采用最新配置版本</Button>}
      <Button variant="outline" disabled={workspace.busy} onClick={() => void (async () => {
        if (!draft.content || await askConfirm({ title: "放弃集合输入？", message: "当前缺失文件输入尚未保存。", confirmLabel: "放弃输入", danger: true })) onCancel()
      })()}>取消</Button>
      <Button variant="outline" disabled={workspace.busy} onClick={() => inputRef.current?.click()}>上传文件</Button>
      <Button disabled={workspace.writeDisabled || !draft.content.trim() || Boolean(status.error) || workspace.dirty} onClick={() => void workspace.importCollections([draft], (_id, config) => {
        expectedSource.current = config
        if (mounted.current) setDraft((current) => ({ ...current, content: "" }))
      }, expectedSource.current ?? undefined, (_id, message) => { if (mounted.current) setError(message) })}>创建文件</Button>
    </div>
  </div>
}
