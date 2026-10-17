import type { ConfigSnapshot, ManagedHttpProviderOwner, ManagedProviderFile, ManagedProviderFileSnapshot } from "../../api/configClient.ts"
import { parseYamlDraft as parseDocument } from "../../shared/yamlDraft.ts"
import type { ProviderCategory } from "./collectionViewModel.ts"
import {
  managedHttpCatalog,
  managedProviderContentKey,
  managedProviderControlsForItem,
  normalizedReference,
  recordValue,
  ruleSetRules,
  type ManagedProviderControls,
  type ManagedProviderItem,
} from "./managedProviderModel.ts"
import { validateInlineProviderDraft } from "./managedProviderYaml.ts"

export function managedHttpOwnerChangeIds(
  currentOwners: ManagedHttpProviderOwner[],
  savedOwners: ManagedHttpProviderOwner[],
) {
  const stableKey = ({ category, name, originalName }: ManagedHttpProviderOwner) =>
    `${category}:${originalName ?? name}`
  const current = new Set(currentOwners.map(stableKey))
  const baseline = new Set(savedOwners.map(stableKey))
  const changed = [...new Set([...current, ...baseline])]
    .filter((id) => current.has(id) !== baseline.has(id))
  const renamed = currentOwners
    .filter((owner) => owner.originalName && owner.originalName !== owner.name)
    .map(stableKey)
  return [...new Set([...changed, ...renamed])].map((id) => {
    const separator = id.indexOf(":")
    return `${id.slice(0, separator)}:declaration:${id.slice(separator + 1)}`
  })
}

function controlsIdentity(value: ManagedProviderControls | undefined) {
  if (!value) return null
  return JSON.stringify({
    ...value,
    selectedGroups: [...value.selectedGroups].sort(),
    ruleSetRules: [...value.ruleSetRules],
  })
}

export function managedPendingChangeIds(
  current: Record<string, ManagedProviderControls>,
  baseline: Record<string, ManagedProviderControls>,
  extraIds: Iterable<string> = [],
) {
  const changed = new Set(extraIds)
  for (const id of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    if (controlsIdentity(current[id]) !== controlsIdentity(baseline[id])) changed.add(id)
  }
  return changed
}

export function managedProviderDraftIssue(
  controls: Record<string, ManagedProviderControls>,
  itemsByCategory: Record<ProviderCategory, ManagedProviderItem[]>,
) {
  for (const item of itemsByCategory.proxy) {
    const value = controls[item.id]
    if (value?.loaded && value.selectedGroups.length === 0) return "载入代理集合时至少选择一个代理组"
  }
  return null
}

export type ManagedRuleProviderUnloadConflict = {
  providerName: string
  rule: string
}

export function managedRuleProviderUnloadConflicts(
  controls: Record<string, ManagedProviderControls>,
  baselineControls: Record<string, ManagedProviderControls>,
  ruleItems: ManagedProviderItem[],
) {
  return ruleItems.flatMap((item) => {
    const baseline = baselineControls[item.id]
    const current = controls[item.id]
    if (!baseline?.loaded || !current || current.loaded) return []
    return current.ruleSetRules.map((rule) => ({ providerName: item.name, rule }))
  })
}

export function managedRuleProviderUnloadConflictMessage(
  conflicts: ManagedRuleProviderUnloadConflict[],
) {
  if (conflicts.length === 0) return null
  return `请先移除规则引用：${conflicts.map(({ providerName, rule }) => `${providerName}：${rule}`).join("；")}`
}

export function managedProviderOperationPending(
  itemId: string,
  pendingItemIds: ReadonlySet<string>,
  contentDirtyIds: ReadonlySet<string>,
  declarationDirtyIds: ReadonlySet<string>,
) {
  return pendingItemIds.has(itemId) || contentDirtyIds.has(itemId) || declarationDirtyIds.has(itemId)
}

export function managedProviderRowOperationPending(
  item: ManagedProviderItem,
  pendingItemIds: ReadonlySet<string>,
  contentDirtyIds: ReadonlySet<string>,
  declarationDirtyIds: ReadonlySet<string>,
) {
  if (item.draftOriginName && !contentDirtyIds.has(item.id) && !declarationDirtyIds.has(item.id)) return false
  return managedProviderOperationPending(item.id, pendingItemIds, contentDirtyIds, declarationDirtyIds)
}

export function managedProviderApplyTargets(
  category: ProviderCategory,
  currentItems: ManagedProviderItem[],
  baselineItems: ManagedProviderItem[],
  currentControls: Record<string, ManagedProviderControls>,
  baselineControls: Record<string, ManagedProviderControls>,
) {
  const baselineById = new Map(baselineItems.map((item) => [item.id, item]))
  return currentItems.filter((item) => {
    if (item.category !== category || !item.declared) return false
    const currentLoaded = currentControls[item.id]?.loaded ?? item.declared
    if (!currentLoaded) return false
    const baseline = baselineById.get(item.id)
    const baselineLoaded = baselineControls[item.id]?.loaded ?? baseline?.declared ?? false
    if (!baseline || !baselineLoaded) return true
    return JSON.stringify(item.declaration) !== JSON.stringify(baseline.declaration)
  })
}

export function managementBaselineKey(managementOnly: boolean, name: string | null, sha256: string | null) {
  return managementOnly && name && sha256 ? `management:${name}:${sha256}` : null
}

export type ManagementBaseline = {
  snapshot: ConfigSnapshot
  files: ManagedProviderFile[]
  httpOwners: ManagedHttpProviderOwner[]
  controls: Record<string, ManagedProviderControls>
}

export function managedProviderDiscardState(baseline: ManagementBaseline) {
  const httpOwners = baseline.httpOwners.map((owner) => structuredClone(owner))
  const controls = Object.fromEntries(Object.entries(baseline.controls).map(([id, value]) => [id, {
    ...value,
    selectedGroups: [...value.selectedGroups],
    ruleSetRules: [...value.ruleSetRules],
  }]))
  return {
    configContent: baseline.snapshot.content,
    lastValidConfigContent: baseline.snapshot.content,
    httpOwners,
    controls,
    contents: {} as Record<string, string>,
    savedContents: {} as Record<string, string>,
    contentErrors: {} as Record<string, string | null>,
    declarationDrafts: {} as Record<string, string>,
    declarationErrors: {} as Record<string, string | null>,
    configContentError: null,
  }
}

export type ManagementLifecycleState = {
  baseline: ManagementBaseline | null
  requestKey: string | null
  status: "loading" | "ready" | "unavailable" | "stale" | "error"
  message: string
}

export type ManagementLifecycleAction =
  | { type: "start"; requestKey: string }
  | { type: "external-conflict"; message: string }
  | { type: "own-commit"; baseline: ManagementBaseline }
  | { type: "disk-diverged"; baseline: ManagementBaseline; message: string }
  | { type: "unavailable"; requestKey: string; message: string }
  | { type: "failure"; requestKey: string; message: string }
  | { type: "success"; requestKey: string; loadedKey: string; baselineKey: string; baseline: ManagementBaseline; dirty: boolean; resourcesChanged: boolean }

export function managementBaselineResourcesChanged(
  current: ManagementBaseline | null,
  next: ManagementBaseline,
) {
  if (!current) return true
  const resources = (baseline: ManagementBaseline) => JSON.stringify({
    files: baseline.files.map((file) => ({
      category: file.category,
      fileName: file.fileName,
      sha256: file.sha256,
      source: file.source,
      writable: file.writable,
    })).sort((left, right) => `${left.category}:${left.fileName}`.localeCompare(`${right.category}:${right.fileName}`)),
    owners: baseline.httpOwners.map((owner) => ({
      category: owner.category,
      name: owner.name,
      writable: owner.writable !== false,
    })).sort((left, right) => `${left.category}:${left.name}`.localeCompare(`${right.category}:${right.name}`)),
  })
  return resources(current) !== resources(next)
}

export function managementLifecycleState(baseline: ManagementBaseline | null): ManagementLifecycleState {
  return baseline
    ? { baseline, requestKey: null, status: "ready", message: "合并配置已同步" }
    : { baseline: null, requestKey: null, status: "loading", message: "正在读取合并配置" }
}

export function reduceManagementLifecycle(
  state: ManagementLifecycleState,
  action: ManagementLifecycleAction,
): ManagementLifecycleState {
  if (action.type === "start") {
    return { ...state, requestKey: action.requestKey, status: "loading", message: "正在后台读取合并配置" }
  }
  if (action.type === "external-conflict") {
    return { ...state, status: "stale", message: action.message }
  }
  if (action.type === "own-commit") {
    return { baseline: action.baseline, requestKey: null, status: "ready", message: "合并配置已同步" }
  }
  if (action.type === "disk-diverged") {
    return { baseline: action.baseline, requestKey: null, status: "stale", message: action.message }
  }
  if (state.requestKey !== action.requestKey) return state
  if (action.type === "unavailable") {
    return { ...state, status: "unavailable", message: action.message }
  }
  if (action.type === "failure") {
    return { ...state, status: "error", message: action.message }
  }
  if (action.requestKey !== action.loadedKey || action.loadedKey !== action.baselineKey) {
    return { ...state, status: "stale", message: "最近加载的配置身份已变化；已保留当前草稿，请重新读取" }
  }
  if (action.dirty) {
    const currentKey = state.baseline
      ? managementBaselineKey(true, state.baseline.snapshot.name, state.baseline.snapshot.sha256)
      : null
    if (currentKey === action.baselineKey && !action.resourcesChanged) {
      return { ...state, requestKey: null, status: "ready", message: "合并配置已同步" }
    }
    return { ...state, status: "stale", message: "磁盘配置已刷新；已保留当前未应用草稿，请先处理冲突" }
  }
  return { baseline: action.baseline, requestKey: null, status: "ready", message: "合并配置已同步" }
}

export function managementLifecycleView(state: ManagementLifecycleState, busy: boolean) {
  const hasBaseline = Boolean(state.baseline)
  return {
    showSkeleton: state.status === "loading" && !hasBaseline,
    preserveBaseline: hasBaseline,
    writeDisabled: busy || state.status !== "ready" || !hasBaseline,
    showMessage: state.status !== "ready",
  }
}

export function managedProviderFileSaveTargets(items: ManagedProviderItem[], changedKeys: ReadonlySet<string>) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = managedProviderContentKey(item)
    if (item.access === "inline" || !changedKeys.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function managedProviderFileHasDraft(
  item: ManagedProviderItem,
  items: ManagedProviderItem[],
  contents: Readonly<Record<string, string>>,
  savedContents: Readonly<Record<string, string>>,
  pendingItemIds: ReadonlySet<string>,
  declarationDirtyIds: ReadonlySet<string>,
) {
  return items.some((candidate) => {
    if (candidate.category !== item.category || (candidate.id !== item.id &&
      !(item.fileName && candidate.fileName === item.fileName) &&
      !(item.referencePath && normalizedReference(candidate.referencePath) === normalizedReference(item.referencePath)))) return false
    const key = managedProviderContentKey(candidate)
    const contentDirtyIds = new Set(contents[key] !== undefined && contents[key] !== (savedContents[key] ?? candidate.content) ? [candidate.id] : [])
    return managedProviderRowOperationPending(candidate, pendingItemIds, contentDirtyIds, declarationDirtyIds)
  })
}

export function reconcileManagedProviderDraft(
  snapshot: ConfigSnapshot,
  files: ManagedProviderFile[],
  persistedHttpOwners: ManagedHttpProviderOwner[],
  itemReader: (
    snapshot: ConfigSnapshot,
    files: ManagedProviderFile[],
    category: ProviderCategory,
    manualHttpCatalog: ManagedHttpProviderOwner[],
  ) => ManagedProviderItem[],
) {
  const httpOwners = managedHttpCatalog(snapshot, persistedHttpOwners)
  const config = recordValue(parseDocument(snapshot.content).toJS()) ?? {}
  const itemsByCategory = {
    proxy: itemReader(snapshot, files, "proxy", httpOwners),
    rule: itemReader(snapshot, files, "rule", httpOwners),
  }
  const controls = Object.fromEntries(
    [...itemsByCategory.proxy, ...itemsByCategory.rule].map((item) => {
      const derived = managedProviderControlsForItem(item)
      return [item.id, {
        ...derived,
        ruleSetRules: item.category === "rule" ? ruleSetRules(config, item.name) : derived.ruleSetRules,
      }]
    }),
  )
  return { httpOwners, itemsByCategory, controls }
}

export async function resolveManagedProviderBaseline(
  snapshot: ConfigSnapshot,
  fallbackFiles: ManagedProviderFile[],
  fallbackHttpOwners: ManagedHttpProviderOwner[],
  readFiles: () => Promise<ManagedProviderFile[]>,
  readHttpOwners: () => Promise<ManagedHttpProviderOwner[]>,
  itemReader: (
    snapshot: ConfigSnapshot,
    files: ManagedProviderFile[],
    category: ProviderCategory,
    manualHttpCatalog: ManagedHttpProviderOwner[],
  ) => ManagedProviderItem[],
): Promise<ManagementBaseline> {
  const resources = await Promise.allSettled([readFiles(), readHttpOwners()])
  const files = resources[0]?.status === "fulfilled" ? resources[0].value : fallbackFiles
  const cleanFallbackOwners = fallbackHttpOwners.map((owner) => {
    const next = { ...owner }
    delete next.originalName
    delete next.originalDeclaration
    return next
  })
  const persistedOwners = resources[1]?.status === "fulfilled" ? resources[1].value : cleanFallbackOwners
  const reconciled = reconcileManagedProviderDraft(snapshot, files, persistedOwners, itemReader)
  return {
    snapshot,
    files,
    httpOwners: reconciled.httpOwners,
    controls: reconciled.controls,
  }
}

export function reconcileManagedProviderTextEdit(
  value: string,
  lastValidContent: string,
  snapshot: ConfigSnapshot,
  files: ManagedProviderFile[],
  persistedHttpOwners: ManagedHttpProviderOwner[],
  itemReader: (
    snapshot: ConfigSnapshot,
    files: ManagedProviderFile[],
    category: ProviderCategory,
    manualHttpCatalog: ManagedHttpProviderOwner[],
  ) => ManagedProviderItem[],
) {
  try {
    const document = parseDocument(value)
    const error = document.errors[0]?.message
    if (error) return { lastValidContent, error, reconciled: null }
    return {
      lastValidContent: value,
      error: null,
      reconciled: reconcileManagedProviderDraft(
        { ...snapshot, content: value },
        files,
        persistedHttpOwners,
        itemReader,
      ),
    }
  } catch (caught) {
    return {
      lastValidContent,
      error: caught instanceof Error ? caught.message : "当前配置 YAML 无法解析",
      reconciled: null,
    }
  }
}

export function managedConfigIdentity(
  snapshot: Pick<ConfigSnapshot, "name" | "sha256"> | null,
  loadedName: string | null,
  loadedSha256: string | null,
) {
  return Boolean(snapshot && loadedName && loadedSha256 &&
    snapshot.name === loadedName && snapshot.sha256 === loadedSha256)
}

export function managedProviderRuntimePaired(
  snapshot: Pick<ConfigSnapshot, "name"> | null,
  confirmedSourceName: string | null,
  status: ManagementLifecycleState["status"],
) {
  return Boolean(snapshot && confirmedSourceName === snapshot.name && status === "ready")
}

export function shouldSyncManagedHttpCatalog(
  saved: readonly Pick<ManagedHttpProviderOwner, "category" | "name">[],
  desired: readonly Pick<ManagedHttpProviderOwner, "category" | "name">[],
) {
  return saved.length > 0 || desired.length > 0
}

export function managedProviderConfigSaveKind(options: {
  snapshot: ConfigSnapshot
  fresh: ConfigSnapshot
  content: string
  changedItems: readonly ManagedProviderItem[]
  currentOwners: readonly ManagedHttpProviderOwner[]
  savedOwners: readonly ManagedHttpProviderOwner[]
  desiredOwners: readonly Pick<ManagedHttpProviderOwner, "category" | "name">[]
}) {
  const ownerIdentity = (owners: readonly ManagedHttpProviderOwner[]) => JSON.stringify(owners.map((owner) => ({
    configName: owner.configName, category: owner.category, name: owner.name,
    writable: owner.writable !== false, declaration: owner.declaration,
    originalName: owner.originalName, originalDeclaration: owner.originalDeclaration,
  })).sort((a, b) => `${a.category}:${a.name}`.localeCompare(`${b.category}:${b.name}`)))
  const ownershipKeys = (owners: readonly Pick<ManagedHttpProviderOwner, "category" | "name">[]) =>
    JSON.stringify(owners.map((owner) => `${owner.category}:${owner.name}`).sort())
  const onlyFileBodies = options.changedItems.length > 0 && options.changedItems.every((item) =>
    item.declared && item.writable && !item.fileIssue && item.fileName && item.sha256 &&
    (item.access === "manual" || item.access === "external"))
  if (onlyFileBodies && options.snapshot.name === options.fresh.name && options.snapshot.sha256 === options.fresh.sha256 &&
    options.content === options.snapshot.content && options.content === options.fresh.content &&
    ownerIdentity(options.currentOwners) === ownerIdentity(options.savedOwners) &&
    ownershipKeys(options.desiredOwners) === ownershipKeys(options.savedOwners.filter((owner) => owner.writable !== false))) {
    return "reuse" as const
  }
  return shouldSyncManagedHttpCatalog(options.savedOwners, options.desiredOwners) ? "catalog" as const : "file" as const
}

export function managedProviderSavedContents(items: ManagedProviderItem[], savedFiles: ManagedProviderFileSnapshot[]) {
  const contents: Record<string, string> = {}
  for (const item of items) {
    if (!item.writable || (item.access !== "manual" && item.access !== "external")) continue
    const saved = savedFiles.find((file) => file.category === item.category && file.fileName === item.fileName &&
      normalizedReference(file.referencePath) === normalizedReference(item.referencePath) && file.sha256 === item.sha256)
    if (saved) contents[managedProviderContentKey(item)] = saved.content
  }
  return contents
}

export function externalManagedConfigDecision(options: {
  snapshotName: string | null
  commitName: string
  commitSha256: string
  loadedName: string | null
  loadedSha256: string | null
  dirty: boolean
}) {
  if (!options.snapshotName || options.snapshotName !== options.commitName ||
    options.loadedName !== options.commitName || options.loadedSha256 !== options.commitSha256) return "ignore" as const
  return options.dirty ? "conflict" as const : "adopt" as const
}

export function updateInlineDraftState(
  configContent: string,
  contents: Record<string, string>,
  errors: Record<string, string | null>,
  item: ManagedProviderItem,
  editorContent: string,
) {
  const result = validateInlineProviderDraft(configContent, item, editorContent)
  return {
    configContent: result.content ?? configContent,
    contents: { ...contents, [item.id]: editorContent },
    errors: { ...errors, [item.id]: result.error },
  }
}
