import { parseDocument, stringify } from "yaml"
import { normalizeProviderFileName, type ManagedProviderItem } from "./managedProviderModel.ts"
import { deleteManagedProviderConfig, replaceCollectionUploadDeclaration, updateManagedProviderConfig } from "./managedProviderYaml.ts"
import { stageCollectionGroups } from "./collectionGroupDraft.ts"

export function suggestedCollectionFileName(name: string) {
  const stem = name.trim().replace(/\.ya?ml$/i, "").replace(/[^\p{L}\p{N}._ -]/gu, "-").replace(/^[^\p{L}\p{N}]+/u, "").slice(0, 100).trim()
  return (stem || "collection") + ".yaml"
}

export function collectionFileName(value: string) {
  const name = normalizeProviderFileName(value)
  if (!/^(?!\.)[\p{L}\p{N}][\p{L}\p{N}._ -]{0,118}\.ya?ml$/iu.test(name)) throw new Error("请输入有效的 YAML 文件名，不包含目录")
  return name
}

export function patchCollectionIdentity(snippet: string, patch: { name?: string; path?: string }) {
  const document = parseDocument(snippet)
  const value = document.toJS()
  if (document.errors.length || !value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length !== 1) throw new Error("请先修正集合声明")
  const name = Object.keys(value)[0]!
  return stringify({ [patch.name ?? name]: { ...value[name], ...(patch.path !== undefined ? { path: patch.path } : {}) } }, { lineWidth: 0 })
}

export function assertCollectionPathAvailable(content: string, category: "proxy" | "rule", path: string, currentName?: string) {
  const document = parseDocument(content)
  const declarations = document.toJS()?.[category + "-providers"] ?? {}
  const normalized = (value: unknown) => {
    if (typeof value !== "string") return null
    const path = value.replaceAll("\\", "/").toLowerCase()
    return path.startsWith("./") ? path.slice(2) : path
  }
  if (Object.entries(declarations).some(([name, entry]) => name !== currentName && entry && typeof entry === "object" && normalized((entry as Record<string, unknown>).path) === normalized(path))) throw new Error("当前配置中已有集合使用该路径，请更换文件名")
}

export function stageCollectionSettings(content: string, item: ManagedProviderItem, draft: { snippet: string; loaded: boolean; selectedGroups: string[]; newGroupNames?: string[] }) {
  const value = parseDocument(draft.snippet)
  const data = value.toJS()
  const names = data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data) : []
  const name = names[0] ?? ""
  const declaration = data?.[name] as Record<string, unknown> | undefined
  if (value.errors.length || names.length !== 1 || !name.trim() || name !== name.trim() || name.length > 120 || (item.category === "rule" && name.includes(",")) || !declaration || declaration.type !== item.declaration?.type) throw new Error("集合名称或来源类型无效")
  if (!draft.loaded) return { name, content: deleteManagedProviderConfig(content, item), declaration }
  if (item.category === "proxy") content = stageCollectionGroups(content, draft.newGroupNames ?? [], draft.selectedGroups, name)
  if (typeof declaration.path === "string") assertCollectionPathAvailable(content, item.category, declaration.path, item.name)
  const source = parseDocument(content).toJS()
  if (name !== item.name && (source?.[item.category + "-providers"]?.[name] || source?.["proxy-groups"]?.some((group: { name?: string }) => group.name === name))) throw new Error("集合名称已存在")
  let next = replaceCollectionUploadDeclaration(content, item, name, declaration)
  if (item.category === "proxy") next = updateManagedProviderConfig(next, { ...item, name, declaration }, { loaded: true, selectedGroups: draft.selectedGroups })
  return { name, content: next, declaration }
}
