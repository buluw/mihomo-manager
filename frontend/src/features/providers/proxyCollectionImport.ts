import { proxyCollectionCount, ruleCollectionCount } from "../../shared/collectionContent.ts"
import { isMap, isSeq, parseDocument, stringify } from "yaml"
import { addHttpProviderConfig } from "./managedProviderYaml.ts"
import { type ManagedProviderItem } from "./managedProviderModel.ts"
import type { CollectionCategory, ProxyCollectionInput } from "../../api/configClient.ts"

export function readUploadDeclaration(snippet: string, category: CollectionCategory) {
  const document = parseDocument(snippet)
  if (document.errors.length || !isMap(document.contents) || document.contents.items.length !== 1) throw new Error("请保留一个集合名称及其 YAML 声明")
  const value = document.toJS() as Record<string, unknown>
  const name = Object.keys(value)[0]!
  const declaration = value[name] as Record<string, unknown> | null
  if (!name.trim() || name !== name.trim() || name.length > 120 || (category === "rule" && name.includes(",")) ||
    !declaration || typeof declaration !== "object" || Array.isArray(declaration)) throw new Error("集合名称或声明无效")
  if (declaration.type !== "file" || typeof declaration.path !== "string" || !declaration.path.trim() ||
    declaration.url !== undefined || declaration.payload !== undefined || declaration.proxies !== undefined) throw new Error("上传声明须保留 File 类型和受控文件路径；正文使用所选上传文件")
  if (category === "rule" && (!["classical", "domain", "ipcidr"].includes(String(declaration.behavior)) ||
    (declaration.format !== undefined && declaration.format !== "yaml"))) throw new Error("规则上传须使用 YAML 和有效规则类型")
  return { name, declaration }
}

export function patchUploadDeclaration(snippet: string, category: CollectionCategory, patch: { name?: string; behavior?: string }) {
  const document = parseDocument(snippet)
  if (document.errors.length || !isMap(document.contents) || document.contents.items.length !== 1) throw new Error("请先修正集合声明")
  const name = String(document.contents.items[0]!.key)
  const declaration = document.toJS()[name] as Record<string, unknown>
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) throw new Error("请先修正集合声明")
  return stringify({ [patch.name ?? name]: { ...declaration, ...(category === "rule" && patch.behavior ? { behavior: patch.behavior } : {}) } }, { lineWidth: 0 })
}

export function createCollectionDraft(content: string, input: ProxyCollectionInput, type: "inline" | "file" | "http", url: string, category: CollectionCategory = "proxy", filePath?: string, fileDeclaration?: Record<string, unknown>) {
  const name = input.name.trim()
  const source = parseDocument(content)
  if (source.errors.length || !isMap(source.contents)) throw new Error("当前配置 YAML 无效")
  const sectionName = category === "proxy" ? "proxy-providers" : "rule-providers"
  if (!name || name.length > 120 || (category === "rule" && name.includes(",")) || source.hasIn([sectionName, name])) throw new Error("集合名称无效或已存在")
  const available = proxyCollectionGroups(content)
  if (category === "proxy" && available.some((group) => group.name === name)) throw new Error("集合名与代理组名称冲突")
  if (input.groupNames.some((group) => !available.some((item) => item.name === group))) throw new Error("所选代理组已不存在")
  const newGroup = input.newGroupName?.trim()
  if (category === "proxy" && newGroup && (newGroup.length > 120 || newGroup === name || available.some((group) => group.name === newGroup) || source.hasIn(["proxy-providers", newGroup]))) throw new Error("新代理组名称已存在或无效")
  if (category === "proxy" && !input.groupNames.length && !newGroup && !available.some((group) => group.implicit)) throw new Error("至少选择一个代理组或填写新组名称")
  let declaration: Record<string, unknown>
  if (type === "inline") {
    if (category === "proxy") {
      proxyCollectionCount(input.content)
      declaration = { type, payload: parseDocument(input.content).toJS().proxies }
    } else {
      ruleCollectionCount(input.content)
      declaration = { type, behavior: input.behavior ?? "classical", format: "yaml", payload: parseDocument(input.content).toJS().payload }
    }
  } else if (type === "file") {
    if (!filePath) throw new Error("请选择受控集合文件")
    declaration = fileDeclaration ?? (category === "proxy"
      ? { type: "file", path: filePath }
      : { type: "file", behavior: input.behavior ?? "classical", format: "yaml", path: filePath })
  } else {
    declaration = addHttpProviderConfig(content, category, name, url, {
      version: 0, ruleBehavior: input.behavior ?? "classical", ruleFormat: input.format ?? "yaml", interval: null, healthCheck: false,
    }).declaration
    const interval = input.interval ?? 0
    if (!Number.isSafeInteger(interval) || interval < 0) throw new Error("更新周期无效")
    declaration.interval = interval
  }
  source.setIn([sectionName, name], declaration)
  if (category === "proxy") {
    if (!source.has("proxy-groups")) source.set("proxy-groups", source.createNode([]))
    const groups = source.get("proxy-groups", true)
    if (!isSeq(groups)) throw new Error("代理组结构无效")
    for (const group of groups.items) {
      if (!isMap(group) || !input.groupNames.includes(String(group.get("name")))) continue
      if (group.get("include-all") === true || group.get("include-all-providers") === true) continue
      const use = group.get("use", true)
      group.set("use", [...new Set([...(isSeq(use) ? use.toJSON() as string[] : []), name])])
    }
    if (newGroup) groups.add({ name: newGroup, type: "select", use: [name] })
  } else {
    if (!["classical", "domain", "ipcidr"].includes(input.behavior ?? "classical")) throw new Error("规则类型无效")
    const policies = new Set(["DIRECT", ...available.map((group) => group.name)])
    if (!input.ruleSetRules?.length || input.ruleSetRules.some((rule) => {
      const parts = rule.split(",")
      return parts.length !== 3 || parts[0] !== "RULE-SET" || parts[1] !== name || !policies.has(parts[2]!)
    })) throw new Error("请选择匹配后的代理组或直连")
    const rules = source.get("rules", true)
    if (rules != null && !isSeq(rules)) throw new Error("规则结构无效")
    if (!isSeq(rules)) source.set("rules", source.createNode([]))
    const ruleList = source.get("rules", true)
    if (isSeq(ruleList)) {
      const fallback = (ruleList.toJSON() as unknown[]).findIndex((rule) => typeof rule === "string" && /^(MATCH|FINAL),/.test(rule))
      ruleList.items.splice(fallback < 0 ? ruleList.items.length : fallback, 0, ...input.ruleSetRules.map((rule) => source.createNode(rule)))
    }
  }
  return { name, declaration, content: source.toString({ lineWidth: 0 }) }
}

export function proxyCollectionGroups(content: string): Array<{ name: string; implicit: boolean }> {
  const document = parseDocument(content)
  if (document.errors.length) return []
  const groups = document.toJS()?.["proxy-groups"]
  return Array.isArray(groups) ? groups.flatMap((group) => group && typeof group.name === "string"
    ? [{ name: group.name, implicit: group["include-all"] === true || group["include-all-providers"] === true }] : []) : []
}

export function collectionUploadTargets(items: ManagedProviderItem[], category: CollectionCategory) {
  return items.filter((item) => item.category === category && item.declared && item.declaration?.type === "file" &&
    (item.access === "manual" || item.access === "external") &&
    (category !== "rule" || item.declaration.format === undefined || item.declaration.format === "yaml") &&
    (item.fileIssue === "missing" || (!item.fileIssue && item.writable && Boolean(item.fileName && item.sha256))))
}

export function collectionUploadMatches(fileName: string, items: ManagedProviderItem[], category: CollectionCategory = "proxy") {
  const stem = fileName.replace(/\.ya?ml$/i, "")
  return collectionUploadTargets(items, category).filter((item) => {
    const path = typeof item.declaration?.path === "string" ? item.declaration.path.split(/[\\/]/).at(-1) : null
    return path === fileName || item.name === fileName || item.name === stem
  })
}
