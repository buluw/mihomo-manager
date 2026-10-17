import type { ConfigSnapshot, ManagedHttpProviderOwner, ManagedProviderFile, ProviderFileIssue } from "../../api/configClient.ts"
import { stringify } from "yaml"
import { parseYamlDraft as parseDocument } from "../../shared/yamlDraft.ts"
import type { ProviderCategory } from "./collectionViewModel.ts"

export type ManagedProviderAccess = "inline" | "manual" | "subscription" | "local" | "external" | "http"

export type ManagedProviderItem = {
  id: string
  category: ProviderCategory
  name: string
  fileName: string | null
  referencePath: string | null
  access: ManagedProviderAccess
  writable: boolean
  declared: boolean
  declaration: Record<string, unknown> | null
  content: string
  sha256: string | null
  filterSettings: ManagedProviderFile["filterSettings"]
  extractionId: string | null
  ownerId?: string | null
  draftOriginName?: string
  pendingRemoval?: boolean
  groups: string[]
  selectedGroups: string[]
  ruleSetRules: string[]
  fileIssue?: ProviderFileIssue["status"]
  implicitGroups?: string[]
}

export type ManagedProviderControls = {
  loaded: boolean
  selectedGroups: string[]
  ruleSetRules: string[]
  behavior: string
  format: string
  interval: number | null
}

export function managedProviderControlsForItem(item: ManagedProviderItem): ManagedProviderControls {
  return {
    loaded: item.declared,
    selectedGroups: item.selectedGroups,
    ruleSetRules: item.ruleSetRules,
    behavior: typeof item.declaration?.behavior === "string" ? item.declaration.behavior : "classical",
    format: typeof item.declaration?.format === "string" ? item.declaration.format : "yaml",
    interval: Number.isSafeInteger(item.declaration?.interval) && Number(item.declaration?.interval) > 0
      ? Number(item.declaration?.interval)
      : null,
  }
}

export function managedHttpCatalog(
  snapshot: ConfigSnapshot,
  persisted: ManagedHttpProviderOwner[],
) {
  const catalog = new Map(persisted.map((owner) => [
    `${owner.category}\0${owner.name}`,
    { ...owner, writable: owner.writable !== false, ...(owner.declaration ? { declaration: structuredClone(owner.declaration) } : {}) },
  ]))
  const document = parseDocument(snapshot.content)
  if (document.errors.length > 0) return [...catalog.values()]
  const config = recordValue(document.toJS()) ?? {}
  for (const category of ["proxy", "rule"] as const) {
    const declarations = recordValue(config[providerSection(category)]) ?? {}
    for (const [name, raw] of Object.entries(declarations)) {
      const declaration = recordValue(raw)
      if (!declaration) continue
      const explicitType = typeof declaration.type === "string" ? declaration.type : null
      const http = explicitType === "http" || (explicitType === null && typeof declaration.url === "string")
      if (!http || typeof declaration.url !== "string" || typeof declaration.path !== "string") continue
      const key = `${category}\0${name}`
      let existing = catalog.get(key)
      if (!existing) {
        const comparable = (value: Record<string, unknown> | undefined) => {
          if (!value) return null
          const copy = structuredClone(value)
          delete copy.path
          return JSON.stringify(copy)
        }
        const candidates = [...catalog.entries()].filter(([, owner]) =>
          owner.category === category && owner.writable !== false && comparable(owner.declaration) === comparable(declaration))
        if (candidates.length === 1) {
          const [previousKey, previous] = candidates[0]!
          catalog.delete(previousKey)
          existing = {
            ...previous,
            originalName: previous.originalName ?? previous.name,
            originalDeclaration: previous.originalDeclaration ?? previous.declaration,
          }
        }
      }
      catalog.set(key, {
        configName: snapshot.name,
        category,
        name,
        declaration: structuredClone(declaration),
        writable: existing?.writable ?? false,
        ...(existing?.originalName ? { originalName: existing.originalName } : {}),
        ...(existing?.originalDeclaration ? { originalDeclaration: structuredClone(existing.originalDeclaration) } : {}),
      })
    }
  }
  return [...catalog.values()].sort((left, right) =>
    left.category.localeCompare(right.category) || left.name.localeCompare(right.name, "zh-CN"))
}

export function desiredManagedHttpOwners(items: ManagedProviderItem[]) {
  return items.filter((item) => item.access === "http" && item.writable)
    .map((item) => ({ category: item.category, name: item.name }))
}

export function managedProviderModificationReason(item: ManagedProviderItem) {
  if (item.access === "inline" && item.declared) return null
  if (item.writable && (item.access === "manual" || item.access === "http")) return null
  if ((item.access === "subscription" || item.access === "local") && item.ownerId && item.sha256) return null
  if (item.access === "subscription" || item.access === "local") return "无法确认自动提取 Provider 的所有权"
  if (item.access === "external") return "文件不属于管理器，允许编辑但不能删除文件"
  if (item.access === "http") return "此 HTTP 集合不由管理器创建，不能删除"
  return "无法确认集合的删除权限"
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function normalizedReference(value: unknown) {
  return typeof value === "string"
    ? value.replaceAll("\\", "/").replace(/^\.\//, "")
    : ""
}

export function managedProviderContentKey(item: Pick<ManagedProviderItem,
  "id" | "category" | "access" | "writable" | "fileName" | "referencePath">) {
  return item.writable && item.fileName && item.referencePath && (item.access === "manual" || item.access === "external")
    ? `${item.category}:body:${normalizedReference(item.referencePath)}`
    : item.id
}

export function providerSection(category: ProviderCategory) {
  return category === "proxy" ? "proxy-providers" : "rule-providers"
}

function groupState(config: Record<string, unknown>, providerName: string) {
  const groups = Array.isArray(config["proxy-groups"])
    ? config["proxy-groups"] as unknown[]
    : []
  const names: string[] = []
  const selected: string[] = []
  const implicit: string[] = []
  for (const value of groups) {
    const group = recordValue(value)
    if (!group || typeof group.name !== "string") continue
    names.push(group.name)
    if (group["include-all"] === true || group["include-all-providers"] === true) implicit.push(group.name)
    if (implicit.includes(group.name) || (Array.isArray(group.use) && group.use.includes(providerName))) selected.push(group.name)
  }
  return { names, selected, implicit }
}

export function ruleSetRules(config: Record<string, unknown>, providerName: string) {
  return (Array.isArray(config.rules) ? config.rules : []).filter(
    (rule): rule is string => typeof rule === "string" &&
      rule.split(",", 3)[0] === "RULE-SET" && rule.split(",", 3)[1] === providerName,
  )
}

function inlineContent(declaration: Record<string, unknown>) {
  if (Array.isArray(declaration.proxies)) return stringify({ proxies: declaration.proxies }, { lineWidth: 0 })
  return stringify({ payload: Array.isArray(declaration.payload) ? declaration.payload : [] }, { lineWidth: 0 })
}

function declarationContent(declaration: Record<string, unknown>) {
  return stringify(declaration, { lineWidth: 0 })
}

export function managedProviderDeclarationSnippet(item: ManagedProviderItem) {
  if (!item.declared || !item.declaration) return ""
  return stringify({ [item.name]: item.declaration }, { lineWidth: 0 })
}

export function managedProviderItems(
  snapshot: ConfigSnapshot,
  files: ManagedProviderFile[],
  category: ProviderCategory,
  manualHttpCatalog: ReadonlySet<string> | ManagedHttpProviderOwner[] = new Set(),
) {
  const httpRecords = Array.isArray(manualHttpCatalog)
    ? manualHttpCatalog.filter((entry) => entry.category === category)
    : []
  const manualHttpNames = Array.isArray(manualHttpCatalog)
    ? new Set(httpRecords.filter((entry) => entry.writable !== false).map((entry) => entry.name))
    : manualHttpCatalog
  const document = parseDocument(snapshot.content)
  if (document.errors.length > 0) throw new Error("当前配置 YAML 无法解析")
  const config = recordValue(document.toJS()) ?? {}
  const declarations = recordValue(config[providerSection(category)]) ?? {}
  const matchedFiles = new Set<string>()
  const items: ManagedProviderItem[] = []

  for (const [name, raw] of Object.entries(declarations)) {
    const declaration = recordValue(raw)
    if (!declaration) continue
    const path = normalizedReference(declaration.path)
    const file = path
      ? files.find((candidate) =>
        candidate.category !== "unknown" &&
        normalizedReference(candidate.referencePath) === path)
      : undefined
    if (file) matchedFiles.add(file.fileName)
    const explicitType = typeof declaration.type === "string" ? declaration.type : null
    const http = explicitType === "http" || (explicitType === null && typeof declaration.url === "string")
    const inline = explicitType === "inline" || (explicitType === null && !path && !http)
    const access: ManagedProviderAccess = inline
      ? "inline"
      : http
        ? "http"
        : file?.source ?? "external"
    const groups = groupState(config, name)
    const canonicalFileName = file?.fileName.replace(/\.ya?ml$/i, "")
    const httpRecord = access === "http" ? httpRecords.find((entry) => entry.name === name) : undefined
    items.push({
      id: file && access !== "inline" && access !== "http" && name === canonicalFileName
        ? `${category}:file:${file.fileName}`
        : `${category}:declaration:${httpRecord?.originalName ?? name}`,
      category,
      name,
      fileName: file?.fileName ?? null,
      referencePath: file?.referencePath ?? (path ? `./${path}` : null),
      access,
      writable: access === "inline" || (access !== "http" && Boolean(file?.writable)) || (access === "http" && manualHttpNames.has(name)),
      declared: true,
      declaration,
      content: access === "inline"
        ? inlineContent(declaration)
        : access === "http"
          ? declarationContent(declaration)
          : "",
      sha256: file?.sha256 ?? null,
      filterSettings: file?.filterSettings ?? null,
      extractionId: file?.extractionId ?? null,
      ownerId: file?.ownerId ?? null,
      ...(httpRecord?.originalName ? { draftOriginName: httpRecord.originalName } : {}),
      groups: groups.names,
      selectedGroups: groups.selected,
      ruleSetRules: category === "rule" ? ruleSetRules(config, name) : [],
      fileIssue: snapshot.providerIssues?.find((issue) => issue.category === category && issue.name === name)?.status,
      implicitGroups: groups.implicit,
    })
  }

  const declaredNames = new Set(items.filter((item) => item.declared).map((item) => item.name))
  for (const owner of httpRecords) {
    for (const declaration of [owner.declaration, owner.originalDeclaration]) {
      const path = normalizedReference(declaration?.path)
      const file = path
        ? files.find((candidate) => candidate.category === category && candidate.source !== "manual" && normalizedReference(candidate.referencePath) === path)
        : undefined
      if (file) matchedFiles.add(file.fileName)
    }
  }

  for (const file of files) {
    if (file.category !== category || matchedFiles.has(file.fileName)) continue
    const name = file.fileName.replace(/\.ya?ml$/i, "")
    const groups = groupState(config, name)
    items.push({
      id: `${category}:file:${file.fileName}`,
      category,
      name,
      fileName: file.fileName,
      referencePath: file.referencePath,
      access: file.source,
      writable: file.writable,
      declared: false,
      declaration: null,
      content: "",
      sha256: file.sha256,
      filterSettings: file.filterSettings,
      extractionId: file.extractionId,
      ownerId: file.ownerId ?? null,
      groups: groups.names,
      selectedGroups: groups.selected,
      ruleSetRules: [],
    })
  }

  for (const owner of httpRecords) {
    if (declaredNames.has(owner.name) || !owner.declaration) continue
    const declaration = structuredClone(owner.declaration)
    const path = normalizedReference(declaration.path)
    items.push({
      id: `${category}:declaration:${owner.originalName ?? owner.name}`,
      category,
      name: owner.name,
      fileName: typeof declaration.path === "string" ? declaration.path.split(/[\\/]/).pop() ?? null : null,
      referencePath: path ? `./${path}` : null,
      access: "http",
      writable: owner.writable !== false,
      declared: false,
      declaration,
      content: declarationContent(declaration),
      sha256: null,
      filterSettings: null,
      extractionId: null,
      ownerId: null,
      ...(owner.originalName ? { draftOriginName: owner.originalName } : {}),
      groups: groupState(config, owner.name).names,
      selectedGroups: [],
      ruleSetRules: [],
    })
  }

  return items.sort((left, right) => {
    const leftPriority = left.access === "inline" || left.access === "manual" ? 0 : 1
    const rightPriority = right.access === "inline" || right.access === "manual" ? 0 : 1
    return leftPriority - rightPriority || left.name.localeCompare(right.name, "zh-CN")
  })
}

export function managedCollectionItems(
  snapshot: ConfigSnapshot,
  files: ManagedProviderFile[],
  category: ProviderCategory,
  manualHttpCatalog: ReadonlySet<string> | ManagedHttpProviderOwner[] = new Set(),
  baseline?: ConfigSnapshot,
) {
  let items = managedProviderItems(snapshot, files, category, manualHttpCatalog)
    .filter((item) => item.declared)
  if (baseline) {
    for (const original of managedProviderItems(baseline, files, category, manualHttpCatalog)) {
      if (!original.declared || items.some((item) => item.declared && item.id === original.id)) continue
      // Keep the original identity and declaration until this removal is saved.
      items = items.filter((item) => item.id !== original.id &&
        (item.declared || item.pendingRemoval || item.id !== `${category}:file:${original.fileName}`))
      items.push({ ...original, declared: false, pendingRemoval: true })
    }
  }
  return items
}

export function normalizeProviderFileName(fileName: string) {
  const trimmed = fileName.trim()
  return /\.ya?ml$/i.test(trimmed) ? trimmed : `${trimmed}.yaml`
}

export function httpIntervalSeconds(value: number, unit: "minutes" | "hours" | "days") {
  const multiplier = unit === "days" ? 86_400 : unit === "hours" ? 3_600 : 60
  const seconds = Math.round(value * multiplier)
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("自动更新周期必须大于 0")
  return seconds
}
