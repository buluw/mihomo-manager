import { saveConfigFile, type ConfigFileRecord, type ConfigSnapshot, type RuntimeLoadState } from "../../api/configClient.ts"
import { applyRuntimeConfig, RuntimeApplyError } from "../../shared/runtimeApplication.ts"
import { updateConfigRules } from "./ruleViewModel.ts"
import type { RuleItem } from "./ruleViewModel.ts"

export function selectRuleConfigTarget(
  files: ConfigFileRecord[],
  loadedName: string | null,
) {
  const names = new Set(files.map((file) => file.name))
  if (loadedName && names.has(loadedName)) return loadedName
  return null
}

export function ruleOrderDirty(rules: RuleItem[], saved: RuleItem[]) {
  return rules.length !== saved.length || rules.some((rule, index) => (
    rule.id !== saved[index]?.id || rule.policy !== saved[index]?.policy
  ))
}

export function sameRuleIdentitySet(left: RuleItem[], right: RuleItem[]) {
  if (left.length !== right.length) return false
  const expected = new Set(left.map((rule) => rule.id))
  return right.every((rule) => expected.has(rule.id))
}

export function commitRuleDiskRefresh(
  draft: RuleItem[],
  saved: RuleItem[],
  next: RuleItem[],
) {
  if (!ruleOrderDirty(draft, saved)) return { rules: next, saved: next, compatible: true }
  if (!sameRuleIdentitySet(draft, next)) return { rules: draft, saved, compatible: false }
  return { rules: draft, saved: next, compatible: true }
}

export type RuleEditorValue = {
  draft: RuleItem[]
  saved: RuleItem[]
}

export type RuleEditAction =
  | { type: "move"; id: string; overId: string; visibleIds: string[] }
  | { type: "policy"; id: string; policy: string }
  | { type: "remove"; id: string }
  | { type: "add"; values: Array<Pick<RuleItem, "type" | "payload" | "policy">>; position: "first" | "before-match" | "last" }

export function applyRuleEditorAction(editor: RuleEditorValue, action: RuleEditAction, displayed?: RuleItem[]) {
  const resolveId = (id: string) => {
    const rule = displayed ? editor.draft[displayed.findIndex((item) => item.id === id)] : editor.draft.find((item) => item.id === id)
    if (!rule) throw new Error("所选规则已变化，请重新操作")
    return rule.id
  }
  switch (action.type) {
    case "move": return moveRuleEditorValue(editor, resolveId(action.id), resolveId(action.overId), action.visibleIds.map(resolveId))
    case "policy": return setRuleEditorPolicy(editor, resolveId(action.id), action.policy)
    case "remove": return removeRuleEditorValue(editor, resolveId(action.id))
    case "add": return addRuleEditorValues(editor, action.values, action.position)
  }
}

export class RuleSaveRebaseError extends Error {}

export function createRuleEditorValue(rules: RuleItem[]): RuleEditorValue {
  return { draft: rules, saved: rules }
}

export function replaceRuleEditorValue(rules: RuleItem[]): RuleEditorValue {
  return createRuleEditorValue(rules)
}

export function moveRuleEditorValue(
  editor: RuleEditorValue,
  activeId: string,
  overId: string,
  visibleIds?: string[],
): RuleEditorValue {
  const draft = moveRuleInFullOrder(editor.draft, activeId, overId, visibleIds)
  return draft === editor.draft ? editor : { ...editor, draft }
}

export function setRuleEditorPolicy(
  editor: RuleEditorValue,
  id: string,
  policy: string,
) {
  const draft = editor.draft.map((rule) => rule.id === id && rule.policy !== policy ? { ...rule, policy } : rule)
  return draft.every((rule, index) => rule === editor.draft[index]) ? editor : { ...editor, draft }
}

export function addRuleSetEditorValue(
  editor: RuleEditorValue,
  provider: string,
  policy: string,
  position: "first" | "before-match" | "last",
) {
  return addRuleEditorValues(editor, [{ type: "RULE-SET", payload: provider, policy }], position)
}

export function parseWebsiteRules(input: string) {
  const hosts: string[] = []
  const errors: Array<{ line: number; message: string }> = []
  const seen = new Set<string>()
  input.split(/\r?\n/).forEach((raw, index) => {
    const value = raw.trim()
    if (!value) return
    try {
      const isUrl = /^https?:\/\//i.test(value)
      if (/[\s\\]/.test(value) || (!isUrl && /[/:?#@,]/.test(value))) throw new Error()
      const url = new URL(isUrl ? value : `https://${value}`)
      const host = url.hostname.toLowerCase()
      if (!host || host.length > 253 || /^\d+(\.\d+){3}$/.test(host) ||
        !host.split(".").every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) throw new Error()
      if (!seen.has(host)) { seen.add(host); hosts.push(host) }
    } catch { errors.push({ line: index + 1, message: "请输入有效域名或 HTTP/HTTPS 网址" }) }
  })
  return { hosts, errors }
}

export function addRuleEditorValues(
  editor: RuleEditorValue,
  values: Array<Pick<RuleItem, "type" | "payload" | "policy">>,
  position: "first" | "before-match" | "last",
) {
  const batch = Date.now()
  const items = values.map((value, index) => ({ ...value,
    id: `draft-rule:${batch}:${editor.draft.length}:${index}:${value.type}:${value.payload}` }))
  const draft = [...editor.draft]
  const matchIndex = draft.findIndex((rule) => ["MATCH", "FINAL"].includes(rule.type.trim().toUpperCase()))
  const index = position === "first" ? 0 : position === "before-match" && matchIndex >= 0 ? matchIndex : draft.length
  draft.splice(index, 0, ...items)
  return { ...editor, draft }
}

export function removeRuleEditorValue(editor: RuleEditorValue, id: string) {
  const draft = editor.draft.filter((rule) => rule.id !== id)
  return draft.length === editor.draft.length ? editor : { ...editor, draft }
}

export function discardRuleEditorValue(editor: RuleEditorValue): RuleEditorValue {
  return ruleOrderDirty(editor.draft, editor.saved)
    ? { draft: editor.saved, saved: editor.saved }
    : editor
}

export function commitRuleEditorRefresh(
  editor: RuleEditorValue,
  next: RuleItem[],
): { editor: RuleEditorValue; compatible: boolean } {
  const committed = commitRuleDiskRefresh(editor.draft, editor.saved, next)
  return {
    editor: { draft: committed.rules, saved: committed.saved },
    compatible: committed.compatible,
  }
}

export function commitRuleEditorSave(
  editor: RuleEditorValue,
  submittedDraft: RuleItem[],
  savedRules: RuleItem[],
): RuleEditorValue {
  const submittedIds = submittedDraft.map((rule) => rule.id)
  const savedIds = savedRules.map((rule) => rule.id)
  const currentIds = editor.draft.map((rule) => rule.id)
  if (
    submittedDraft.length !== savedRules.length
    || editor.draft.length !== submittedDraft.length
    || new Set(submittedIds).size !== submittedIds.length
    || new Set(savedIds).size !== savedIds.length
    || new Set(currentIds).size !== currentIds.length
  ) throw new RuleSaveRebaseError("保存后的规则身份无法完整重建")

  const savedBySubmittedId = new Map(
    submittedDraft.map((rule, index) => [rule.id, savedRules[index]!] as const),
  )
  const draft = editor.draft.map((rule) => {
    const saved = savedBySubmittedId.get(rule.id)
    if (!saved) throw new RuleSaveRebaseError("保存后的规则身份无法完整重建")
    return { ...saved, policy: rule.policy }
  })
  if (draft.length !== savedBySubmittedId.size) {
    throw new RuleSaveRebaseError("保存后的规则身份无法完整重建")
  }
  return { draft, saved: savedRules }
}

export function moveRuleInFullOrder(rules: RuleItem[], activeId: string, overId: string, visibleIds?: string[]): RuleItem[] {
  if (visibleIds) {
    const ids = new Set(visibleIds)
    const visible = rules.filter((rule) => ids.has(rule.id))
    const moved = moveRuleInFullOrder(visible, activeId, overId)
    if (moved === visible) return rules
    let index = 0
    return rules.map((rule) => ids.has(rule.id) ? moved[index++]! : rule)
  }
  const from = rules.findIndex((rule) => rule.id === activeId)
  const to = rules.findIndex((rule) => rule.id === overId)
  if (from < 0 || to < 0 || from === to) return rules
  const next = [...rules]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

export async function saveRuleConfiguration(
  input: { name: string; content: string; sha256: string; rules: RuleItem[] },
  saveDisk: typeof saveConfigFile = saveConfigFile,
  applyRuntime: (source: Pick<ConfigSnapshot, "name" | "sha256">) => Promise<RuntimeLoadState> = applyRuntimeConfig,
): Promise<{ disk: ConfigSnapshot; runtimeState: RuntimeLoadState | null; runtimeError: RuntimeApplyError | null }> {
  const content = updateConfigRules(input.content, input.rules)
  const disk = await saveDisk(input.name, content, input.sha256)
  try {
    return { disk, runtimeState: await applyRuntime(disk), runtimeError: null }
  } catch (error) {
    if (error instanceof RuntimeApplyError) {
      return { disk, runtimeState: error.state ?? null, runtimeError: error }
    }
    throw error
  }
}
