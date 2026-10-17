import { isMap, isNode, isSeq, LineCounter } from "yaml"
import { parseYamlDraft as parseDocument } from "../../shared/yamlDraft.ts"
import type { ConfigDiagnostic, ProviderFileIssue } from "../../api/configClient.ts"
import type { EditorIssue } from "../../components/patterns/monaco-workspace"

export function sourceDiagnostics(content: string, providers: ProviderFileIssue[] = [], core: ConfigDiagnostic[] = [], configName?: string): EditorIssue[] {
  const lines = new LineCounter()
  const document = parseDocument(content, { lineCounter: lines, prettyErrors: false })
  const mark = (start: number, end: number, message: string): EditorIssue => {
    const from = lines.linePos(start), to = lines.linePos(Math.max(start + 1, end))
    return { line: from.line, column: from.col, endLine: to.line, endColumn: to.col,
      message: configName ? `${configName} 第${from.line}行：${message}` : message, severity: "error" }
  }
  // Parser explanations omit the source excerpt (which may contain credentials).
  const result = document.errors.map((error) => mark(error.pos[0], error.pos[1], error.message))
  if (result.length || !isMap(document.contents)) return result
  const add = (path: Array<string | number>, message: string) => {
    const node = document.getIn(path, true)
    if (isNode(node) && node.range) result.push(mark(node.range[0], node.range[1], message))
  }
  for (const item of providers) {
    const path = [item.category === "proxy" ? "proxy-providers" : "rule-providers", item.name]
    if (document.getIn([...path, "type"]) === "file") {
      const filePath = document.getIn([...path, "path"])
      add([...path, "path"], item.status === "missing"
        ? `集合「${item.name}」已声明，但声明中的文件「${filePath}」找不到，请导入或恢复文件。`
        : `集合「${item.name}」的声明文件${item.status === "outside_scope" ? "超出受控目录" : "不可读取"}。`)
    }
  }
  for (const item of core) {
    if (item.code === "rule_provider_missing") {
      if (item.path?.length === 2 && item.path[0] === "rules" && Number.isSafeInteger(item.path[1])) {
        const rule = document.getIn(item.path)
        const parts = typeof rule === "string" ? rule.split(",").map((part) => part.trim()) : []
        if (parts[0] === "RULE-SET" && parts[1] && !document.hasIn(["rule-providers", parts[1]])) {
          add(item.path, `规则引用了集合「${parts[1]}」，但配置中没有声明这个集合。`)
        }
      }
    } else if (item.path) add(item.path, item.message)
    if (item.code === "empty_proxy_group") {
      // Core sorts groups before reporting indexes. Locate only independently
      // verifiable empty source declarations, never reuse its group index.
      const groups = document.get("proxy-groups", true)
      if (isSeq(groups)) groups.items.forEach((group, index) => {
        if (!isMap(group) || ["include-all", "include-all-proxies", "include-all-providers"].some((key) => group.get(key) === true)) return
        if (["use", "proxies"].every((key) => { const node = group.get(key, true); return node == null || (isSeq(node) && !node.items.length) })) add(["proxy-groups", index, "name"], item.message)
      })
    }
  }
  return result
}
