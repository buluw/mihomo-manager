import { parseDocument } from "yaml"

export function sourceSettingsDocument(content: string): Record<string, unknown> {
  const doc = parseDocument(content, { merge: true })
  if (doc.errors.length) throw new Error("所选源 YAML 无法解析；未使用运行参数代替")
  let source: unknown
  try { source = doc.toJS({ maxAliasCount: 100 }) } catch { throw new Error("所选源 YAML 无法解析；未使用运行参数代替") }
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("所选源 YAML 必须是配置映射")
  return source as Record<string, unknown>
}
