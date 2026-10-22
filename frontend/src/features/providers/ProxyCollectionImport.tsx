import { useEffect, useMemo, useRef, useState } from "react"
import { Upload } from "lucide-react"
import { useUiState } from "@/app/state/uiState"
import { MonacoWorkspace } from "@/components/patterns/monaco-workspace"
import { StatusBadge } from "@/components/patterns/status-badge"
import { Button } from "@/components/ui/button"
import { WorkspaceToolbar } from "@/components/patterns/workspace"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { CollectionCategory } from "@/api/configClient"
import { CollectionGroupChoices } from "./CollectionGroupChoices"
import { cn } from "@/lib/utils"
import { managedProviderDeclarationSnippet, type ManagedProviderItem } from "./managedProviderModel"
import type { useManagedProviderWorkspace } from "./useManagedProviderWorkspace"
import { CollectionHttpFields } from "./CollectionHttpFields"
import { assertCollectionPathAvailable, collectionFileName, patchCollectionIdentity, suggestedCollectionFileName } from "./collectionNaming"
import { collectionShouldReference, collectionUploadMatches, collectionUploadTargets, createCollectionDraft, patchUploadDeclaration, readUploadDeclaration, proxyCollectionGroups, type CollectionDraftInput } from "./proxyCollectionImport"

type Workspace = ReturnType<typeof useManagedProviderWorkspace>
type CollectionType = "file" | "inline" | "http"
type ImportDraft = CollectionDraftInput & { uploadName: string; target: string; targetName?: string; defaultSnippet?: string; policy: string; done?: boolean; error?: string; groupNameInput?: string }

function newDraft(): ImportDraft {
  const operationId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("")
  return { operationId, name: "", content: "", groupNames: [], newGroupNames: [], uploadName: "", target: "new", behavior: "classical", policy: "DIRECT" }
}

function targetFields(item: ManagedProviderItem | undefined): Partial<ImportDraft> {
  return { repair: item?.fileIssue === "missing", replace: Boolean(item && item.fileIssue !== "missing"),
    targetName: item?.name,
    targetFileName: item?.fileName ?? undefined, expectedFileSha256: item?.sha256 ?? undefined,
    groupNames: item?.selectedGroups ?? [], newGroupNames: [], behavior: String(item?.declaration?.behavior ?? "classical") }
}

export function CollectionCreateWorkspace({ mode: initialMode, category = "proxy", onClose, onStaged, workspace, onDirtyChange }: {
  mode: "new" | "upload"; category?: CollectionCategory; onClose: () => void; onStaged?: () => void; workspace: Workspace; onDirtyChange: (dirty: boolean) => void
}) {
  const { askConfirm } = useUiState()
  const [mode, setMode] = useState(initialMode)
  const [createDrafts, setCreateDrafts] = useState<ImportDraft[]>(() => [{ ...newDraft(), content: category === "proxy" ? "proxies: []\n" : "payload: []\n" }])
  const [uploadDrafts, setUploadDrafts] = useState<ImportDraft[]>([])
  const drafts = mode === "new" ? createDrafts : uploadDrafts
  const setDrafts = mode === "new" ? setCreateDrafts : setUploadDrafts
  const [activeId, setActiveId] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [collectionType, setCollectionType] = useState<CollectionType>("file")
  const [url, setUrl] = useState("")
  const [interval, setInterval] = useState(0)
  const [intervalValid, setIntervalValid] = useState(true)
  const [fileName, setFileName] = useState<string | null>(null)
  const [tab, setTab] = useState("settings")
  const [editorTab, setEditorTab] = useState("content")
  const [dragging, setDragging] = useState(false)
  const expectedSource = useRef(workspace.snapshot)
  const mounted = useRef(true)
  const readRequest = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readRequest.current?.abort() } }, [])
  const groups = useMemo(() => proxyCollectionGroups(workspace.configContent), [workspace.configContent])
  const active = drafts.find((draft) => draft.operationId === activeId) ?? drafts[0]
  const groupPending = drafts.some(draft => Boolean(draft.groupNameInput))
  const targets = collectionUploadTargets(workspace.items, category)
  const dirty = groupPending || (mode === "upload" ? drafts.some((draft) => !draft.done) : Boolean(url || interval || fileName !== null || collectionType !== "file" || active && (
    (active.content !== (category === "proxy" ? "proxies: []\n" : "payload: []\n")) || active.name || active.groupNames.length || active.newGroupNames?.length || active.behavior !== "classical" || active.policy !== "DIRECT")))
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
          name: target?.name ?? name, target: target ? target.id : "new" }
      }))
      if (mounted.current) { setDrafts((current) => [...current, ...next]); setActiveId(next[0]!.operationId) }
    } catch { if (mounted.current) setFileError("文件读取失败，原输入已保留") }
    finally { if (mounted.current) setReading(false); if (readRequest.current === request) readRequest.current = null }
  }
  const inputFor = (draft: ImportDraft): CollectionDraftInput => ({
    operationId: draft.operationId, category, name: draft.targetName ?? draft.name.trim(), content: draft.content, snippet: draft.snippet,
    groupNames: draft.groupNames, newGroupNames: draft.newGroupNames, repair: draft.repair, replace: draft.replace,
    targetFileName: draft.targetFileName, expectedFileSha256: draft.expectedFileSha256, behavior: draft.behavior, format: "yaml", interval,
    ...(category === "rule" && draft.target === "new" && draft.policy !== "none" ? { ruleSetRules: [`RULE-SET,${draft.name.trim()},${draft.policy}`] } : {}),
  })
  const rowError = (draft: ImportDraft) => {
    if (draft.done) return null
    if (!draft.target) return "请选择目标集合；无精确匹配或存在歧义时需要手动选择"
    if (drafts.some((other) => other !== draft && (other.name.trim() === draft.name.trim() ||
      (draft.targetFileName && other.targetFileName === draft.targetFileName) || (draft.target !== "new" && other.target === draft.target)))) return "多份文件不能对应同一集合文件"
    if (collectionType === "file" && draft.target === "new" && !collectionShouldReference(workspace.configContent, inputFor(draft), category)) {
      try {
        if (!draft.name.trim()) return "请填写集合名称"
        const name = mode === "upload" ? String(readUploadDeclaration(draft.snippet ?? "", category).declaration.path).split(/[\\/]/).at(-1)! : fileName ?? suggestedCollectionFileName(draft.name)
        collectionFileName(name)
        if (workspace.files.some(file => file.category === category && file.fileName.toLowerCase() === name.toLowerCase())) return "文件名已存在"
      } catch (error) { return (error as Error).message }
      return null
    }
    if (mode === "upload") {
      let declaration: ReturnType<typeof readUploadDeclaration>
      try { declaration = readUploadDeclaration(draft.snippet ?? "", category) } catch (error) { return (error as Error).message }
      if (drafts.some((other) => other !== draft && other.snippet && (() => {
        try { return readUploadDeclaration(other.snippet, category).declaration.path === declaration.declaration.path } catch { return false }
      })())) return "多份文件不能对应同一集合文件"
      if (draft.target !== "new") {
        if (!targets.some((item) => item.id === draft.target)) return "目标不可替换，请重新选择"
        if (workspace.items.some((item) => item.name === declaration.name && item.id !== draft.target) ||
          (category === "proxy" && groups.some((group) => group.name === declaration.name))) return "集合名称已存在"
        return null
      }
      try {
        assertCollectionPathAvailable(workspace.configContent, category, String(declaration.declaration.path))
        createCollectionDraft(workspace.configContent, { ...inputFor(draft), name: declaration.name }, "file", "", category, String(declaration.declaration.path), declaration.declaration)
      }
      catch (error) { return (error as Error).message }
      return null
    }
    try {
      const path = collectionType === "inline" ? undefined : (collectionType === "http" ? "./" + (category === "proxy" ? "providers/" : "ruleset/") : "./") + collectionFileName(fileName ?? suggestedCollectionFileName(draft.name))
      if (path) assertCollectionPathAvailable(workspace.configContent, category, path)
      createCollectionDraft(workspace.configContent, inputFor(draft), collectionType, url, category, path)
    } catch (error) { return error instanceof Error ? error.message : "请检查集合设置" }
    if (collectionType === "http" && !intervalValid) return "请填写有效的更新周期"
    return null
  }
  const save = async () => {
    if (disabled || workspace.writeDisabled || groupPending || drafts.some((draft) => rowError(draft))) return
    if (mode === "new" && active) {
      if (await workspace.createDeclaredCollection({ ...inputFor(active), targetFileName: undefined }, collectionType, url, category, fileName ?? suggestedCollectionFileName(active.name))) { onStaged?.(); onClose() }
      return
    }
    const pending = drafts.filter((draft) => !draft.done)
    if (pending.some((draft) => draft.replace) && !(await askConfirm({ title: "确认替换已有 File 集合？",
      message: "将替换所选普通 File 的正文。内容先进入当前配置草稿，统一保存或应用时发布。", confirmLabel: "确认替换", cancelLabel: "继续编辑", danger: true }))) return
    const saved = await workspace.importCollections(pending.map(inputFor), (id, config) => {
      expectedSource.current = config
      setDrafts((current) => current.map((draft) => draft.operationId === id ? { ...draft, done: true, error: undefined } : draft))
    }, expectedSource.current ?? undefined, (id, error) => {
      setDrafts((current) => current.map((draft) => draft.operationId === id ? { ...draft, error } : draft))
      setActiveId(id)
    })
    if (saved && mounted.current) { onStaged?.(); onClose() }
  }
  const close = async () => {
    if (disabled) return
    if (!dirty || await askConfirm({ title: "放弃未保存的修改？", message: "未确认的集合输入将被丢弃，已确认的共享草稿继续保留。", confirmLabel: "放弃修改", cancelLabel: "继续编辑", danger: true })) onClose()
  }
  const existing = active?.target !== "new" ? targets.find((item) => item.id === active?.target) : undefined
  let uploadPath: string | null = null
  if (mode === "upload" && active?.snippet) {
    try { uploadPath = String(readUploadDeclaration(active.snippet, category).declaration.path) } catch { /* Keep declaration edits available. */ }
  }
  return <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label="新增集合工作区">
    <WorkspaceToolbar variant="resource-editor">
      <span className="min-w-0 flex-1 truncate text-sm">新增{category === "proxy" ? "代理" : "规则"}集合</span>
      <Tabs className="md:hidden" value={tab} onValueChange={setTab}><TabsList><TabsTrigger value="settings">设置</TabsTrigger><TabsTrigger value="content">内容</TabsTrigger></TabsList></Tabs>
      <Button variant="outline" disabled={disabled} onClick={() => void close()}>取消</Button>
      <Button disabled={disabled || workspace.writeDisabled || groupPending || !drafts.some(draft => !draft.done) || drafts.some(draft => rowError(draft))} onClick={() => void save()}>确认</Button>
    </WorkspaceToolbar>
    <input ref={inputRef} type="file" accept=".yaml,.yml" multiple className="sr-only" aria-label="选择上传的集合文件" disabled={disabled} onChange={event => { void readFiles([...(event.target.files ?? [])]); event.target.value = "" }} />
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className={cn("min-h-0 w-full shrink-0 flex-col border-r md:flex md:w-[320px] lg:w-[360px]", tab === "settings" ? "flex" : "hidden")}>
        <WorkspaceToolbar variant="editor"><span className="text-sm">集合设置</span><span className="ml-auto truncate text-xs text-muted-foreground">{workspace.snapshot?.name}</span></WorkspaceToolbar>
        <div className="min-h-0 flex-1 overflow-y-auto p-5"><FieldGroup>
          <Field><FieldLabel>集合类型</FieldLabel><Select value={collectionType} disabled={disabled} onValueChange={value => { if (value === "file" || value === "inline" || value === "http") { setCollectionType(value); if (value !== "file") setMode("new") } }}><SelectTrigger aria-label="集合类型" className="w-full"><SelectValue>{collectionType === "file" ? "文件 File" : collectionType === "inline" ? "内嵌 Inline" : "在线 HTTP"}</SelectValue></SelectTrigger><SelectContent><SelectGroup><SelectItem value="inline">内嵌 Inline</SelectItem><SelectItem value="file">文件 File</SelectItem><SelectItem value="http">在线 HTTP</SelectItem></SelectGroup></SelectContent></Select></Field>
          {collectionType === "file" && <Tabs value={mode} onValueChange={value => { if (value === "new" || value === "upload") setMode(value) }}><TabsList className="w-full" aria-label="文件添加方式"><TabsTrigger value="new">新建文件</TabsTrigger><TabsTrigger value="upload">上传文件</TabsTrigger></TabsList></Tabs>}
          {mode === "upload" && <Field><Button variant="outline" disabled={disabled} onClick={() => inputRef.current?.click()}><Upload data-icon="inline-start" />选择文件</Button><FieldDescription>支持拖拽及多文件上传。</FieldDescription>
            {drafts.map(draft => <Button key={draft.operationId} variant={draft === active ? "secondary" : "ghost"} className="w-full justify-start" onClick={() => setActiveId(draft.operationId)}><span className="min-w-0 flex-1 truncate text-left">{draft.uploadName}</span><StatusBadge status={draft.error || rowError(draft) ? "error" : "info"}>{draft.done ? "已加入" : draft.error || rowError(draft) ? "待完善" : "待加入"}</StatusBadge></Button>)}
          </Field>}
          {active && <>
            {mode === "upload" && <Field><FieldLabel>目标集合</FieldLabel><Select value={active.target || null} disabled={disabled || active.done} onValueChange={chooseTarget}><SelectTrigger aria-label="目标集合" className="w-full"><SelectValue>{active.target === "new" ? "新建 File 集合" : existing?.name ?? "选择目标集合"}</SelectValue></SelectTrigger><SelectContent><SelectGroup><SelectItem value="new">新建 File 集合</SelectItem>{targets.map(item => <SelectItem key={item.id} value={item.id}>{item.name} · {item.fileIssue === "missing" ? "缺少文件" : "替换普通 File"}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>}
            <Field><FieldLabel htmlFor="collection-name">集合名称</FieldLabel><Input id="collection-name" value={active.name} disabled={disabled || active.done} onChange={event => patch({ name: event.target.value })} /></Field>
            {collectionType !== "inline" && <Field><FieldLabel htmlFor="collection-filename">{collectionType === "http" ? "缓存文件名" : "文件名"}</FieldLabel><Input id="collection-filename" value={mode === "new" ? fileName ?? suggestedCollectionFileName(active.name) : uploadPath?.split(/[\\/]/).at(-1) ?? ""} disabled={disabled || active.done || (mode === "upload" && uploadPath === null)} onChange={event => {
              if (/[\\/]/.test(event.target.value)) return
              if (mode === "new") setFileName(event.target.value)
              else if (uploadPath !== null) patch({ snippet: patchCollectionIdentity(active.snippet ?? "", { path: (uploadPath.replace(/[^/]*$/, "") || "./") + event.target.value }) })
            }} /></Field>}
            {collectionType === "http" && <><Field><FieldLabel htmlFor="collection-url">HTTP 地址</FieldLabel><Input id="collection-url" value={url} disabled={disabled} onChange={event => setUrl(event.target.value)} /></Field><CollectionHttpFields interval={interval} disabled={disabled} onChange={setInterval} onValidChange={setIntervalValid} /></>}
            {existing ? <Field><FieldLabel>现有引用</FieldLabel><FieldDescription>{category === "proxy" ? existing.selectedGroups.join("、") || "未被代理组使用" : existing.ruleSetRules.join("；") || "暂无规则引用"}</FieldDescription></Field>
              : category === "proxy" ? <CollectionGroupChoices key={active.operationId} content={workspace.configContent} collectionName={active.name} selected={active.groupNames} newGroups={active.newGroupNames ?? []} pendingName={active.groupNameInput ?? ""} disabled={disabled || active.done} onPendingNameChange={groupNameInput => patch({ groupNameInput })} onChange={(groupNames, newGroupNames) => patch({ groupNames, newGroupNames })} />
              : <><Field><FieldLabel>规则行为</FieldLabel><Select value={active.behavior} disabled={disabled || active.done} onValueChange={value => value && patch({ behavior: value })}><SelectTrigger aria-label="规则行为"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{["classical", "domain", "ipcidr"].map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field><FieldLabel>匹配后去向</FieldLabel><Select value={active.policy} disabled={disabled || active.done} onValueChange={value => value && patch({ policy: value })}><SelectTrigger aria-label="匹配后去向"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{[...(collectionType === "file" ? ["none"] : []), "DIRECT", ...groups.map(group => group.name).filter(name => name !== "DIRECT")].map(value => <SelectItem key={value} value={value}>{value === "none" ? "仅添加文件" : value}</SelectItem>)}</SelectGroup></SelectContent></Select></Field></>}
            {(active.error || rowError(active)) && <FieldError>{active.error ?? rowError(active)}</FieldError>}
          </>}
          {fileError && <FieldError>{fileError}</FieldError>}
          <FieldDescription>加入当前源配置的共享草稿，再统一保存或应用。</FieldDescription>
        </FieldGroup></div>
      </div>
      <div className={cn("relative min-h-0 min-w-0 flex-1 flex-col md:flex", tab === "content" ? "flex" : "hidden")} onDragOver={event => { if (mode === "upload" && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true) } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }} onDrop={event => { if (mode === "upload") { event.preventDefault(); setDragging(false); void readFiles([...event.dataTransfer.files]) } }}>
        <WorkspaceToolbar variant="editor"><span className="min-w-0 flex-1 truncate text-sm">{collectionType === "http" ? "在线内容" : active?.uploadName || "集合内容"}</span>{mode === "upload" && active && <Tabs value={editorTab} onValueChange={setEditorTab}><TabsList variant="line"><TabsTrigger value="content">内容</TabsTrigger><TabsTrigger value="declaration">集合声明</TabsTrigger></TabsList></Tabs>}</WorkspaceToolbar>
        {collectionType === "http" ? <Empty className="flex-1"><EmptyHeader><EmptyTitle>在线内容由 Core 更新获取</EmptyTitle><EmptyDescription>填写 HTTP 地址与更新周期。</EmptyDescription></EmptyHeader></Empty>
          : !active ? <div className="min-h-0 flex-1 p-4"><Empty className="h-full border-2 border-dashed"><EmptyHeader><EmptyTitle>{dragging ? "松开以读取文件" : "拖拽 YAML 文件到这里"}</EmptyTitle><EmptyDescription>支持多文件，读取后可继续编辑。</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => inputRef.current?.click()}><Upload data-icon="inline-start" />选择文件</Button></Empty></div>
          : <div className="min-h-0 flex-1"><MonacoWorkspace path={"collection-import://" + active.operationId + "/" + editorTab + ".yaml"} transientModels value={mode === "upload" && editorTab === "declaration" ? active.snippet ?? "" : active.content} readOnly={disabled || active.done} onChange={value => patch(mode === "upload" && editorTab === "declaration" ? { snippet: value } : { content: value })} ariaLabel={mode === "upload" && editorTab === "declaration" ? "上传集合声明" : "新增集合内容"} /></div>}
      </div>
    </div>
  </section>
}
