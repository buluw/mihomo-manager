import { providerFileIssueLabel } from "../../shared/configMessages.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { Activity, Plus, RefreshCw, Save, Settings2, Trash2, Upload } from "lucide-react"
import {
  type ConfigSnapshot,
} from "@/api/configClient";
import { MonacoWorkspace } from "@/components/patterns/monaco-workspace"
import { ResourceWorkspace } from "@/components/patterns/resource-workspace"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { Notify } from "@/shared/types"
import { collectionEditLocation, configEditLocation, type CollectionTarget } from "@/shared/collectionTarget"
import { useUiState } from "@/app/state/uiState"
import { CollectionResourceList } from "./CollectionResourceList"
import { CollectionActionsMenu } from "./CollectionActionsMenu"
import { CollectionCategoryPicker, CollectionDetailHeader } from "./CollectionMobileNavigation"
import { CollectionSettingsDialog } from "./CollectionSettingsDialog"
import { MissingProxyCollectionEditor, MissingRuleCollectionEditor, ProxyCollectionImportDialog } from "./ProxyCollectionImport.tsx"
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
  const [repairId, setRepairId] = useState<string | null>(null)
  const [mobileEditing, setMobileEditing] = useState(false)
  const items = workspace.items
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
  const descriptions = Object.fromEntries(items.map((item) => {
    const provider = providers[item.name]
    const type = item.access === "inline" ? "Inline" : item.access === "http" ? "HTTP" : "File"
    const status = item.pendingRemoval ? "待保存移除" : item.fileIssue ? providerFileIssueLabel(item.fileIssue)
      : workspace.itemOperationPending(item) ? "未保存" : runtimeBlocked ? "运行来源未配对" : !provider ? "待应用" : `运行 ${providerItemCount(category, provider)} ${category === "proxy" ? "个节点" : "条规则"}`
    return [item.name, `${type} · ${status}`]
  }))
  useEffect(() => {
    if (active && !active.fileIssue) void workspace.select(active)
  }, [active, workspace.select])
  useEffect(() => { setMobileEditing(false); setRepairId(null) }, [category])
  useEffect(() => {
    if (!target.name || target.category !== category || workspace.identityStatus !== "ready") return
    const key = `${target.source?.name}:${category}:${target.name}`
    if (focusedTarget.current === key) return
    const item = items.find((item) => item.name === target.name)
    if (!item) return
    focusedTarget.current = key
    void workspace.select(item)
    if (target.repair && item.fileIssue === "missing" && item.declaration?.type === "file" &&
      (item.access === "manual" || item.access === "external") && !workspace.readOnlyFor(item)) setRepairId(item.id)
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
    setRepairId(null)
    if (open) setMobileEditing(true)
  }
  const list = (mobile = false) => <CollectionResourceList category={category} entries={entries} activeName={activeName}
    loading={workspace.loading} error={!workspace.snapshot ? workspace.message : undefined}
    onSelect={(name) => select(name, mobile)} writableNames={writableNames}
    mergedNames={mergedNames} descriptions={descriptions} emptyActions={mobile && <div className="flex flex-wrap justify-center gap-2">
      <Button variant="outline" size="sm" disabled={inputBlocked} onClick={() => setImportMode("new")}><Plus data-icon="inline-start" />新建</Button>
      <Button variant="outline" size="sm" disabled={inputBlocked} onClick={() => setImportMode("upload")}><Upload data-icon="inline-start" />上传</Button>
      <Button variant="outline" size="sm" disabled={cleanupBlocked} onClick={() => setCleanupOpen(true)}><Trash2 data-icon="inline-start" />清理文件</Button>
    </div>} />
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
  const healthCheck = () => activeName && running && runRuntimeAction(() => runtime.healthCheckProvider(activeName))
  const inputBlocked = workspace.writeDisabled || workspace.dirty || inputDirty || Boolean(workspace.configContentError)
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
    : workspace.dirty || inputDirty ? "请先保存配置或撤销草稿" : managedProviderModificationReason(active)
  const secondaryStatus = [workspace.busy ? "正在处理集合操作…" : workspace.dirty ? "未保存" : workspace.savedPending ? "已保存待应用" : "",
    runtimeBlocked ? "运行来源未配对" : running ? "" : "运行集合未就绪"].filter(Boolean).join(" · ")
  const moreMenu = <CollectionActionsMenu description={removeReason ?? undefined} groups={[
    [
      { label: "新建", icon: Plus, disabled: inputBlocked, onSelect: () => setImportMode("new") },
      { label: "上传", icon: Upload, disabled: inputBlocked, onSelect: () => setImportMode("upload") },
      { label: "清理文件", icon: Trash2, disabled: cleanupBlocked, onSelect: () => setCleanupOpen(true) },
    ],
    [
      { label: "设置", icon: Settings2, disabled: !active?.declared || inputBlocked, onSelect: openSettings },
      ...(active?.fileIssue === "missing" && active.declaration?.type === "file" && (active.access === "manual" || active.access === "external") && !readOnly
        ? [{ label: "编辑／上传缺失文件", disabled: inputBlocked, onSelect: () => { setRepairId(active.id); setMobileEditing(true) } }] : []),
      ...(pathChange ? [
        { label: "同步重命名", disabled: inputBlocked, onSelect: () => active && void workspace.recoverPath(active, "rename") },
        { label: "恢复原路径", disabled: inputBlocked, onSelect: () => active && void workspace.recoverPath(active, "restore") },
      ] : []),
      ...(workspace.contentError ? [{ label: "重试读取当前集合", disabled: !active || workspace.busy, onSelect: () => active && void workspace.select(active) }] : []),
    ],
    [
      { label: "重新读取", icon: RefreshCw, disabled: workspace.loading, onSelect: () => void onRefresh() },
      { label: "更新当前", icon: RefreshCw, disabled: !running || runtimeBusy, onSelect: () => void update() },
      { label: "全部更新", icon: RefreshCw, disabled: Boolean(runtime.batchProgress) || !Object.keys(providers).length, onSelect: () => void updateAll() },
      ...(category === "proxy" ? [{ label: "健康检查", icon: Activity, disabled: !running || runtimeBusy, onSelect: () => { void healthCheck() } }] : []),
    ],
    [
      ...(ordinary && active ? [{ label: "只读", checked: readOnly, disabled: workspace.writeDisabled || workspace.contentDirty, onSelect: () => void workspace.setReadOnly(active, !readOnly) }] : []),
      { label: "删除集合", icon: Trash2, destructive: true, disabled: removeReason !== null, onSelect: () => setDeleteTarget(active) },
    ],
  ]} />
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex min-h-0 flex-1">
      <ResourceWorkspace idPrefix="collection" resources={list()} mobileResources={null} mobileListOpen={false}
        onMobileListOpenChange={() => undefined} resizeHandleLabel="调整集合列表宽度" mobileTriggerLabel="打开集合列表"
        mobileSheetWidth={304} mobileTitle="集合" mobileDescription="选择集合">
        {() => <>
          <div className={cn("h-full min-h-0 flex-col md:hidden", mobileEditing ? "hidden" : "flex")}>
            <CollectionCategoryPicker category={category} disabled={workspace.busy || inputDirty} onChoose={onCategoryChange} />
            <div className="min-h-0 flex-1">{list(true)}</div>
          </div>
          <section className={cn("@container/collection h-full min-h-0 min-w-0 flex-col overflow-hidden md:flex", mobileEditing ? "flex" : "hidden")}>
            <CollectionDetailHeader title={activeName ?? "未选择集合"} onBack={() => setMobileEditing(false)} />
            <div data-slot="collection-actions" className="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_44px] items-center gap-2 border-b px-4 py-1 md:flex md:min-h-12 md:flex-wrap md:justify-end md:px-3 md:py-2">
              {ordinary && active && <label className="hidden shrink-0 items-center gap-1.5 text-xs @min-[800px]/collection:flex"><Checkbox aria-label="只读" checked={readOnly}
                disabled={workspace.writeDisabled || workspace.contentDirty} onCheckedChange={(checked) => void workspace.setReadOnly(active, checked === true)} />只读</label>}
              <div className="hidden items-center gap-2 @min-[800px]/collection:flex">
                <Button variant="outline" size="sm" disabled={inputBlocked} onClick={() => setImportMode("new")}><Plus data-icon="inline-start" />新建</Button>
                <Button variant="outline" size="sm" disabled={inputBlocked} onClick={() => setImportMode("upload")}><Upload data-icon="inline-start" />上传</Button>
                <Button variant="outline" size="sm" disabled={!active?.declared || inputBlocked} onClick={openSettings}><Settings2 data-icon="inline-start" />设置</Button>
              </div>
              <Button variant="outline" size="sm" disabled={workspace.writeDisabled || inputDirty} onClick={() => void workspace.saveConfigDraft()}>
                {workspace.busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}保存配置
              </Button>
              <Button size="sm" disabled={workspace.writeDisabled || inputDirty || workspace.dirty || workspace.hasContentErrors || Boolean(workspace.configContentError || workspace.draftIssue)} onClick={applyConfig}>应用配置</Button>
              {moreMenu}
            </div>
            {workspace.identityStatus !== "ready" && !(workspace.identityStatus === "loading" && workspace.snapshot) &&
              <Alert className="shrink-0 rounded-none"><AlertDescription className="flex flex-wrap items-center gap-2"><span>{workspace.message}</span>
                {target.source && <Button variant="outline" size="sm" disabled={workspace.busy || inputDirty} onClick={() => void (async () => {
                  if (workspace.dirty && !await askConfirm({ title: "采用最新编辑版本？", message: "当前集合草稿将撤销；目标配置保持不变。", confirmLabel: "采用最新版本", danger: true })) return
                  try { await workspace.adoptLatestSource() } catch { notify("无法读取当前编辑目标，输入已保留", "error") }
                })()}>采用最新编辑版本</Button>}
              </AlertDescription></Alert>}
            {runtime.loadErrors[category] && <Alert className="shrink-0 rounded-none"><AlertDescription>Controller 运行状态读取失败；磁盘草稿保留。</AlertDescription></Alert>}
            <div data-slot="collection-secondary" className={cn("shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 @min-[800px]/collection:flex", secondaryStatus || target.source || workspace.dirty ? "flex" : "hidden")}>
              {workspace.busy && <Spinner />}<span role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">{secondaryStatus}</span>
              {target.source && <>
                <Button variant="ghost" size="sm" disabled={workspace.busy || inputDirty} onClick={() => {
                  const destination = configEditLocation(workspace.snapshot ?? target.source!)
                  navigate(destination.pathname, { state: destination.state })
                }}>返回编辑配置</Button>
                <Button variant="ghost" size="sm" disabled={workspace.busy} onClick={() => navigate("/collections")}>结束编辑目标</Button>
              </>}
              <div className="hidden items-center gap-2 @min-[800px]/collection:flex">
                <Button variant="outline" size="sm" disabled={cleanupBlocked} onClick={() => setCleanupOpen(true)}><Trash2 data-icon="inline-start" />清理文件</Button>
                <Button variant="outline" size="sm" disabled={workspace.loading} onClick={() => void onRefresh()}><RefreshCw data-icon="inline-start" />重新读取</Button>
                <Button variant="outline" size="sm" disabled={!running || runtimeBusy} onClick={() => void update()}><RefreshCw data-icon="inline-start" />更新当前</Button>
                <Button variant="outline" size="sm" disabled={Boolean(runtime.batchProgress) || !Object.keys(providers).length} onClick={() => void updateAll()}><RefreshCw data-icon="inline-start" />全部更新</Button>
                {category === "proxy" && <Button variant="outline" size="sm" disabled={!running || runtimeBusy} onClick={() => void healthCheck()}><Activity data-icon="inline-start" />健康检查</Button>}
                <Tooltip><TooltipTrigger render={<span className="inline-flex" />}><Button variant="destructive" size="sm" disabled={removeReason !== null} onClick={() => setDeleteTarget(active)}><Trash2 data-icon="inline-start" />删除集合</Button></TooltipTrigger><TooltipContent>{removeReason ?? "删除集合"}</TooltipContent></Tooltip>
              </div>
              {workspace.dirty && <Button variant="ghost" size="sm" disabled={workspace.busy || inputDirty} onClick={() => workspace.discardDrafts()}>撤销</Button>}
            </div>
            {active?.fileIssue === "missing" && repairId !== active.id && <Alert className="shrink-0 rounded-none"><AlertDescription className="flex flex-wrap items-center gap-2"><span>缺少文件：{active.name}</span>
              {active.declaration?.type === "file" && (active.access === "manual" || active.access === "external") && !readOnly &&
                <Button variant="outline" size="sm" disabled={inputBlocked} onClick={() => setRepairId(active.id)}>编辑／上传</Button>}
            </AlertDescription></Alert>}
            {pathChange && active && <Alert className="shrink-0 rounded-none"><AlertDescription className="flex flex-wrap items-center gap-2">
              <span>新路径未找到文件，原文件仍存在：{pathChange.fromPath}</span>
              <Button variant="outline" size="sm" disabled={inputBlocked} onClick={() => void workspace.recoverPath(active, "rename")}>同步重命名</Button>
              <Button variant="outline" size="sm" disabled={inputBlocked} onClick={() => void workspace.recoverPath(active, "restore")}>恢复原路径</Button>
            </AlertDescription></Alert>}
            {workspace.contentError && <Alert variant="destructive" className="shrink-0 rounded-none"><AlertDescription className="flex flex-wrap items-center gap-2"><span>{workspace.contentError}</span>
              <Button variant="outline" size="sm" disabled={!active || workspace.busy} onClick={() => active && void workspace.select(active)}>重试读取当前集合</Button>
            </AlertDescription></Alert>}
            {workspace.configContentError && <Alert variant="destructive" className="shrink-0 rounded-none"><AlertDescription>{workspace.configContentError}</AlertDescription></Alert>}
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
              {active?.fileIssue === "missing" && repairId === active.id ? (
                category === "proxy" ? (
                  <MissingProxyCollectionEditor key={`${workspace.snapshot?.name}:${active.id}`} item={active} workspace={workspace} onDirtyChange={onInputDirtyChange} onCancel={() => setRepairId(null)} />
                ) : (
                  <MissingRuleCollectionEditor key={`${workspace.snapshot?.name}:${active.id}`} item={active} workspace={workspace} onDirtyChange={onInputDirtyChange} onCancel={() => setRepairId(null)} />
                )
              ) : active ? (
                <>
                  <div className={cn("h-full w-full", !workspace.contentReady && !active.fileIssue && "invisible pointer-events-none")}>
                    <MonacoWorkspace
                      path={`collection://source/${encodeURIComponent(workspace.snapshot?.name ?? "current")}/${category}/${encodeURIComponent(active.id)}.yaml`}
                      value={workspace.content}
                      onChange={(value) => workspace.editContent(active, value)}
                      onSave={() => void workspace.saveConfigDraft()}
                      readOnly={!editable || Boolean(active.fileIssue)}
                      ariaLabel={`${active.name} 集合正文`}
                    />
                  </div>
                  {!workspace.contentReady && !active.fileIssue && (
                    <div className="absolute inset-0 flex items-center justify-center bg-background/80">
                      <Empty className="h-full">
                        <EmptyHeader>
                          <EmptyTitle>
                            {active?.fileIssue
                              ? providerFileIssueLabel(active.fileIssue)
                              : workspace.contentError
                                ? "集合正文读取失败"
                                : "正在读取集合正文"}
                          </EmptyTitle>
                          <EmptyDescription>
                            {active?.access === "http"
                              ? "HTTP 正文由 Core 下载；可使用更新当前读取。"
                              : "来源未确认时保留可用的 Controller 更新和健康检查。"}
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    </div>
                  )}
                </>
              ) : (
                <Empty className="h-full">
                  <EmptyHeader>
                    <EmptyTitle>{target.name && workspace.identityStatus === "ready" ? "指定集合不存在" : "未选择可读取的源集合"}</EmptyTitle>
                    <EmptyDescription>{target.name && workspace.identityStatus === "ready" ? "请在当前配置中重新选择集合。" : "来源未确认时保留可用的 Controller 更新和健康检查。"}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
          </section>
        </>}
      </ResourceWorkspace>
    </div>
    {importMode && <ProxyCollectionImportDialog mode={importMode} category={category} onClose={() => setImportMode(null)} workspace={workspace} onDirtyChange={onInputDirtyChange} />}
    {settingsTarget && <CollectionSettingsDialog item={settingsTarget.item} source={settingsTarget.source} workspace={workspace} onClose={() => setSettingsTarget(null)} onDirtyChange={onInputDirtyChange} />}
    {cleanupOpen && <CollectionCleanupDialog category={category} onClose={() => setCleanupOpen(false)} onDone={() => workspace.refresh(true, true)} onBusyChange={onInputDirtyChange} notify={notify} />}
    <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !workspace.busy) setDeleteTarget(null) }}><AlertDialogContent><AlertDialogHeader>
      <AlertDialogTitle>删除集合 {deleteTarget?.name}？</AlertDialogTitle><AlertDialogDescription>配置：{workspace.snapshot?.name}。受影响代理组：{deleteTarget?.selectedGroups.join("、") || "无"}。{deleteTarget?.access === "inline" || deleteTarget?.access === "http" ? "移除集合声明和当前配置引用。" : "删除集合文件及当前配置引用；其他配置仍有引用时会阻止删除。"}完成后使用“应用配置”加载变更。</AlertDialogDescription>
    </AlertDialogHeader>
      {emptiedGroups.length > 0 && <Alert variant="destructive"><AlertDescription>删除会使以下代理组失去所有来源：{emptiedGroups.join("、")}。请先调整这些组的来源或处理这些组，再删除集合。</AlertDescription></Alert>}
      <AlertDialogFooter><AlertDialogCancel disabled={workspace.busy}>取消</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={workspace.writeDisabled || workspace.busy || emptiedGroups.length > 0} onClick={() => {
      const target = deleteTarget; setDeleteTarget(null); void workspace.remove(target)
    }}>{workspace.busy && <Spinner data-icon="inline-start" />}删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>
}
