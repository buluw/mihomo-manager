import { isAlias, parseDocument, visit, YAMLParseError } from "yaml"

// Draft parsing must also diagnose reference conversion failures, without throwing
// into a render or treating an unresolved document as an empty configuration.
export function parseYamlDraft(...args: Parameters<typeof parseDocument>) {
  const document = parseDocument(...args)
  if (!document.errors.length) {
    try { document.toJS() }
    catch {
      visit(document, (_key, node) => {
        if (isAlias(node) && !node.resolve(document)) {
          document.errors.push(new YAMLParseError(node.range?.slice(0, 2) as [number, number] ?? [0, 1],
            "BAD_ALIAS", "YAML 别名未定义；请先定义对应锚点。"))
        }
      })
      if (!document.errors.length) document.errors.push(new YAMLParseError([0, 1],
        "BAD_ALIAS", "YAML 引用无法解析；请检查锚点、别名及引用数量。"))
    }
  }
  return document
}
