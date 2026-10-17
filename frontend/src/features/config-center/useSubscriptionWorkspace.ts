import { configErrorMessage } from "../../shared/configMessages.ts";
import { subscriptionUpdateErrorMessage } from "../../shared/configMessages.ts";
import { providerRefreshFailureMessage, subscriptionRefreshMessage } from "./subscriptionRuntime.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  ConfigError,
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  listManagedProviderFiles,
  previewSubscriptionFilter,
  saveSubscriptionFilterSettings,
  updateSubscription,
  updateSubscriptionProvider,
  type ConfigSubscription,
  type ConfigSubscriptionInput,
  type ConfigSnapshot,
  type ManagedProviderFile,
} from "@/api/configClient";
import { useUiState } from "@/app/state/uiState"
import {
  applySubscriptionConfigBinding,
  deleteSubscriptionAfterBindingRemoval,
  migrateSubscriptionBinding,
  ProviderReloadError,
  generateInitialProviderAndApplyBinding,
  InitialProviderGenerationError,
  updateSubscriptionAndReloadProvider,
} from "./subscriptionActions"
import {
  emptySubscriptionDraft,
  editSubscriptionDraft,
  canSaveSubscriptionDraft,
  canStartSubscriptionUpdate,
  isSubscriptionDirty,
  removeSubscriptionSnapshot,
  refreshedSubscriptionSelection,
  subscriptionDraftFromSnapshot,
  DEFAULT_PROVIDER_FILTER_RULES,
  mergeFilterRuleError,
  upsertSubscriptionSnapshot,
} from "./subscriptionWorkspaceState"
import { LatestRequestController } from "@/shared/requestLifecycle"
import type { Notify } from "@/shared/types"
import {
  SubscriptionPreviewSession,
  subscriptionPreviewIdentity,
  type SubscriptionFilterPreview,
} from "./subscriptionPreview"

type SubscriptionBusy = "load" | "save" | "delete" | null

const subscriptionWorkspaceCache: {
  initialized: boolean
  items: ConfigSubscription[]
  activeId: string | null
} = {
  initialized: false,
  items: [],
  activeId: null,
}

export function useSubscriptionWorkspace(
  notify: Notify,
  syncConfigSnapshot: (snapshot: ConfigSnapshot) => void = () => undefined,
  sharedProviderFiles: ManagedProviderFile[] | null = null,
  onProviderFilesCommit: (files: ManagedProviderFile[]) => void = () => undefined,
) {
  const initialActive = subscriptionWorkspaceCache.items.find(
    (item) => item.id === subscriptionWorkspaceCache.activeId
  ) ?? subscriptionWorkspaceCache.items[0] ?? null
  const initialForm = initialActive
    ? subscriptionDraftFromSnapshot(initialActive)
    : emptySubscriptionDraft()
  const [items, setItems] = useState<ConfigSubscription[]>(subscriptionWorkspaceCache.items)
  const [providerFiles, setProviderFiles] = useState<ManagedProviderFile[]>([])
  const [activeId, setActiveId] = useState<string | null>(initialActive?.id ?? null)
  const [form, setForm] = useState<ConfigSubscriptionInput>(initialForm)
  const [savedForm, setSavedForm] = useState<ConfigSubscriptionInput>(initialForm)
  const [newDraft, setNewDraft] = useState(false)
  const [busy, setBusy] = useState<SubscriptionBusy>(
    subscriptionWorkspaceCache.initialized ? null : "load"
  )
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [pendingDelete, setPendingDelete] =
    useState<ConfigSubscription | null>(null)
  const [filterDraft, setFilterDraft] = useState(() => ({ enabled: initialActive?.filterSettings.enabled ?? false, rules: (initialActive?.filterSettings.rules.length ? initialActive.filterSettings.rules : DEFAULT_PROVIDER_FILTER_RULES).join("\n") }))
  const [filterPreview, setFilterPreview] = useState<SubscriptionFilterPreview | null>(null)
  const [filterPreviewPending, setFilterPreviewPending] = useState(false)
  const previewSession = useRef(new SubscriptionPreviewSession())
  const loadRequests = useRef(new LatestRequestController())
  const activeIdRef = useRef<string | null>(initialActive?.id ?? null)
  const dirtyRef = useRef(false)
  const updatingIdRef = useRef<string | null>(null)
  const mounted = useRef(false)
  const { askConfirm } = useUiState()

  const resetFilterPreview = useCallback(() => {
    previewSession.current.invalidate()
    setFilterPreviewPending(false)
    setFilterPreview(null)
  }, [])

  useEffect(() => {
    if (sharedProviderFiles) setProviderFiles(sharedProviderFiles)
  }, [sharedProviderFiles])

  const dirty = isSubscriptionDirty(form, savedForm, newDraft)
  dirtyRef.current = dirty
  const active = useMemo(
    () => items.find((item) => item.id === activeId) ?? null,
    [activeId, items]
  )
  const valid = canSaveSubscriptionDraft(form, Boolean(activeId))

  const select = useCallback((item: ConfigSubscription | null, name = "") => {
    resetFilterPreview()
    if (item) {
      const draft = subscriptionDraftFromSnapshot(item)
      subscriptionWorkspaceCache.activeId = item.id
      activeIdRef.current = item.id
      setActiveId(item.id)
      setForm(draft)
      setSavedForm(draft)
      setNewDraft(false)
      setFilterDraft({ enabled: item.filterSettings.enabled, rules: (item.filterSettings.rules.length ? item.filterSettings.rules : DEFAULT_PROVIDER_FILTER_RULES).join("\n") })
    } else {
      subscriptionWorkspaceCache.activeId = null
      activeIdRef.current = null
      setActiveId(null)
      setForm(emptySubscriptionDraft(name))
      setSavedForm(emptySubscriptionDraft())
      setNewDraft(true)
    }
  }, [resetFilterPreview])

  const publishItem = useCallback((saved: ConfigSubscription) => {
    const nextItems = upsertSubscriptionSnapshot(
      subscriptionWorkspaceCache.items,
      saved
    )
    subscriptionWorkspaceCache.items = nextItems
    setItems(nextItems)
  }, [])

  const clear = useCallback(() => {
    subscriptionWorkspaceCache.activeId = null
    activeIdRef.current = null
    setActiveId(null)
    setForm(emptySubscriptionDraft())
    setSavedForm(emptySubscriptionDraft())
    setNewDraft(false)
  }, [])

  const load = useCallback(
    async (preferredId?: string, confirmDiscard = false) => {
      if (updatingIdRef.current) return
      if (
        confirmDiscard &&
        dirty &&
        !(await askConfirm({
          title: "重新读取订阅？",
          message: "未保存的订阅更改将丢失。",
          confirmLabel: "放弃并重新读取",
          danger: true,
        }))
      )
        return

      const request = loadRequests.current.begin()
      if (!request.isCurrent()) return
      setBusy("load")
      try {
        const [subscriptions, nextProviderFiles] = await Promise.all([
          listSubscriptions(request.signal),
          listManagedProviderFiles(request.signal),
        ])
        if (!request.isCurrent()) return
        subscriptionWorkspaceCache.items = subscriptions
        subscriptionWorkspaceCache.initialized = true
        setItems(subscriptions)
        setProviderFiles(nextProviderFiles)
        onProviderFilesCommit(nextProviderFiles)
        setUnavailable(false)
        const selected =
          subscriptions.find((item) => item.id === preferredId) ??
          subscriptions[0] ??
          null
        if (selected) select(selected)
        else clear()
      } catch (error) {
        if (!request.isCurrent()) return
        setUnavailable(error instanceof ConfigError && error.status === 0)
        if (!(error instanceof ConfigError && error.status === 0))
          notify(configErrorMessage(error as Error), "error")
      } finally {
        if (request.finish()) setBusy(null)
      }
    },
    [askConfirm, clear, dirty, notify, onProviderFilesCommit, select]
  )

  useEffect(() => {
    mounted.current = true
    loadRequests.current = new LatestRequestController()
    if (!subscriptionWorkspaceCache.initialized) void load()
    return () => {
      mounted.current = false
      loadRequests.current.dispose()
      previewSession.current.invalidate()
    }
  }, [])

  const requestSelection = async (item: ConfigSubscription) => {
    if (busy) return false
    if (item.id === activeId && !newDraft) return true
    if (
      dirty &&
      !(await askConfirm({
        title: "放弃未保存更改？",
        message: "继续切换会丢弃当前本地修改。",
        confirmLabel: "放弃并切换",
        danger: true,
      }))
    )
      return false
    if (!mounted.current) return false
    select(item)
    return true
  }

  const save = async () => {
    if (!valid || !dirty || busy || updatingIdRef.current) return
    setBusy("save")
    try {
      if (
        active?.binding &&
        (!form.extractProvider ||
          !form.mergeIntoConfig ||
          active.binding.configName !== form.configName ||
          active.binding.providerName !== form.providerName ||
          JSON.stringify(active.binding.groupNames) !== JSON.stringify(form.groupNames))
      ) {
        const saved = await migrateSubscriptionBinding(
          active,
          form,
          syncConfigSnapshot
        )
        if (!mounted.current) return
        publishItem(saved)
        select(saved)
        notify("订阅设置已保存")
        return
      }
      let saved = activeId
        ? await updateSubscription(activeId, form)
        : await createSubscription(form)
      if (saved.extractProvider && !saved.providerSha256) {
        try {
          const generated = await generateInitialProviderAndApplyBinding(saved, syncConfigSnapshot)
          saved = generated.subscription
          if (generated.refreshError) {
            notify("Provider 已生成，但订阅列表刷新失败", "error")
          }
        } catch (error) {
          if (!(error instanceof InitialProviderGenerationError)) throw error
          if (!mounted.current) return
          publishItem(saved)
          select(saved)
          notify("提取设置已保存，但 Provider 首次生成失败；尚未写入配置绑定", "error")
          return
        }
      }
      if (saved.mergeIntoConfig && saved.providerSha256 && !saved.binding)
        saved = await applySubscriptionConfigBinding(saved, null, syncConfigSnapshot)
      if (!mounted.current) return
      publishItem(saved)
      select(saved)
      notify(activeId ? "订阅设置已保存" : "订阅已创建")
    } catch (error) {
      if (!mounted.current) return
      notify(configErrorMessage(error as Error), "error")
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const updateItem = async (item: ConfigSubscription) => {
    if (!canStartSubscriptionUpdate({
      busy,
      updatingId: updatingIdRef.current,
      itemId: item.id,
      activeId: activeIdRef.current,
      dirty: dirtyRef.current,
    })) return false
    const id = item.id
    updatingIdRef.current = id
    setUpdatingId(id)
    try {
      const result = await updateSubscriptionAndReloadProvider(
        id,
        undefined,
        async (provider) => {
          if (provider.config) syncConfigSnapshot(provider.config)
          if (
            !item.mergeIntoConfig ||
            item.binding?.status === "active" ||
            !provider.providerName ||
            !provider.providerPath
          ) return
          const claimed = await applySubscriptionConfigBinding(
            item,
            provider,
            syncConfigSnapshot
          )
          if (mounted.current) publishItem(claimed)
        }
      )
      if (!mounted.current) return
      notify(subscriptionRefreshMessage(result))
      const refreshed = await listSubscriptions()
      if (!mounted.current) return
      subscriptionWorkspaceCache.items = refreshed
      setItems(refreshed)
      const selectedId = activeIdRef.current
      const selected = refreshedSubscriptionSelection(refreshed, selectedId, dirtyRef.current)
      if (selected) select(selected)
    } catch (error) {
      if (!mounted.current) return
      if (error instanceof ProviderReloadError) {
        notify(providerRefreshFailureMessage(error.cause), "error")
      } else {
        notify(subscriptionUpdateErrorMessage(error), "error")
      }
      const refreshed = await listSubscriptions().catch(() => null)
      if (mounted.current && refreshed) {
        subscriptionWorkspaceCache.items = refreshed
        setItems(refreshed)
      }
    } finally {
      if (mounted.current) {
        if (updatingIdRef.current === id) {
          updatingIdRef.current = null
          setUpdatingId(null)
        }
      }
    }
    return true
  }

  const updateActive = async () => {
    if (active) await updateItem(active)
  }

  const saveMergeSettings = async (
    item: ConfigSubscription,
    patch: Pick<ConfigSubscriptionInput, "extractProvider" | "providerName" | "mergeIntoConfig" | "configName" | "groupNames">,
  ) => {
    if (busy || updatingIdRef.current) return null
    const nextForm = editSubscriptionDraft(subscriptionDraftFromSnapshot(item), patch)
    setBusy("save")
    try {
      let saved: ConfigSubscription
      if (
        item.binding &&
        (!nextForm.extractProvider || !nextForm.mergeIntoConfig ||
          item.binding.configName !== nextForm.configName ||
          item.binding.providerName !== nextForm.providerName ||
          JSON.stringify(item.binding.groupNames) !== JSON.stringify(nextForm.groupNames))
      ) {
        saved = await migrateSubscriptionBinding(item, nextForm, syncConfigSnapshot)
      } else {
        saved = await updateSubscription(item.id, nextForm)
      }
      if (saved.extractProvider && !saved.providerSha256) {
        try {
          const generated = await generateInitialProviderAndApplyBinding(saved, syncConfigSnapshot)
          saved = generated.subscription
          if (generated.refreshError) notify("Provider 已生成，但运行态刷新失败", "error")
        } catch (error) {
          if (!(error instanceof InitialProviderGenerationError)) throw error
          if (!mounted.current) return null
          publishItem(saved)
          if (activeIdRef.current === saved.id && !dirtyRef.current) select(saved)
          notify("提取设置已保存，但 Provider 首次生成失败", "error")
          return saved
        }
      }
      if (saved.mergeIntoConfig && saved.providerSha256 && !saved.binding) {
        saved = await applySubscriptionConfigBinding(saved, null, syncConfigSnapshot)
      }
      if (!mounted.current) return null
      publishItem(saved)
      if (activeIdRef.current === saved.id && !dirtyRef.current) select(saved)
      notify("订阅设置已保存")
      return saved
    } catch (error) {
      if (mounted.current) notify(configErrorMessage(error as Error), "error")
      return null
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const removePending = async () => {
    if (!pendingDelete || busy || updatingIdRef.current) return
    const deleting = pendingDelete
    setPendingDelete(null)
    setBusy("delete")
    try {
      if (deleting.binding) {
        await deleteSubscriptionAfterBindingRemoval(
          deleting,
          syncConfigSnapshot,
          publishItem
        )
      } else await deleteSubscription(deleting.id)
      if (!mounted.current) return
      const remaining = removeSubscriptionSnapshot(items, deleting.id)
      subscriptionWorkspaceCache.items = remaining
      setItems(remaining)
      if (!newDraft && deleting.id === activeId) {
        const selected = remaining[0] ?? null
        if (selected) select(selected)
        else clear()
      }
      notify("订阅已删除")
    } catch (error) {
      if (!mounted.current) return
      notify(configErrorMessage(error as Error), "error")
      await load(activeId ?? undefined)
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const createDraft = async () => {
    if (busy || updatingIdRef.current) return false
    if (
      dirty &&
      !(await askConfirm({
        title: "放弃未保存更改？",
        message: "创建新草稿会丢弃当前订阅的本地修改。",
        confirmLabel: "放弃并创建",
        danger: true,
      }))
    )
      return false
    if (!mounted.current) return false
    select(null)
    return true
  }

  const discardDraft = async () => {
    if (busy || updatingIdRef.current) return
    if (
      !(await askConfirm({
        title: "删除未保存的订阅？",
        message: "这个订阅尚未保存，删除后无法恢复。",
        confirmLabel: "删除草稿",
        danger: true,
      }))
    )
      return
    if (!mounted.current) return
    const selected = items[0] ?? null
    if (selected) select(selected)
    else clear()
  }

  const resetToSaved = () => {
    if (newDraft) {
      const selected = items[0] ?? null
      if (selected) select(selected)
      else clear()
    } else {
      setForm(savedForm)
    }
  }

  const edit = (patch: Partial<ConfigSubscriptionInput>) =>
    setForm((current) => ({ ...current, ...patch }))

  const requestDelete = (item: ConfigSubscription) => {
    if (!busy && !updatingIdRef.current) setPendingDelete(item)
  }

  const filterRules = () => filterDraft.rules.split(/\r?\n/).map((rule) => rule.trim()).filter(Boolean)
  const filterError = mergeFilterRuleError(filterDraft.rules)
  const saveActiveFilter = async () => {
    if (!active || busy || updatingIdRef.current || filterError) return false
    setBusy("save")
    try {
      const settings = await saveSubscriptionFilterSettings(active.id, {
        version: active.filterSettings.version,
        enabled: filterDraft.enabled,
        rules: filterRules(),
      })
      publishItem({ ...active, filterSettings: settings })
      notify(settings.enabled ? "过滤已保存，下次订阅更新时生效" : "过滤已关闭，重新更新订阅后恢复完整内容")
      return true
    } catch (error) {
      notify(configErrorMessage(error as Error), "error")
      return false
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const previewActiveFilter = async () => {
    if (!active || busy || updatingIdRef.current || filterError) return false
    const rules = filterRules()
    const rulesVersion = filterDraft.rules
    const targetKey = subscriptionPreviewIdentity(active.id, rulesVersion)
    const request = previewSession.current.start(
      { subscriptionId: active.id, rules, rulesVersion },
      previewSubscriptionFilter,
    )
    if (!request) return false
    setFilterPreview(null)
    setFilterPreviewPending(true)
    try {
      const result = await request.promise
      if (
        mounted.current &&
        previewSession.current.isCurrent(request.key) &&
        targetKey === subscriptionPreviewIdentity(activeIdRef.current ?? "", filterDraft.rules)
      ) setFilterPreview(result)
      return true
    } catch (error) {
      if (previewSession.current.isCurrent(request.key)) notify(configErrorMessage(error as Error), "error")
      return false
    } finally {
      if (previewSession.current.finish(request.key) && mounted.current) setFilterPreviewPending(false)
    }
  }

  const editFilterDraft = (patch: Partial<typeof filterDraft>) => {
    resetFilterPreview()
    setFilterDraft((current) => ({ ...current, ...patch }))
  }

  return {
    active,
    activeId,
    busy,
    dirty,
    form,
    items,
    newDraft,
    pendingDelete,
    unavailable,
    updatingId,
    writeLocked: busy !== null || updatingId !== null,
    valid,
    filterDraft,
    filterError,
    filterPreview,
    filterPreviewPending,
    cancelDelete: () => setPendingDelete(null),
    createDraft,
    discardDraft,
    edit,
    load,
    removePending,
    requestDelete,
    requestSelection,
    resetToSaved,
    save,
    saveMergeSettings,
    setFilterDraft: editFilterDraft,
    saveActiveFilter,
    previewActiveFilter,
    updateActive,
    updateItem,
  }
}
