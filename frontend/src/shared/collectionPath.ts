import { isScalar } from "yaml"
import type { CollectionPathChange } from "../api/configClient.ts"
import { parseYamlDraft } from "./yamlDraft.ts"

export function restoreCollectionPath(content: string, change: CollectionPathChange) {
  const document = parseYamlDraft(content)
  if (document.errors.length) throw new Error("当前配置 YAML 无效，请修正后恢复路径")
  const node = document.getIn([change.category + "-providers", change.name, "path"], true)
  if (!isScalar(node) || node.value !== change.toPath || !node.range) throw new Error("集合路径已变化，请重新打开集合文件")
  let [start, end] = node.range
  let replacement = JSON.stringify(change.fromPath)
  if (node.type === "BLOCK_FOLDED" || node.type === "BLOCK_LITERAL") {
    const bodyStart = content.indexOf("\n", start) + 1
    const body = content.slice(bodyStart, end)
    start = bodyStart + body.search(/\S/)
    end = bodyStart + body.trimEnd().length
    replacement = change.fromPath
  }
  return content.slice(0, start) + replacement + content.slice(end)
}
