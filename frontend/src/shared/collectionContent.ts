import { parseDocument } from "yaml"

export function proxyCollectionCount(content: string) {
  const document = parseDocument(content)
  if (document.errors.length) throw new Error("集合 YAML 无效")
  const root = document.toJS()
  if (!root || typeof root !== "object" || Array.isArray(root) ||
    Object.keys(root).some((key) => key !== "proxies") || !Array.isArray(root.proxies)) {
    throw new Error("请上传代理集合 YAML（顶层 proxies），不能上传完整主配置")
  }
  if (root.proxies.some((node: unknown) => !node || typeof node !== "object" ||
    !("name" in node) || typeof node.name !== "string" || !node.name.trim() ||
    !("type" in node) || typeof node.type !== "string" || !node.type.trim())) throw new Error("节点须包含名称和类型")
  if (!root.proxies.length) throw new Error("集合至少需要一个节点")
  return root.proxies.length as number
}

export function ruleCollectionCount(content: string) {
  const document = parseDocument(content)
  if (document.errors.length) throw new Error("集合 YAML 无效")
  const root = document.toJS()
  if (!root || typeof root !== "object" || Array.isArray(root) ||
    Object.keys(root).some((key) => key !== "payload") || !Array.isArray(root.payload)) {
    throw new Error("请上传规则集合 YAML（顶层 payload），不能上传完整主配置")
  }
  if (root.payload.some((rule: unknown) => typeof rule !== "string" || !rule.trim())) throw new Error("规则条目不能为空")
  if (!root.payload.length) throw new Error("集合至少需要一条规则")
  return root.payload.length as number
}
