import { useEffect, type ReactNode } from "react"
import { RefreshCw, Save, Trash2 } from "lucide-react"

import type { ConfigFileRecord, ManagedProviderFile } from "@/api/configClient"
import { ResourceWorkspace } from "@/components/patterns/resource-workspace"
import { ResourceListGroup, ResourceListHeader, ResourceListRow } from "@/components/patterns/resource-list"
import { WorkspaceStatusBar, WorkspaceToolbar } from "@/components/patterns/workspace"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { Notify } from "@/shared/types"

import type { useSubscriptionWorkspace } from "./useSubscriptionWorkspace"
import { useMergeConfigWorkspace } from "./useMergeConfigWorkspace"
import { ConfigDetailHeader } from "./ConfigMobileNavigation"

export function MergeConfigWorkspace({
  resourcesHeader,
  subscriptions,
  configFiles,
  notify,
  providerFiles,
  onProviderFilesCommit,
  loadedName,
  onGuardChange,
  mobileListTitle,
  mobileDetailOpen,
  onOpenDetail,
  onBack,
}: {
  resourcesHeader: ReactNode
  subscriptions: ReturnType<typeof useSubscriptionWorkspace>
  configFiles: ConfigFileRecord[]
  notify: Notify
  providerFiles: ManagedProviderFile[] | null
  onProviderFilesCommit: (files: ManagedProviderFile[]) => void
  loadedName: string | null
  onGuardChange: (state: { dirty: boolean; pendingWrite: boolean }) => void
  mobileListTitle: ReactNode
  mobileDetailOpen: boolean
  onOpenDetail: () => void
  onBack: () => void
}) {
  const workspace = useMergeConfigWorkspace(subscriptions, configFiles, notify, providerFiles, onProviderFilesCommit, loadedName)
  useEffect(() => {
    onGuardChange({ dirty: workspace.dirty, pendingWrite: workspace.busy })
    return () => onGuardChange({ dirty: false, pendingWrite: false })
  }, [onGuardChange, workspace.dirty, workspace.busy])

  const list = (mobile = false) => (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]">
      {mobile && <ResourceListHeader>
        {mobileListTitle}
        <span className="text-xs text-muted-foreground tabular-nums">{workspace.relations.length}</span>
      </ResourceListHeader>}
      <div className="flex min-h-0 flex-col overflow-y-auto p-2">
        <ResourceListGroup>
        {workspace.relations.map((relation) => {
          const name = relation.kind === "subscription" ? relation.subscription.name : relation.local?.configName ?? relation.localRelations[0]?.configName ?? relation.config?.name ?? "源配置已不存在"
          const provider = relation.kind === "subscription" ? relation.subscription.providerName : relation.local ? relation.local.fileName.replace(/\.ya?ml$/i, "") : relation.conflict ? "存在多个提取关系" : "尚未配置"
          const selected = workspace.active?.id === relation.id
          return <ResourceListRow key={relation.id} name={name} selected={selected}
            metadata={provider || "尚未命名"}
            status={selected && workspace.dirty ? <span className="text-status-info">未保存</span> : relation.kind === "subscription" ? relation.subscription.extractProvider ? "已启用" : "未启用" : relation.conflict ? "关系冲突" : relation.local?.enabled ? "已启用" : "未启用"}
            disabled={workspace.busy || workspace.loading} onSelect={() => { void workspace.select(relation).then(accepted => { if (accepted) onOpenDetail() }) }} />
        })}
        </ResourceListGroup>
      </div>
    </div>
  )

  const active = workspace.active
  const draft = workspace.draft
  const relationConflict = active?.kind === "local" && active.conflict
  const editingDisabled = workspace.busy || relationConflict || (workspace.catalogReady && !workspace.draftSynchronized)
  const actionDisabled = editingDisabled || !workspace.draftSynchronized
  const detailTitle = active ? (active.kind === "subscription" ? active.subscription.name : active.local?.configName ?? active.localRelations[0]?.configName ?? active.config?.name ?? "源配置已不存在") : "代理集提取"
  return <ResourceWorkspace
      idPrefix="config-center"
      toolbar={        <WorkspaceToolbar variant="resource-editor" className="flex-wrap">
          <span className="min-w-0 flex-1 truncate">{detailTitle}</span>
          <div className="ml-auto flex gap-1">
            {workspace.cleanupAvailable && <Button variant="destructive" size="sm" disabled={workspace.busy || workspace.loading} onClick={() => void workspace.cleanup()}><Trash2 data-icon="inline-start" />清理关系</Button>}
            <Button variant="outline" size="sm" disabled={workspace.busy} onClick={() => void workspace.refresh()}><RefreshCw data-icon="inline-start" />刷新</Button>
            <Button size="sm" aria-busy={workspace.busy} className="disabled:aria-busy:opacity-100" disabled={!active || !draft || actionDisabled || !draft.providerName.trim()} onClick={() => void workspace.save()}>
              {workspace.busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}保存
            </Button>
          </div>
        </WorkspaceToolbar>}
      resourcesHeader={resourcesHeader}
      resources={list()}
      mobileResources={list(true)}
      mobileNavigation={{ detailOpen: mobileDetailOpen, header: <ConfigDetailHeader title={detailTitle} onBack={onBack} /> }}
      status={<WorkspaceStatusBar>{workspace.loading ? "正在读取代理集提取" : null}</WorkspaceStatusBar>}
      resizeHandleLabel="调整配置来源列表宽度"
    >
      {() => <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)]">

        <div className="min-h-0 overflow-y-auto p-5">
          {active && draft ? <div className="grid max-w-2xl content-start gap-5">
              {active.kind === "local" && !active.config && <FieldError>源配置已删除；现有提取关系仍保留</FieldError>}
              {relationConflict && <div className="text-sm text-destructive">存在多个提取关系，需先处理</div>}
              <Field><FieldLabel>来源</FieldLabel><Input value={active.kind === "subscription" ? active.subscription.name : active.local?.configName ?? active.localRelations[0]?.configName ?? active.config?.name ?? "源配置已不存在"} readOnly /></Field>
              <Field><FieldLabel htmlFor="merge-provider-name">代理集合名称</FieldLabel><Input id="merge-provider-name" value={draft.providerName} disabled={editingDisabled} onChange={(event) => workspace.setDraft({ providerName: event.target.value })} /></Field>
              <Field orientation="horizontal"><div className="flex-1"><FieldLabel htmlFor="merge-enabled">启用提取</FieldLabel></div><Switch id="merge-enabled" checked={draft.enabled} disabled={editingDisabled} onCheckedChange={(enabled) => workspace.setDraft({ enabled })} /></Field>
              <p className="text-sm text-muted-foreground">提取始终保留源配置中的全部代理节点。订阅过滤请在订阅页面设置。</p>
          </div> : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">选择一个配置来源</div>}
        </div>
      </div>}
    </ResourceWorkspace>
}
