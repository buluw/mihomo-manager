import { useCallback, useEffect, useMemo, useState } from "react"

import {
  ConfigError,
  createLocalProviderExtraction,
  deleteLocalProviderExtraction,
  listLocalProviderExtractions,
  listManagedProviderFiles,
  updateLocalProviderExtraction,
  type ConfigFileRecord,
  type ConfigSubscription,
  type LocalProviderExtraction,
  type ManagedProviderFile,
} from "@/api/configClient"
import type { Notify } from "@/shared/types"
import { useUiState } from "@/app/state/uiState"

import {
  mergeConfigurationSources,
  applyPersistedDraftPatch,
  persistedDraftSynchronized,
  reconcilePersistedDraft,
  type PersistedDraftState,
} from "./subscriptionWorkspaceState"
import type { useSubscriptionWorkspace } from "./useSubscriptionWorkspace"

type SubscriptionWorkspace = ReturnType<typeof useSubscriptionWorkspace>

export type MergeRelation =
  | { kind: "subscription"; id: string; subscription: ConfigSubscription; file: ManagedProviderFile | null }
  | { kind: "local"; id: string; config: ConfigFileRecord | null; local: LocalProviderExtraction | null;
    localRelations: LocalProviderExtraction[]; conflict: boolean; file: ManagedProviderFile | null }

export type MergeDraft = {
  enabled: boolean
  providerName: string
}

function fileBase(fileName: string) {
  return fileName.replace(/\.ya?ml$/i, "")
}

export function draftFor(relation: MergeRelation): MergeDraft {
  const representativeLocal = relation.kind === "local"
    ? relation.local ?? relation.localRelations[0] ?? null
    : null
  return relation.kind === "subscription" ? {
    enabled: relation.subscription.extractProvider,
    providerName: relation.subscription.providerName,
  } : {
    enabled: representativeLocal?.enabled ?? true,
    providerName: representativeLocal ? fileBase(representativeLocal.fileName) : fileBase(relation.config!.name),
  }
}

export type MergeDraftState = PersistedDraftState<MergeDraft>

export function mergeRelationIdentity(relation: MergeRelation) {
  if (relation.kind === "subscription") {
    return JSON.stringify([
      relation.subscription.id,
      relation.subscription.providerName,
      relation.subscription.providerSha256,
      relation.subscription.extractProvider,
    ])
  }
  return JSON.stringify(relation.localRelations.map((local) => [
    local.id,
    local.fileName,
    local.providerSha256,
    local.sourceSha256,
    local.enabled,
  ]))
}

export function reconcileMergeDraftState(
  current: MergeDraftState | null,
  relation: MergeRelation,
): MergeDraftState {
  const identity = mergeRelationIdentity(relation)
  return reconcilePersistedDraft(current, relation.id, identity, draftFor(relation))
}

export function useMergeConfigWorkspace(
  subscriptions: SubscriptionWorkspace,
  configFiles: ConfigFileRecord[],
  notify: Notify,
  sharedProviderFiles: ManagedProviderFile[] | null = null,
  onProviderFilesCommit: (files: ManagedProviderFile[]) => void = () => undefined,
  loadedName: string | null = null,
) {
  const [locals, setLocals] = useState<LocalProviderExtraction[]>([])
  const [files, setFiles] = useState<ManagedProviderFile[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draftState, setDraftState] = useState<MergeDraftState | null>(null)
  const [loading, setLoading] = useState(false)
  const [catalogReady, setCatalogReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const { askConfirm } = useUiState()

  useEffect(() => {
    if (sharedProviderFiles) setFiles(sharedProviderFiles)
  }, [sharedProviderFiles])

  const relations = useMemo(
    () => mergeConfigurationSources(subscriptions.items, configFiles, locals, files, loadedName),
    [configFiles, files, loadedName, locals, subscriptions.items],
  )
  const active = relations.find((item) => item.id === activeId) ?? relations[0] ?? null
  const draft = active && draftState && draftState.relationId === active.id ? draftState.draft : null
  const dirty = Boolean(draft && draftState?.dirtyFields.length)
  const activeIdentity = active ? mergeRelationIdentity(active) : null
  const draftSynchronized = persistedDraftSynchronized(
    catalogReady,
    active?.id ?? null,
    activeIdentity,
    draftState,
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setCatalogReady(false)
    try {
      const [nextLocals, nextFiles] = await Promise.all([
        listLocalProviderExtractions(),
        listManagedProviderFiles(),
      ])
      setLocals(nextLocals)
      setFiles(nextFiles)
      onProviderFilesCommit(nextFiles)
      setCatalogReady(true)
    } catch (error) {
      notify(error instanceof ConfigError ? "代理集提取服务暂不可用" : (error as Error).message, "error")
    } finally {
      setLoading(false)
    }
  }, [notify, onProviderFilesCommit])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!active) {
      setDraftState(null)
      return
    }
    setActiveId(active.id)
    setDraftState((current) => reconcileMergeDraftState(current, active))
  }, [active])

  const select = async (relation: MergeRelation) => {
    if (busy || loading) return false
    if (relation.id === active?.id) return true
    if (dirty && !(await askConfirm({
      title: "放弃未保存更改？",
      message: "切换配置来源会丢弃当前提取设置的未保存修改。",
      confirmLabel: "放弃并切换",
      danger: true,
    }))) return false
    setActiveId(relation.id)
    setDraftState((current) => reconcileMergeDraftState(current, relation))
    return true
  }

  const cleanupAvailable = active?.kind === "local" && !active.config && !active.conflict &&
    active.local && !active.local.enabled && active.local.providerSha256 === null && active.local.nodeCount === 0 && !active.file

  const cleanup = async () => {
    if (!cleanupAvailable || active?.kind !== "local" || !active.local || busy || loading) return
    if (!(await askConfirm({ title: "清理提取关系？",
      message: "该来源已删除且停用的提取关系没有正文。清理仅移除此关系，未保存的设置也将丢弃。",
      confirmLabel: "确认清理", danger: true }))) return
    setBusy(true)
    try {
      await deleteLocalProviderExtraction(active.local)
      setDraftState(null)
      notify("提取关系已清理")
      await refresh()
    } catch (error) { notify((error as Error).message, "error") }
    finally { setBusy(false) }
  }

  const save = async () => {
    if (!draftSynchronized || !active || !draft || busy || (active.kind === "local" && active.conflict)) return false
    setBusy(true)
    try {
      if (active.kind === "subscription") {
        const saved = await subscriptions.saveMergeSettings(active.subscription, {
          extractProvider: draft.enabled,
          providerName: draft.providerName,
          mergeIntoConfig: active.subscription.mergeIntoConfig,
          configName: active.subscription.configName,
          groupNames: active.subscription.groupNames,
        })
        if (!saved) return false
      } else {
        const nextFileName = /\.ya?ml$/i.test(draft.providerName) ? draft.providerName : `${draft.providerName}.yaml`
        if (active.local) {
          await updateLocalProviderExtraction({
            id: active.local.id, currentFileName: active.local.fileName, fileName: nextFileName,
            providerSha256: active.local.providerSha256, currentEnabled: active.local.enabled,
            enabled: draft.enabled, filterSettings: { ...active.local.filterSettings, enabled: false, rules: [] },
          })
        } else if (active.config) {
          await createLocalProviderExtraction({
            configName: active.config.name, sourceSha256: active.config.sha256, fileName: nextFileName,
            enabled: draft.enabled,
          })
        } else throw new Error("源配置已不存在")
      }
      notify("代理集提取已保存")
      setDraftState((current) => current ? { ...current, dirtyFields: [] } : current)
      await refresh()
      return true
    } catch (error) {
      notify((error as Error).message, "error")
      return false
    } finally {
      setBusy(false)
    }
  }

  return {
    relations, active, draft, dirty, loading, catalogReady, draftSynchronized, busy, cleanupAvailable, cleanup,
    setDraft: (patch: Partial<MergeDraft>) => setDraftState((current) => current
      ? applyPersistedDraftPatch(current, patch)
      : current),
    select, refresh, save,
  }
}
