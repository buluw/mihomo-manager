import { configErrorMessage } from "../../shared/configMessages.ts";
import { configValidationErrorMessage, providerFilesErrorMessage } from "../../shared/configMessages.ts";
import { configProviderIssues, matchesCollectionImportSource } from "./configCollectionImport"
import { useCallback, useEffect, useRef, useState } from "react"

import {
  ConfigError,
  configDiagnostics,
  type ConfigDiagnostic,
  type ProviderCleanupItem,
  type ProviderFileIssue,
  createConfigChangeSource,
  createConfigFile,
  deleteConfigFile,
  listConfigFiles,
  readConfigFile,
  renameConfigFile,
  validateConfig,
  type ConfigFileRecord,
  type ConfigSnapshot,
} from "@/api/configClient";
import { useUiState } from "@/app/state/uiState"
import {
  configFileState,
  setSelectedConfigFile,
} from "@/shared/configFileState"
import { applyRuntimeConfig, confirmedRuntimeSource, RuntimeApplyError } from "@/shared/runtimeApplication"
import type { CollectionSource } from "@/shared/collectionTarget"
import { LatestRequestController } from "@/shared/requestLifecycle"
import type { Notify } from "@/shared/types"

import { isConfigDirty, saveConfigToDisk } from "./configActions"
import {
  ConfigPublishCoordinator,
  ConfigReconciliationLifecycle,
  type ConfigDrainTicket,
} from "./configReconciliationLifecycle"
import {
  configRuntimeState,
  configApplyControl,
  configInlineMutationError,
  createConfigWorkspaceEntry,
  setConfigRuntimeState,
  stageExternalConfigSnapshot,
  applyConfigWorkspaceRename,
  reconcileConfigWorkspace,
  type ConfigRuntimeState,
} from "./configWorkspaceState"
import {
  ConfigSnapshotSession,
  ConfigSnapshotVersionError,
} from "./configSnapshotSession"
import { runtimeApplyErrorMessage, runtimeApplyErrorWithBaseline } from "./runtimeConfigActions"
import { useRuntimeRecord, type RuntimeConfigView } from "./useRuntimeRecord"
import { sourceDiagnostics } from "./configDiagnostics"
import { cleanupSummary } from "@/shared/collectionCleanup"

type ConfigBusy = "load" | "apply" | "validate" | "save" | null
type ConfigMutation = "create" | "rename" | "delete" | null
type ValidationState = "idle" | "running" | "passed" | "failed"
type ConfigContentState = "idle" | "loading" | "ready" | "error"

const configWorkspaceCache: {
  initialized: boolean
  files: ConfigFileRecord[]
  snapshots: Map<string, ConfigSnapshot>
  activeName: string | null
  runtimeStates: Map<string, ConfigRuntimeState>
} = {
  initialized: false,
  files: [],
  snapshots: new Map(),
  activeName: null,
  runtimeStates: new Map(),
}
const configSnapshotSession = new ConfigSnapshotSession(configWorkspaceCache.snapshots)

export function useConfigWorkspace(notify: Notify, initialRuntimeView: RuntimeConfigView = "edit", initialSource?: CollectionSource | null, onActiveRename?: (from: CollectionSource, to: CollectionSource) => void) {
  const runtime = useRuntimeRecord(initialRuntimeView)
  const initialIdentity = configFileState()
  const initialActiveName = initialSource?.name ?? initialIdentity.selectedName ?? configWorkspaceCache.activeName
  const initialFile = initialActiveName
    ? configWorkspaceCache.files.find((file) => file.name === initialActiveName)
    : undefined
  const cachedInitialSnapshot = initialFile
    ? configSnapshotSession.get(initialFile) ?? undefined
    : undefined
  const initialSnapshot = !initialSource || cachedInitialSnapshot?.sha256 === initialSource.sha256 ? cachedInitialSnapshot : undefined
  const initialRuntimeState = configRuntimeState(
    configWorkspaceCache.runtimeStates,
    initialSnapshot?.name ?? initialIdentity.selectedName
  )
  const [files, setFiles] = useState<ConfigFileRecord[]>(configWorkspaceCache.files)
  const [activeName, setActiveName] = useState<string | null>(initialSnapshot?.name ?? initialActiveName)
  const recent = runtime.error ? null : runtime.state?.lastSuccessful?.generated
  const loadedName = recent?.sourceName ?? null
  const loadedSha256 = runtime.state?.lastAttempt?.status === "succeeded" && runtime.settingsVersion === recent?.settingsVersion
    ? recent?.sourceSha256 ?? null : null
  const [applyError, setApplyError] = useState<RuntimeApplyError | null>(null)
  const [content, setContent] = useState(initialSnapshot?.content ?? "")
  const [savedContent, setSavedContent] = useState(initialSnapshot?.content ?? "")
  const [contentState, setContentState] = useState<ConfigContentState>(
    initialSnapshot ? "ready" : initialActiveName ? "loading" : "idle"
  )
  const [contentError, setContentError] = useState<string | null>(null)
  const [sha256, setSha256] = useState(initialSnapshot?.sha256 ?? "")
  const [path, setPath] = useState(initialSnapshot?.path ?? "")
  const [providerCheck, setProviderCheck] = useState<{ name: string; content: string; issues: ProviderFileIssue[] } | null>(
    initialSnapshot ? { name: initialSnapshot.name, content: initialSnapshot.content, issues: initialSnapshot.providerIssues ?? [] } : null)
  const [coreCheck, setCoreCheck] = useState<{ name: string; content: string; sha256: string; diagnostics: ConfigDiagnostic[] } | null>(null)
  const [editorCheck, setEditorCheck] = useState<{ name: string | null; content: string; sha256: string; issues: ReturnType<typeof sourceDiagnostics> } | null>(null)
  const [busy, setBusy] = useState<ConfigBusy>(configWorkspaceCache.initialized ? null : "load")
  const [mutation, setMutation] = useState<ConfigMutation>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ConfigFileRecord | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [validation, setValidation] = useState<ValidationState>("idle")
  const [runtimeSaveState, setRuntimeSaveState] = useState<ConfigRuntimeState>(initialRuntimeState === "synced" ? "idle" : initialRuntimeState)
  const [message, setMessage] = useState(
    configWorkspaceCache.initialized
      ? initialSnapshot
        ? initialRuntimeState === "pending-apply"
          ? "磁盘配置已更新，等待手动加载"
          : initialRuntimeState === "disk-only"
            ? "磁盘配置与运行配置不一致"
            : "已与磁盘同步"
        : "暂无配置文件"
      : "正在读取配置文件"
  )
  const requests = useRef(new LatestRequestController())
  const validationRequests = useRef(new LatestRequestController())
  const reconciliationRequests = useRef(new ConfigReconciliationLifecycle())
  const publishCoordinator = useRef(new ConfigPublishCoordinator())
  const reconcileCallbackRef = useRef<() => void>(() => undefined)
  const snapshotCache = useRef(configWorkspaceCache.snapshots)
  const activeNameRef = useRef<string | null>(initialSnapshot?.name ?? initialActiveName)
  const sha256Ref = useRef(initialSnapshot?.sha256 ?? "")
  const contentRef = useRef(initialSnapshot?.content ?? "")
  const savedContentRef = useRef(initialSnapshot?.content ?? "")
  const dirtyRef = useRef(false)
  const busyRef = useRef<ConfigBusy>(busy)
  const mutationRef = useRef<ConfigMutation>(mutation)
  const mounted = useRef(false)
  const { askConfirm } = useUiState()
  const viewRef = useRef(runtime.view)
  viewRef.current = runtime.view
  const providerIssues = contentState === "ready" && providerCheck?.name === activeName && providerCheck.content === content
    ? providerCheck.issues : []
  const setProviderIssues = useCallback((name: string, body: string, issues: ProviderFileIssue[] = []) => {
    setProviderCheck({ name, content: body, issues })
  }, [])
  const visibleApplyError = runtimeApplyErrorMessage(applyError, runtime.state)

  useEffect(() => {
    const timer = setTimeout(() => {
      const providers = providerCheck?.name === activeName && providerCheck.content === content ? providerCheck.issues : []
      const core = coreCheck?.name === activeName && coreCheck.content === content && coreCheck.sha256 === sha256 ? coreCheck.diagnostics : []
      setEditorCheck({ name: activeName, content, sha256, issues: contentState === "ready" ? sourceDiagnostics(content, providers, core, activeName ?? undefined) : [] })
    }, 350)
    return () => clearTimeout(timer)
  }, [activeName, content, sha256, contentState, providerCheck, coreCheck])
  const editorIssues = editorCheck?.name === activeName && editorCheck.content === content && editorCheck.sha256 === sha256 ? editorCheck.issues : []
  const validationError = editorIssues.length ? editorIssues.map((item) => item.message).join("；")
    : coreCheck?.name === activeName && coreCheck.content === content && coreCheck.sha256 === sha256
      ? coreCheck.diagnostics.map((item) => item.message).join("；") : ""

  useEffect(() => {
    if (applyError && visibleApplyError === null) setApplyError(null)
  }, [applyError, visibleApplyError])

  useEffect(() => {
    if (!activeName) return
    const attempt = runtime.state?.lastAttempt
    const state: ConfigRuntimeState = runtime.error ? "idle"
      : loadedName === activeName && loadedSha256 === sha256 ? "synced"
      : attempt?.generated.sourceName === activeName && ["failed", "unknown"].includes(attempt.status) ? "disk-only"
      : loadedName === activeName ? "pending-apply"
      : configRuntimeState(configWorkspaceCache.runtimeStates, activeName) === "synced" ? "idle"
      : configRuntimeState(configWorkspaceCache.runtimeStates, activeName)
    setConfigRuntimeState(configWorkspaceCache.runtimeStates, activeName, state)
    setRuntimeSaveState(state)
  }, [activeName, sha256, loadedName, loadedSha256, runtime.state, runtime.error])

  const scheduleReconciliation = useCallback((ticket: ConfigDrainTicket | null) => {
    if (!ticket) return
    queueMicrotask(() => {
      if (
        mounted.current &&
        publishCoordinator.current.consumeDrain(ticket)
      ) reconcileCallbackRef.current()
    })
  }, [])

  const dirty = Boolean(activeName) && !unavailable && busy !== "load" && isConfigDirty(content, savedContent)
  dirtyRef.current = dirty
  busyRef.current = busy
  mutationRef.current = mutation
  sha256Ref.current = sha256

  const publishFiles = useCallback((nextFiles: ConfigFileRecord[]) => {
    configSnapshotSession.reconcile(nextFiles)
    configWorkspaceCache.files = nextFiles
    setFiles(nextFiles)
  }, [])

  const publishRuntimeState = useCallback((name: string, state: ConfigRuntimeState) => {
    setConfigRuntimeState(configWorkspaceCache.runtimeStates, name, state)
    if (activeNameRef.current === name) setRuntimeSaveState(state)
  }, [])

  const publishSnapshot = useCallback((snapshot: ConfigSnapshot) => {
    setCoreCheck(null)
    configSnapshotSession.put(snapshot)
    configWorkspaceCache.activeName = snapshot.name
    activeNameRef.current = snapshot.name
    contentRef.current = snapshot.content
    savedContentRef.current = snapshot.content
    setActiveName(snapshot.name)
    setSelectedConfigFile(snapshot.name)
    setContent(snapshot.content)
    setSavedContent(snapshot.content)
    setSha256(snapshot.sha256)
    setPath(snapshot.path)
    setProviderIssues(snapshot.name, snapshot.content, snapshot.providerIssues)
    setContentState("ready")
    setContentError(null)
    setUnavailable(false)
    setValidation("idle")
    const identity = runtime.stateRef.current
    const loaded = identity?.lastSuccessful?.generated
    const cachedState = configRuntimeState(configWorkspaceCache.runtimeStates, snapshot.name)
    const state = loaded?.sourceName === snapshot.name
      ? identity?.lastAttempt?.status === "succeeded" && loaded.sourceSha256 === snapshot.sha256 ? "synced" : "pending-apply"
      : cachedState === "synced" ? "idle" : cachedState
    setConfigRuntimeState(configWorkspaceCache.runtimeStates, snapshot.name, state)
    setRuntimeSaveState(state)
    setMessage(state === "pending-apply"
      ? "磁盘配置已更新，等待手动加载"
      : state === "disk-only"
        ? "磁盘配置与运行配置不一致"
      : "已与磁盘同步")
  }, [])

  useEffect(() => {
    if (runtime.view === "edit") return
    validationRequests.current.cancel()
    if (busyRef.current === "validate") {
      busyRef.current = null
      setBusy(null)
      setValidation("idle")
    }
  }, [runtime.view])

  const readVersionedSnapshot = useCallback((name: string) => {
    const file = configWorkspaceCache.files.find((entry) => entry.name === name)
    if (!file) return Promise.reject(new Error("所选配置文件已不存在"))
    return configSnapshotSession.read(file, readConfigFile)
  }, [])

  const applyExternalSnapshot = useCallback((snapshot: ConfigSnapshot) => {
    const background = publishCoordinator.current.beginBackground(
      busyRef.current !== null || mutationRef.current !== null,
    )
    if (!background) return
    try {
      if (!background.isCurrent()) return
      const staged = stageExternalConfigSnapshot(
      configWorkspaceCache.files,
      snapshotCache.current,
      snapshot,
      {
        activeName: activeNameRef.current,
        snapshotName: snapshot.name,
        dirty: dirtyRef.current,
        busy: busyRef.current !== null,
        mutating: mutationRef.current !== null,
      }
    )
      publishFiles(staged.files)
      publishRuntimeState(snapshot.name, "pending-apply")
      if (!staged.editorSnapshot) {
        if (activeNameRef.current === snapshot.name) {
          setMessage("磁盘配置已更新；当前未保存或处理中的编辑未被覆盖")
        }
        return
      }
      requests.current.cancel()
      validationRequests.current.cancel()
      contentRef.current = staged.editorSnapshot.content
      savedContentRef.current = staged.editorSnapshot.content
      setContent(staged.editorSnapshot.content)
      setSavedContent(staged.editorSnapshot.content)
      setSha256(staged.editorSnapshot.sha256)
      setPath(staged.editorSnapshot.path)
      setProviderIssues(staged.editorSnapshot.name, staged.editorSnapshot.content, staged.editorSnapshot.providerIssues)
      setContentState("ready")
      setContentError(null)
      setValidation("idle")
      setMessage("订阅合并已写入磁盘，尚未加载到运行配置")
    } finally {
      scheduleReconciliation(background.finish())
    }
  }, [publishFiles, publishRuntimeState, scheduleReconciliation])

  const publishMissingTarget = useCallback((name: string) => {
    snapshotCache.current.delete(name)
    activeNameRef.current = name
    configWorkspaceCache.activeName = name
    contentRef.current = ""
    savedContentRef.current = ""
    setActiveName(name)
    setSelectedConfigFile(name)
    setContent("")
    setSavedContent("")
    setSha256("")
    setPath("")
    setUnavailable(false)
    setContentState("error")
    setContentError(`指定配置「${name}」不存在，请确认编辑目标`)
    setMessage("指定配置不存在")
  }, [])

  const load = useCallback(async (confirmDiscard = false, preferredName?: string) => {
    if (confirmDiscard && dirty) {
      const approved = await askConfirm({
        title: "重新读取配置？",
        message: "未保存的更改将丢失。",
        confirmLabel: "放弃并重新读取",
        danger: true,
      })
      if (!approved) return
    }
    validationRequests.current.cancel()
    const foreground = publishCoordinator.current.beginForeground()
    if (!foreground) return
    const request = requests.current.begin()
    const canPublish = () => request.isCurrent() && foreground.isCurrent()
    if (!canPublish()) {
      scheduleReconciliation(foreground.finish())
      return
    }
    busyRef.current = "load"
    setBusy("load")
    setMessage("正在读取配置文件")
    try {
      const nextFiles = await listConfigFiles(request.signal)
      if (!canPublish()) return
      const storedName = configFileState().selectedName
      const selected = preferredName ?? (initialSource ? activeName : null) ?? [activeName, storedName, nextFiles[0]?.name]
        .find((name): name is string => Boolean(name && nextFiles.some((file) => file.name === name)))
      publishFiles(nextFiles)
      if (!selected) {
        activeNameRef.current = null
        configWorkspaceCache.activeName = null
        contentRef.current = ""
        savedContentRef.current = ""
        setActiveName(null)
        setSelectedConfigFile(null)
        setContent("")
        setSavedContent("")
        setContentState("idle")
        setContentError(null)
        setSha256("")
        setPath("")
        setUnavailable(false)
        setMessage("暂无配置文件")
        configWorkspaceCache.initialized = true
        return
      }
      const selectedFile = nextFiles.find((file) => file.name === selected)
      if (!selectedFile) {
        publishMissingTarget(selected)
        configWorkspaceCache.initialized = true
        return
      }
      const cached = configSnapshotSession.get(selectedFile)
      if (!cached) {
        configWorkspaceCache.activeName = selected
        activeNameRef.current = selected
        contentRef.current = ""
        savedContentRef.current = ""
        setActiveName(selected)
        setSelectedConfigFile(selected)
        setContent("")
        setSavedContent("")
        setSha256(selectedFile.sha256)
        setPath(selectedFile.path)
        setContentState("loading")
        setContentError(null)
      }
      let snapshot: ConfigSnapshot
      try {
        configSnapshotSession.invalidate(selected)
        snapshot = await readVersionedSnapshot(selected)
      } catch (error) {
        if (!canPublish()) return
        setUnavailable(false)
        setContentState("error")
        setContentError(error instanceof ConfigSnapshotVersionError
          ? "磁盘版本已变化，请重试读取"
          : "无法读取所选配置，其他配置仍可继续切换")
        setMessage("所选配置读取失败")
        configWorkspaceCache.initialized = true
        return
      }
      if (canPublish()) {
        publishSnapshot(snapshot)
        configWorkspaceCache.initialized = true
      }
    } catch (error) {
      if (!canPublish()) return
      setUnavailable(true)
      setMessage("配置功能暂不可用")
      if (!(error instanceof ConfigError && error.status === 0)) notify(configErrorMessage(error as Error), "error")
    } finally {
      if (request.finish()) {
        busyRef.current = null
        setBusy(null)
      }
      scheduleReconciliation(foreground.finish())
    }
  }, [activeName, askConfirm, dirty, initialSource, notify, publishFiles, publishMissingTarget, publishSnapshot, readVersionedSnapshot])

  const reconcileDiskVersions = useCallback(async () => {
    const background = publishCoordinator.current.beginBackground(
      busyRef.current !== null || mutationRef.current !== null,
    )
    if (!background) return
    const request = reconciliationRequests.current.begin()
    if (!request) {
      scheduleReconciliation(background.finish())
      return
    }
    const guardedRequest = {
      ...request,
      isCurrent: () => request.isCurrent() && background.isCurrent(),
    }
    try {
      await reconcileConfigWorkspace(
        guardedRequest,
        {
          activeName: () => activeNameRef.current,
          sha256: () => sha256Ref.current,
          dirty: () => dirtyRef.current,
          busy: () => busyRef.current !== null,
          mutating: () => mutationRef.current !== null,
          explicitTarget: Boolean(initialSource),
        },
        { list: listConfigFiles, read: (name) => readVersionedSnapshot(name) },
        {
          files: publishFiles,
          pending: (name) => {
            setMessage("磁盘已更新，等待刷新配置信息")
            publishRuntimeState(name, "pending-apply")
            if (
              activeNameRef.current === name &&
              !dirtyRef.current &&
              busyRef.current === null &&
              mutationRef.current === null
            ) {
              contentRef.current = ""
              savedContentRef.current = ""
              setContent("")
              setSavedContent("")
              setContentState("loading")
              setContentError(null)
            }
          },
          dirty: () => setMessage("其他设备已更新磁盘内容"),
          empty: (missingName) => {
            if (initialSource) { publishMissingTarget(missingName); return }
            snapshotCache.current.delete(missingName)
            configWorkspaceCache.activeName = null
            activeNameRef.current = null
            contentRef.current = ""
            savedContentRef.current = ""
            setActiveName(null)
            setSelectedConfigFile(null)
            setContent("")
            setSavedContent("")
            setContentState("idle")
            setContentError(null)
            setSha256("")
            setPath("")
            setValidation("idle")
            setRuntimeSaveState("idle")
            setMessage("暂无配置文件")
          },
          snapshot: publishSnapshot,
        },
      )
    } catch {
      // EventSource reconnect and the next focus event retry the lightweight check.
    } finally {
      request.finish()
      scheduleReconciliation(background.finish())
    }
  }, [initialSource, publishFiles, publishMissingTarget, publishRuntimeState, publishSnapshot, readVersionedSnapshot])
  reconcileCallbackRef.current = () => void reconcileDiskVersions()

  useEffect(() => {
    const cleanupCoordinator = publishCoordinator.current.setup()
    const cleanupRequests = reconciliationRequests.current.setup()
    const source = createConfigChangeSource(() => void reconcileDiskVersions())
    const onFocus = () => void reconcileDiskVersions()
    window.addEventListener("focus", onFocus)
    return () => {
      source.close()
      window.removeEventListener("focus", onFocus)
      cleanupRequests()
      cleanupCoordinator()
    }
  }, [reconcileDiskVersions])

  useEffect(() => {
    mounted.current = true
    requests.current = new LatestRequestController()
    validationRequests.current = new LatestRequestController()
    if (!configWorkspaceCache.initialized || (initialActiveName && !initialSnapshot)) void load()
    return () => {
      mounted.current = false
      requests.current.dispose()
      validationRequests.current.dispose()
      configSnapshotSession.cancelPending()
    }
  }, [])

  // File availability can change without changing the main YAML's SHA.
  useEffect(() => {
    if (!activeName || contentState !== "ready") return
    const request = new AbortController()
    const name = activeName
    const version = sha256
    void readConfigFile(name, request.signal).then((snapshot) => {
      if (request.signal.aborted || busyRef.current || mutationRef.current || activeNameRef.current !== name ||
        sha256Ref.current !== version || snapshot.sha256 !== version || contentRef.current !== snapshot.content) return
      configSnapshotSession.put(snapshot)
      setProviderIssues(name, snapshot.content, snapshot.providerIssues)
    }).catch(() => { /* Explicit refresh remains available if the availability check fails. */ })
    return () => request.abort()
  }, [activeName, sha256, contentState, setProviderIssues])

  const selectFile = async (name: string, retry = false, onAccepted?: () => void) => {
    if (mutationRef.current !== null) return
    if (busyRef.current !== null && busyRef.current !== "load") return
    if (name === activeName && !retry) { onAccepted?.(); return }
    const file = configWorkspaceCache.files.find((entry) => entry.name === name)
    if (!file) return
    if (dirty && !(await askConfirm({
      title: "切换配置文件？",
      message: "当前文件的未保存更改将丢失。",
      confirmLabel: "放弃并切换",
      danger: true,
    }))) return
    validationRequests.current.cancel()
    if (busyRef.current === "load") {
      requests.current.cancel()
      busyRef.current = null
      setBusy(null)
    }
    const foreground = publishCoordinator.current.beginForeground()
    if (!foreground) return
    const request = requests.current.begin()
    const canPublish = () => request.isCurrent() && foreground.isCurrent()
    if (!canPublish()) {
      scheduleReconciliation(foreground.finish())
      return
    }
    configWorkspaceCache.activeName = name
    activeNameRef.current = name
    contentRef.current = ""
    savedContentRef.current = ""
    dirtyRef.current = false
    setActiveName(name)
    setSelectedConfigFile(name)
    setContent("")
    setSavedContent("")
    setSha256(file.sha256)
    setPath(file.path)
    setUnavailable(false)
    setValidation("idle")
    setRuntimeSaveState(configRuntimeState(configWorkspaceCache.runtimeStates, name))
    setContentError(null)

    const cached = configSnapshotSession.get(file)
    if (cached) {
      publishSnapshot(cached)
      request.finish()
      scheduleReconciliation(foreground.finish())
      onAccepted?.()
      return
    }

    setContentState("loading")
    setMessage("正在读取所选配置")
    onAccepted?.()
    try {
      const snapshot = await configSnapshotSession.read(file, readConfigFile)
      if (!canPublish()) return
      publishSnapshot(snapshot)
      publishFiles(configWorkspaceCache.files.map((file) => file.name === name
        ? { ...file, path: snapshot.path, sha256: snapshot.sha256 }
        : file))
    } catch (error) {
      if (!canPublish()) return
      setContentState("error")
      setContentError(error instanceof ConfigSnapshotVersionError
        ? "磁盘版本已变化，请重试读取"
        : "无法读取所选配置，其他配置仍可继续切换")
      setMessage("所选配置读取失败")
    } finally {
      request.finish()
      scheduleReconciliation(foreground.finish())
    }
  }

  const retryContent = () => {
    if (!activeName) return
    configSnapshotSession.invalidate(activeName)
    void selectFile(activeName, true)
  }

  const validate = async () => {
    if (!content || busyRef.current || mutationRef.current || viewRef.current !== "edit") return
    const foreground = publishCoordinator.current.beginForeground()
    if (!foreground) return
    const request = validationRequests.current.begin()
    const source = { name: activeName!, content, sha256, path }
    const isCurrent = () => request.isCurrent() && matchesCollectionImportSource(source,
      { name: activeNameRef.current, content: contentRef.current, sha256: sha256Ref.current, view: viewRef.current })
    if (!request.isCurrent()) {
      scheduleReconciliation(foreground.finish())
      return
    }
    busyRef.current = "validate"
    setBusy("validate")
    setValidation("running")
    setMessage("正在使用 Mihomo 校验")
    try {
      await validateConfig(content, request.signal)
      if (!isCurrent()) return
      setProviderIssues(source.name, source.content)
      setCoreCheck(null)
      setValidation("passed")
      setMessage("Mihomo 校验通过")
      notify("配置校验通过")
    } catch (error) {
      if (!isCurrent()) return
      const issues = configProviderIssues(error)
      setCoreCheck({ ...source, diagnostics: configDiagnostics(error) })
      setProviderIssues(source.name, source.content, issues)
      setValidation("failed")
      setMessage(providerFilesErrorMessage(error) ?? configValidationErrorMessage(error) ?? "Mihomo 校验失败")
      notify(providerFilesErrorMessage(error) ?? configValidationErrorMessage(error) ?? (error instanceof ConfigError && error.status === 422 ? "Mihomo 配置校验失败" : configErrorMessage(error as Error)), "error")
    } finally {
      if (request.finish()) {
        busyRef.current = null
        setBusy(null)
      }
      scheduleReconciliation(foreground.finish())
    }
  }

  const commitConfig = async (saveOnly: boolean) => {
    const activeName = activeNameRef.current
    const content = contentRef.current
    const sha256 = sha256Ref.current
    const dirty = dirtyRef.current
    if (!activeName || !sha256 || busyRef.current || mutationRef.current || (!saveOnly && dirty)) return
    const foreground = publishCoordinator.current.beginForeground()
    if (!foreground) return
    const selectedName = activeName
    const draftContent = content
    const control = configApplyControl({ activeName, dirty, loadedName: runtime.error ? null : confirmedRuntimeSource(runtime.state)?.name ?? null })
    let savedSha256 = sha256
    let applying = false
    busyRef.current = "save"
    setBusy("save")
    setApplyError(null)
    try {
      if (dirty) {
        setMessage("正在保存配置")
        const result = await saveConfigToDisk(selectedName, draftContent, savedSha256)
        if (!mounted.current) return
        savedSha256 = result.sha256
        publishCoordinator.current.invalidate()
        savedContentRef.current = draftContent
        sha256Ref.current = result.sha256
        dirtyRef.current = false
        setSavedContent(draftContent)
        setSha256(result.sha256)
        setCoreCheck((current) => current?.name === selectedName && current.content === draftContent
          ? { ...current, sha256: result.sha256 } : current)
        setPath(result.path)
        setProviderIssues(selectedName, draftContent, result.providerIssues)

        publishFiles(configWorkspaceCache.files.map((file) => file.name === selectedName
          ? { ...file, path: result.path, sha256: result.sha256 } : file))
        configSnapshotSession.put({ name: selectedName, path: result.path, content: draftContent,
          sha256: result.sha256, providerIssues: result.providerIssues, collectionPathChanges: result.collectionPathChanges })
        publishRuntimeState(selectedName, "pending-apply")
      }
      if (saveOnly) {
        setMessage(dirty ? "配置已保存，待应用" : "配置已保存")
        notify(`${selectedName} 已保存${dirty ? "，待应用" : ""}`)
        return
      }
      applying = true
      busyRef.current = "apply"
      setBusy("apply")
      setMessage("正在生成并加载运行配置")
      const recorded = await applyRuntimeConfig({ name: selectedName, sha256: savedSha256 })
      if (!mounted.current) return
      if (!runtime.publish(recorded)) {
        setMessage("本次加载已完成，共享记录已有较新操作")
        await runtime.refresh()
        return
      }
      const generated = recorded.lastSuccessful!.generated
      for (const [name, state] of configWorkspaceCache.runtimeStates) {
        if (name !== generated.sourceName && state === "synced") setConfigRuntimeState(configWorkspaceCache.runtimeStates, name, "idle")
      }
      publishRuntimeState(selectedName, "synced")
      setMessage(`配置${control.completed}，共享记录已保存`)
      notify(`${selectedName} ${control.completed}`)
      void runtime.refresh()
    } catch (error) {
      if (!mounted.current) return
      if (applying) {
        const failure = error instanceof RuntimeApplyError
          ? runtimeApplyErrorWithBaseline(error, runtime.stateRef.current)
          : new RuntimeApplyError("磁盘已保存，应用未完成；运行身份未知", "record", null, runtime.stateRef.current ?? undefined)
        if (failure.state) runtime.publish(failure.state)
        publishRuntimeState(selectedName, failure.phase === "prepare" ? "pending-apply" : "disk-only")
        setApplyError(failure)
        if (failure.phase === "prepare" && failure.cause) {
          setCoreCheck({ name: selectedName, content: draftContent, sha256: savedSha256, diagnostics: configDiagnostics(failure.cause) })
          setProviderIssues(selectedName, draftContent, configProviderIssues(failure.cause))
          setValidation("failed")
        }
        setMessage(failure.message)
        notify(failure.message, "error")
        await runtime.refresh()
      } else {
        const message = error instanceof ConfigError && error.status === 409
          ? "配置已被其他操作修改，未保存；请重新读取"
          : providerFilesErrorMessage(error) ?? (error instanceof ConfigError && error.status === 422
            ? "配置保存失败，草稿已保留" : "配置保存失败，未应用到 Core")
        setMessage(message)
        notify(message, "error")
      }
    } finally {
      busyRef.current = null
      if (mounted.current) setBusy(null)
      scheduleReconciliation(foreground.finish())
    }
  }

  const edit = (value: string) => {
    setCoreCheck(null)
    publishCoordinator.current.invalidate()
    validationRequests.current.cancel()
    if (busyRef.current === "validate") busyRef.current = null
    setBusy((current) => current === "validate" ? null : current)
    setContent(value)
    contentRef.current = value
    dirtyRef.current = value !== savedContentRef.current
    setValidation("idle")
    setMessage("配置已修改")
  }

  const createDraft = async (
    name: string,
    draftContent = "",
    mode: "new" | "upload" = "new"
  ) => {
    if (unavailable || busy || mutation) return false
    if (dirty && !(await askConfirm({
      title: "放弃当前配置更改？",
      message: "创建并切换到新配置会丢弃当前未保存内容。",
      confirmLabel: "放弃并新建",
      danger: true,
    }))) return false
    const foreground = publishCoordinator.current.beginForeground()
    if (!foreground) return false
    setCreateError(null)
    mutationRef.current = "create"
    setMutation("create")
    try {
      const created = await createConfigWorkspaceEntry({
        files: configWorkspaceCache.files,
        snapshots: snapshotCache.current,
        states: configWorkspaceCache.runtimeStates,
        name,
        content: draftContent,
        mode,
      }, createConfigFile)
      if (!mounted.current) return false
      if (!created.ok) {
        setCreateError(created.createError)
        return false
      }
      publishCoordinator.current.invalidate()
      publishFiles(created.files)
      configWorkspaceCache.activeName = created.activeName
      activeNameRef.current = created.activeName
      contentRef.current = created.content
      savedContentRef.current = created.savedContent
      setActiveName(created.activeName)
      setSelectedConfigFile(created.activeName)
      setContent(created.content)
      setSavedContent(created.savedContent)
      setPath(created.path)
      setProviderIssues(created.snapshot.name, created.content, created.snapshot.providerIssues)
      setSha256(created.sha256)
      setContentState("ready")
      setContentError(null)
      setRuntimeSaveState(created.runtimeState)
      setUnavailable(false)
      setValidation("idle")
      setMessage("磁盘配置已更新，等待手动加载")
      notify(`${created.activeName} 已创建`)
      return created.snapshot
    } finally {
      mutationRef.current = null
      if (mounted.current) setMutation(null)
      scheduleReconciliation(foreground.finish())
    }
  }

  const renameFile = async (oldName: string, newName: string) => {
    if (unavailable || busy || mutation) return false
    if (runtime.stateRef.current?.lastSuccessful?.generated.sourceName === oldName) {
      setCreateError("此配置是最近成功加载来源，请先成功应用其他配置，再重命名或删除。")
      return false
    }
    const file = files.find((item) => item.name === oldName)
    if (!file) return false
    const foreground = publishCoordinator.current.beginForeground()
    if (!foreground) return false
    setCreateError(null)
    mutationRef.current = "rename"
    setMutation("rename")
    try {
      const snapshot = await renameConfigFile(oldName, newName, file.sha256)
      if (!mounted.current) return false
      const renamed = applyConfigWorkspaceRename({
        files: configWorkspaceCache.files,
        snapshots: snapshotCache.current,
        states: configWorkspaceCache.runtimeStates,
        oldName,
        snapshot,
        activeName: activeNameRef.current,
        loadedName,
        editorContent: contentRef.current,
        savedContent,
        editorPath: path,
        editorSha256: sha256,
      })
      publishCoordinator.current.invalidate()
      publishFiles(renamed.files)
      if (renamed.activeName !== activeNameRef.current) {
        activeNameRef.current = renamed.activeName
        configWorkspaceCache.activeName = renamed.activeName
        setActiveName(renamed.activeName)
        setSelectedConfigFile(renamed.activeName)
        setPath(renamed.editorPath)
        setSha256(renamed.editorSha256)
        if (renamed.runtimeState) setRuntimeSaveState(renamed.runtimeState)
        onActiveRename?.({ name: oldName, sha256 }, { name: snapshot.name, sha256: snapshot.sha256 })
      }
      if (loadedName === oldName) {
        setMessage("源文件已重命名；最近成功加载记录保留原来源")
      }
      notify(`${oldName} 已重命名为 ${newName}`)
      return true
    } catch (error) {
      if (!mounted.current) return false
      setCreateError(configInlineMutationError(error))
      return false
    } finally {
      mutationRef.current = null
      if (mounted.current) setMutation(null)
      scheduleReconciliation(foreground.finish())
    }
  }

  const removeFile = (name: string) => {
    if (busyRef.current || mutationRef.current) return
    if (runtime.stateRef.current?.lastSuccessful?.generated.sourceName === name) {
      notify("此配置是最近成功加载来源，请先成功应用其他配置，再重命名或删除。", "error")
      return
    }
    setDeleteTarget(files.find((item) => item.name === name) ?? null)
  }

  const confirmDelete = async (file: ConfigFileRecord, cleanup?: ProviderCleanupItem[]) => {
    if (busyRef.current || mutationRef.current) return
    const name = file.name
    if (files.find((item) => item.name === name)?.sha256 !== file.sha256) { notify("配置已变化，请重新打开删除预览", "error"); return }
    if (runtime.stateRef.current?.lastSuccessful?.generated.sourceName === name) {
      notify("此配置是最近成功加载来源，请先成功应用其他配置，再重命名或删除。", "error")
      return
    }
    const previousFiles = files
    const deletedSnapshot = snapshotCache.current.get(name)
    const remaining = files.filter((item) => item.name !== name)
    const nextName = name === activeName ? remaining[0]?.name : undefined
    const nextFile = nextName ? remaining.find((item) => item.name === nextName) : undefined
    const nextSnapshot = nextFile ? configSnapshotSession.get(nextFile) ?? undefined : undefined
    const foreground = publishCoordinator.current.beginForeground()
    if (!foreground) return
    mutationRef.current = "delete"
    setMutation("delete")
    publishCoordinator.current.invalidate()
    snapshotCache.current.delete(name)
    publishFiles(remaining)
    if (nextSnapshot) publishSnapshot(nextSnapshot)
    try {
      const result = await deleteConfigFile(name, file.sha256, cleanup)
      if (!mounted.current) return
      if (nextName && !nextSnapshot) {
        const snapshot = nextFile
          ? await configSnapshotSession.read(nextFile, readConfigFile)
          : null
        if (snapshot && mounted.current && activeNameRef.current === name) publishSnapshot(snapshot)
      } else if (name === activeName && !nextName) {
        activeNameRef.current = null
        configWorkspaceCache.activeName = null
        contentRef.current = ""
        savedContentRef.current = ""
        setActiveName(null)
        setSelectedConfigFile(null)
        setContent("")
        setSavedContent("")
        setContentState("idle")
        setContentError(null)
        setSha256("")
        setPath("")
      }

      notify(`${name} 已从磁盘删除${result?.cleanup ? `；${cleanupSummary(result.cleanup)}` : result?.cleanupFailed ? "；集合清理未完成，请到集合页重新检查" : ""}`)
      if (result?.extractionCleanupFailed) notify("源配置已删除；提取关系仍保留，请到代理集提取页核查清理", "error")
    } catch (error) {
      if (mounted.current) {
        publishCoordinator.current.invalidate()
        publishFiles(previousFiles)
        if (deletedSnapshot) snapshotCache.current.set(name, deletedSnapshot)
        if (activeNameRef.current === name && deletedSnapshot) publishSnapshot(deletedSnapshot)
        notify(configErrorMessage(error as Error), "error")
      }
    } finally {
      mutationRef.current = null
      if (mounted.current) setMutation(null)
      scheduleReconciliation(foreground.finish())
    }
  }

  const resetToSaved = () => {
    setCoreCheck(null)
    publishCoordinator.current.invalidate()
    validationRequests.current.cancel()
    setBusy((current) => current === "validate" ? null : current)
    contentRef.current = savedContentRef.current
    dirtyRef.current = false
    setContent(savedContent)
    setValidation("idle")
  }

  return {
    deleteTarget, closeDelete: () => setDeleteTarget(null), confirmDelete,
    editorIssues, validationError,
    providerIssues,
    activeName, busy, content, contentError, contentState, createError, dirty, files, loadedName, loadedSha256, message, mutation, path,
    runtimeSaveState, sha256, unavailable, validation, runtime, applyError: visibleApplyError,
    applyExternalSnapshot, saveConfig: () => commitConfig(true), applyConfig: () => commitConfig(false), clearCreateError: () => setCreateError(null), createDraft, edit, load,
    collectionSource: () => activeNameRef.current && sha256Ref.current && contentRef.current === savedContentRef.current
      ? { name: activeNameRef.current, sha256: sha256Ref.current } : null,
    removeFile, renameFile, resetToSaved, retryContent, selectFile, validate,
  }
}
