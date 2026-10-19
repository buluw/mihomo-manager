import { configErrorMessage } from "../../shared/configMessages.ts";
import { configValidationErrorMessage, retainedProviderMessage, providerFilesErrorMessage } from "../../shared/configMessages.ts";
import { parseYamlDraft as parseDocument } from "../../shared/yamlDraft.ts"
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"

import {
  ConfigError,
  readCollectionPreferences,
  saveCollectionReadOnly,
  saveCollectionSettings,
  type CollectionPreferences,
  createConfigChangeSource,
  readCollectionUploadDeclaration,
  readProviderPayload,
  type ProxyCollectionInput,
  deleteManagedProviderFile,
  deleteManagedProviderSource,
  deleteManagedProviderWithConfig,
  listManagedProviderFiles,
  listManagedHttpProviders,
  readConfigFile,
  resolveCollectionPath,
  readRuntimeLoadState,
  readManagedProviderFile,
  saveConfigFile,
  saveCollectionWorkspace,
  validateCollectionWorkspace,
  type ConfigSnapshot,
  type ManagedProviderFile,
  type ManagedHttpProviderOwner,
  type ManagedProviderFileSnapshot,
} from "@/api/configClient";
import { LatestRequestController } from "@/shared/requestLifecycle"
import { applyRuntimeConfig, RuntimeApplyError, runtimeSourceIdentity, confirmedRuntimeSource } from "@/shared/runtimeApplication"
import type { Notify } from "@/shared/types"
import { collectionSourceMatches, type CollectionSource } from "@/shared/collectionTarget"
import { restoreCollectionPath } from "@/shared/collectionPath"
import { cleanupSummary } from "@/shared/collectionCleanup"
import type { ProviderCategory } from "./collectionViewModel"
import { createCollectionDraft, readUploadDeclaration } from "./proxyCollectionImport"
import { assertCollectionPathAvailable, collectionFileName, patchCollectionIdentity, stageCollectionSettings, suggestedCollectionFileName } from "./collectionNaming"
import {
  managedConfigIdentity,
  managedHttpOwnerChangeIds,
  managedProviderFileHasDraft,
  managedCollectionBodyDrafts,
  managedProviderRuntimePaired,
  updateInlineDraftState,
  externalManagedConfigDecision,
  managedPendingChangeIds,
  managedProviderDraftIssue,
  managedProviderDiscardState,
  managedProviderRowOperationPending,
  managementBaselineKey,
  managementBaselineResourcesChanged,
  managementLifecycleState,
  managementLifecycleView,
  reduceManagementLifecycle,
  reconcileManagedProviderDraft,
  reconcileManagedProviderTextEdit,
  resolveManagedProviderBaseline,
  type ManagementBaseline,
} from "./managedProviderState"
import {
  managedProviderControlsForItem as controlsFor,
  managedProviderContentKey,
  managedProviderModificationReason,
  managedCollectionItems,
  managedProviderDeclarationSnippet,
  type ManagedProviderItem,
  type ManagedProviderControls,
} from "./managedProviderModel"
import { replaceCollectionUploadDeclaration, deleteManagedProviderConfig, replaceProviderDraftText, replaceProviderDrafts, inlineProviderDraftText, updateHttpProviderContent } from "./managedProviderYaml"
import {
  updateCollectionProvider,
  type ManagedProviderApplyResult,
  type ManagedProviderRemovalResult,
} from "./providerOperations"

type ItemControls = ManagedProviderControls

const managementBaselineCache = new Map<string, ManagementBaseline>()
let unifiedSession: {
  baseline: ManagementBaseline
  activeIds: Partial<Record<ProviderCategory, string>>
  contents: Record<string, string>
  preferences: CollectionPreferences
  savedPending: boolean
} | null = null

function providerError(error: unknown) {
  if (error instanceof ConfigError && error.code === "runtime_reference") return "最近成功加载的运行文件仍引用该集合；请先处理引用并应用配置，再删除文件"
  if (error instanceof ConfigError && error.code === "runtime_unknown") return "运行依赖无法确认，集合文件已保留"
  const diagnostic = configValidationErrorMessage(error)
  if (diagnostic) return diagnostic
  const issue = providerFilesErrorMessage(error)
  if (issue) return issue
  if (error instanceof ConfigError && error.code === "provider_file_referenced") {
    const names = Array.isArray(error.details.configNames)
      ? error.details.configNames.filter((name): name is string => typeof name === "string")
      : []
    return names.length ? `仍被配置引用：${names.join("、")}` : "Provider 文件仍被配置引用"
  }
  if (error instanceof ConfigError && error.code === "provider_file_conflict") return "Provider 文件已被其他设备修改"
  if (error instanceof ConfigError && error.code === "config_conflict") return "当前配置已被其他设备修改"
  if (error instanceof ConfigError && error.code === "provider_file_exists") return "集合名称、代理组名称或文件已存在，请检查当前主配置"
  if (error instanceof ConfigError && error.code === "invalid_provider_file") return "集合内容或设置无效，请检查当前代理集合或规则集合的格式、名称及配置引用。"
  return error instanceof Error ? configErrorMessage(error) : "集合操作失败"
}

export function useManagedProviderWorkspace(
  category: ProviderCategory,
  notify: Notify,
  options: { inputDirty?: boolean;
    source?: CollectionSource | null; invalidSource?: boolean; targetName?: string | null;
    onSourceChange?: (source: CollectionSource, item?: { category: ProviderCategory; name: string }) => void } = {},
) {
  const explicitSource = useRef(options.source ?? null)
  const previousSource = useRef(options.source)
  const externalSourceRevision = useRef("")
  if (!collectionSourceMatches(previousSource.current ?? null, options.source ?? null) &&
    (previousSource.current || options.source)) {
    if (!collectionSourceMatches(explicitSource.current, options.source ?? null)) {
      externalSourceRevision.current = `${options.source?.name}:${options.source?.sha256}`
    }
    explicitSource.current = options.source ?? null
    previousSource.current = options.source
  }
  const onSourceChange = useRef(options.onSourceChange)
  onSourceChange.current = options.onSourceChange
  const acceptSourceCommit = useCallback((source: CollectionSource, item?: { category: ProviderCategory; name: string }) => {
    if (!explicitSource.current || explicitSource.current.name !== source.name) return
    explicitSource.current = { name: source.name, sha256: source.sha256 }
    onSourceChange.current?.(explicitSource.current, item)
  }, [])
  const inputDirtyRef = useRef(options.inputDirty)
  inputDirtyRef.current = options.inputDirty
  const [initialSession] = useState(() => !options.source && !options.invalidSource ? unifiedSession : null)
  const [preferences, setPreferences] = useState<CollectionPreferences>(() =>
    initialSession?.preferences ?? { version: 0, readOnly: [] }
  )
  const initialBaseline = initialSession
    ? initialSession.baseline
    : options.source
    ? managementBaselineCache.get(managementBaselineKey(true, options.source.name, options.source.sha256)!)
    : undefined
  const [httpOwners, setHttpOwners] = useState<ManagedHttpProviderOwner[]>(initialBaseline?.httpOwners ?? [])
  const [configContent, setConfigContent] = useState(initialBaseline?.snapshot.content ?? "")
  const [lastValidConfigContent, setLastValidConfigContent] = useState(initialBaseline?.snapshot.content ?? "")
  const [controls, setControls] = useState<Record<string, ItemControls>>(initialBaseline?.controls ?? {})
  const [managementLifecycle, dispatchManagementLifecycle] = useReducer(
    reduceManagementLifecycle,
    initialBaseline ?? null,
    managementLifecycleState,
  )
  const [contents, setContents] = useState<Record<string, string>>(() =>
    ({ ...initialSession?.contents })
  )
  const [savedContents, setSavedContents] = useState<Record<string, string>>(() =>
    ({ ...initialSession?.contents })
  )
  const [contentErrors, setContentErrors] = useState<Record<string, string | null>>({})
  const [readErrors, setReadErrors] = useState<Record<string, string | null>>({})
  const [configContentError, setConfigContentError] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [declarationDrafts, setDeclarationDrafts] = useState<Record<string, string>>({})
  const [declarationErrors, setDeclarationErrors] = useState<Record<string, string | null>>({})
  const [activeIds, setActiveIds] = useState<Partial<Record<ProviderCategory, string>>>(() =>
    ({ ...initialSession?.activeIds })
  )
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [runtimeSourceName, setRuntimeSourceName] = useState<string | null>(null)
  const [runtimeSource, setRuntimeSource] = useState<CollectionSource | null>(null)
  const [pendingRemovals, setPendingRemovals] = useState<Array<{ category: ProviderCategory; name: string }>>([])
  const [savedPending, setSavedPending] = useState(initialSession?.savedPending ?? false)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const requests = useRef<LatestRequestController | null>(null)
  const contentRequests = useRef(new LatestRequestController())
  const configContentRef = useRef(initialBaseline?.snapshot.content ?? "")
  const lastValidConfigContentRef = useRef(initialBaseline?.snapshot.content ?? "")
  const contentsRef = useRef<Record<string, string>>({ ...initialSession?.contents })
  const contentErrorsRef = useRef<Record<string, string | null>>({})
  const dirtyRef = useRef(false)

  const managementBaseline = managementLifecycle.baseline
  const managementBaselineRef = useRef(managementBaseline)
  managementBaselineRef.current = managementBaseline
  const snapshot = managementBaseline?.snapshot ?? null
  const files = managementBaseline?.files ?? []
  const savedHttpOwners = managementBaseline?.httpOwners ?? []
  const baselineControls = managementBaseline?.controls ?? {}
  const identityStatus = managementLifecycle.status
  const message = managementLifecycle.message

  useEffect(() => {
    // Only cache a coherent, accepted source and its saved bodies, never drafts.
    if (options.source || options.invalidSource) return
    if (identityStatus === "ready" && managementBaseline && runtimeSourceName === managementBaseline.snapshot.name && !parseDocument(managementBaseline.snapshot.content).errors.length) {
      unifiedSession = { baseline: managementBaseline, activeIds, contents: savedContents, preferences, savedPending }
    } else if (identityStatus === "unavailable" || identityStatus === "error" || identityStatus === "stale" || (managementBaseline && parseDocument(managementBaseline.snapshot.content).errors.length)) {
      unifiedSession = null
    }
  }, [options.source, options.invalidSource, identityStatus, managementBaseline, runtimeSourceName, activeIds, savedContents, preferences, savedPending])

  const readOnlyForItem = (item: ManagedProviderItem) => preferences.readOnly.includes(JSON.stringify([snapshot?.name, item.category, item.name]))
  const itemReader = managedCollectionItems
  const itemsByCategory = useMemo(() => {
    const itemsFor = (providerCategory: ProviderCategory) => {
      if (!snapshot) return []
      return itemReader(
        { ...snapshot, content: lastValidConfigContent },
        files,
        providerCategory,
        httpOwners,
        { ...snapshot, content: parseDocument(snapshot.content).errors.length ? lastValidConfigContent : snapshot.content },
      )
    }
    return { proxy: itemsFor("proxy"), rule: itemsFor("rule") }
  }, [files, httpOwners, itemReader, lastValidConfigContent, snapshot])
  const items = itemsByCategory[category]
  const activeId = activeIds[category]
  const active = options.targetName
    ? items.find((item) => item.name === options.targetName) ?? null
    : items.find((item) => item.id === activeId || item.name === activeId) ?? items[0] ?? null
  const canApply = Boolean(snapshot)
  const configDirty = Boolean(snapshot && configContent !== snapshot.content)
  const changedHttpOwnerIds = useMemo(() => {
    return managedHttpOwnerChangeIds(httpOwners, savedHttpOwners)
  }, [httpOwners, savedHttpOwners])
  const pendingItemIds = useMemo(
    () => managedPendingChangeIds(controls, baselineControls, changedHttpOwnerIds),
    [baselineControls, changedHttpOwnerIds, controls],
  )
  const contentDirty = active
    ? (contents[managedProviderContentKey(active)] ?? active.content) !== (savedContents[managedProviderContentKey(active)] ?? active.content)
    : false
  const declarationDirtyIds = Object.keys(declarationDrafts).filter((id) => {
    const item = [...itemsByCategory.proxy, ...itemsByCategory.rule].find((candidate) => candidate.id === id)
    return item ? declarationDrafts[id] !== managedProviderDeclarationSnippet(item) : true
  })
  const contentDirtyIds = useMemo(
    () => new Set([...itemsByCategory.proxy, ...itemsByCategory.rule].filter((item) => {
      const key = managedProviderContentKey(item)
      return contents[key] !== undefined && contents[key] !== (savedContents[key] ?? item.content)
    }).map((item) => item.id)),
    [contents, itemsByCategory, savedContents],
  )
  const declarationDirtyIdSet = useMemo(() => new Set(declarationDirtyIds), [declarationDirtyIds])
  const contentDraftDirty = Object.keys(contents).some((key) => contents[key] !== savedContents[key])
  const dirty = configDirty || pendingItemIds.size > 0 ||
    contentDraftDirty || declarationDirtyIds.length > 0
  dirtyRef.current = dirty
  const fileHasDraftRef = useRef<(item: ManagedProviderItem) => boolean>(() => true)
  fileHasDraftRef.current = (item) => managedProviderFileHasDraft(item, itemsByCategory[item.category],
    contentsRef.current, savedContents, pendingItemIds, declarationDirtyIdSet)
  const managementView = managementLifecycleView(managementLifecycle, busy)
  const writeDisabled = managementView.writeDisabled || !canApply
  const declarationError = Object.values(declarationErrors).find((value): value is string => Boolean(value)) ?? null
  const draftIssue = declarationError ?? managedProviderDraftIssue(controls, itemsByCategory)
  const itemOperationPending = useCallback((item: ManagedProviderItem) =>
    managedProviderRowOperationPending(item, pendingItemIds, contentDirtyIds, declarationDirtyIdSet),
  [contentDirtyIds, declarationDirtyIdSet, pendingItemIds])

  const verifySource = useCallback(async () => {
    const target = explicitSource.current
    if (options.invalidSource) throw new Error("集合编辑目标不完整，请返回编辑配置确认来源")
    if (target) {
      const fresh = await readConfigFile(target.name)
      if (!collectionSourceMatches(snapshot, target) || !collectionSourceMatches(fresh, target)) {
        throw new ConfigError("configuration changed", 409, "config_conflict")
      }
      return
    }
    const source = confirmedRuntimeSource(await readRuntimeLoadState())
    if (!snapshot || source?.name !== snapshot.name) throw new Error("集合来源身份已变化；草稿已保留，请重新读取确认")
  }, [options.invalidSource, snapshot])

  const runtimePaired = managedProviderRuntimePaired(snapshot, runtimeSourceName, identityStatus) &&
    (!options.source || collectionSourceMatches(snapshot, runtimeSource))
  const verifyRuntimeSource = useCallback(async () => {
    if (!snapshot) return
    const source = confirmedRuntimeSource(await readRuntimeLoadState().catch(() => null))
    setRuntimeSourceName(source?.name ?? null)
    setRuntimeSource(source)
    if (managedProviderRuntimePaired(snapshot, source?.name ?? null, identityStatus) &&
      (!explicitSource.current || collectionSourceMatches(snapshot, source))) return
    const message = "编辑来源与最近成功加载来源未配对；草稿已保留，请重新读取确认后操作运行集合"
    dispatchManagementLifecycle({ type: "external-conflict", message })
    throw new Error(message)
  }, [identityStatus, snapshot])

  const discardDrafts = useCallback(() => {
    if (busy) return false
    const baseline = managementBaselineRef.current
    if (!baseline) return true
    const reset = managedProviderDiscardState(baseline)
    configContentRef.current = reset.configContent
    lastValidConfigContentRef.current = reset.lastValidConfigContent
    contentsRef.current = reset.contents
    contentErrorsRef.current = reset.contentErrors
    dirtyRef.current = false
    setConfigContent(reset.configContent)
    setLastValidConfigContent(reset.lastValidConfigContent)
    setHttpOwners(reset.httpOwners)
    setControls(reset.controls)
    setContents(reset.contents)
    setSavedContents(reset.savedContents)
    setContentErrors(reset.contentErrors)
    setDeclarationDrafts(reset.declarationDrafts)
    setDeclarationErrors(reset.declarationErrors)
    setConfigContentError(reset.configContentError)
    setPendingRemovals([])
    return true
  }, [baselineControls, busy, files, savedHttpOwners, snapshot])

  const refresh = useCallback(async (committed = false, throwOnError = false) => {
    const activeRequests = requests.current
    if (!activeRequests || (busyRef.current && !committed)) return
    contentRequests.current.cancel()
    const request = activeRequests.begin()
    const selected = explicitSource.current?.name ?? null
    let requestKey = selected ? `management:selected:${selected}` : "management:unavailable"
    setLoading(true)
    dispatchManagementLifecycle({ type: "start", requestKey })
    try {
      const [nextFiles, runtimeState, nextPreferences] = await Promise.all([
        listManagedProviderFiles(request.signal),
        readRuntimeLoadState(request.signal).catch(() => null),
        readCollectionPreferences(request.signal),
      ])
      if (!request.isCurrent()) return
      setPreferences(nextPreferences)
      setRuntimeSourceName(confirmedRuntimeSource(runtimeState)?.name ?? null)
      const recent = confirmedRuntimeSource(runtimeState)
      setRuntimeSource(recent)
      const targetName = selected ?? recent?.name ?? null
      if (!targetName || options.invalidSource) {
        dispatchManagementLifecycle({ type: "unavailable", requestKey, message: options.invalidSource
          ? "集合编辑目标不完整，请返回编辑配置确认来源"
          : "集合来源身份未知；草稿已保留，请在编辑配置中确认目标" })
        return
      }
      const nextSnapshot = await readConfigFile(targetName, request.signal)
      if (!request.isCurrent()) return
      if (explicitSource.current && !collectionSourceMatches(nextSnapshot, explicitSource.current)) {
        dispatchManagementLifecycle({ type: "failure", requestKey, message: "编辑配置版本已变化；输入已保留，请确认后采用最新编辑版本" })
        return
      }
      const referenced = [...managedCollectionItems(nextSnapshot, nextFiles, "proxy"), ...managedCollectionItems(nextSnapshot, nextFiles, "rule")]
        .filter((item) => item.access !== "http" && item.fileName).map((item) => `${item.category}:${item.fileName}`)
      const loadedAt = runtimeState?.lastSuccessful?.loadedAt ?? ""
      setSavedPending(nextSnapshot.sha256 !== recent?.sha256 || nextFiles.some((file) =>
        referenced.includes(`${file.category}:${file.fileName}`) && Date.parse(file.updatedAt) > Date.parse(loadedAt)))
      const key = managementBaselineKey(true, nextSnapshot.name, nextSnapshot.sha256)
      if (key) {
        requestKey = key
        dispatchManagementLifecycle({ type: "start", requestKey })
      }
      const nextDraft = reconcileManagedProviderDraft(
        nextSnapshot,
        nextFiles,
        await listManagedHttpProviders(nextSnapshot.name, request.signal),
        itemReader,
      )
      const nextHttpOwners = nextDraft.httpOwners
      if (!request.isCurrent()) return
      const nextControls = nextDraft.controls
      const nextBaseline = { snapshot: nextSnapshot, files: nextFiles, httpOwners: nextHttpOwners, controls: nextControls }
      const previousBaseline = managementBaselineRef.current
      const contentUnchanged = previousBaseline?.snapshot.name === nextSnapshot.name &&
        previousBaseline.snapshot.sha256 === nextSnapshot.sha256 &&
        !managementBaselineResourcesChanged(previousBaseline, nextBaseline)
      const currentSelected = explicitSource.current?.name ?? null
      const currentTarget = currentSelected ?? recent?.name ?? null
      const loadedKey = currentTarget === nextSnapshot.name && key ? key : "management:unavailable"
      if (key && key === requestKey && key === loadedKey) managementBaselineCache.set(key, nextBaseline)
      dispatchManagementLifecycle({
        type: "success",
        requestKey,
        loadedKey,
        baselineKey: key ?? "management:invalid",
        baseline: nextBaseline,
        dirty: !committed && (dirtyRef.current || Boolean(inputDirtyRef.current)),
        resourcesChanged: managementBaselineResourcesChanged(managementBaselineRef.current, nextBaseline),
      })
      const adopt = (committed || (!dirtyRef.current && !inputDirtyRef.current)) && key !== null && key === requestKey && key === loadedKey
      if (!adopt) return
      setHttpOwners(nextHttpOwners)
      configContentRef.current = nextSnapshot.content
      lastValidConfigContentRef.current = nextSnapshot.content
      setConfigContent(nextSnapshot.content)
      setLastValidConfigContent(nextSnapshot.content)
      setConfigContentError(null)
      setControls(nextControls)
      if (!contentUnchanged) {
        contentsRef.current = {}
        setContents({})
        setSavedContents({})
        setReadErrors({})
        contentErrorsRef.current = {}
        setContentErrors({})
        setDeclarationDrafts({})
        setDeclarationErrors({})
      }
    } catch (error) {
      if (!request.isCurrent()) return
      const errorMessage = providerError(error)
      dispatchManagementLifecycle({ type: "failure", requestKey, message: errorMessage })
      if (throwOnError) throw error
    } finally {
      if (request.finish()) setLoading(false)
    }
  }, [itemReader, externalSourceRevision.current, options.invalidSource])

  const adoptLatestSource = useCallback(async () => {
    const target = explicitSource.current
    if (!target || busyRef.current) return
    const fresh = await readConfigFile(target.name)
    acceptSourceCommit(fresh)
    discardDrafts()
    await refresh(true)
    return fresh
  }, [acceptSourceCommit, discardDrafts, refresh])

  const reconcileFileCommit = useCallback((saved: ManagedProviderFileSnapshot, requestedItemId?: string) => {
    if (saved.category === "unknown") return
    const id = requestedItemId ?? itemsByCategory[saved.category].find((item) => item.fileName === saved.fileName)?.id ?? `${saved.category}:file:${saved.fileName}`
    const key = managedProviderContentKey({ id, category: saved.category, fileName: saved.fileName,
      referencePath: saved.referencePath, access: saved.source, writable: saved.writable })
    contentRequests.current.cancel()
    const updateFiles = (current: ManagedProviderFile[]) => {
      const matches = (file: ManagedProviderFile) => file.category === saved.category && file.fileName === saved.fileName
      return current.some(matches) ? current.map((file) => matches(file) ? saved : file) : [...current, saved]
    }
    const baseline = managementBaselineRef.current
    if (baseline) {
      const nextFiles = updateFiles(baseline.files)
      const item = itemReader(baseline.snapshot, nextFiles, saved.category, baseline.httpOwners).find((candidate) => candidate.id === id)
      const nextControls = item ? { ...baseline.controls, [id]: controlsFor(item) } : baseline.controls
      dispatchManagementLifecycle({ type: "own-commit", baseline: { ...baseline, files: nextFiles, controls: nextControls } })
      if (item) setControls((current) => current[id] ? current : { ...current, [id]: controlsFor(item) })
    }
    // A different unsaved body remains a draft against the newly published version.
    setContents((current) => {
      const old = savedContents[key]
      const content = current[key] === undefined || current[key] === old ? saved.content : current[key]
      const next = { ...current, [key]: content }
      contentsRef.current = next
      return next
    })
    setSavedContents((current) => ({ ...current, [key]: saved.content }))
  }, [itemReader, itemsByCategory, savedContents])

  const reconcileConfigCommit = useCallback(async (commit: Pick<ConfigSnapshot, "name" | "sha256">) => {
    const runtimeState = await readRuntimeLoadState().catch(() => null)
    const recent = runtimeSourceIdentity(runtimeState)
    const decision = externalManagedConfigDecision({
      snapshotName: snapshot?.name ?? null,
      commitName: commit.name,
      commitSha256: commit.sha256,
      loadedName: recent?.name ?? null,
      loadedSha256: recent?.sha256 ?? null,
      dirty: dirtyRef.current,
    })
    if (decision === "ignore") return false
    if (decision === "conflict") {
      dispatchManagementLifecycle({
        type: "external-conflict",
        message: "当前配置已被外部更新；已保留未应用草稿，请重新读取后处理冲突",
      })
      return false
    }
    await refresh()
    return true
  }, [refresh, snapshot?.name])

  useEffect(() => {
    const activeRequests = new LatestRequestController()
    contentRequests.current = new LatestRequestController()
    requests.current = activeRequests
    void refresh()
    return () => {
      activeRequests.dispose()
      contentRequests.current.dispose()
      if (requests.current === activeRequests) requests.current = null
    }
  }, [refresh])

  useEffect(() => {
    const source = createConfigChangeSource((event) => {
      if (busyRef.current) return
      if (event.operation === "save" && event.name && event.sha256) {
        void reconcileConfigCommit({ name: event.name, sha256: event.sha256 })
        return
      }
      if (event.operation !== "subscription-update") return
      const targetName = snapshot?.name
      if (!targetName || event.name !== targetName) return
      void (async () => {
        try {
          const [nextSnapshot, nextFiles] = await Promise.all([
            readConfigFile(targetName),
            listManagedProviderFiles(),
          ])
          await verifyRuntimeSource()
          for (const providerCategory of ["proxy", "rule"] as const) {
            const names = itemReader(nextSnapshot, nextFiles, providerCategory)
              .filter((item) => item.declared && item.access === "subscription")
              .map((item) => item.name)
            await Promise.allSettled(names.map((name) =>
              updateCollectionProvider(providerCategory, name, new AbortController().signal)))
          }
          await refresh()
        } catch {
          // The next configd event, focus refresh, or explicit refresh reconciles this view.
        }
      })()
    })
    return () => source.close()
  }, [itemReader, reconcileConfigCommit, refresh, snapshot?.name, verifyRuntimeSource])

  useEffect(() => {
    if (!active) return
    setActiveIds((current) => {
      const next = current[category] ? current : { ...current, [category]: active.id }
      return next
    })
  }, [active, category])

  const select = useCallback(async (item: ManagedProviderItem) => {
    if (busy || (identityStatus !== "ready")) return
    setActiveIds((current) => {
      const next = { ...current, [category]: item.id }
      return next
    })
    const key = managedProviderContentKey(item)
    if (contents[key] !== undefined || item.access === "inline" || item.fileIssue) return
    const activeRequests = contentRequests.current
    if (!activeRequests) return
    const request = activeRequests.begin()
    try {
      const result = item.fileName
        ? await readManagedProviderFile(item.category, item.fileName, request.signal)
        : { content: await readProviderPayload(item.category, item.name, request.signal,
            snapshot ? { name: snapshot.name, sha256: snapshot.sha256 } : undefined) }
      if (!request.isCurrent()) return
      if ("sha256" in result) reconcileFileCommit(result, item.id)
      else {
        contentsRef.current = { ...contentsRef.current, [key]: result.content }
        setContents(contentsRef.current)
        setSavedContents((current) => ({ ...current, [key]: result.content }))
      }
      setReadErrors((current) => ({ ...current, [key]: null }))
    } catch (error) {
      if (request.isCurrent()) setReadErrors((current) => ({ ...current, [key]: providerError(error) }))
    } finally {
      request.finish()
    }
  }, [busy, category, contents, identityStatus, notify, reconcileFileCommit, snapshot])

  const refreshItem = useCallback(async (item: ManagedProviderItem) => {
    const fileName = item.fileName ?? item.referencePath?.split(/[\/]/).pop()
    if (!fileName || busyRef.current || fileHasDraftRef.current(item) || inputDirtyRef.current) return
    const request = contentRequests.current.begin()
    const key = managedProviderContentKey(item)
    try {
      const result = await readManagedProviderFile(item.category, fileName, request.signal)
      if (!request.isCurrent() || fileHasDraftRef.current(item) || inputDirtyRef.current ||
        (!collectionSourceMatches(managementBaselineRef.current?.snapshot ?? null, snapshot))) return
      if (!snapshot || !itemReader(snapshot, [result], item.category, []).some((entry) => entry.name === item.name && entry.fileName === result.fileName)) return
      reconcileFileCommit(result, item.id)
      setReadErrors((current) => ({ ...current, [key]: null }))
    } catch (error) {
      if (request.isCurrent()) setReadErrors((current) => ({ ...current, [key]: providerError(error) }))
    } finally {
      request.finish()
    }
  }, [itemReader, reconcileFileCommit, snapshot])

  const contentReadError = active ? readErrors[managedProviderContentKey(active)] ?? null : null
  const contentRetryBlockedReason = !active || !contentReadError ? "当前没有需要重试的读取"
    : busy || identityStatus !== "ready" ? "请等待当前操作完成并确认集合来源"
    : options.inputDirty ? "请先保存或取消集合输入，再重试读取"
    : fileHasDraftRef.current(active) ? "请先保存或放弃当前集合草稿，再重试读取"
    : active.fileIssue || active.access === "inline" ? "请先处理当前集合的文件状态"
    : contents[managedProviderContentKey(active)] !== undefined && !(active.fileName ?? active.referencePath?.split(/[\/]/).pop())
      ? "当前集合没有可重新读取的文件" : null
  const retryContent = useCallback(async () => {
    if (!active || contentRetryBlockedReason || busyRef.current || inputDirtyRef.current || fileHasDraftRef.current(active)) return
    if (contentsRef.current[managedProviderContentKey(active)] !== undefined) await refreshItem(active)
    else await select(active)
  }, [active, contentRetryBlockedReason, refreshItem, select])

  const editConfigContent = useCallback((value: string) => {
    if (!snapshot) {
      configContentRef.current = value
      setConfigContent(value)
      return
    }
    const next = reconcileManagedProviderTextEdit(
      value,
      lastValidConfigContentRef.current,
      snapshot,
      files,
      httpOwners,
      itemReader,
    )
    configContentRef.current = value
    setConfigContent(value)
    setConfigContentError(next.error)
    if (!next.reconciled) return
    lastValidConfigContentRef.current = next.lastValidContent
    setLastValidConfigContent(next.lastValidContent)
    setHttpOwners(next.reconciled.httpOwners)
    setControls(next.reconciled.controls)
  }, [files, httpOwners, itemReader, snapshot])

  const editContent = useCallback((item: ManagedProviderItem, value: string) => {
    if (!item.writable || writeDisabled) return
    if (item.access === "inline") {
      setSavedContents((current) => current[item.id] !== undefined ? current : { ...current, [item.id]: item.content })
      const next = updateInlineDraftState(
        parseDocument(configContentRef.current).errors.length ? lastValidConfigContentRef.current : configContentRef.current,
        contentsRef.current,
        contentErrorsRef.current,
        item,
        value,
      )
      configContentRef.current = next.configContent
      lastValidConfigContentRef.current = next.configContent
      contentsRef.current = next.contents
      contentErrorsRef.current = next.errors
      setConfigContent(next.configContent)
      setLastValidConfigContent(next.configContent)
      setContents(next.contents)
      setContentErrors(next.errors)
      return
    }
    if (item.access === "http" && item.writable) {
      let nextContent: string | null = null
      let error: string | null = null
      try { nextContent = updateHttpProviderContent(configContentRef.current, item, value) } catch (caught) {
        error = caught instanceof Error ? caught.message : "HTTP Provider 内容无效"
      }
      contentsRef.current = { ...contentsRef.current, [item.id]: value }
      contentErrorsRef.current = { ...contentErrorsRef.current, [item.id]: error }
      setContents(contentsRef.current)
      setContentErrors(contentErrorsRef.current)
      if (nextContent !== null) {
        configContentRef.current = nextContent
        lastValidConfigContentRef.current = nextContent
        setConfigContent(nextContent)
        setLastValidConfigContent(nextContent)
        setConfigContentError(null)
      }
      return
    }
    const key = managedProviderContentKey(item)
    contentsRef.current = { ...contentsRef.current, [key]: value }
    contentErrorsRef.current = { ...contentErrorsRef.current, [key]: parseDocument(value).errors.length ? "集合 YAML 格式错误；可保存草稿，修正后应用" : null }
    setContents(contentsRef.current)
    setContentErrors(contentErrorsRef.current)
  }, [writeDisabled])


  const uploadContent = useCallback(async (item: ManagedProviderItem, file: File) => {
    if (busyRef.current || writeDisabled || !item.writable) return false
    if (!/\.ya?ml$/i.test(file.name)) { notify("请选择 YAML 文件", "error"); return false }
    const request = contentRequests.current.begin()
    busyRef.current = true; setBusy(true)
    try {
      const content = await file.text()
      if (!request.isCurrent()) return false
      editContent(item, content)
      return true
    } catch { if (request.isCurrent()) notify("文件读取失败，草稿已保留", "error"); return false }
    finally { busyRef.current = false; if (request.finish()) setBusy(false) }
  }, [editContent, notify, writeDisabled])

  const useExistingContent = useCallback(async (item: ManagedProviderItem, fileName: string) => {
    if (busyRef.current || writeDisabled || !item.writable || !["manual", "external"].includes(item.access)) return false
    const file = files.find(entry => entry.category === item.category && entry.fileName === fileName && entry.writable && ["manual", "external"].includes(entry.source))
    if (!file) { notify("所选集合文件已变化，请重新读取", "error"); return false }
    const request = contentRequests.current.begin()
    busyRef.current = true; setBusy(true)
    try {
      const result = await readManagedProviderFile(item.category, fileName, request.signal)
      if (!request.isCurrent()) return false
      if (!result.writable || !["manual", "external"].includes(result.source) || result.sha256 !== file.sha256) throw new Error("所选集合文件已变化，请重新读取")
      editContent(item, result.content)
      return true
    } catch (error) { if (request.isCurrent()) notify(providerError(error), "error"); return false }
    finally { busyRef.current = false; if (request.finish()) setBusy(false) }
  }, [editContent, files, notify, writeDisabled])

  const createDeclaredCollection = useCallback(async (input: ProxyCollectionInput, type: "inline" | "file" | "http", url: string, collectionCategory: ProviderCategory = category, fileName = suggestedCollectionFileName(input.name)) => {
    if (!snapshot || writeDisabled || busyRef.current) return false
    busyRef.current = true; setBusy(true)
    try {
      let body = input.content || (collectionCategory === "proxy" ? "proxies: []\n" : "payload: []\n")
      if (type === "file" && input.targetFileName) {
        const file = files.find((entry) => entry.category === collectionCategory && entry.referencePath === input.targetFileName && entry.writable)
        if (!file) throw new Error("所选集合文件已变化，请重新选择")
        body = (await readManagedProviderFile(collectionCategory, file.fileName)).content
      }
      const path = type === "file" ? "./" + collectionFileName(fileName) : undefined
      if (path) assertCollectionPathAvailable(configContentRef.current, collectionCategory, path)
      const created = createCollectionDraft(configContentRef.current, input, type, url, collectionCategory, path)
      editConfigContent(created.content)
      if (type === "file") {
        contentsRef.current = { ...contentsRef.current, [collectionCategory + ":declaration:" + created.name]: body }
        setContents(contentsRef.current)
      }
      if (type === "http") setHttpOwners((current) => [...current, { configName: snapshot.name, category: collectionCategory, name: created.name, declaration: created.declaration }])
      setActiveIds((current) => ({ ...current, [collectionCategory]: `${collectionCategory}:declaration:${created.name}` }))
      if (explicitSource.current) onSourceChange.current?.(explicitSource.current, { category: collectionCategory, name: created.name })
      notify("集合已加入草稿，可保存或直接应用配置")
      return true
    } catch (error) { notify(providerError(error), "error"); return false }
    finally { busyRef.current = false; setBusy(false) }
  }, [category, editConfigContent, files, notify, snapshot, writeDisabled])


  const importCollections = useCallback(async (inputs: ProxyCollectionInput[], onSaved: (id: string, config: ConfigSnapshot) => void,
    expectedSource?: Pick<ConfigSnapshot, "name" | "sha256">, onError?: (id: string, message: string) => void) => {
    if (!snapshot || busyRef.current || writeDisabled) return false
    if (expectedSource && !collectionSourceMatches(snapshot, expectedSource)) { notify("配置版本已变化，上传草稿已保留", "error"); return false }
    let content = configContentRef.current
    const staged = { ...contentsRef.current }
    const uploadedBodies: Array<{ category: ProviderCategory; name: string; content: string }> = []
    const removedNames: Array<{ category: ProviderCategory; name: string }> = []
    let last: { category: ProviderCategory; name: string } | null = null
    busyRef.current = true; setBusy(true)
    try {
      for (const input of inputs) {
        const kind = input.category ?? "proxy"
        const existing = itemsByCategory[kind].find((item) => item.name === input.name)
        if (existing) {
          if (!existing.writable || existing.declaration?.type !== "file" || readOnlyForItem(existing)) throw new Error("目标集合正文只读")
          const declaration = input.snippet ? readUploadDeclaration(input.snippet, kind) : { name: existing.name, declaration: existing.declaration! }
          content = replaceCollectionUploadDeclaration(content, existing, declaration.name, declaration.declaration)
          if (declaration.name !== existing.name) removedNames.push({ category: kind, name: existing.name })
          uploadedBodies.push({ category: kind, name: declaration.name, content: input.content })
          last = { category: kind, name: declaration.name }
        } else {
          const declaration = input.snippet ? readUploadDeclaration(input.snippet, kind) : null
          const created = createCollectionDraft(content, { ...input, name: declaration?.name ?? input.name }, "file", "", kind,
            String(declaration?.declaration.path ?? "./" + input.name + ".yaml"), declaration?.declaration)
          content = created.content
          uploadedBodies.push({ category: kind, name: created.name, content: input.content })
          last = { category: kind, name: created.name }
        }
      }
      const nextItems = [...itemReader({ ...snapshot, content }, files, "proxy", httpOwners), ...itemReader({ ...snapshot, content }, files, "rule", httpOwners)]
      for (const body of uploadedBodies) {
        const item = nextItems.find((entry) => entry.category === body.category && entry.name === body.name)
        if (!item || !item.writable) throw new Error("上传目标正文不可写")
        staged[managedProviderContentKey(item)] = body.content
      }
      await validateCollectionWorkspace(snapshot.name, { content, expectedSha256: snapshot.sha256, bodies: [], removals: [] })
      editConfigContent(content)
      setPendingRemovals((current) => [...current, ...removedNames])
      contentsRef.current = staged
      setContents(staged)
      if (last) {
        const selected = last
        setActiveIds((current) => ({ ...current, [selected.category]: selected.name }))
        if (explicitSource.current) onSourceChange.current?.(explicitSource.current, last)
      }
      for (const input of inputs) onSaved(input.operationId, snapshot)
      notify("上传内容已加入集合草稿，可保存或直接应用整份配置")
      return true
    } catch (error) {
      const message = providerError(error)
      for (const input of inputs) onError?.(input.operationId, message)
      notify(message, "error"); return false
    }
    finally { busyRef.current = false; setBusy(false) }
  }, [editConfigContent, files, httpOwners, itemReader, itemsByCategory, notify, preferences.readOnly, snapshot, writeDisabled])

  const validate = useCallback(async () => {
    if (!snapshot || busyRef.current || writeDisabled) return false
    const bodies = [...itemsByCategory.proxy, ...itemsByCategory.rule].filter((item) => !item.pendingRemoval && contentsRef.current[managedProviderContentKey(item)] !== undefined)
      .map((item) => ({ category: item.category, name: item.name, content: contentsRef.current[managedProviderContentKey(item)]!, expectedSha256: item.sha256 }))
    busyRef.current = true; setBusy(true)
    try {
      await validateCollectionWorkspace(snapshot.name, { content: configContentRef.current, expectedSha256: snapshot.sha256, bodies, removals: [] })
      notify("YAML 校验通过"); return true
    } catch (error) { notify(providerError(error), "error"); return false }
    finally { busyRef.current = false; setBusy(false) }
  }, [itemsByCategory, notify, snapshot, writeDisabled])

  const apply = useCallback(async (saveOnly = false) => {
    if (!snapshot || !canApply || busyRef.current || writeDisabled) return false
    setApplyError(null)
    const currentContents = { ...contentsRef.current }
    const allItems = [...itemsByCategory.proxy, ...itemsByCategory.rule].filter((item) => !item.pendingRemoval &&
      !pendingRemovals.some((removed) => removed.category === item.category && removed.name === item.name))
    let sourceContent = configContentRef.current
    const fragments: Array<{ item: ManagedProviderItem; snippet: string }> = []
    for (const item of allItems) {
      if (item.access === "inline" && contentErrorsRef.current[item.id]) fragments.push({ item, snippet: inlineProviderDraftText(item, currentContents[item.id] ?? item.content) })
      if (declarationErrors[item.id] && declarationDrafts[item.id] !== undefined) fragments.push({ item, snippet: declarationDrafts[item.id]! })
    }
    if (fragments.length) sourceContent = replaceProviderDrafts(lastValidConfigContentRef.current, fragments)
    const bodies = managedCollectionBodyDrafts(allItems, currentContents, savedContents, pendingRemovals)
    busyRef.current = true
    setBusy(true)
    let savedConfig: ConfigSnapshot | null = null
    try {
      await verifySource()
      savedConfig = await saveCollectionWorkspace(snapshot.name, { content: sourceContent, expectedSha256: snapshot.sha256, bodies, removals: pendingRemovals, httpProviders: httpOwners.filter((owner) => owner.writable !== false).map(({ category, name }) => ({ category, name })) })
      acceptSourceCommit(savedConfig)
      setPendingRemovals([])
      setSavedPending(true)
      const nextFiles = await listManagedProviderFiles()
      const validSource = !parseDocument(savedConfig.content).errors.length
      const nextBaseline = validSource
        ? { snapshot: savedConfig, files: nextFiles, ...reconcileManagedProviderDraft(savedConfig, nextFiles, httpOwners, itemReader) }
        : { snapshot: savedConfig, files: nextFiles, httpOwners, controls }
      dispatchManagementLifecycle({ type: "own-commit", baseline: nextBaseline })
      managementBaselineRef.current = nextBaseline
      setHttpOwners(nextBaseline.httpOwners)
      setControls(nextBaseline.controls)
      configContentRef.current = savedConfig.content
      setConfigContent(savedConfig.content)
      if (validSource) {
        lastValidConfigContentRef.current = savedConfig.content
        setLastValidConfigContent(savedConfig.content)
      }
      setConfigContentError(validSource ? null : "配置草稿已保存，YAML 尚未完成；请修正后应用")
      const savedBodies: Record<string, string> = {}
      if (validSource) {
        const nextItems = [...itemReader(savedConfig, nextFiles, "proxy", httpOwners), ...itemReader(savedConfig, nextFiles, "rule", httpOwners)]
        for (const item of nextItems) {
          const old = allItems.find((candidate) => candidate.category === item.category && candidate.name === item.name)
          const body = old && currentContents[managedProviderContentKey(old)]
          if (body !== undefined) savedBodies[managedProviderContentKey(item)] = body
        }
      } else Object.assign(savedBodies, currentContents)
      contentsRef.current = savedBodies
      setContents(savedBodies)
      setSavedContents(savedBodies)
      const savedErrors = Object.fromEntries(Object.entries(savedBodies).map(([key, body]) => [key, parseDocument(body).errors.length ? "集合 YAML 格式错误；草稿已保存，修正后应用" : null]))
      contentErrorsRef.current = savedErrors
      setContentErrors(savedErrors)
      setDeclarationDrafts({})
      setDeclarationErrors({})
      if (saveOnly) { notify("配置及集合草稿已保存，待应用"); return true }
      const applied = await applyRuntimeConfig(savedConfig)
      setSavedPending(false)
      setRuntimeSourceName(savedConfig.name)
      setRuntimeSource({ name: savedConfig.name, sha256: savedConfig.sha256 })
      await refresh(true)
      notify("配置及集合已应用" + (applied.collectionCleanup?.length ? "；" + cleanupSummary({ files: applied.collectionCleanup }) : ""))
      return { snapshot: { name: savedConfig.name, sha256: savedConfig.sha256 }, category, runtimeProviders: {}, removedNames: pendingRemovals.filter((item) => item.category === category).map((item) => item.name) } satisfies ManagedProviderApplyResult
    } catch (error) {
      const failure = error instanceof RuntimeApplyError ? error.message
        : savedConfig ? "磁盘配置及集合已保存，应用未完成；" + providerError(error) : providerError(error)
      setApplyError(failure)
      notify(failure, "error")
      return false
    } finally { busyRef.current = false; setBusy(false) }
  }, [acceptSourceCommit, canApply, category, controls, declarationDrafts, declarationErrors, httpOwners, itemReader, itemsByCategory, notify, pendingRemovals, refresh, savedContents, savedHttpOwners, snapshot, verifySource, writeDisabled])

  const remove = useCallback(async (target: ManagedProviderItem | null = active) => {
    if (!target || busyRef.current || inputDirtyRef.current || writeDisabled) return false
    const ownedSource = target.access === "local" || target.access === "subscription"
    const reason = managedProviderModificationReason(target)
    if (reason) { notify(reason, "error"); return false }
    busyRef.current = true
    setBusy(true)
    try {
      await verifySource()
      if (target.access === "http" || target.access === "inline" || (target.declared && (target.access === "manual" || target.access === "external"))) {
        const candidate = deleteManagedProviderConfig(configContentRef.current, target)
        editConfigContent(candidate)
        setPendingRemovals((current) => [...current.filter((item) => item.category !== target.category || item.name !== target.name), { category: target.category, name: target.name }])
        setHttpOwners((current) => current.filter((owner) => owner.category !== target.category || owner.name !== target.name))
        notify("集合已从配置草稿移除，请保存并应用")
        return { applied: null } satisfies ManagedProviderRemovalResult
      }
      if (ownedSource) {
        if (dirtyRef.current) throw new Error("请先保存当前配置草稿，再删除自动提取关系")
        if (!snapshot || !target.fileName || !target.sha256 || !target.ownerId) return false
        const source = target.access as "local" | "subscription"
        const candidate = target.declared
          ? deleteManagedProviderConfig(snapshot.content, target)
          : snapshot.content
        const fresh = await readConfigFile(snapshot.name)
        if (fresh.sha256 !== snapshot.sha256) throw new ConfigError("configuration changed", 409, "config_conflict")
        const result = await deleteManagedProviderSource(target.fileName, {
          source,
          ownerId: target.ownerId,
          expectedSha256: target.sha256,
          configName: snapshot.name,
          configContent: candidate,
          expectedConfigSha256: fresh.sha256,
        })
        acceptSourceCommit(result.config)
        const successMessage = target.access === "local"
          ? "本地提取关系与生成文件已删除，源配置已保留"
          : "订阅已保留，Provider 提取已关闭并删除生成文件"
        setSavedPending(true)
        await refresh(true)
        notify(`${successMessage}；尚未应用到 Core`)
        return { applied: null } satisfies ManagedProviderRemovalResult
      }
      if (!target.fileName || !target.sha256) return false
      const removalResult: ManagedProviderRemovalResult = { applied: null }
      if (target.declared && snapshot) {
        const candidate = deleteManagedProviderConfig(snapshot.content, target)
        const fresh = await readConfigFile(snapshot.name)
        if (fresh.sha256 !== snapshot.sha256) throw new ConfigError("configuration changed", 409, "config_conflict")
        const result = await deleteManagedProviderWithConfig(target.category, target.fileName, {
          expectedSha256: target.sha256,
          configName: snapshot.name,
          configContent: candidate,
          expectedConfigSha256: fresh.sha256,
        })
        acceptSourceCommit(result.config)
        setSavedPending(true)
        await refresh(true)
        notify("集合文件和配置引用已删除，尚未应用到 Core")
        return { applied: null } satisfies ManagedProviderRemovalResult
      } else {
        await deleteManagedProviderFile(target.category, target.fileName, target.sha256)
        notify("Provider 文件已删除")
      }
      await refresh(true)
      return removalResult
    } catch (error) {
      notify(providerError(error), "error")
      return false
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [active, editConfigContent, itemOperationPending, notify, refresh, snapshot, verifySource, writeDisabled])

  const setReadOnly = useCallback(async (item: ManagedProviderItem, readOnly: boolean) => {
    if (!snapshot || writeDisabled) return
    setBusy(true)
    try {
      await verifySource()
      setPreferences(await saveCollectionReadOnly({ configName: snapshot.name, category: item.category,
        name: item.name, readOnly, expectedVersion: preferences.version }))
    } catch (error) { notify(providerError(error), "error") }
    finally { setBusy(false) }
  }, [notify, preferences.version, snapshot, verifySource, writeDisabled])

  const saveSettings = useCallback(async (item: ManagedProviderItem, source: Pick<ConfigSnapshot, "name" | "sha256">, draft: { snippet: string; loaded: boolean; selectedGroups: string[] }, onSourceSaved?: (source: Pick<ConfigSnapshot, "name" | "sha256">) => void) => {
    if (!snapshot || writeDisabled || busyRef.current) return false
    let savedDrafts = false
    busyRef.current = true; setBusy(true)
    try {
      if (!managedConfigIdentity(snapshot, source.name, source.sha256)) throw new ConfigError("configuration changed", 409, "config_conflict")
      await verifySource()
      if (item.declaration?.type === "file" && item.writable && ["manual", "external"].includes(item.access) && item.fileIssue === "missing" && !item.sha256) {
        const staged = stageCollectionSettings(configContentRef.current, item, draft)
        const next = itemReader({ ...snapshot, content: staged.content }, files, item.category, httpOwners).find((entry) => entry.name === staged.name && entry.declared)
        if (next?.sha256) throw new Error("该文件名已存在，请更换文件名")
        const oldKey = managedProviderContentKey(item)
        const nextContents = { ...contentsRef.current }
        const nextErrors = { ...contentErrorsRef.current }
        if (next && nextContents[oldKey] !== undefined) {
          const key = managedProviderContentKey(next)
          const body = nextContents[oldKey]!
          const error = nextErrors[oldKey] ?? null
          delete nextContents[oldKey]; delete nextErrors[oldKey]
          nextContents[key] = body; nextErrors[key] = error
        } else if (!draft.loaded) { delete nextContents[oldKey]; delete nextErrors[oldKey] }
        editConfigContent(staged.content)
        contentsRef.current = nextContents; setContents(nextContents)
        contentErrorsRef.current = nextErrors; setContentErrors(nextErrors)
        setActiveIds((current) => ({ ...current, [item.category]: staged.name }))
        if (explicitSource.current && next) onSourceChange.current?.(explicitSource.current, { category: item.category, name: staged.name })
        notify("集合设置已加入草稿，正文已保留")
        return true
      }
      if (dirtyRef.current) {
        busyRef.current = false
        if (!await apply(true)) return false
        savedDrafts = true
        onSourceSaved?.(managementBaselineRef.current!.snapshot)
      }
      busyRef.current = true; setBusy(true)
      const baseline = managementBaselineRef.current!
      const currentSource = baseline.snapshot
      const fresh = await readConfigFile(currentSource.name)
      if (!collectionSourceMatches(fresh, currentSource)) throw new ConfigError("configuration changed", 409, "config_conflict")
      const currentItem = itemReader(currentSource, baseline.files, item.category, baseline.httpOwners).find((entry) => entry.name === item.name)
      if (!currentItem) throw new Error("集合已变化，输入已保留，请重新打开设置")
      if (parseDocument(draft.snippet).errors.length) {
        const content = replaceProviderDraftText(currentSource.content, currentItem, draft.snippet)
        const saved = await saveConfigFile(currentSource.name, content, currentSource.sha256)
        acceptSourceCommit(saved)
        dispatchManagementLifecycle({ type: "own-commit", baseline: { ...baseline, snapshot: saved } })
        configContentRef.current = saved.content
        setConfigContent(saved.content)
        setConfigContentError("集合声明已保存，YAML 尚未完成；集合列表沿用最近可解析声明，请在配置中心继续编辑")
        setSavedPending(true)
        notify("配置已保存，待修正后应用")
        return true
      }
      const result = await saveCollectionSettings({ configName: currentSource.name, expectedConfigSha256: currentSource.sha256,
        category: item.category, name: item.name, ...draft, expectedFileSha256: currentItem.sha256 ?? undefined })
      acceptSourceCommit(result.config, { category: item.category, name: result.name })
      setActiveIds((current) => ({ ...current, [item.category]: result.name }))
      await refresh(true)
      setSavedPending(true)
      notify(["集合设置已保存，等待应用", retainedProviderMessage(result.retainedSource)].filter(Boolean).join("；"))
      return true
    } catch (error) {
      const conflict = error instanceof ConfigError && error.status === 409
      const detail = conflict ? `${providerError(error)}；输入已保留，请取消后重新读取并打开设置` : providerError(error)
      const message = (savedDrafts ? "原配置及正文草稿已保存；集合设置尚未保存。" : "") + detail
      if (conflict) dispatchManagementLifecycle({ type: "external-conflict", message })
      notify(message, "error")
      return false
    }
    finally { busyRef.current = false; setBusy(false) }
  }, [acceptSourceCommit, apply, editConfigContent, files, httpOwners, itemReader, notify, refresh, snapshot, verifySource, writeDisabled])

  const recoverPath = useCallback(async (item: ManagedProviderItem, action: "rename" | "restore") => {
    const change = snapshot?.collectionPathChanges?.find((entry) => entry.category === item.category && entry.name === item.name)
    if (!snapshot || !change || busyRef.current || writeDisabled || inputDirtyRef.current) return false
    busyRef.current = true
    setBusy(true)
    try {
      await verifySource()
      const restored = action === "restore" ? restoreCollectionPath(configContentRef.current, change) : null
      const result = await resolveCollectionPath({ configName: snapshot.name, expectedConfigSha256: snapshot.sha256,
        category: item.category, name: item.name, fromPath: change.fromPath, toPath: change.toPath,
        expectedFileSha256: change.fileSha256, draftContent: configContentRef.current, action })
      if (restored !== null) editConfigContent(restored)
      else {
        if (result.config) acceptSourceCommit(result.config)
        await refresh(true)
        setSavedPending(true)
      }
      notify(action === "restore" ? "原路径已恢复到当前配置草稿，请保存配置"
        : ["集合文件已同步重命名，等待应用", retainedProviderMessage(result.retainedSource)].filter(Boolean).join("；"))
      return true
    } catch (error) { notify(providerError(error), "error"); return false }
    finally { busyRef.current = false; setBusy(false) }
  }, [acceptSourceCommit, editConfigContent, notify, refresh, snapshot, verifySource, writeDisabled])

  return {
    files,
    readOnlyFor: (item: ManagedProviderItem) => preferences.readOnly.includes(JSON.stringify([snapshot?.name, item.category, item.name])),
    setReadOnly,
    saveSettings,
    runtimeSource,
    hasExplicitTarget: Boolean(options.source || options.invalidSource),
    adoptLatestSource,
    recoverPath,
    runtimePaired,
    verifyRuntimeSource,
    savedPending,
    saveConfigDraft: () => apply(true),
    validate,
    importCollections,
    prepareUploadDeclaration: async (name: string, operationId: string, category: ProviderCategory, signal: AbortSignal) => {
      if (!snapshot) throw new Error("来源未确认")
      const result = await readCollectionUploadDeclaration({ configName: snapshot.name, name, operationId, category }, signal)
      return { snippet: patchCollectionIdentity(result.snippet, { path: "./" + suggestedCollectionFileName(name) }) }
    },
    snapshot,
    items,
    itemsByCategory,
    active,
    content: active ? contents[managedProviderContentKey(active)] ?? active.content : "",
    contentReady: Boolean(active && (active.access === "inline" || contents[managedProviderContentKey(active)] !== undefined)),
    loading,
    busy,
    message,
    identityStatus,
    dirty,
    contentDirty,
    configContent,
    configContentError,
    applyError,
    contentError: active ? contentErrors[managedProviderContentKey(active)] ?? readErrors[managedProviderContentKey(active)] ?? null : null,
    contentReadError,
    contentRetryBlockedReason,
    retryContent,
    hasContentErrors: Object.values(contentErrors).some(Boolean),
    draftIssue,
    writeDisabled,
    itemOperationPending,
    discardDrafts,
    select,
    refreshItem,
    refresh,
    createDeclaredCollection,
    apply,
    remove,
    editContent,
    uploadContent,
    useExistingContent,
  }
}
