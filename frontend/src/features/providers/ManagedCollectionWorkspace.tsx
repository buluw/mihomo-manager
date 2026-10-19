import { providerFileIssueLabel } from "../../shared/configMessages.ts";
import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { ArrowLeft, Boxes, ListTree, ShieldCheck, Plus, RefreshCw, Save, Settings2, Trash2, Upload } from "lucide-react"
import {
  type ConfigSnapshot,
} from "@/api/configClient";
import { WorkspaceCategoryTabs, WorkspaceToolbar } from "@/components/patterns/workspace"
import { CollectionBodyWorkspace } from "./CollectionBodyWorkspace"
import { ResourceWorkspace } from "@/components/patterns/resource-workspace"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import type { Notify } from "@/shared/types"
import { collectionEditLocation, configEditLocation, type CollectionTarget } from "@/shared/collectionTarget"
import { useUiState } from "@/app/state/uiState"
import { CollectionResourceList } from "./CollectionResourceList"
import { CollectionActionsMenu } from "./CollectionActionsMenu"
import { CollectionCategoryPicker, CollectionDetailHeader } from "./CollectionMobileNavigation"
import { CollectionSettingsDialog } from "./CollectionSettingsDialog"
import { ProxyCollectionImportDialog } from "./ProxyCollectionImport.tsx"
import { groupsEmptiedByRemoval } from "./managedProviderYaml"
import { managedProviderModificationReason, type ManagedProviderItem } from "./managedProviderModel"
import { CollectionCleanupDialog } from "./CollectionCleanupDialog"
import { providerActionKey, providerItemCount, type ProviderCategory, type ProviderPayload } from "./collectionViewModel"
import type { useManagedProviderWorkspace } from "./useManagedProviderWorkspace"
import type { useProviderCollections } from "./useProviderCollections"

type Workspace = ReturnType<typeof useManagedProviderWorkspace>
type Runtime = ReturnType<typeof useProviderCollections>

export function ManagedCollectionWorkspace({ category, workspace, runtime, notify, inputDirty, onInputDirtyChange, onRefresh, onApplied, target, onCategoryChange }: {
  category: ProviderCategory; workspace: Workspace; runtime: Runtime; notify: Notify
  inputDirty: boolean; onInputDirtyChange: (dirty: boolean) => void; onRefresh: () => Promise<void>
  onApplied: () => Promise<void>
  target: CollectionTarget
  onCategoryChange: (category: ProviderCategory) => boolean
}) {
  const navigate = useNavigate()
  const { askConfirm } = useUiState()
  const focusedTarget = useRef("")
  const [importMode, setImportMode] = useState<"new" | "upload" | null>(null)
  const [settingsTarget, setSettingsTarget] = useState<{ item: ManagedProviderItem; source: Pick<ConfigSnapshot, "name" | "sha256"> } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ManagedProviderItem | null>(null)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [mobileEditing, setMobileEditing] = useState(false)
  const [filePickerId, setFilePickerId] = useState<string | null>(null)
  const items = workspace.items
  useEffect(() => {
    if (filePickerId && !items.some(item => item.id === filePickerId && item.fileIssue === "missing" && !item.sha256)) setFilePickerId(null)
  }, [filePickerId, items])
  const active = workspace.active
  const runtimeBlocked = Boolean((workspace.snapshot || workspace.hasExplicitTarget) && !workspace.runtimePaired)
  const providers = useMemo<Record<string, ProviderPayload>>(() => runtimeBlocked ? {} : runtime.providerMaps[category], [category, runtime.providerMaps, runtimeBlocked])
  const runtimeName = runtimeBlocked ? undefined : runtime.activeNames[category]
  const activeName = active?.name ?? (target.category === category ? target.name : null) ?? runtimeName ?? Object.keys(providers)[0]
  const running = activeName ? providers[activeName] : undefined
  const runtimeBusy = Boolean(activeName && runtime.actions.has(providerActionKey(category, activeName)))
  const ordinary = Boolean(active && (active.access === "inline" || (active.access !== "http" && active.writable)))
  const readOnly = Boolean(active && workspace.readOnlyFor(active))
  const editable = ordinary && !readOnly && !workspace.writeDisabled
  const entries = useMemo<Array<[string, ProviderPayload]>>(() => workspace.snapshot
    ? items.map((item) => [item.name, providers[item.name] ?? { vehicleType: item.declaration?.type ?? "file" }])
    : Object.entries(providers), [items, providers, workspace.snapshot])
  const writableNames = new Set(items.filter((item) => item.access !== "http" && item.writable && !workspace.readOnlyFor(item)).map((item) => item.name))
  const mergedNames = new Set(items.filter((item) => item.access === "local").map((item) => item.name))
  const descriptions = Object.fromEntries(items.map(item => [item.name, `${item.access === "inline" ? "Inline" : item.access === "http" ? "HTTP" : "File"} · ${typeof item.declaration?.path === "string" ? item.declaration.path : item.referencePath ?? item.name}`]))
  const ordinaryFileStatus = (item: ManagedProviderItem, status: string) => (item.access === "http" || !item.writable || workspace.readOnlyFor(item)) && !item.fileIssue ? "只读" : status
  const statuses = Object.fromEntries(items.map((item) => {
    const provider = providers[item.name]
    const status = item.pendingRemoval ? "待移除" : workspace.itemOperationPending(item) ? "未保存" : item.fileIssue ? providerFileIssueLabel(item.fileIssue) : runtimeBlocked ? "待应用" : !provider ? "待应用" : `运行 ${providerItemCount(category, provider)} ${category === "proxy" ? "个节点" : "条规则"}`
    return [item.name, ordinaryFileStatus(item, status)]
  }))
  useEffect(() => {
    if (active && !active.fileIssue) void workspace.select(active)
  }, [active, workspace.select])
  useEffect(() => { setMobileEditing(false) }, [category])
  useEffect(() => {
    if (!target.name || target.category !== category || workspace.identityStatus !== "ready") return
    const key = `${target.source?.name}:${category}:${target.name}`
    if (focusedTarget.current === key) return
    const item = items.find((item) => item.name === target.name)
    if (!item) return
    focusedTarget.current = key
    void workspace.select(item)
    setMobileEditing(true)
  }, [category, items, target.name, target.category, target.repair, target.source?.name, workspace.identityStatus, workspace.select])
  const select = (name: string, open = false) => {
    if (inputDirty) { notify("请先保存或取消集合输入", "error"); return }
    const item = items.find((item) => item.name === name)
    if (item) void workspace.select(item)
    if (item && target.source && workspace.snapshot) {
      focusedTarget.current = [workspace.snapshot.name, category, item.name].join(":")
      const destination = collectionEditLocation(workspace.snapshot, { category, name: item.name })
      navigate(destination.pathname, { state: destination.state, replace: true })
    }
    if (!runtimeBlocked) runtime.selectProvider(category, name)
    if (open) setMobileEditing(true)
  }
  const list = (mobile = false) => <CollectionResourceList category={category} entries={entries} activeName={activeName}
    loading={workspace.loading} error={!workspace.snapshot ? workspace.message : undefined}
    onSelect={(name) => select(name, mobile)} writableNames={writableNames}
    mergedNames={mergedNames} descriptions={descriptions} statuses={statuses} />
  const applyConfig = () => void workspace.apply().then((result) => { if (result) void onApplied() })
  const runRuntimeAction = async (action: () => Promise<unknown>) => {
    if (runtimeBlocked) return
    try { await workspace.verifyRuntimeSource(); await action() }
    catch (error) { notify(error instanceof Error ? error.message : "运行集合来源无法确认", "error") }
  }
  const update = async () => {
    if (!activeName || !running) return
    await runRuntimeAction(async () => {
      const updated = await runtime.updateProvider(category, activeName)
      if (updated && active && !inputDirty) await workspace.refreshItem(active)
    })
  }
  const updateAll = async () => {
    await runRuntimeAction(async () => {
      await runtime.updateAllProviders(category)
      if (!workspace.dirty && !inputDirty) await workspace.refresh()
    })
  }
  const validate = () => workspace.validate()
  const inputBlocked = workspace.writeDisabled || inputDirty || Boolean(workspace.configContentError)
  const cleanupBlocked = workspace.busy || workspace.loading || workspace.dirty || inputDirty
  const emptiedGroups = useMemo(() => {
    try { return deleteTarget ? groupsEmptiedByRemoval(workspace.configContent, deleteTarget) : [] }
    catch { return [] } // The mutation reports an invalid YAML candidate before any write.
  }, [deleteTarget, workspace.configContent])
  const pathChange = active && workspace.snapshot?.collectionPathChanges?.find((change) => change.category === active.category && change.name === active.name)
  const openSettings = () => {
    if (active && workspace.snapshot) setSettingsTarget({ item: structuredClone(active), source: { name: workspace.snapshot.name, sha256: workspace.snapshot.sha256 } })
  }
  const removeReason = !active ? "未选择集合" : workspace.writeDisabled ? workspace.message
    : inputDirty ? "请先完成当前输入" : managedProviderModificationReason(active)
  const discard = async () => {
    if (await askConfirm({ title: "放弃全部草稿？", message: "恢复当前源配置及全部集合的已保存内容。", confirmLabel: "放弃全部草稿", cancelLabel: "继续编辑", danger: true })) workspace.discardDrafts()
  }
  const fileEditable = Boolean(active && ordinary && !readOnly && active.declaration?.type === "file")
  const missingFile = Boolean(fileEditable && active?.fileIssue === "missing" && !active.sha256)
  const pickingFile = Boolean(missingFile && (filePickerId === active?.id || !workspace.contentReady))
  const fileBack = missingFile && !pickingFile && <Button variant="outline" size="lg" aria-label="返回文件选择" title="返回文件选择，保留草稿" disabled={workspace.busy} onClick={() => active && setFilePickerId(active.id)}><ArrowLeft data-icon="inline-start" /><span className="hidden md:inline">返回</span></Button>
  const createAction = { label: "新建", icon: Plus, disabled: inputBlocked, onSelect: () => setImportMode("new") }
  const importActions = [
    { label: "上传", icon: Upload, disabled: inputBlocked, onSelect: () => setImportMode("upload") },
    { label: "清理文件", icon: Trash2, disabled: cleanupBlocked, onSelect: () => setCleanupOpen(true) },
  ]
  const moreMenu = <CollectionActionsMenu description={removeReason ?? undefined} groups={[
    [
      { ...createAction, visibility: "mobile" },
      ...importActions,
    ],
    [
      { label: "设置", icon: Settings2, visibility: "mobile", disabled: !active?.declared || inputBlocked, onSelect: openSettings },
      ...(missingFile && !pickingFile ? [{ label: "返回文件选择", icon: ArrowLeft, visibility: "mobile" as const, disabled: workspace.busy, onSelect: () => active && setFilePickerId(active.id) }] : []),
      ...(pathChange ? [
        { label: "同步重命名", disabled: inputBlocked, onSelect: () => active && void workspace.recoverPath(active, "rename") },
        { label: "恢复原路径", disabled: inputBlocked, onSelect: () => active && void workspace.recoverPath(active, "restore") },
      ] : []),
    ],
    [
      { label: "重新读取", icon: RefreshCw, visibility: "desktop", disabled: workspace.loading, onSelect: () => void onRefresh() },
      { label: "更新当前", icon: RefreshCw, disabled: !running || runtimeBusy, onSelect: () => void update() },
      { label: "全部更新", icon: RefreshCw, disabled: Boolean(runtime.batchProgress) || !Object.keys(providers).length, onSelect: () => void updateAll() },
    ],
    [
      ...(ordinary && active ? [{ label: "只读", visibility: "mobile" as const, checked: readOnly, disabled: workspace.writeDisabled || workspace.contentDirty, onSelect: () => void workspace.setReadOnly(active, !readOnly) }] : []),
      ...(workspace.dirty ? [{ label: "放弃全部草稿", disabled: workspace.busy || inputDirty, destructive: true, onSelect: () => void discard() }] : []),
      ...(target.source ? [
        { label: "返回编辑配置", disabled: workspace.busy || inputDirty, onSelect: () => { const destination = configEditLocation(workspace.snapshot ?? target.source!); navigate(destination.pathname, { state: destination.state }) } },
        { label: "结束编辑目标", disabled: workspace.busy || inputDirty, onSelect: () => navigate("/collections") },
      ] : []),
      { label: "删除集合", icon: Trash2, destructive: true, disabled: removeReason !== null, onSelect: () => setDeleteTarget(active) },
    ],
  ]} />
  const toolbar = <>
    <CollectionDetailHeader title={activeName ?? "集合管理"} onBack={() => setMobileEditing(false)} disabled={workspace.busy || inputDirty} />
    <WorkspaceToolbar variant="resource-editor" className="max-md:min-h-14 max-md:px-3 max-md:py-1">
      <div className="mr-auto md:hidden">{moreMenu}</div>
      <div className="hidden min-w-0 flex-1 items-center gap-2 md:flex">
        <span className="hidden truncate text-sm font-medium md:inline">{workspace.snapshot?.name ?? target.source?.name ?? "来源未确认"}</span>
        <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">{workspace.dirty ? "未保存" : workspace.savedPending ? "待应用" : "源配置"}</span>
      </div>
      <span className="hidden text-xs text-muted-foreground md:block">全部集合 · {workspace.itemsByCategory.proxy.length + workspace.itemsByCategory.rule.length}</span>
      <div className="flex shrink-0 items-center gap-2" aria-label="配置及全部集合统一操作">
        <Button variant="outline" size="lg" className="md:hidden" disabled={workspace.loading} onClick={() => void onRefresh()}>重载</Button>
        <Button variant="outline" size="lg" disabled={workspace.writeDisabled || inputDirty} onClick={validate}><ShieldCheck className="hidden md:block" data-icon="inline-start" />校验</Button>
        <Button variant="outline" size="lg" aria-label="保存配置" disabled={workspace.writeDisabled || inputDirty} onClick={() => void workspace.saveConfigDraft()}>{workspace.busy ? <Spinner data-icon="inline-start" /> : <Save className="hidden md:block" data-icon="inline-start" />}<span>保存<span className="hidden md:inline">配置</span></span></Button>
        <Button size="lg" aria-label="应用配置" disabled={workspace.writeDisabled || inputDirty} onClick={applyConfig}><span>应用<span className="hidden md:inline">配置</span></span></Button>
      </div>
    </WorkspaceToolbar>
  </>
  const detailToolbar = <WorkspaceToolbar variant="editor" className="hidden md:flex">
    {fileBack}<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{activeName ?? "未选择集合"}</span>
    {ordinary && active && <label className="flex shrink-0 items-center gap-1.5 text-xs"><Checkbox aria-label="只读" checked={readOnly} disabled={workspace.writeDisabled || workspace.contentDirty} onCheckedChange={checked => void workspace.setReadOnly(active, checked === true)} />只读</label>}
    <Button variant="outline" size="lg" disabled={inputBlocked} onClick={() => setImportMode("new")}><Plus data-icon="inline-start" />新建</Button>
    <Button variant="outline" size="icon-lg" aria-label="集合设置" disabled={!active?.declared || inputBlocked} onClick={openSettings}><Settings2 /></Button>{moreMenu}
  </WorkspaceToolbar>
  const categoryTabs = <WorkspaceCategoryTabs layout="list" value={category} onValueChange={value => onCategoryChange(value as ProviderCategory)} disabled={workspace.busy || inputDirty} items={[{ value: "proxy", label: "代理集合", icon: Boxes }, { value: "rule", label: "规则集合", icon: ListTree }]} />
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex min-h-0 flex-1">
      <ResourceWorkspace idPrefix="collection" resources={list()} resourcesHeader={categoryTabs} toolbar={toolbar}
        mobileResources={<div className="flex h-full min-h-0 flex-col">
          <CollectionCategoryPicker category={category} count={entries.length} disabled={workspace.busy || inputDirty} actions={<CollectionActionsMenu groups={[[createAction, ...importActions]]} />} onChoose={onCategoryChange} />
          <div className="min-h-0 flex-1">{list(true)}</div>
        </div>}
        mobileNavigation={{ detailOpen: mobileEditing }}
        resizeHandleLabel="调整集合列表宽度">
        {() => <section className="@container/collection flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
            {detailToolbar}
            {workspace.identityStatus !== "ready" && !(workspace.identityStatus === "loading" && workspace.snapshot) &&
              <Alert className="shrink-0 rounded-none"><AlertDescription className="flex flex-wrap items-center gap-2"><span>{workspace.message}</span>
                {target.source && <Button variant="outline" size="sm" disabled={workspace.busy || inputDirty} onClick={() => void (async () => {
                  if (workspace.dirty && !await askConfirm({ title: "采用最新编辑版本？", message: "当前集合草稿将撤销；目标配置保持不变。", confirmLabel: "采用最新版本", danger: true })) return
                  try { await workspace.adoptLatestSource() } catch { notify("无法读取当前编辑目标，输入已保留", "error") }
                })()}>采用最新编辑版本</Button>}
              </AlertDescription></Alert>}
            {runtime.loadErrors[category] && <Alert className="shrink-0 rounded-none"><AlertDescription>Controller 运行状态读取失败；磁盘草稿保留。</AlertDescription></Alert>}
            {runtimeBlocked && <Alert className="shrink-0 rounded-none py-2"><AlertDescription>编辑来源：{workspace.snapshot?.name ?? target.source?.name ?? "未知"}；最近成功加载：{workspace.runtimeSource?.name ?? "未知"}</AlertDescription></Alert>}
            {workspace.contentError && <Alert variant="destructive" className="shrink-0 rounded-none"><AlertDescription className="flex flex-wrap items-center gap-2"><span>{workspace.contentError}</span>
              {workspace.contentReadError && <>
                <Button variant="outline" size="sm" disabled={Boolean(workspace.contentRetryBlockedReason)} onClick={() => void workspace.retryContent()}>重试读取当前集合</Button>
                {workspace.contentRetryBlockedReason && <span>{workspace.contentRetryBlockedReason}</span>}
              </>}
            </AlertDescription></Alert>}
            {workspace.configContentError && <Alert variant="destructive" className="shrink-0 rounded-none"><AlertDescription>{workspace.configContentError}</AlertDescription></Alert>}
            {workspace.applyError && <Alert variant="destructive" className="shrink-0 rounded-none"><AlertDescription>{workspace.applyError}</AlertDescription></Alert>}
            {active ? <CollectionBodyWorkspace key={workspace.snapshot?.name + ":" + active.id} workspace={workspace} item={active} editable={editable} pickerOpen={filePickerId === active.id} onPickerChange={open => setFilePickerId(open ? active.id : null)} /> : <Empty className="min-h-0 flex-1"><EmptyHeader><EmptyTitle>{target.name && workspace.identityStatus === "ready" ? "指定集合不存在" : "未选择可读取的源集合"}</EmptyTitle><EmptyDescription>{target.name && workspace.identityStatus === "ready" ? "请在当前配置中重新选择集合。" : "来源未确认时保留可用的 Controller 更新操作。"}</EmptyDescription></EmptyHeader></Empty>}
          </section>}
      </ResourceWorkspace>
    </div>
    {importMode && <ProxyCollectionImportDialog mode={importMode} category={category} onClose={() => setImportMode(null)} onStaged={() => setMobileEditing(true)} workspace={workspace} onDirtyChange={onInputDirtyChange} />}
    {settingsTarget && <CollectionSettingsDialog item={settingsTarget.item} source={settingsTarget.source} workspace={workspace} onClose={() => setSettingsTarget(null)} onDirtyChange={onInputDirtyChange} />}
    {cleanupOpen && <CollectionCleanupDialog category={category} onClose={() => setCleanupOpen(false)} onDone={() => workspace.refresh(true, true)} onBusyChange={onInputDirtyChange} notify={notify} />}
    <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !workspace.busy) setDeleteTarget(null) }}><AlertDialogContent><AlertDialogHeader>
      <AlertDialogTitle>删除集合 {deleteTarget?.name}？</AlertDialogTitle><AlertDialogDescription>配置：{workspace.snapshot?.name}。受影响代理组：{deleteTarget?.selectedGroups.join("、") || "无"}。{deleteTarget?.access === "inline" || deleteTarget?.access === "http" ? "移除集合声明和当前配置引用。" : "移除当前配置的集合声明和引用；成功应用后清理属于管理器且不再依赖的文件，其余文件保留。"}完成后使用“应用配置”加载变更。</AlertDialogDescription>
    </AlertDialogHeader>
      {emptiedGroups.length > 0 && <Alert variant="destructive"><AlertDescription>删除会使以下代理组失去所有来源：{emptiedGroups.join("、")}。保存允许保留草稿，应用前请补充这些组的来源。</AlertDescription></Alert>}
      <AlertDialogFooter><AlertDialogCancel disabled={workspace.busy}>取消</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={workspace.writeDisabled || workspace.busy} onClick={() => {
      const target = deleteTarget; setDeleteTarget(null); void workspace.remove(target)
    }}>{workspace.busy && <Spinner data-icon="inline-start" />}删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>
}
