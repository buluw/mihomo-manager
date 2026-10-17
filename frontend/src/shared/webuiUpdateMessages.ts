import { SystemError } from "../api/systemClient.ts"
import { coreUpdateError } from "./systemMessages.ts"

const errors: Record<string, string> = {
  webui_unpublished: "当前仓库尚无可用的正式发布。",
  webui_release_forbidden: "发布查询受到权限或 API 额度限制，请稍后重试。",
  webui_release_unavailable: "发布服务暂不可用，请稍后重试。",
  webui_invalid_release: "发布信息无法解析，请重新检查。",
  webui_asset_unavailable: "正式发布缺少本平台可用的运行包。",
  webui_invalid_package: "文件不是有效的 Mihomo Manager 运行包。",
  webui_package_unsupported: "此包未支持当前 Web UI 更新协议。",
  webui_environment_mismatch: "运行包的 Linux 架构或 Node 版本与本机不符。",
  checksum_mismatch: "运行包的摘要、来源或构建文件校验失败。",
  version_mismatch: "运行包内组件版本或发布版本不一致。",
  webui_action_busy: "更新任务正在运行，请稍后重试。",
  webui_task_interrupted: "上次准备任务被中断，请重新准备更新包。",
  webui_state_unavailable: "更新状态无法读取，请检查服务状态。",
  webui_install_status_unavailable: "独立安装任务状态暂不可读取。",
  webui_install_unconfirmed: "安装请求尚未确认，正在重新读取任务状态。",
  webui_install_rejected: "安装入口未接受请求，请重新准备更新包后重试。",
  webui_install_failed: "安装准备失败，当前程序保持可用。",
  webui_startup_failed_restored: "新程序健康检查失败，已恢复切换前的程序。",
  webui_install_failed_restored: "程序切换未完成，已恢复切换前的程序。",
  webui_recovery_failed: "程序恢复尚未完成，请检查管理器服务。",
  webui_policy_changed: "后台策略已被其他页面修改，当前草稿保留；重新读取后再保存。",
  webui_invalid_policy: "请核对周期、时间和后台线路；自动下载需要开启自动检查。",
  webui_policy_unavailable: "后台策略暂不可读取或保存。",
  webui_auto_candidate_unavailable: "自动安装需要已核对官方摘要的新版本候选。",
  webui_schedule_failed: "后台更新任务未完成，请查看对应更新卡片。",
  update_request_unconfirmed: "更新服务暂不可达，将自动重新读取任务结果。",
}
export const webUiUpdateError = (code: string | null) => code ? errors[code] ?? (
  ["download_failed", "core_proxy_unavailable", "invalid_url", "invalid_route", "invalid_source", "official_checksum_unavailable", "unsupported_architecture", "file_too_large", "candidate_changed", "previous_unavailable", "core_action_busy"].includes(code)
    ? coreUpdateError(code)! : "Web UI 更新未完成，请重新读取状态后重试。") : null
export const webUiRequestMessage = (error: Error) => webUiUpdateError(error instanceof SystemError ? error.code : "webui_update_failed")!
