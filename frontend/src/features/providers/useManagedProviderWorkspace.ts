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
  applyManagedHttpProviders,
  createConfigChangeSource,
  createManagedCollection,
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
  saveManagedProviderFile,
  validateManagedProviderFile,
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
import type { ProviderCategory } from "./collectionViewModel"
import { createCollectionDraft } from "./proxyCollectionImport"
import {
  managedConfigIdentity,
  managedHttpOwnerChangeIds,
  managedProviderFileHasDraft,
  managedProviderFileSaveTargets,
  managedProviderRuntimePaired,
  updateInlineDraftState,
  externalManagedConfigDecision,
  managedPendingChangeIds,
  managedProviderDraftIssue,
  managedProviderApplyTargets,
  managedProviderDiscardState,
  managedProviderRowOperationPending,
  managedRuleProviderUnloadConflictMessage,
  managedRuleProviderUnloadConflicts,
  managementBaselineKey,
  managementBaselineResourcesChanged,
  managementLifecycleState,
  managementLifecycleView,
  reduceManagementLifecycle,
  managedProviderConfigSaveKind,
  managedProviderSavedContents,
  reconcileManagedProviderDraft,
  reconcileManagedProviderTextEdit,
  resolveManagedProviderBaseline,
  type ManagementBaseline,
} from "./managedProviderState"
import {
  desiredManagedHttpOwners,
  managedProviderControlsForItem as controlsFor,
  managedProviderItems,
  managedProviderContentKey,
  managedProviderModificationReason,
  managedCollectionItems,
  managedProviderDeclarationSnippet,
  type ManagedProviderItem,
  type ManagedProviderControls,
} from "./managedProviderModel"
import { deleteManagedProviderConfig, replaceProviderDraftText, replaceProviderDrafts, inlineProviderDraftText, updateHttpProviderContent } from "./managedProviderYaml"
import {
  updateAndReadCollectionProviderStatuses,
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
  if (error instanceof ConfigError && error.code === "invalid_provider_file") return "请检查集合 YAML、名称及代理组归属；集合仅包含 proxies 节点列表"
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
  const [declarationDrafts, setDeclarationDrafts] = useState<Record<string, string>>({})
  const [declarationErrors, setDeclarationErrors] = useState<Record<string, string | null>>({})
  const [activeIds, setActiveIds] = useState<Partial<Record<ProviderCategory, string>>>(() =>
    ({ ...initialSession?.activeIds })
  )
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [runtimeSourceName, setRuntimeSourceName] = useState<string | null>(null)
  const [runtimeSource, setRuntimeSource] = useState<CollectionSource | null>(null)
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

  const adoptDiskBaselineAfterControllerFailure = useCallback(async (
    nextSnapshot: ConfigSnapshot,
    failureMessage: string,
    sourceConfirmed = false,
  ) => {
    const baseline = await resolveManagedProviderBaseline(
      nextSnapshot,
      files,
      httpOwners,
      () => listManagedProviderFiles(),
      () => listManagedHttpProviders(nextSnapshot.name),
      itemReader,
    )
    dispatchManagementLifecycle(sourceConfirmed
      ? { type: "own-commit", baseline }
      : { type: "disk-diverged", baseline, message: failureMessage })
    setHttpOwners(baseline.httpOwners)
    configContentRef.current = nextSnapshot.content
    lastValidConfigContentRef.current = nextSnapshot.content
    setConfigContent(nextSnapshot.content)
    setLastValidConfigContent(nextSnapshot.content)
    setConfigContentError(null)
    setControls(baseline.controls)
    contentsRef.current = {}
    contentErrorsRef.current = {}
    setContents({})
    setSavedContents({})
    setContentErrors({})
    setDeclarationDrafts({})
    setDeclarationErrors({})
  }, [files, httpOwners, itemReader])

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

  const importCollections = useCallback(async (inputs: ProxyCollectionInput[], onSaved: (id: string, config: ConfigSnapshot) => void,
    expectedSource?: Pick<ConfigSnapshot, "name" | "sha256">, onError?: (id: string, message: string) => void) => {
    if (!snapshot || busyRef.current || dirtyRef.current || writeDisabled) return false
    busyRef.current = true
    setBusy(true)
    let current = expectedSource ?? snapshot
    let pendingId = inputs[0]?.operationId
    try {
      await verifySource()
      for (const input of inputs) {
        pendingId = input.operationId
        const category = input.category ?? "proxy"
        const result = await createManagedCollection({ ...input, category, configName: current.name, expectedConfigSha256: current.sha256 })
        current = result.config
        acceptSourceCommit(result.config, { category, name: result.name })
        onSaved(input.operationId, result.config)
        setActiveIds((ids) => ({ ...ids, [category]: `${category}:declaration:${result.name}` }))
        setSavedPending(true)
      }
      await refresh(true)
      notify("集合文件和主配置引用已保存，等待应用")
      return true
    } catch (error) {
      if (pendingId) onError?.(pendingId, providerError(error))
      notify(`${providerError(error)}；已保留输入，可重试未完成项`, "error")
      await refresh(true)
      return false
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [acceptSourceCommit, notify, refresh, snapshot, verifySource, writeDisabled])

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
    contentsRef.current = { ...contentsRef.current, [managedProviderContentKey(item)]: value }
    setContents(contentsRef.current)
  }, [writeDisabled])


  const createDeclaredCollection = useCallback((input: ProxyCollectionInput, type: "inline" | "file" | "http", url: string, collectionCategory: ProviderCategory = category) => {
    if (!snapshot || writeDisabled || busyRef.current || dirtyRef.current) return false
    try {
      const created = createCollectionDraft(configContentRef.current, input, type, url, collectionCategory, input.targetFileName)
      editConfigContent(created.content)
      if (type === "http") setHttpOwners((current) => [...current, { configName: snapshot.name, category: collectionCategory, name: created.name, declaration: created.declaration }])
      setActiveIds((current) => ({ ...current, [collectionCategory]: `${collectionCategory}:declaration:${created.name}` }))
      if (explicitSource.current) onSourceChange.current?.(explicitSource.current, { category: collectionCategory, name: created.name })
      notify("集合已加入草稿，请保存配置后应用")
      return true
    } catch (error) { notify(providerError(error), "error"); return false }
  }, [category, editConfigContent, notify, snapshot, writeDisabled])


  const apply = useCallback(async (saveOnly = false) => {
    if (!snapshot || !canApply || busy || writeDisabled) return false
    const currentContent = configContentRef.current
    const currentContents = { ...contentsRef.current }
    const currentContentErrors = contentErrorsRef.current
    const allItems = [...itemsByCategory.proxy, ...itemsByCategory.rule]
    const changedContentKeys = new Set(allItems.filter((item) => {
      const key = managedProviderContentKey(item)
      return currentContents[key] !== undefined && currentContents[key] !== (savedContents[key] ?? item.content)
    }).map(managedProviderContentKey))
    if (!saveOnly && (configContentError || draftIssue || Object.values(contentErrors).some(Boolean) || dirtyRef.current)) return false
    const unloadConflictMessage = managedRuleProviderUnloadConflictMessage(
      managedRuleProviderUnloadConflicts(controls, baselineControls, itemsByCategory.rule),
    )
    if (!saveOnly && unloadConflictMessage) {
      configContentRef.current = snapshot.content
      lastValidConfigContentRef.current = snapshot.content
      setConfigContent(snapshot.content)
      setLastValidConfigContent(snapshot.content)
      setHttpOwners(savedHttpOwners)
      setControls(baselineControls)
      setDeclarationDrafts({})
      setDeclarationErrors({})
      setConfigContentError(unloadConflictMessage)
      return false
    }
    busyRef.current = true
    setBusy(true)
    let filesSaved = false
    const savedFiles: ManagedProviderFileSnapshot[] = []
    try {
      await verifySource()
      const fresh = await readConfigFile(snapshot.name)
      if (fresh.sha256 !== snapshot.sha256) throw new ConfigError("configuration changed", 409, "config_conflict")
      for (const item of managedProviderFileSaveTargets(allItems, changedContentKeys)) {
        if (!item.writable || item.access === "http" || !item.fileName || !item.sha256) throw new Error("集合正文不可写，未应用配置")
        const content = currentContents[managedProviderContentKey(item)] ?? item.content
        if (!saveOnly) await validateManagedProviderFile(item.category, item.fileName, content)
        const saved = await saveManagedProviderFile(item.category, item.fileName, content, item.sha256)
        savedFiles.push(saved)
        reconcileFileCommit(saved)
        filesSaved = true
        setSavedPending(true)
      }
      if (saveOnly) {
        let sourceContent = parseDocument(currentContent).errors.length ? lastValidConfigContentRef.current : currentContent
        const fragments: Array<{ item: ManagedProviderItem; snippet: string }> = []
        for (const item of allItems) {
          if (item.access === "inline" && currentContentErrors[item.id]) {
            fragments.push({ item, snippet: inlineProviderDraftText(item, currentContents[item.id] ?? item.content) })
          }
          if (declarationErrors[item.id] && declarationDrafts[item.id] !== undefined) {
            fragments.push({ item, snippet: declarationDrafts[item.id]! })
          }
        }
        if (fragments.length) sourceContent = replaceProviderDrafts(sourceContent, fragments)
        // A direct main-editor draft is already the complete source payload.
        if (configContentError && !Object.values(currentContentErrors).some(Boolean) && !Object.values(declarationErrors).some(Boolean)) sourceContent = currentContent
        const saved = sourceContent === fresh.content ? fresh : await saveConfigFile(snapshot.name, sourceContent, fresh.sha256)
        acceptSourceCommit(saved)
        const nextFiles = files.map((file) => savedFiles.find((body) => body.category === file.category && body.fileName === file.fileName) ?? file)
        const baseline = { snapshot: saved, files: nextFiles, httpOwners, controls }
        dispatchManagementLifecycle({ type: "own-commit", baseline })
        configContentRef.current = saved.content
        setConfigContent(saved.content)
        setConfigContentError(parseDocument(saved.content).errors.length
          ? "配置草稿已保存，YAML 尚未完成；集合列表沿用最近可解析声明，请修正正文或在配置中心继续编辑"
          : null)
        setSavedContents(currentContents)
        setDeclarationDrafts({})
        setSavedPending(true)
        notify("配置已保存，待应用")
        return false
      }
      const draftItems = [
        ...managedProviderItems({ ...snapshot, content: configContent }, files, "proxy", httpOwners),
        ...managedProviderItems({ ...snapshot, content: configContent }, files, "rule", httpOwners),
      ]
      const baselineItems = [
        ...managedProviderItems(snapshot, files, "proxy", savedHttpOwners),
        ...managedProviderItems(snapshot, files, "rule", savedHttpOwners),
      ]
      const desiredHttpOwners = desiredManagedHttpOwners(draftItems)
      const applyTargets = managedProviderApplyTargets(
        category,
        draftItems,
        baselineItems,
        controls,
        baselineControls,
      )
      const configSaveKind = managedProviderConfigSaveKind({
        snapshot, fresh, content: configContent,
        changedItems: [...itemsByCategory.proxy, ...itemsByCategory.rule].filter((item) => contentDirtyIds.has(item.id)),
        currentOwners: httpOwners, savedOwners: savedHttpOwners, desiredOwners: desiredHttpOwners,
      })
      const savedConfig = configSaveKind === "reuse" ? fresh : configSaveKind === "catalog"
        ? await applyManagedHttpProviders({
            configName: snapshot.name,
            content: configContent,
            expectedSha256: fresh.sha256,
            providers: desiredHttpOwners,
          })
        : await saveConfigFile(snapshot.name, configContent, fresh.sha256)
      acceptSourceCommit(savedConfig)
      setSavedPending(true)
      try {
        await applyRuntimeConfig(savedConfig)
        setSavedPending(false)
        setRuntimeSourceName(savedConfig.name)
        setRuntimeSource({ name: savedConfig.name, sha256: savedConfig.sha256 })
      } catch (error) {
        const failureMessage = error instanceof RuntimeApplyError
          ? error.message
          : "磁盘配置已保存，但运行配置应用失败；运行身份未知"
        const sourceConfirmed = error instanceof RuntimeApplyError && error.phase === "prepare" &&
          confirmedRuntimeSource(await readRuntimeLoadState().catch(() => null))?.name === savedConfig.name
        await adoptDiskBaselineAfterControllerFailure(savedConfig, failureMessage, sourceConfirmed)
        notify(failureMessage, "error")
        return false
      }
      const nextBaseline = await resolveManagedProviderBaseline(
        savedConfig,
        files.map((file) => savedFiles.find((saved) => saved.category === file.category && saved.fileName === file.fileName) ?? file),
        httpOwners,
        () => listManagedProviderFiles(),
        () => listManagedHttpProviders(savedConfig.name),
        itemReader,
      )
      const runtimeTargets = applyTargets.filter((item) => item.access === "http")
      let runtimeProviders: Record<string, Record<string, unknown>> = {}
      let runtimeFailures = 0
      let retainedVersions = 0
      let verificationFailed = false
      let unverifiedUpdateFailures = 0
      if (runtimeTargets.length > 0) {
        const runtimeResult = await updateAndReadCollectionProviderStatuses(
          category,
          runtimeTargets.map((item) => item.name),
          new AbortController().signal,
        )
        verificationFailed = runtimeResult.verificationFailed
        unverifiedUpdateFailures = runtimeResult.verificationFailed ? runtimeResult.updateFailedNames.size : 0
        if (!runtimeResult.verificationFailed) {
          runtimeProviders = Object.fromEntries(runtimeTargets
            .map((item) => [item.name, runtimeResult.providers[item.name]] as const)
            .filter(([, provider]) => provider !== undefined))
          runtimeFailures = Object.values(runtimeResult.statuses).filter((status) => status === "failed").length
          retainedVersions = Object.values(runtimeResult.statuses).filter((status) => status === "update-failed").length
        }
      }
      const key = managementBaselineKey(true, savedConfig.name, savedConfig.sha256)
      if (key) managementBaselineCache.set(key, nextBaseline)
      dispatchManagementLifecycle({ type: "own-commit", baseline: nextBaseline })
      setHttpOwners(nextBaseline.httpOwners)
      configContentRef.current = savedConfig.content
      lastValidConfigContentRef.current = savedConfig.content
      setConfigContent(savedConfig.content)
      setLastValidConfigContent(savedConfig.content)
      setConfigContentError(null)
      setControls(nextBaseline.controls)
      const savedBodies = managedProviderSavedContents([
        ...itemReader(savedConfig, nextBaseline.files, "proxy", nextBaseline.httpOwners),
        ...itemReader(savedConfig, nextBaseline.files, "rule", nextBaseline.httpOwners),
      ], savedFiles)
      contentsRef.current = savedBodies
      contentErrorsRef.current = {}
      setContents(savedBodies)
      setSavedContents(savedBodies)
      setContentErrors({})
      setDeclarationDrafts({})
      setDeclarationErrors({})

      const localIssues = [
        ...(savedConfig.providerRefreshFailed ? ["关联代理 Provider 提取更新失败，继续使用现有版本"] : []),
        ...(retainedVersions > 0 ? [`${retainedVersions} 项更新失败，继续使用现有版本`] : []),
        ...(runtimeFailures > 0 ? [`${runtimeFailures} 项暂无可用内容`] : []),
        ...(unverifiedUpdateFailures > 0 ? [`${unverifiedUpdateFailures} 项更新请求失败且运行态无法核对`] : []),
        ...(verificationFailed ? ["Controller 运行态核对失败，目标状态尚未确认"] : []),
      ]
      notify(localIssues.length > 0
        ? `配置已应用；${localIssues.join("；")}`
        : "配置已应用并刷新", localIssues.length > 0 ? "error" : "ok")
      const currentById = new Map(draftItems.map((item) => [item.id, item]))
      const removedNames = baselineItems
        .filter((item) => item.category === category && item.declared && !currentById.get(item.id)?.declared)
        .map((item) => item.name)
      return {
        snapshot: { name: savedConfig.name, sha256: savedConfig.sha256 },
        category,
        runtimeProviders,
        removedNames,
      } satisfies ManagedProviderApplyResult
    } catch (error) {
      const message = `${filesSaved ? "部分集合文件已保存；" : ""}${providerError(error)}；操作未完成`
      notify(message, "error")
      return false
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [adoptDiskBaselineAfterControllerFailure, baselineControls, busy, canApply, category, changedHttpOwnerIds, configContent, configContentError, configDirty, contentDirtyIds, contentErrors, controls, declarationDrafts, declarationErrors, draftIssue, files, httpOwners, itemReader, itemsByCategory, notify, reconcileFileCommit, savedContents, savedHttpOwners, snapshot, verifySource, writeDisabled])

  const remove = useCallback(async (target: ManagedProviderItem | null = active) => {
    if (!target || busyRef.current || inputDirtyRef.current || dirtyRef.current || itemOperationPending(target) || writeDisabled) return false
    const ownedSource = target.access === "local" || target.access === "subscription"
    const reason = managedProviderModificationReason(target)
    if (reason) { notify(reason, "error"); return false }
    busyRef.current = true
    setBusy(true)
    try {
      await verifySource()
      if (target.access === "http" || target.access === "inline") {
        const candidate = deleteManagedProviderConfig(configContentRef.current, target)
        editConfigContent(candidate)
        setHttpOwners((current) => current.filter((owner) => owner.category !== target.category || owner.name !== target.name))
        notify("集合已从配置草稿移除，请保存并应用")
        return { applied: null } satisfies ManagedProviderRemovalResult
      }
      if (ownedSource) {
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
  }, [active, adoptDiskBaselineAfterControllerFailure, editConfigContent, itemOperationPending, notify, refresh, snapshot, verifySource, writeDisabled])

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

  const saveSettings = useCallback(async (item: ManagedProviderItem, source: Pick<ConfigSnapshot, "name" | "sha256">, draft: { snippet: string; loaded: boolean; selectedGroups: string[] }) => {
    if (!snapshot || writeDisabled || dirtyRef.current || busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    try {
      if (!managedConfigIdentity(snapshot, source.name, source.sha256)) throw new ConfigError("configuration changed", 409, "config_conflict")
      await verifySource()
      if (parseDocument(draft.snippet).errors.length) {
        const content = replaceProviderDraftText(snapshot.content, item, draft.snippet)
        const saved = await saveConfigFile(source.name, content, source.sha256)
        acceptSourceCommit(saved)
        dispatchManagementLifecycle({ type: "own-commit", baseline: { snapshot: saved, files, httpOwners, controls } })
        configContentRef.current = saved.content
        setConfigContent(saved.content)
        setConfigContentError("集合声明已保存，YAML 尚未完成；集合列表沿用最近可解析声明，请在配置中心继续编辑")
        setSavedPending(true)
        notify("配置已保存，待修正后应用")
        return true
      }
      const result = await saveCollectionSettings({ configName: source.name, expectedConfigSha256: source.sha256,
        category: item.category, name: item.name, ...draft, expectedFileSha256: item.sha256 ?? undefined })
      acceptSourceCommit(result.config, { category: item.category, name: result.name })
      setActiveIds((current) => ({ ...current, [item.category]: result.name }))
      await refresh(true)
      setSavedPending(true)
      notify(["集合设置已保存，等待应用", retainedProviderMessage(result.retainedSource)].filter(Boolean).join("；"))
      return true
    } catch (error) {
      const conflict = error instanceof ConfigError && error.status === 409
      const message = conflict ? `${providerError(error)}；输入已保留，请取消后重新读取并打开设置` : providerError(error)
      if (conflict) dispatchManagementLifecycle({ type: "external-conflict", message })
      notify(message, "error")
      return false
    }
    finally { busyRef.current = false; setBusy(false) }
  }, [controls, files, httpOwners, notify, refresh, snapshot, verifySource, writeDisabled])

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
    importCollections,
    prepareUploadDeclaration: (name: string, operationId: string, category: ProviderCategory, signal: AbortSignal) => {
      if (!snapshot) throw new Error("来源未确认")
      return readCollectionUploadDeclaration({ configName: snapshot.name, name, operationId, category }, signal)
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
    contentError: active ? contentErrors[managedProviderContentKey(active)] ?? readErrors[managedProviderContentKey(active)] ?? null : null,
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
  }
}
