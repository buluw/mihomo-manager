import { isMap, isSeq, parseDocument } from "yaml"

export function collectionGroupNameError(content: string, value: string, pending: string[] = [], collectionName = "") {
  const name = value.trim()
  if (!name) return "请输入代理组名称"
  if (name.length > 120) return "代理组名称不能超过 120 个字符"
  const document = parseDocument(content)
  if (document.errors.length) return "请先修正配置 YAML"
  const source = document.toJS()
  const groups = source?.["proxy-groups"]
  if (name === collectionName.trim() || pending.includes(name) || (Array.isArray(groups) && groups.some((group: { name?: string } | null) => group?.name === name)) || source?.["proxy-providers"]?.[name]) return "代理组或集合名称已存在"
  return null
}

export function stageCollectionGroups(content: string, names: string[], selected: string[], collectionName: string) {
  const requested = names.filter(name => selected.includes(name))
  if (!requested.length) return content
  const document = parseDocument(content)
  if (document.errors.length || !isMap(document.contents)) throw new Error("当前配置 YAML 无效")
  const added: string[] = []
  for (const name of requested) {
    const error = collectionGroupNameError(content, name, added, collectionName)
    if (error) throw new Error(error)
    added.push(name)
  }
  if (!document.has("proxy-groups")) document.set("proxy-groups", document.createNode([]))
  const groups = document.get("proxy-groups", true)
  if (!isSeq(groups)) throw new Error("代理组结构无效")
  for (const name of added) groups.add({ name, type: "select", use: [] })
  return document.toString({ lineWidth: 0 })
}
