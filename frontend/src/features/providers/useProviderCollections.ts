import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { withMinimumSpin } from "@/hooks/useAnimatedAction"
import type { Notify } from "@/shared/types"

import {
  providerActionKey,
  providerDisplayName,
  collectionRuntimeLists,
  type ProviderCategorySnapshot,
  type ProviderAction,
  type ProviderCategory,
  type ProviderMap,
} from "./collectionViewModel"
import { CollectionRequestController } from "./collectionRequests"
import {
  healthCheckCollectionProvider,
  mergeCollectionProviderTargets,
  readCollectionProvider,
  readCollectionProviders,
  updateCollectionProvider,
  updateCollectionProviders,
} from "./providerOperations"

const categories: ProviderCategory[] = ["proxy", "rule"]

const providerCollectionsCache: {
  sourceKey: string
  providerMaps: Record<ProviderCategory, ProviderMap>
  activeNames: Partial<Record<ProviderCategory, string>>
} = {
  sourceKey: "",
  providerMaps: { proxy: {}, rule: {} },
  activeNames: {},
}

export function useProviderCollections(notify: Notify, sourceKey: string) {
  const [snapshots, setSnapshots] = useState<Partial<Record<ProviderCategory, ProviderCategorySnapshot>>>(() => {
    if (sourceKey && providerCollectionsCache.sourceKey === sourceKey) {
      return {
        proxy: { sourceKey, providers: providerCollectionsCache.providerMaps.proxy, loading: false },
        rule: { sourceKey, providers: providerCollectionsCache.providerMaps.rule, loading: false },
      }
    }
    return {}
  })
  const { providerMaps, loading, loadErrors } = useMemo(
    () => collectionRuntimeLists(sourceKey, snapshots), [sourceKey, snapshots],
  )
  const sourceKeyRef = useRef(sourceKey)
  sourceKeyRef.current = sourceKey
  const [activeNames, setActiveNames] = useState<
    Partial<Record<ProviderCategory, string>>
  >(providerCollectionsCache.activeNames)
  const [actions, setActions] = useState<Map<string, ProviderAction>>(new Map())
  const [batchProgress, setBatchProgress] = useState<{
    category: ProviderCategory
    completed: number
    total: number
  } | null>(null)
  const [sourceRevisions, setSourceRevisions] = useState<Record<string, number>>({})
  const busyActions = useRef(new Set<string>())
  const requests = useRef(new CollectionRequestController())

  const invalidateProviderSource = useCallback((category: ProviderCategory, names: string | string[]) => {
    const targets = Array.isArray(names) ? names : [names]
    setSourceRevisions((current) => {
      const next = { ...current }
      for (const name of targets) {
        const key = providerActionKey(category, name)
        next[key] = (next[key] ?? 0) + 1
      }
      return next
    })
  }, [])

  const mergeCategoryProviders = useCallback((category: ProviderCategory, updates: ProviderMap) => {
    if (!Object.keys(updates).length || sourceKeyRef.current !== sourceKey) return
    // Publish in the category request lane so an earlier list cannot overwrite this result.
    const publication = requests.current.beginCategory(category)
    if (!publication.finish()) return
    setSnapshots((current) => {
      const snapshot = current[category]
      if (!snapshot || snapshot.sourceKey !== sourceKey || sourceKeyRef.current !== sourceKey) return current
      const providers = mergeCollectionProviderTargets(snapshot.providers, updates)
      providerCollectionsCache.providerMaps[category] = providers
      return { ...current, [category]: { sourceKey, providers, loading: false } }
    })
  }, [sourceKey])

  const loadCategory = useCallback(async (category: ProviderCategory) => {
    if (sourceKeyRef.current !== sourceKey) return
    const request = requests.current.beginCategory(category)
    if (!request.isCurrent()) return
    const isCurrent = () => request.isCurrent() && sourceKeyRef.current === sourceKey
    setSnapshots((current) => {
      const existing = current[category]
      const existingProviders = existing?.sourceKey === sourceKey ? existing.providers
        : providerCollectionsCache.sourceKey === sourceKey ? providerCollectionsCache.providerMaps[category] : {}
      return { ...current, [category]: { sourceKey, providers: existingProviders, loading: true } }
    })
    try {
      const providers = await readCollectionProviders(category, request.signal)
      if (!isCurrent()) return
      setSnapshots((current) => ({ ...current, [category]: { sourceKey, providers, loading: false } }))
      providerCollectionsCache.providerMaps[category] = providers
      setActiveNames((current) => {
        const currentName = current[category]
        const nextName = currentName && providers[currentName]
          ? currentName
          : Object.keys(providers)[0]
        const next = { ...current, [category]: nextName }
        providerCollectionsCache.activeNames = next
        return next
      })
    } catch (error) {
      if (!isCurrent()) return
      const message = (error as Error).message
      setSnapshots((current) => ({ ...current, [category]: { sourceKey, providers: {}, loading: false, error: message } }))
      notify(message, "error")
    } finally {
      request.finish()
    }
  }, [notify, sourceKey])

  useEffect(() => {
    const activeRequests = new CollectionRequestController()
    requests.current = activeRequests
    setActions(new Map())
    if (providerCollectionsCache.sourceKey !== sourceKey) {
      providerCollectionsCache.sourceKey = sourceKey
      providerCollectionsCache.providerMaps = { proxy: {}, rule: {} }
    }
    // 来源名或版本改变时，同时取消并重读两类列表。
    void Promise.all(categories.map((category) => loadCategory(category)))
    return () => {
      activeRequests.dispose()
    }
  }, [loadCategory, sourceKey])

  const runProviderAction = useCallback(async (
    action: ProviderAction,
    category: ProviderCategory,
    name: string
  ) => {
    if (requests.current.batchRunning || sourceKeyRef.current !== sourceKey) return false
    const key = providerActionKey(category, name)
    if (busyActions.current.has(key)) return false
    busyActions.current.add(key)

    const activeRequests = requests.current
    const controller = activeRequests.beginAction()
    const isCurrent = () => !controller.signal.aborted && requests.current === activeRequests && sourceKeyRef.current === sourceKey
    if (!isCurrent()) {
      busyActions.current.delete(key)
      return false
    }
    setActions((current) => new Map(current).set(key, action))
    try {
      await withMinimumSpin(
        action === "update"
          ? updateCollectionProvider(category, name, controller.signal)
          : healthCheckCollectionProvider(name, controller.signal)
      )
      if (!isCurrent()) return false
      if (action === "update") invalidateProviderSource(category, name)
      const updates = await readCollectionProvider(category, name, controller.signal)
      if (!isCurrent()) return false
      mergeCategoryProviders(category, updates)
      if (isCurrent()) {
        notify(
          action === "update"
            ? `${providerDisplayName(name)} 已更新`
            : `${providerDisplayName(name)} 健康检查完成`
        )
      }
      return true
    } catch (error) {
      if (isCurrent()) notify((error as Error).message, "error")
      return false
    } finally {
      activeRequests.finishAction(controller)
      busyActions.current.delete(key)
      if (isCurrent()) {
        setActions((current) => {
          const next = new Map(current)
          next.delete(key)
          return next
        })
      }
    }
  }, [invalidateProviderSource, mergeCategoryProviders, notify, sourceKey])

  const updateProvider = useCallback(
    (category: ProviderCategory, name: string) =>
      runProviderAction("update", category, name),
    [runProviderAction]
  )
  const healthCheckProvider = useCallback(
    (name: string) => runProviderAction("healthcheck", "proxy", name),
    [runProviderAction]
  )

  const updateAllProviders = useCallback(async (category: ProviderCategory) => {
    if (requests.current.batchRunning || busyActions.current.size > 0) return false
    const names = Object.keys(providerCollectionsCache.providerMaps[category])
    if (!names.length) return false
    const batch = requests.current.beginBatch(() => setBatchProgress(null))
    if (!batch) return false
    setBatchProgress({ category, completed: 0, total: names.length })
    try {
      const result = await updateCollectionProviders(
        category,
        names,
        batch.signal,
        (completed, total) => {
          if (!batch.signal.aborted) setBatchProgress({ category, completed, total })
        },
      )
      if (batch.signal.aborted) return false
      invalidateProviderSource(category, names)
      await loadCategory(category)
      if (!batch.signal.aborted) {
        notify(`全部更新完成：成功 ${result.success}，失败 ${result.failed}`, result.failed ? "error" : "ok")
      }
      return true
    } catch (error) {
      if (!batch.signal.aborted) notify((error as Error).message, "error")
      return false
    } finally {
      batch.finish()
    }
  }, [invalidateProviderSource, loadCategory, notify])

  const selectProvider = useCallback((category: ProviderCategory, name: string) => {
    setActiveNames((current) => {
      const next = { ...current, [category]: name }
      providerCollectionsCache.activeNames = next
      return next
    })
  }, [])

  return {
    providerMaps,
    activeNames,
    loading,
    loadErrors,
    actions,
    batchProgress,
    sourceRevisions,
    loadCategory,
    updateProvider,
    updateAllProviders,
    healthCheckProvider,
    selectProvider,
    invalidateProviderSource,
    mergeCategoryProviders,
  }
}
