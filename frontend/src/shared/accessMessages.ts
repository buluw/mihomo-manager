import { AccessError } from "../api/accessClient.ts"

export function accessErrorMessage(error: unknown) {
  const code = error instanceof AccessError ? error.code : "access_unavailable"
  return ({ invalid_credentials: "密码不正确，请重新输入。", invalid_password: "请使用 8–128 个字符的密码。",
    access_required: "会话已失效，请重新登录。", invalid_origin: "请求来源不匹配，请从当前管理器入口重试。",
    access_state_changed: "访问认证状态已变化，请重新确认。" } as Record<string, string>)[code] ?? "访问认证服务暂不可用，请重试。"
}
