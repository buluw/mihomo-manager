import { providerFileIssueLabel } from "../../shared/configMessages.ts";
import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, Boxes, ListTree, ShieldCheck, FolderOpen, RefreshCw, Save, Settings2 } from "lucide-react"
import {
  type ConfigSnapshot,
} from "@/api/configClient";
import { WorkspaceCategoryTabs, WorkspaceToolbar } from "@/components/patterns/workspace"
import { CollectionBodyWorkspace } from "./CollectionBodyWorkspace"
import { ResourceWorkspace } from "@/components/patterns/resource-workspace"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import type { Notify } from "@/shared/types"
import type { CollectionTarget, CollectionWorkspaceNavigation } from "@/shared/collectionTarget"
import { useUiState } from "@/app/state/uiState"
import { CollectionResourceList } from "./CollectionResourceList"
import { CollectionActionsMenu } from "./CollectionActionsMenu"
import { CollectionCategoryPicker } from "./CollectionMobileNavigation"
import { CollectionSettingsDialog } from "./CollectionSettingsDialog"
import { CollectionCreateWorkspace } from "./ProxyCollectionImport.tsx"
import { managedProviderBodyWritable, type ManagedProviderItem } from "./managedProviderModel"
import { cn } from "@/lib/utils"
import { CollectionFileManager } from "./CollectionFileManager"
import { collectionSourceLabel } from "./collectionFileManagement"
import { CollectionCleanupDialog } from "./CollectionCleanupDialog"
import { providerActionKey, providerItemCount, type ProviderCategory, type ProviderPayload } from "./collectionViewModel"
import type { useManagedProviderWorkspace } from "./useManagedProviderWorkspace"
import type { useProviderCollections } from "./useProviderCollections"

type Workspace = ReturnType<typeof useManagedProviderWorkspace>
type Runtime = ReturnType<typeof useProviderCollections>

export function ManagedCollectionWorkspace({ category, workspace, runtime, notify, inputDirty, onInputDirtyChange, onRefresh, onApplied, target, navigation, discardInputVersion, onCategoryChange, onSelectCollection, onOpenManagement, onBack, onReturnConfig, onEndTarget }: {
  category: ProviderCategory; workspace: Workspace; runtime: Runtime; notify: Notify
  inputDirty: boolean; onInputDirtyChange: (dirty: boolean) => void; onRefresh: () => Promise<void>
  onApplied: () => Promise<void>
  target: CollectionTarget
  navigation: CollectionWorkspaceNavigation
  discardInputVersion: number
  onCategoryChange: (category: ProviderCategory) => boolean
  onSelectCollection: (name: string, open: boolean) => void
  onOpenManagement: () => void
  onBack: () => void
  onReturnConfig: () => void
  onEndTarget: () => void
}) {
  const { askConfirm } = useUiState()
  const [importMode, setImportMode] = useState<"new" | "upload" | null>(null)
  const [settingsTarget, setSettingsTarget] = useState<{ item: ManagedProviderItem; source: Pick<ConfigSnapshot, "name" | "sha256"> } | null>(null)
  const view = navigation.view === "manage" ? "manage" : "collections"
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const mobileEditing = navigation.view === "editor"
  useEffect(() => { setImportMode(null); setSettingsTarget(null); setCleanupOpen(false) }, [discardInputVersion])
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
  const ordinary = Boolean(active && managedProviderBodyWritable(active))
  const editable = ordinary && !workspace.writeDisabled
  const entries = useMemo<Array<[string, ProviderPayload]>>(() => workspace.snapshot
    ? items.map((item) => [item.name, providers[item.name] ?? { vehicleType: item.declaration?.type ?? "file" }])
    : Object.entries(providers), [items, providers, workspace.snapshot])
  const writableNames = new Set(items.filter(managedProviderBodyWritable).map((item) => item.name))
  const mergedNames = new Set(items.filter((item) => item.access === "local").map((item) => item.name))
  const descriptions = Object.fromEntries(items.map(item => [item.name, `${item.access === "inline" ? "Inline" : item.access === "http" ? "HTTP" : "File"} · ${typeof item.declaration?.path === "string" ? item.declaration.path : item.referencePath ?? item.name}`]))
  const ordinaryFileStatus = (item: ManagedProviderItem, status: string) => !managedProviderBodyWritable(item) && !item.fileIssue ? "只读" : status
  const statuses = Object.fromEntries(items.map((item) => {
    const provider = providers[item.name]
    const status = item.pendingRemoval ? "待移除" : workspace.itemOperationPending(item) ? "未保存" : item.fileIssue ? providerFileIssueLabel(item.fileIssue) : runtimeBlocked ? "待应用" : !provider ? "待应用" : `运行 ${providerItemCount(category, provider)} ${category === "proxy" ? "个节点" : "条规则"}`
    return [item.name, ordinaryFileStatus(item, status)]
  }))
  useEffect(() => {
    if (active && !active.fileIssue) void workspace.select(active)
  }, [active, workspace.select])
  const select = (name: string, open = false) => {
    if (inputDirty || workspace.busy) { notify("请先确认或取消集合输入，并等待当前操作完成", "error"); return }
    const item = items.find((item) => item.name === name)
    if (item) void workspace.select(item)
    if (!runtimeBlocked) runtime.selectProvider(category, name)
    onSelectCollection(name, open)
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
  const pathChange = active && workspace.snapshot?.collectionPathChanges?.find((change) => change.category === active.category && change.name === active.name)
  const openSettings = () => {
    if (active && workspace.snapshot) setSettingsTarget({ item: structuredClone(active), source: { name: workspace.snapshot.name, sha256: workspace.snapshot.sha256 } })
  }
  const discard = async () => {
    if (await askConfirm({ title: "放弃全部草稿？", message: "恢复当前源配置及全部集合的已保存内容。", confirmLabel: "放弃全部草稿", cancelLabel: "继续编辑", danger: true })) workspace.discardDrafts()
  }
  const fileEditable = Boolean(active && ordinary && active.declaration?.type === "file")
  const missingFile = Boolean(fileEditable && active?.fileIssue === "missing" && !active.sha256)
  const pickingFile = Boolean(missingFile && (filePickerId === active?.id || !workspace.contentReady))
  const fileBack = missingFile && !pickingFile && <Button variant="outline" size="lg" aria-label="返回文件选择" title="返回文件选择，保留草稿" disabled={workspace.busy} onClick={() => active && setFilePickerId(active.id)}><ArrowLeft data-icon="inline-start" /><span className="hidden md:inline">返回</span></Button>
  const moreMenu = <CollectionActionsMenu groups={[
    [
      { label: "重新读取文件", icon: RefreshCw, disabled: workspace.loading || workspace.dirty || inputDirty, onSelect: () => active && void workspace.refreshItem(active) },
      { label: "Core 更新当前", icon: RefreshCw, disabled: !running || runtimeBusy, onSelect: () => void update() },
      { label: "Core 更新全部", icon: RefreshCw, disabled: Boolean(runtime.batchProgress) || !Object.keys(providers).length, onSelect: () => void updateAll() },
    ],
    [
      ...(pathChange ? [
        { label: "同步重命名", disabled: inputBlocked, onSelect: () => active && void workspace.recoverPath(active, "rename") },
        { label: "恢复原路径", disabled: inputBlocked, onSelect: () => active && void workspace.recoverPath(active, "restore") },
      ] : []),
      ...(workspace.dirty ? [{ label: "放弃全部草稿", disabled: workspace.busy || inputDirty, destructive: true, onSelect: () => void discard() }] : []),
      ...(target.source ? [
        { label: "返回编辑配置", disabled: workspace.busy || inputDirty, onSelect: onReturnConfig },
        { label: "结束编辑目标", disabled: workspace.busy || inputDirty, onSelect: onEndTarget },
      ] : []),
    ],
  ]} />
  const toolbar = <WorkspaceToolbar variant="resource-editor" className="max-md:min-h-14 max-md:px-2 max-md:py-1">
    {view === "manage" && <Button variant="ghost" size="icon" aria-label="返回集合" disabled={workspace.busy || inputDirty} onClick={onBack}><ArrowLeft /></Button>}
    <span className="min-w-0 flex-1 truncate text-sm font-medium">{view === "manage" ? "管理集合" : workspace.snapshot?.name ?? "来源未确认"}</span>
    <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{view === "manage" && workspace.snapshot?.name + " · "}{workspace.dirty ? "未保存" : workspace.savedPending ? "待应用" : workspace.snapshot ? "已保存" : "来源未确认"}</span>
    {view === "collections" && <Button variant="outline" size="sm" className="max-sm:size-8 max-sm:p-0" aria-label="管理集合" disabled={workspace.busy || inputDirty} onClick={onOpenManagement}><FolderOpen data-icon="inline-start" /><span className="hidden sm:inline">管理集合</span></Button>}
    <div className="flex shrink-0 items-center gap-2" aria-label="配置及全部集合统一操作">
      <Button variant="outline" size="sm" disabled={workspace.writeDisabled || inputDirty} onClick={validate}><ShieldCheck className="hidden md:block" data-icon="inline-start" />校验</Button>
      <Button variant="outline" size="sm" aria-label="保存配置" disabled={workspace.writeDisabled || inputDirty} onClick={() => void workspace.saveConfigDraft()}>{workspace.busy ? <Spinner data-icon="inline-start" /> : <Save className="hidden md:block" data-icon="inline-start" />}保存</Button>
      <Button size="sm" aria-label="应用配置" disabled={workspace.writeDisabled || inputDirty} onClick={applyConfig}>应用</Button>
    </div>
  </WorkspaceToolbar>
  const detailToolbar = <WorkspaceToolbar variant="editor">
    <Button variant="ghost" size="icon" className="md:hidden" aria-label={navigation.returnView === "manage" ? "返回管理集合" : navigation.returnView === "config" ? "返回编辑配置" : "返回集合列表"} disabled={workspace.busy || inputDirty} onClick={onBack}><ArrowLeft /></Button>
    {fileBack}<span className="min-w-0 flex-1 truncate text-sm">{activeName ?? "未选择集合"}</span>
    {active && !ordinary && <Badge variant="outline">{collectionSourceLabel(active)} · 正文只读</Badge>}
    <Button variant="outline" size="sm" aria-label="集合设置" disabled={!active?.declared || workspace.writeDisabled || inputDirty} onClick={openSettings}><Settings2 data-icon="inline-start" />设置</Button>{moreMenu}
  </WorkspaceToolbar>
  const categoryTabs = <WorkspaceCategoryTabs layout="list" listSpacing="comfortable" value={category} onValueChange={value => onCategoryChange(value as ProviderCategory)} disabled={workspace.busy || inputDirty} items={[{ value: "proxy", label: "代理集合", icon: Boxes }, { value: "rule", label: "规则集合", icon: ListTree }]} />
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {!importMode && toolbar}
    {(workspace.configContentError || workspace.applyError) && <Alert variant="destructive" className="shrink-0 rounded-none"><AlertDescription>{workspace.configContentError ?? workspace.applyError}</AlertDescription></Alert>}
    <div className={cn("min-h-0 flex-1", view === "collections" && !importMode ? "flex" : "hidden")}>
      <ResourceWorkspace idPrefix="collection" resources={list()} resourcesHeader={categoryTabs}
        mobileResources={<div className="flex h-full min-h-0 flex-col">
          <CollectionCategoryPicker category={category} count={entries.length} disabled={workspace.busy || inputDirty} actions={null} onChoose={onCategoryChange} />
          <div className="min-h-0 flex-1">{list(true)}</div>
        </div>}
        mobileNavigation={{ detailOpen: mobileEditing }}
        resizeHandleLabel="调整集合列表宽度">
        {() => <section className="@container/collection flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
            {detailToolbar}
            {active && <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground"><span className="min-w-0 flex-1 truncate">{String(active.declaration?.path ?? active.referencePath ?? "内嵌于源配置")}</span><span className="shrink-0">{collectionSourceLabel(active)}</span></div>}
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
            {active ? <CollectionBodyWorkspace key={workspace.snapshot?.name + ":" + active.id} workspace={workspace} item={active} editable={editable} pickerOpen={filePickerId === active.id} onPickerChange={open => setFilePickerId(open ? active.id : null)} /> : <Empty className="min-h-0 flex-1"><EmptyHeader><EmptyTitle>{target.name && workspace.identityStatus === "ready" ? "指定集合不存在" : "未选择可读取的源集合"}</EmptyTitle><EmptyDescription>{target.name && workspace.identityStatus === "ready" ? "请在当前配置中重新选择集合。" : "来源未确认时保留可用的 Controller 更新操作。"}</EmptyDescription></EmptyHeader></Empty>}
          </section>}
      </ResourceWorkspace>
    </div>
    <div className={cn("min-h-0 flex-1", view === "manage" && !importMode ? "flex" : "hidden")}><CollectionFileManager category={category} workspace={workspace} historyEntry={navigation.entry} visible={view === "manage" && !importMode} discardInputVersion={discardInputVersion} onCategoryChange={onCategoryChange} onOpenCollection={item => select(item.name, true)} onNew={() => setImportMode("new")} onCleanup={() => setCleanupOpen(true)} onDirtyChange={onInputDirtyChange} /></div>
    {importMode && <CollectionCreateWorkspace mode={importMode} category={category} onClose={() => setImportMode(null)} workspace={workspace} onDirtyChange={onInputDirtyChange} />}
    {settingsTarget && <CollectionSettingsDialog item={settingsTarget.item} source={settingsTarget.source} workspace={workspace} onClose={() => setSettingsTarget(null)} onDirtyChange={onInputDirtyChange} />}
    {cleanupOpen && <CollectionCleanupDialog category={category} onClose={() => setCleanupOpen(false)} onDone={() => workspace.refresh(true, true)} onBusyChange={onInputDirtyChange} notify={notify} />}
  </div>
}
