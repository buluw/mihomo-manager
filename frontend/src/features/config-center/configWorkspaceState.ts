import { providerFilesErrorMessage } from "../../shared/configMessages.ts";
import type { ConfigFileRecord, ConfigSnapshot } from "../../api/configClient.ts"

import type { LatestRequest } from "../../shared/requestLifecycle.ts"

export type ConfigRuntimeState = "idle" | "synced" | "pending-apply" | "disk-only"

export function configApplyControl(options: {
  activeName: string | null
  loadedName: string | null
  dirty: boolean
}) {
  const switching = Boolean(options.loadedName && options.activeName !== options.loadedName)
  const label = switching ? "切换配置" : "应用配置"
  return {
    label,
    icon: switching ? "switch" as const : "apply" as const,
    completed: switching ? "已切换配置" : "已应用配置",
    disabled: !options.activeName || options.dirty,
    reason: options.dirty ? "请先保存配置" : options.loadedName ? null : `运行来源未知；${label}将加载所选配置`,
  }
}

export async function reconcileConfigWorkspace(
  request: LatestRequest,
  state: {
    activeName: () => string | null
    sha256: () => string
    dirty: () => boolean
    busy: () => boolean
    mutating: () => boolean
    explicitTarget?: boolean
  },
  dependencies: {
    list: (signal: AbortSignal) => Promise<ConfigFileRecord[]>
    read: (name: string, signal: AbortSignal) => Promise<ConfigSnapshot>
  },
  publish: {
    files: (files: ConfigFileRecord[]) => void
    pending: (name: string) => void
    dirty: () => void
    empty: (missingName: string) => void
    snapshot: (snapshot: ConfigSnapshot) => void
  },
) {
  const files = await dependencies.list(request.signal)
  if (!request.isCurrent()) return
  publish.files(files)
  const name = state.activeName()
  if (!name) return
  const file = files.find((entry) => entry.name === name)
  if (!file) {
    if (state.dirty() || state.busy() || state.mutating()) {
      publish.dirty()
      return
    }
    const fallback = state.explicitTarget ? undefined : files[0]
    if (!fallback) {
      publish.empty(name)
      return
    }
    const snapshot = await dependencies.read(fallback.name, request.signal)
    if (
      !request.isCurrent() ||
      state.activeName() !== name ||
      state.dirty() ||
      state.busy() ||
      state.mutating() ||
      snapshot.name !== fallback.name ||
      snapshot.sha256 !== fallback.sha256
    ) return
    publish.snapshot(snapshot)
    return
  }
  if (file.sha256 === state.sha256()) return
  publish.pending(name)
  if (state.dirty() || state.busy() || state.mutating()) {
    publish.dirty()
    return
  }
  const snapshot = await dependencies.read(name, request.signal)
  if (
    !request.isCurrent() ||
    state.activeName() !== name ||
    state.dirty() ||
    state.busy() ||
    state.mutating() ||
    snapshot.name !== name ||
    snapshot.sha256 !== file.sha256
  ) return
  publish.snapshot(snapshot)
}

const CONFIG_FILE_NAME_PATTERN = /^(?!\.)[\p{L}\p{N}][\p{L}\p{N}._ -]{0,118}\.ya?ml$/iu

export function newConfigFileName(value: string) {
  const name = value.trim()
  if (/\.ya?ml$/i.test(name) || !/^(?!\.)[\p{L}\p{N}][\p{L}\p{N}._ -]{0,113}$/u.test(name)) return null
  return `${name}.yaml`
}

export function validUploadedConfigName(value: string) {
  return CONFIG_FILE_NAME_PATTERN.test(value.trim())
}

export function validUploadedConfigContent(value: string | null) {
  return value != null && value.trim().length > 0
}

export function configInlineMutationError(error: unknown) {
  const issue = providerFilesErrorMessage(error)
  if (issue) return issue
  const value = error as { code?: string; status?: number }
  if (value.code === "config_source_in_use") return "此配置正在使用，请先切换到其他配置"
  if (value.code === "config_source_usage_unknown") return "配置使用状态未知，请先成功应用其他配置再重命名或删除"
  if (value.code === "config_exists") return "同名配置文件已存在"
  if (value.code === "validation_failed") return "Mihomo 校验失败，请检查上传的 YAML 配置"
  if (value.code === "invalid_config_name") return "文件名无效，请勿包含路径或特殊字符"
  if (value.status === 0) return "配置服务暂不可用，请稍后重试"
  return "上传、创建或重命名失败，请稍后重试"
}

export async function createConfigWorkspaceEntry(
  options: {
    files: ConfigFileRecord[]
    snapshots: Map<string, ConfigSnapshot>
    states: Map<string, ConfigRuntimeState>
    name: string
    content: string
    mode: "new" | "upload"
    updatedAt?: string
  },
  create: (name: string, content: string) => Promise<ConfigSnapshot>
) {
  if (options.mode === "upload" && !validUploadedConfigContent(options.content)) {
    return { ok: false as const, createError: "上传文件为空，请选择可校验的 YAML 配置" }
  }
  try {
    const snapshot = await create(options.name, options.content)
    const files = [...options.files, {
      name: snapshot.name,
      path: snapshot.path,
      sha256: snapshot.sha256,
      size: new TextEncoder().encode(snapshot.content).byteLength,
      updatedAt: options.updatedAt ?? new Date().toISOString(),
      subscriptionManaged: false,
      subscriptionId: null,
    }].sort((left, right) => left.name.localeCompare(right.name, "en"))
    options.snapshots.set(snapshot.name, snapshot)
    const runtimeState = setConfigRuntimeState(options.states, snapshot.name, "pending-apply")
    return {
      ok: true as const,
      createError: null,
      files,
      snapshot,
      activeName: snapshot.name,
      content: snapshot.content,
      savedContent: snapshot.content,
      path: snapshot.path,
      sha256: snapshot.sha256,
      runtimeState,
    }
  } catch (error) {
    return { ok: false as const, createError: configInlineMutationError(error) }
  }
}

export function configRuntimeState(
  states: Map<string, ConfigRuntimeState>,
  name: string | null
) {
  return name ? states.get(name) ?? "idle" : "idle"
}

export function setConfigRuntimeState(
  states: Map<string, ConfigRuntimeState>,
  name: string,
  state: ConfigRuntimeState
) {
  if (state === "idle") states.delete(name)
  else states.set(name, state)
  return state
}

export function canReplaceEditorWithExternalSnapshot(options: {
  activeName: string | null
  snapshotName: string
  dirty: boolean
  busy: boolean
  mutating: boolean
}) {
  return options.activeName === options.snapshotName &&
    !options.dirty &&
    !options.busy &&
    !options.mutating
}

export function applyExternalConfigSnapshot(
  files: ConfigFileRecord[],
  snapshots: Map<string, ConfigSnapshot>,
  snapshot: ConfigSnapshot,
  updatedAt = new Date().toISOString()
) {
  snapshots.set(snapshot.name, snapshot)
  const existing = files.some((file) => file.name === snapshot.name)
  const updated = files.map((file) =>
    file.name === snapshot.name
      ? {
          ...file,
          path: snapshot.path,
          sha256: snapshot.sha256,
          size: new TextEncoder().encode(snapshot.content).byteLength,
          updatedAt,
          subscriptionManaged: snapshot.subscriptionManaged ?? file.subscriptionManaged,
          subscriptionId: snapshot.subscriptionId ?? file.subscriptionId,
        }
      : file
  )
  if (existing) return updated
  return [...updated, {
    name: snapshot.name,
    path: snapshot.path,
    sha256: snapshot.sha256,
    size: new TextEncoder().encode(snapshot.content).byteLength,
    updatedAt,
    subscriptionManaged: snapshot.subscriptionManaged ?? false,
    subscriptionId: snapshot.subscriptionId ?? null,
  }].sort((left, right) => left.name.localeCompare(right.name, "en"))
}

export function stageExternalConfigSnapshot(
  files: ConfigFileRecord[],
  snapshots: Map<string, ConfigSnapshot>,
  snapshot: ConfigSnapshot,
  editor: Parameters<typeof canReplaceEditorWithExternalSnapshot>[0],
  updatedAt = new Date().toISOString()
) {
  return {
    files: applyExternalConfigSnapshot(files, snapshots, snapshot, updatedAt),
    editorSnapshot: canReplaceEditorWithExternalSnapshot(editor) ? snapshot : null,
  }
}

export function renameConfigWorkspaceEntry(
  files: ConfigFileRecord[],
  snapshots: Map<string, ConfigSnapshot>,
  states: Map<string, ConfigRuntimeState>,
  oldName: string,
  snapshot: ConfigSnapshot,
) {
  snapshots.delete(oldName)
  snapshots.set(snapshot.name, snapshot)
  const previousState = states.get(oldName)
  states.delete(oldName)
  if (previousState) states.set(snapshot.name, previousState === "synced" ? "pending-apply" : previousState)
  return files.map((file) => file.name === oldName
    ? { ...file, name: snapshot.name, path: snapshot.path, sha256: snapshot.sha256 }
    : file
  ).sort((left, right) => left.name.localeCompare(right.name, "en"))
}

export function applyConfigWorkspaceRename(options: {
  files: ConfigFileRecord[]
  snapshots: Map<string, ConfigSnapshot>
  states: Map<string, ConfigRuntimeState>
  oldName: string
  snapshot: ConfigSnapshot
  activeName: string | null
  loadedName: string | null
  editorContent: string
  savedContent: string
  editorPath: string
  editorSha256: string
}) {
  const files = renameConfigWorkspaceEntry(
    options.files,
    options.snapshots,
    options.states,
    options.oldName,
    options.snapshot
  )
  const active = options.activeName === options.oldName
  const wasLoaded = options.loadedName === options.oldName
  if (wasLoaded) setConfigRuntimeState(options.states, options.snapshot.name, "pending-apply")
  return {
    files,
    activeName: active ? options.snapshot.name : options.activeName,
    loadedName: wasLoaded ? null : options.loadedName,
    editorContent: options.editorContent,
    savedContent: options.savedContent,
    editorPath: active ? options.snapshot.path : options.editorPath,
    editorSha256: active ? options.snapshot.sha256 : options.editorSha256,
    runtimeState: active
      ? configRuntimeState(options.states, options.snapshot.name)
      : null,
    dirty: active && options.editorContent !== options.savedContent,
  }
}
