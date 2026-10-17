import { useState, useSyncExternalStore, type FormEvent } from "react"
import { changeAccess, getAccessState, subscribeAccess } from "@/api/accessClient"
import { useUiState } from "@/app/state/uiState"
import { PasswordField } from "@/components/patterns/password-field"
import { Button } from "@/components/ui/button"
import { FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { accessErrorMessage } from "@/shared/accessMessages"
import { SettingsGroup, SettingsToolRow } from "./ManagerSettingsFields"

type Mode = "enable" | "password" | "disable"
export function AccessSettings({ disabled }: { disabled: boolean }) {
  const state = useSyncExternalStore(subscribeAccess, getAccessState)
  const { dirty, pendingWrite, askConfirm } = useUiState()
  const [mode, setMode] = useState<Mode | null>(null)
  const [current, setCurrent] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState("")
  const [feedback, setFeedback] = useState("")
  const [busy, setBusy] = useState(false)
  const enabled = Boolean(state.status?.enabled)
  const blocked = disabled || pendingWrite || busy
  const select = (value: Mode | null) => { setMode(value); setCurrent(""); setPassword(""); setConfirm(""); setError(""); setFeedback("") }
  const run = async (operation: Mode | "logout") => {
    if (blocked) return
    if ((operation === "logout" || operation === "password") && dirty && !await askConfirm({ title: "放弃未保存的修改？",
      message: "重新登录前将结束当前编辑，请先保存需要保留的修改。", confirmLabel: "放弃并继续", danger: true })) return
    setBusy(true); setError("")
    try {
      await changeAccess(operation, { ...(operation !== "logout" ? { currentPassword: current, password } : {}) })
      select(null)
      if (operation === "enable" || operation === "disable") setFeedback(operation === "enable" ? "访问认证已开启" : "访问认证已关闭")
    } catch (failure) { setError(accessErrorMessage(failure)) }
    finally { setBusy(false) }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!mode || blocked) return
    if (mode !== "disable" && password !== confirm) { setError("两次输入的密码不一致。"); return }
    void run(mode)
  }
  const edit = (setter: (value: string) => void) => (value: string) => { setter(value); setError("") }
  return <div className="flex flex-col gap-6">
    <SettingsGroup title="访问认证">
      <SettingsToolRow label="启用访问认证" description={enabled ? "打开管理器时需要输入密码" : "打开管理器时直接进入"}>
        <Switch aria-label="启用访问认证" checked={enabled} disabled={blocked} onCheckedChange={() => select(enabled ? "disable" : "enable")} />
      </SettingsToolRow>
      {enabled && <SettingsToolRow label="登录密码" description="已设置"><Button variant="outline" size="sm" className="w-22" disabled={blocked} onClick={() => select("password")}>修改密码</Button></SettingsToolRow>}
      {mode && <form onSubmit={submit} className="px-3 py-4 md:px-4">
        <FieldGroup className="gap-5">
          <div className="flex flex-col gap-2"><FieldLabel>{mode === "enable" ? "设置访问密码" : mode === "password" ? "修改密码" : "关闭访问认证"}</FieldLabel>
            <FieldDescription>{mode === "enable" ? "设置 8–128 个字符的密码，新访问需要先登录。" : mode === "password" ? "保存后需使用新密码重新登录。" : "关闭后，访问管理器将直接进入。"}</FieldDescription></div>
          <FieldGroup className="max-w-100 gap-4">
            {mode !== "enable" && <PasswordField id="access-current" label="当前密码" current value={current} onChange={edit(setCurrent)} disabled={busy} invalid={error.startsWith("密码不正确")} describedBy="access-error" />}
            {mode !== "disable" && <>
              <PasswordField id="access-new" label="新密码" value={password} onChange={edit(setPassword)} disabled={busy} describedBy="access-error" />
              <PasswordField id="access-confirm" label="确认密码" value={confirm} onChange={edit(setConfirm)} disabled={busy} invalid={error.startsWith("两次")} describedBy="access-error" />
            </>}
          </FieldGroup>
          {error && <FieldError id="access-error" role="alert">{error}</FieldError>}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" className="min-w-22 max-md:flex-1" disabled={busy} onClick={() => select(null)}>取消</Button>
            <Button type="submit" size="sm" className="min-w-22 max-md:flex-1" disabled={blocked}>{busy && <Spinner data-icon="inline-start" />}{mode === "enable" ? "保存并开启" : mode === "password" ? "保存密码" : "确认关闭"}</Button>
          </div>
        </FieldGroup>
      </form>}
    </SettingsGroup>
    {feedback && <FieldDescription role="status">{feedback}</FieldDescription>}
    {enabled && <SettingsGroup title="当前会话"><SettingsToolRow label="退出登录" description="退出后需重新输入密码">
      <Button variant="outline" size="sm" className="w-22" disabled={blocked} onClick={() => void run("logout")}>退出登录</Button>
    </SettingsToolRow></SettingsGroup>}
    {!mode && error && <FieldError role="alert">{error}</FieldError>}
    {pendingWrite && <FieldDescription>请等待当前写入完成后再修改访问认证。</FieldDescription>}
  </div>
}
