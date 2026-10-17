import type { ProviderTemplateSettings } from "../../api/configClient.ts"
import { isMap, isScalar, isSeq, stringify } from "yaml"
import { parseYamlDraft as parseDocument } from "../../shared/yamlDraft.ts"
import type { ProviderCategory } from "./collectionViewModel.ts"
import { normalizeProviderFileName, normalizedReference, providerSection, recordValue, type ManagedProviderItem } from "./managedProviderModel.ts"

// Use the known declaration boundary to persist an unfinished fragment as source text.
export function replaceProviderDraftText(configContent: string, item: ManagedProviderItem, snippet: string) {
  return replaceProviderDrafts(configContent, [{ item, snippet }])
}

export function replaceProviderDrafts(configContent: string, drafts: Array<{ item: ManagedProviderItem; snippet: string }>) {
  const document = parseDocument(configContent)
  if (document.errors.length) throw new Error("源配置无法定位集合，请在配置中心保存正文")
  const normalized = document.toString({ lineWidth: 0, collectionStyle: "block" })
  const parsed = parseDocument(normalized)
  const replacements = drafts.map(({ item, snippet }) => {
    const section = parsed.get(providerSection(item.category), true)
    const pair = isMap(section) ? section.items.find((entry) => isScalar(entry.key) && entry.key.value === item.name) : undefined
    const start = isScalar(pair?.key) ? pair.key.range?.[0] : undefined
    const end = pair?.value && typeof pair.value === "object" && "range" in pair.value
      ? (pair.value.range as [number, number, number] | undefined)?.[2] : undefined
    if (start == null || end == null) throw new Error("集合声明已变化，请重新读取")
    const lineStart = normalized.lastIndexOf("\n", start - 1) + 1
    const indent = normalized.slice(lineStart, start)
    return { start: lineStart, end, content: snippet.trimEnd().split(/\r?\n/).map((line) => indent + line).join("\n") + "\n" }
  })
  return replacements.sort((a, b) => b.start - a.start).reduce((content, edit) =>
    content.slice(0, edit.start) + edit.content + content.slice(edit.end), normalized)
}

export function inlineProviderDraftText(item: ManagedProviderItem, content: string) {
  const declaration = { ...item.declaration }
  delete declaration.payload
  delete declaration.proxies
  const prefix = stringify({ [item.name]: declaration }, { lineWidth: 0 })
  return prefix + content.replace(/^proxies\s*:/m, "payload:").split(/\r?\n/).map((line) => `  ${line}`).join("\n")
}

export function addHttpProviderConfig(
  content: string,
  category: ProviderCategory,
  fileName: string,
  url: string,
  templates?: ProviderTemplateSettings,
) {
  const normalizedFileName = normalizeProviderFileName(fileName)
  const name = normalizedFileName.replace(/\.ya?ml$/i, "")
  if (!name) throw new Error("请输入 Provider 名称")
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error("请输入有效的 HTTP/HTTPS 地址")
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Provider 地址只支持 HTTP/HTTPS")
  }
  const document = parseDocument(content)
  if (document.errors.length > 0) throw new Error("当前配置 YAML 无法解析")
  const sectionName = providerSection(category)
  let section = document.getIn([sectionName], true)
  if (!isMap(section)) {
    if (section != null) throw new Error("Provider 声明结构无效")
    const created = document.createNode({})
    document.set(sectionName, created)
    section = created
  }
  if (!isMap(section)) throw new Error("Provider 声明结构无效")
  if (section.has(name)) throw new Error("当前配置已有同名 Provider 声明")
  const optional = {
    ...(templates?.interval ? { interval: templates.interval } : {}),
    ...(templates?.healthCheck ? { "health-check": { enable: true, url: "http://www.gstatic.com/generate_204", interval: 300 } } : {}),
  }
  const declaration = category === "proxy"
    ? { type: "http", url: parsedUrl.toString(), path: `./providers/${normalizedFileName}`, ...optional }
    : {
        type: "http",
        behavior: templates?.ruleBehavior ?? "classical",
        format: templates?.ruleFormat ?? "yaml",
        url: parsedUrl.toString(),
        path: `./ruleset/${normalizedFileName}`,
        ...optional,
      }
  section.set(name, declaration)
  return {
    content: document.toString({ lineWidth: 0 }),
    name,
    fileName: normalizedFileName,
    referencePath: `./${category === "proxy" ? "providers" : "ruleset"}/${normalizedFileName}`,
    declaration,
  }
}

function defaultDeclaration(item: ManagedProviderItem, behavior = "classical", format = "yaml", templates?: ProviderTemplateSettings) {
  if (!item.referencePath) throw new Error("集合没有可载入的受控路径")
  if ((item.access === "http" || item.pendingRemoval) && item.declaration) return structuredClone(item.declaration)
  const optional = {
    ...(templates?.interval ? { interval: templates.interval } : {}),
    ...(templates?.healthCheck ? { "health-check": { enable: true, url: "http://www.gstatic.com/generate_204", interval: 300 } } : {}),
  }
  return item.category === "proxy"
    ? { type: "file", path: item.referencePath, ...optional }
    : { type: "file", behavior, format, path: item.referencePath, ...optional }
}

export function updateManagedProviderConfig(
  content: string,
  item: ManagedProviderItem,
  options: {
    loaded: boolean
    selectedGroups?: string[]
    ruleSetRules?: string[]
    behavior?: string
    format?: string
    interval?: number | null
    templates?: ProviderTemplateSettings
  },
) {
  const document = parseDocument(content)
  if (document.errors.length > 0) throw new Error("当前配置 YAML 无法解析")
  const sectionName = providerSection(item.category)
  let section = document.get(sectionName, true)

  if (options.loaded) {
    if (!isMap(section)) {
      document.set(sectionName, document.createNode({}))
      section = document.get(sectionName, true)
    }
    if (!isMap(section)) throw new Error("Provider 声明结构无效")
    let declaration = section.get(item.name, true)
    if (!item.declared) {
      if (declaration != null) {
        const path = isMap(declaration) ? declaration.get("path") : null
        if (normalizedReference(path) !== normalizedReference(item.referencePath)) {
          throw new Error("当前配置已有同名 Provider 声明")
        }
      } else {
        section.set(item.name, document.createNode(defaultDeclaration(item, options.behavior, options.format, options.templates)))
        declaration = section.get(item.name, true)
      }
    }
    if (item.category === "rule" && (options.behavior !== undefined || options.format !== undefined)) {
      if (!isMap(declaration)) throw new Error("Provider 声明结构不支持安全原位修改")
      const updateScalar = (key: "behavior" | "format", value: string | undefined) => {
        if (!value) return
        const current = declaration.get(key, true)
        if (isScalar(current)) {
          if (current.value !== value) current.value = value
        } else if (current == null) declaration.set(key, value)
        else throw new Error(`Provider ${key} 结构不支持安全原位修改`)
      }
      updateScalar("behavior", options.behavior)
      updateScalar("format", options.format)
    }
    if (item.access === "http" && options.interval !== undefined) {
      if (!isMap(declaration)) throw new Error("HTTP Provider 声明结构无效")
      if (options.interval === null) declaration.delete("interval")
      else if (Number.isSafeInteger(options.interval) && options.interval > 0) declaration.set("interval", options.interval)
      else throw new Error("自动更新周期必须是正整数秒")
    }
  } else if (isMap(section)) {
    const declaration = section.get(item.name, true)
    const isDraftDeclaration = !item.declared && isMap(declaration) &&
      normalizedReference(declaration.get("path")) === normalizedReference(item.referencePath)
    if (item.declared || isDraftDeclaration) section.delete(item.name)
    if (section.items.length === 0) document.delete(sectionName)
  }

  if (item.category === "proxy") {
    const groups = document.get("proxy-groups", true)
    const selected = new Set(options.loaded ? options.selectedGroups ?? [] : [])
    const available = new Set<string>()
    if (isSeq(groups)) {
      for (const group of groups.items) {
        if (!isMap(group)) continue
        const name = group.get("name")
        if (typeof name !== "string") continue
        available.add(name)
        const useNode = group.get("use", true)
        const current = isSeq(useNode)
          ? useNode.items.flatMap((entry) => isScalar(entry) && typeof entry.value === "string" ? [entry.value] : [])
          : []
        const next = current.filter((provider) => provider !== item.name)
        if (selected.has(name) && group.get("include-all") !== true && group.get("include-all-providers") !== true) next.push(item.name)
        if (next.length > 0) group.set("use", [...new Set(next)])
        else group.delete("use")
      }
    }
    if ([...selected].some((name) => !available.has(name))) throw new Error("所选代理组已失效")
  } else if (options.loaded) {
    let rules = document.get("rules", true)
    const nextRules = options.ruleSetRules ?? []
    if (!isSeq(rules) && nextRules.length > 0) {
      document.set("rules", [])
      rules = document.get("rules", true)
    }
    if (isSeq(rules)) {
      const related = (node: unknown) => isScalar(node) && typeof node.value === "string" &&
        node.value.split(",", 3)[0] === "RULE-SET" && node.value.split(",", 3)[1] === item.name
      const first = rules.items.findIndex(related)
      rules.items = rules.items.filter((node) => !related(node))
      const insertAt = first < 0 ? rules.items.length : Math.min(first, rules.items.length)
      rules.items.splice(insertAt, 0, ...nextRules.map((rule) => document.createNode(rule)))
    }
  }

  return document.toString({ lineWidth: 0 })
}

export function groupsEmptiedByRemoval(content: string, item: ManagedProviderItem): string[] {
  if (item.category !== "proxy") return []
  const document = parseDocument(content)
  if (document.errors.length) throw new Error("源配置 YAML 无法解析，请先修正配置")
  const groups = document.get("proxy-groups", true)
  const providers = document.get("proxy-providers", true)
  if (!isSeq(groups)) return []
  const otherProviders = isMap(providers) && providers.items.some((entry) => isScalar(entry.key) && entry.key.value !== item.name)
  return groups.items.flatMap((group) => {
    if (!isMap(group)) return []
    // include-all-proxies has Core's own empty-fallback behavior.
    if (group.get("include-all") === true || group.get("include-all-proxies") === true) return []
    const allProviders = group.get("include-all-providers") === true
    const use = group.get("use", true), proxies = group.get("proxies", true)
    const names = isSeq(use) ? use.items.flatMap((node) => isScalar(node) ? [node.value] : []) : []
    const affected = allProviders ? isMap(providers) && providers.has(item.name) : names.includes(item.name)
    const hasUse = allProviders ? otherProviders : names.some((name) => name !== item.name)
    const name = group.get("name")
    return affected && !hasUse && !(isSeq(proxies) && proxies.items.length) && typeof name === "string" ? [name] : []
  })
}

export function deleteManagedProviderConfig(content: string, item: ManagedProviderItem) {
  const empty = groupsEmptiedByRemoval(content, item)
  if (empty.length) throw new Error(`删除会使以下代理组失去所有来源：${empty.join("、")}。请先调整代理组来源或处理这些组。`)
  const withoutDeclaration = updateManagedProviderConfig(content, item, { loaded: false })
  if (item.category !== "rule") return withoutDeclaration
  const document = parseDocument(withoutDeclaration)
  const rules = document.get("rules", true)
  if (!isSeq(rules)) return withoutDeclaration
  rules.items = rules.items.filter((node) => !(
    isScalar(node) && typeof node.value === "string" &&
    node.value.split(",", 3)[0] === "RULE-SET" &&
    node.value.split(",", 3)[1] === item.name
  ))
  return document.toString({ lineWidth: 0 })
}

export function updateInlineProviderContent(
  configContent: string,
  item: ManagedProviderItem,
  editorContent: string,
) {
  if (item.access !== "inline") throw new Error("只有 Inline 集合可写回当前配置")
  const payloadDocument = parseDocument(editorContent)
  if (payloadDocument.errors.length > 0) throw new Error("Inline YAML 无法解析")
  const payloadValue = recordValue(payloadDocument.toJS())
  const key = Array.isArray(payloadValue?.payload) ? "payload" : Array.isArray(payloadValue?.proxies) ? "proxies" : null
  if (!key) throw new Error("Inline 内容必须包含 payload 或 proxies 数组")
  const payload = payloadValue![key] as unknown[]
  const document = parseDocument(configContent)
  const declaration = document.getIn([providerSection(item.category), item.name], true)
  if (!isMap(declaration)) throw new Error("Inline Provider 声明已失效")
  declaration.set("payload", payload)
  declaration.delete("proxies")
  return document.toString({ lineWidth: 0 })
}

export function validateInlineProviderDraft(
  configContent: string,
  item: ManagedProviderItem,
  editorContent: string,
): { content: string; error: null } | { content: null; error: string } {
  try {
    return { content: updateInlineProviderContent(configContent, item, editorContent), error: null }
  } catch (error) {
    return { content: null, error: error instanceof Error ? error.message : "Inline 内容无效" }
  }
}

export function updateHttpProviderContent(
  configContent: string,
  item: ManagedProviderItem,
  editorContent: string,
) {
  if (item.access !== "http" || !item.writable) throw new Error("只有管理器创建的 HTTP Provider 可编辑")
  const source = parseDocument(editorContent)
  if (source.errors.length > 0) throw new Error("HTTP Provider YAML 无法解析")
  const declaration = recordValue(source.toJS())
  if (!declaration || declaration.type !== "http" || typeof declaration.url !== "string" || typeof declaration.path !== "string") {
    throw new Error("HTTP Provider 必须包含 type: http、url 和 path")
  }
  let parsedUrl: URL
  try { parsedUrl = new URL(declaration.url) } catch { throw new Error("HTTP Provider URL 无效") }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("HTTP Provider URL 只支持 HTTP/HTTPS")
  const document = parseDocument(configContent)
  const section = document.get(providerSection(item.category), true)
  if (!isMap(section) || !section.has(item.name)) throw new Error("HTTP Provider 声明已失效")
  section.set(item.name, declaration)
  return document.toString({ lineWidth: 0 })
}
