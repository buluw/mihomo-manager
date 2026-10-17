import type { RuntimeLoadState } from "../../api/configClient.ts"
import { confirmedRuntimeSource } from "../../shared/runtimeApplication.ts"

export function managerSettingsTarget(state: RuntimeLoadState | null, currentName: string, preserveDraft: boolean) {
  const confirmed = confirmedRuntimeSource(state)
  const name = preserveDraft && currentName ? currentName : confirmed?.name ?? ""
  const error = !confirmed ? "最近成功加载来源无法确认；当前草稿已保留，请重新读取后应用。"
    : name !== confirmed.name ? "成功加载来源已变化；当前草稿仍属于原来源，请取消本页修改后跟随加载来源。" : null
  return { name, confirmed, error }
}

export function assertManagerSettingsTarget(state: RuntimeLoadState | null, name: string) {
  const target = managerSettingsTarget(state, name, true)
  if (target.error || !name || target.confirmed?.name !== name) throw new Error(target.error ?? "设置来源尚未确认")
}
