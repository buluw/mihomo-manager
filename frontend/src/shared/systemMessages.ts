import { SystemError } from "../api/systemClient.ts";

const updateErrors: Record<string, string> = {
  download_failed: "连接或下载失败，请重试或更换连接方式、来源。",
  core_proxy_unavailable: "当前 Mihomo 代理不可用，请检查核心及代理端口，或改用直连、外部代理、上传。",
  invalid_url: "请输入完整的 HTTP/HTTPS 文件地址或有效的代理地址。",
  invalid_route: "请选择连接方式。", invalid_source: "请选择下载来源。",
  official_checksum_unavailable: "官方 API 未提供该包的 SHA256，无法作为官方包安装。",
  invalid_release: "官方稳定版信息无效，请重试。", checksum_mismatch: "文件与官方 SHA256 不一致，已拒绝安装。",
  invalid_binary: "文件不是本机可运行的 Linux Mihomo Core，已拒绝安装。",
  version_mismatch: "文件版本与官方发布版本不一致，已拒绝安装。",
  unsupported_architecture: "当前架构暂不支持在线更新。", file_too_large: "文件不能超过 128 MiB。",
  candidate_changed: "待安装文件已变化，请重新准备文件。", previous_unavailable: "上一可用版本不存在或已变化，请刷新状态。",
  startup_failed_restored: "新版本未能启动，已自动恢复切换前的可用版本。",
  core_action_busy: "核心正在执行其他操作，请稍后重试。",
};
export const coreUpdateError = (code: string | null) => code ? updateErrors[code] ?? "核心更新未完成，请查看服务状态后重试；本地上一版本仍可用于回退。" : null;

const requestErrors: Record<string, string> = {
  resources_request_failed: "服务资源读取失败，将自动重试",
  resources_unavailable: "服务资源暂不可用，将自动重试",
  resources_invalid_response: "服务资源响应无效，将自动重试",
  core_service_busy: "核心服务正在执行操作，请稍后再试",
  core_status_invalid_response: "核心服务状态响应无效",
  update_request_unconfirmed: "更新服务请求未确认，请刷新状态后重试。",
  interfaces_request_failed: "网卡列表暂不可用，仍可手动填写网卡名称",
  interfaces_invalid_response: "网卡列表响应无效，仍可手动填写网卡名称",
  core_action_unconfirmed: "核心服务操作未确认，请重新读取服务状态",
  core_status_unavailable: "无法读取核心服务状态",
  core_action_failed: "核心服务操作失败，请检查服务状态和失败原因",
};

export function systemErrorMessage(error: Error) {
  if (!(error instanceof SystemError)) return error.message;
  if (error.code === "interfaces_http_error") return "网卡列表读取失败 (" + error.status + ")，仍可手动填写网卡名称";
  return requestErrors[error.code] ?? coreUpdateError(error.code)!;
}
