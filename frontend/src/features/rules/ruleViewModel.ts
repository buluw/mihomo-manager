import type { Json } from "@/shared/types"
import { isScalar, isSeq, parseDocument } from "yaml"

export type RuleItem = {
  id: string
  type: string
  payload: string
  policy: string
}

export type RuleTone = "provider" | "domain" | "network" | "geo" | "process" | "logic" | "muted"

export function ruleItems(rules: Json[]): RuleItem[] {
  const occurrences = new Map<string, number>()

  return rules.map((rule) => {
    const fingerprint = [rule.type, rule.payload, rule.proxy].map(String).join("\u0000")
    const occurrence = occurrences.get(fingerprint) ?? 0
    occurrences.set(fingerprint, occurrence + 1)

    return {
      id: `${fingerprint}\u0000${occurrence}`,
      type: String(rule.type || "Unknown"),
      payload: String(rule.payload || ""),
      policy: String(rule.proxy || "-"),
    }
  })
}

export function filterRuleItems(rules: RuleItem[], query: string, typeFilter: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN")
  return rules.filter(({ type, payload, policy }) =>
    (typeFilter === "all" || type === typeFilter) &&
    (!normalizedQuery || [type, payload, policy].some((value) =>
      value.toLocaleLowerCase("zh-CN").includes(normalizedQuery)
    ))
  )
}

function topLevelFieldSpans(rule: string) {
  const fields: Array<{ start: number; end: number }> = []
  let start = 0
  let depth = 0
  for (let index = 0; index < rule.length; index += 1) {
    if (rule[index] === "(") depth += 1
    else if (rule[index] === ")") depth -= 1
    else if (rule[index] === "," && depth === 0) {
      fields.push({ start, end: index })
      start = index + 1
    }
    if (depth < 0) throw new Error("规则括号不平衡")
  }
  if (depth !== 0) throw new Error("规则括号不平衡")
  fields.push({ start, end: rule.length })
  return fields
}

function topLevelFields(rule: string) {
  return topLevelFieldSpans(rule).map(({ start, end }) => rule.slice(start, end).trim())
}

function ruleIdentity(raw: string) {
  let hash = 0xcbf29ce484222325n
  for (const character of raw) {
    hash ^= BigInt(character.codePointAt(0) ?? 0)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, "0")
}

export function configRuleItems(content: string): RuleItem[] {
  const document = parseDocument(content)
  if (document.errors.length) throw new Error("配置 YAML 无法解析")
  const rules = document.get("rules", true)
  if (rules == null) return []
  if (!isSeq(rules)) throw new Error("配置 rules 不是列表")
  const occurrences = new Map<string, number>()
  return rules.items.map((node) => {
    if (!isScalar(node) || typeof node.value !== "string") throw new Error("配置包含无法排序的规则")
    const raw = node.value
    const fingerprint = ruleIdentity(raw)
    const occurrence = occurrences.get(fingerprint) ?? 0
    occurrences.set(fingerprint, occurrence + 1)
    const fields = topLevelFields(raw)
    const type = fields[0] || "Unknown"
    const policyIndex = ["MATCH", "FINAL"].includes(type.toUpperCase()) ? 1 : 2
    return {
      id: `rule-${fingerprint}-${occurrence}`,
      type,
      payload: fields.slice(1, policyIndex).join(","),
      policy: fields[policyIndex] || "-",
    }
  })
}

export function configProxyGroupNames(content: string) {
  const document = parseDocument(content)
  if (document.errors.length) throw new Error("配置 YAML 无法解析")
  const groups = document.get("proxy-groups", true)
  if (groups == null) return []
  if (!isSeq(groups)) throw new Error("配置 proxy-groups 不是列表")
  return [...new Set(groups.items.flatMap((node) => {
    if (!node || typeof node !== "object" || !("get" in node)) return []
    const name = (node as { get: (key: string) => unknown }).get("name")
    return typeof name === "string" && name ? [name] : []
  }))]
}

export function configRuleProviderNames(content: string) {
  const document = parseDocument(content)
  if (document.errors.length) throw new Error("配置 YAML 无法解析")
  const providers = document.get("rule-providers", true)
  if (providers == null) return []
  if (!providers || typeof providers !== "object" || !("items" in providers)) {
    throw new Error("配置 rule-providers 不是映射")
  }
  return (providers as { items: Array<{ key?: unknown }> }).items.flatMap(({ key }) =>
    isScalar(key) && typeof key.value === "string" ? [key.value] : [])
}

export function rulePolicyEditable(rule: RuleItem) {
  return rule.type.trim().toUpperCase() !== "SUB-RULE"
}

function replaceRulePolicy(raw: string, policy: string) {
  const spans = topLevelFieldSpans(raw)
  const type = raw.slice(spans[0]!.start, spans[0]!.end).trim().toUpperCase()
  const policyIndex = ["MATCH", "FINAL"].includes(type) ? 1 : 2
  const span = spans[policyIndex]
  if (!span) throw new Error("规则字段不完整，无法安全修改策略")
  const current = raw.slice(span.start, span.end)
  if (type === "SUB-RULE") {
    if (current.trim() !== policy) throw new Error("SUB-RULE 子规则名不可修改")
    return raw
  }
  const leading = current.match(/^\s*/)?.[0] ?? ""
  const trailing = current.match(/\s*$/)?.[0] ?? ""
  return `${raw.slice(0, span.start)}${leading}${policy}${trailing}${raw.slice(span.end)}`
}

export function updateConfigRules(content: string, orderedRules: RuleItem[]) {
  const document = parseDocument(content)
  if (document.errors.length) throw new Error("配置 YAML 无法解析")
  if (!document.has("rules")) document.set("rules", document.createNode([]))
  const sequence = document.get("rules", true)
  if (!isSeq(sequence)) throw new Error("配置 rules 不是列表")
  const current = configRuleItems(content)
  const orderedIds = orderedRules.map((rule) => rule.id)
  const currentIds = new Set(current.map((item) => item.id))
  if (new Set(currentIds).size !== currentIds.size || new Set(orderedIds).size !== orderedIds.length ||
    orderedRules.some((rule) => !currentIds.has(rule.id) && !rule.id.startsWith("draft-rule:"))) {
    throw new Error("磁盘规则已变化，请重新读取")
  }
  const nodes = new Map(current.map((item, index) => [item.id, sequence.items[index]!]))
  const reordered = orderedRules.map((rule) => {
    const node = nodes.get(rule.id)
    if (!node && rule.id.startsWith("draft-rule:")) {
      if (!["RULE-SET", "DOMAIN", "DOMAIN-SUFFIX"].includes(rule.type) || !rule.payload.trim() ||
        !rule.policy.trim() || /[,\r\n]/.test(rule.payload + rule.policy)) throw new Error("新增规则字段无效")
      return document.createNode(`${rule.type},${rule.payload},${rule.policy}`)
    }
    if (isScalar(node) && typeof node.value === "string") node.value = replaceRulePolicy(node.value, rule.policy)
    return node
  })
  if (reordered.some((node) => !node)) throw new Error("磁盘规则已变化，请重新读取")
  sequence.items = reordered as typeof sequence.items
  return document.toString({ lineWidth: 0 })
}

export function reorderConfigRules(content: string, orderedIds: string[]) {
  const current = new Map(configRuleItems(content).map((rule) => [rule.id, rule]))
  const ordered = orderedIds.map((id) => current.get(id)).filter((rule): rule is RuleItem => Boolean(rule))
  return updateConfigRules(content, ordered)
}

export function ruleTone(type: string): RuleTone {
  const normalized = type.replace(/[^a-z\d]/gi, "").toUpperCase()
  if (normalized === "RULESET" || normalized.includes("PROVIDER")) return "provider"
  if (normalized.includes("DOMAIN")) return "domain"
  if (normalized.includes("GEO")) return "geo"
  if (normalized.includes("IP") || normalized.includes("NETWORK") || normalized.includes("SRC")) return "network"
  if (normalized.includes("PROCESS") || normalized.includes("PORT")) return "process"
  if (["AND", "OR", "NOT"].includes(normalized)) return "logic"
  return "muted"
}

export function ruleTypeTone(type: string) {
  return { provider: "text-rule-provider", domain: "text-rule-domain", network: "text-rule-network", geo: "text-rule-geo", process: "text-rule-process", logic: "text-rule-logic", muted: "text-muted-foreground" }[ruleTone(type)]
}

export function policyTone(policy: string) {
  if (policy.toUpperCase() === "DIRECT") return "text-status-success"
  if (["REJECT", "REJECT-DROP"].includes(policy.toUpperCase())) return "text-destructive"
  return "text-primary"
}
