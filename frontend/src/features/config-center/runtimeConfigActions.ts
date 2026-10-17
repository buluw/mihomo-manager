import type { RuntimeLoadState } from "../../api/configClient.ts"
import { RuntimeApplyError } from "../../shared/runtimeApplication.ts"

export function runtimeApplyErrorMessage(
  error: RuntimeApplyError | null,
  state: RuntimeLoadState | null,
) {
  if (!error) return null
  if (!error.state && state) return null
  if (error.state && state && state.version > error.state.version) return null
  return error.message
}

export function runtimeApplyErrorWithBaseline(
  error: RuntimeApplyError,
  state: RuntimeLoadState | null,
) {
  return error.state || !state
    ? error
    : new RuntimeApplyError(error.message, error.phase, error.loaded, state, error.cause)
}

export function runtimeRecordMessage(state: RuntimeLoadState | null) {
  if (!state) return "共享记录不可用，运行身份未知"
  if (state.lastAttempt?.kind === "mode") {
    if (state.lastAttempt.status === "pending" || state.lastAttempt.status === "unknown") return "模式单项更新结果未确认；显示上次确认的运行文件"
    if (state.lastAttempt.status === "failed") return "模式单项更新失败；显示上次确认的运行文件"
    return "模式单项更新已记录；最近完整加载时间保持不变"
  }
  if (state.lastAttempt?.status === "pending") return "加载结果尚未确认，运行身份未知"
  if (state.lastAttempt?.status === "unknown") return "加载结果未知，磁盘与运行配置可能不一致"
  if (state.lastAttempt?.status === "failed") return "加载失败，磁盘配置与运行配置不一致"
  return state.lastSuccessful ? "最近成功加载已记录；当前运行身份无法持续确认" : "尚无成功加载记录，运行身份未知"
}
