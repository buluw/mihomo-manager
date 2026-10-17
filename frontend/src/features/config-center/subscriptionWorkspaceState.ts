import type {
  ConfigFileRecord,
  ConfigSubscription,
  ConfigSubscriptionInput,
  LocalProviderExtraction,
  ManagedProviderFile,
  ManagedProviderFilterSettings,
} from "@/api/configClient"

export function commitProviderFileSettings(
  files: ManagedProviderFile[],
  fileName: string,
  settings: ManagedProviderFilterSettings,
) {
  return files.map((file) => file.fileName === fileName ? { ...file, filterSettings: settings } : file)
}

export const DEFAULT_PROVIDER_FILTER_RULES = ["剩余流量", "套餐 & 到期", "/^(官网|公告|通知)/i"]

export function mergeFilterRuleError(value: string) {
  for (const rule of value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    if (!rule.startsWith("/")) continue
    const lastSlash = rule.lastIndexOf("/")
    if (lastSlash <= 0) return "正则表达式缺少结束斜杠"
    try {
      new RegExp(rule.slice(1, lastSlash), rule.slice(lastSlash + 1))
    } catch {
      return `无效正则表达式：${rule}`
    }
  }
  return null
}

export type PersistedDraftState<T> = {
  relationId: string
  identity: string
  dirtyFields: Array<keyof T>
  draft: T
}

export function applyPersistedDraftPatch<T extends object>(
  current: PersistedDraftState<T>,
  patch: Partial<T>,
): PersistedDraftState<T> {
  return {
    ...current,
    dirtyFields: [...new Set([...current.dirtyFields, ...Object.keys(patch) as Array<keyof T>])],
    draft: { ...current.draft, ...patch },
  }
}

export function reconcilePersistedDraft<T>(
  current: PersistedDraftState<T> | null,
  relationId: string,
  identity: string,
  persistedDraft: T,
): PersistedDraftState<T> {
  if (!current || current.relationId !== relationId) {
    return { relationId, identity, dirtyFields: [], draft: persistedDraft }
  }
  if (current.identity === identity) return current
  const draft = { ...persistedDraft }
  for (const field of current.dirtyFields) draft[field] = current.draft[field]
  return { relationId, identity, dirtyFields: current.dirtyFields, draft }
}

export function persistedDraftSynchronized<T>(
  catalogReady: boolean,
  activeRelationId: string | null,
  activeIdentity: string | null,
  state: PersistedDraftState<T> | null,
) {
  return Boolean(
    catalogReady && activeRelationId && activeIdentity && state &&
    state.relationId === activeRelationId && state.identity === activeIdentity,
  )
}

export function mergeConfigurationSources(
  subscriptions: ConfigSubscription[],
  configFiles: ConfigFileRecord[],
  locals: LocalProviderExtraction[],
  files: ManagedProviderFile[],
  loadedName: string | null = null,
) {
  const fileBase = (fileName: string) => fileName.replace(/\.ya?ml$/i, "")
  const localConfigs = configFiles.filter((file) => !file.subscriptionManaged && file.name !== loadedName)
  const configuredNames = new Set(localConfigs.map((file) => file.name))
  const localsByConfig = new Map<string, LocalProviderExtraction[]>()
  for (const local of locals) {
    const entries = localsByConfig.get(local.configName) ?? []
    entries.push(local)
    localsByConfig.set(local.configName, entries)
  }
  const localSource = (config: ConfigFileRecord | null, configName: string) => {
    const localRelations = localsByConfig.get(configName) ?? []
    const local = localRelations.length === 1 ? localRelations[0]! : null
    return {
      kind: "local" as const,
      id: `local:${configName}`,
      config,
      local,
      localRelations,
      conflict: localRelations.length > 1,
      file: local ? files.find((file) => file.extractionId === local.id) ?? null : null,
    }
  }
  return [
    ...subscriptions.map((subscription) => ({
      kind: "subscription" as const, id: `subscription:${subscription.id}`, subscription,
      file: files.find((file) => file.source === "subscription" && fileBase(file.fileName) === subscription.providerName) ?? null,
    })),
    ...localConfigs.map((config) => localSource(config, config.name)),
    ...[...localsByConfig.keys()]
      .filter((configName) => !configuredNames.has(configName) && configName !== loadedName)
      .map((configName) => localSource(null, configName)),
  ]
}

export function emptySubscriptionDraft(
  name = ""
): ConfigSubscriptionInput {
  return {
    name,
    url: "",
    extractProvider: false,
    providerName: name,
    providerNameMode: "follow",
    mergeIntoConfig: false,
    configName: "",
    groupNames: [],
    autoUpdate: false,
    intervalMinutes: 60,
  }
}

export function editSubscriptionDraft(
  current: ConfigSubscriptionInput,
  patch: Partial<ConfigSubscriptionInput>,
) {
  const nextName = patch.name ?? current.name
  const currentMode = current.providerNameMode ??
    ((current.providerName ?? "").trim() === current.name.trim() ? "follow" : "custom")
  let providerNameMode = patch.providerNameMode ?? currentMode
  let providerName = patch.providerName ?? current.providerName ?? ""
  if (patch.providerName !== undefined) {
    providerNameMode = patch.providerName.trim() === nextName.trim() ? "follow" : "custom"
  } else if (patch.name !== undefined && providerNameMode === "follow") {
    providerName = patch.name
  }
  return { ...current, ...patch, providerName, providerNameMode }
}

export type SubscriptionGroupDrafts = Record<string, string[]>

export function subscriptionGroupDrafts(form: ConfigSubscriptionInput): SubscriptionGroupDrafts {
  return form.configName ? { [form.configName]: [...(form.groupNames ?? [])] } : {}
}

export function editSubscriptionConfigTarget(
  current: ConfigSubscriptionInput,
  configName: string,
  remembered: SubscriptionGroupDrafts,
) {
  const nextRemembered = { ...remembered }
  if (current.configName) nextRemembered[current.configName] = [...(current.groupNames ?? [])]
  return {
    form: editSubscriptionDraft(current, {
      configName,
      groupNames: [...(nextRemembered[configName] ?? [])],
    }),
    remembered: nextRemembered,
  }
}

export function rememberSubscriptionGroups(
  remembered: SubscriptionGroupDrafts,
  configName: string | undefined,
  groupNames: string[],
) {
  return configName ? { ...remembered, [configName]: [...groupNames] } : remembered
}

export function canSaveSubscriptionDraft(
  form: ConfigSubscriptionInput,
  existing: boolean,
) {
  if (!form.name.trim() || (!existing && !form.url?.trim())) return false
  if (!form.extractProvider) return true
  if (!form.providerName?.trim()) return false
  if (!form.mergeIntoConfig) return true
  return Boolean(
    form.configName?.trim() && form.groupNames?.some((name) => name.trim()),
  )
}

export type SubscriptionGroupQueryStatus = "idle" | "loading" | "error" | "success"

export function subscriptionGroupQueryIdentity(
  form: ConfigSubscriptionInput,
  item: Pick<ConfigSubscription, "id" | "binding"> | null,
) {
  const binding = item?.binding
  return JSON.stringify([
    form.configName ?? "",
    form.providerName ?? "",
    item?.id ?? "new",
    binding ? [
      binding.configName,
      binding.providerName,
      binding.providerPath,
      binding.groupNames,
      binding.status,
    ] : null,
  ])
}

export function invalidSubscriptionGroups(options: {
  form: ConfigSubscriptionInput
  currentIdentity: string
  resultIdentity: string | null
  status: SubscriptionGroupQueryStatus
  availableGroups: string[]
}) {
  if (
    !options.form.extractProvider ||
    !options.form.mergeIntoConfig ||
    !options.form.configName?.trim() ||
    options.status !== "success" ||
    options.resultIdentity !== options.currentIdentity
  ) return []
  return (options.form.groupNames ?? []).filter(
    (name) => !options.availableGroups.includes(name),
  )
}

export function subscriptionDraftFromSnapshot(
  item: ConfigSubscription
): ConfigSubscriptionInput {
  return {
    name: item.name,
    url: item.url,
    extractProvider: item.extractProvider,
    providerName: item.providerName,
    providerNameMode: item.providerNameMode,
    mergeIntoConfig: item.mergeIntoConfig,
    configName: item.configName,
    groupNames: item.groupNames,
    autoUpdate: item.autoUpdate,
    intervalMinutes: item.intervalMinutes,
  }
}

export function isSubscriptionDirty(
  current: ConfigSubscriptionInput,
  saved: ConfigSubscriptionInput,
  isNew: boolean
) {
  return (
    isNew ||
    current.name !== saved.name ||
    current.url !== saved.url ||
    current.extractProvider !== saved.extractProvider ||
    current.providerName !== saved.providerName ||
    current.providerNameMode !== saved.providerNameMode ||
    current.mergeIntoConfig !== saved.mergeIntoConfig ||
    current.configName !== saved.configName ||
    JSON.stringify(current.groupNames) !== JSON.stringify(saved.groupNames) ||
    current.autoUpdate !== saved.autoUpdate ||
    current.intervalMinutes !== saved.intervalMinutes
  )
}

export function upsertSubscriptionSnapshot(
  current: ConfigSubscription[],
  saved: ConfigSubscription,
) {
  const index = current.findIndex((item) => item.id === saved.id)
  if (index === -1) return [...current, saved]
  const next = [...current]
  next[index] = saved
  return next
}

export function removeSubscriptionSnapshot(
  current: ConfigSubscription[],
  id: string,
) {
  return current.filter((item) => item.id !== id)
}

export function subscriptionDomain(value: string) {
  try {
    return new URL(value).hostname || "地址不可用"
  } catch {
    return "地址不可用"
  }
}

export function formatSubscriptionBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "--"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let amount = value
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`
}

export function subscriptionRelativeTime(value: string | null, now = Date.now()) {
  if (!value) return "尚未更新"
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return "更新时间不可用"
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (minutes < 1) return "刚刚更新"
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export function subscriptionUsage(item: Pick<ConfigSubscription, "uploadBytes" | "downloadBytes" | "totalBytes">) {
  const used = item.uploadBytes != null && item.downloadBytes != null
    ? item.uploadBytes + item.downloadBytes
    : null
  const progress = used != null && item.totalBytes != null && item.totalBytes > 0
    ? Math.min(100, used / item.totalBytes * 100)
    : null
  return { used, total: item.totalBytes, progress }
}

export const SUBSCRIPTION_INTERVAL_PRESETS = [30, 60, 180, 360, 720, 1440, 4320, 10080] as const

export function subscriptionFilterControl(hasFilterSettings: boolean) {
  return {
    available: true,
    description: hasFilterSettings
      ? "过滤规则将在下次订阅下载时生效。"
      : "无需建立 Provider 提取关系，过滤将在订阅下载阶段生效。",
  }
}

export function subscriptionIntervalOption(minutes: number) {
  return SUBSCRIPTION_INTERVAL_PRESETS.includes(
    minutes as (typeof SUBSCRIPTION_INTERVAL_PRESETS)[number]
  ) ? String(minutes) : "custom"
}

export function subscriptionIntervalLabel(minutes: number) {
  if (minutes < 60) return `每 ${minutes} 分钟`
  if (minutes < 1440 && minutes % 60 === 0) return `每 ${minutes / 60} 小时`
  if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天`
  return `每 ${minutes} 分钟`
}

export type SubscriptionWriteBusy = "load" | "save" | "delete" | null

export function subscriptionUpdateControls(options: {
  busy: SubscriptionWriteBusy
  updatingId: string | null
  itemId: string
  activeId: string | null
  dirty: boolean
}) {
  const updating = options.updatingId === options.itemId
  return {
    updating,
    canSelect: options.busy === null,
    canRefresh: options.busy === null && options.updatingId === null &&
      !(options.itemId === options.activeId && options.dirty),
    writeLocked: options.busy !== null || options.updatingId !== null,
    reason: options.itemId === options.activeId && options.dirty
      ? "请先保存当前订阅设置再更新"
      : null,
  }
}

export function canStartSubscriptionUpdate(options: Parameters<typeof subscriptionUpdateControls>[0]) {
  return subscriptionUpdateControls(options).canRefresh
}

export function refreshedSubscriptionSelection(
  items: ConfigSubscription[],
  activeId: string | null,
  dirty: boolean
) {
  return activeId && !dirty
    ? items.find((item) => item.id === activeId) ?? null
    : null
}
