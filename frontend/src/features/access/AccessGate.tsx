import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react"
import { ArrowRight, ShieldCheck } from "lucide-react"
import { changeAccess, getAccessState, refreshAccess, subscribeAccess } from "@/api/accessClient"
import { PasswordField } from "@/components/patterns/password-field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { FieldDescription, FieldError, FieldGroup, FieldSet } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { accessErrorMessage } from "@/shared/accessMessages"

export function AccessGate({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribeAccess, getAccessState)
  const ready = state.phase === "ready"
  const [mountedReset, setMountedReset] = useState<number | null>(ready ? state.reset : null)
  const mounted = mountedReset === state.reset
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  if (ready && !mounted) setMountedReset(state.reset)
  useEffect(() => {
    void refreshAccess()
    const check = () => { void refreshAccess() }
    const timer = setInterval(check, 30_000)
    window.addEventListener("focus", check)
    return () => { clearInterval(timer); window.removeEventListener("focus", check) }
  }, [])
  // Existing editor dialogs retain their state while their portal surfaces are inert.
  useLayoutEffect(() => {
    if (ready) return
    const saved = new Map<HTMLElement, { inert: boolean; visibility: string }>()
    const hidePortals = () => {
      for (const node of document.body.children) {
        if (!(node instanceof HTMLElement) || node.id === "root" || saved.has(node)) continue
        saved.set(node, { inert: node.inert, visibility: node.style.visibility })
        node.inert = true; node.style.visibility = "hidden"
      }
    }
    hidePortals()
    const observer = new MutationObserver(hidePortals)
    observer.observe(document.body, { childList: true })
    return () => { observer.disconnect(); for (const [node, original] of saved) { node.inert = original.inert; node.style.visibility = original.visibility } }
  }, [ready])
  const login = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError("")
    try { await changeAccess("login", { password }); setPassword("") }
    catch (failure) { setError(accessErrorMessage(failure)) }
    finally { setBusy(false) }
  }
  return <>
    {mounted && <div key={state.reset} hidden={!ready} inert={!ready || undefined} className={ready ? "h-full" : "hidden"}>{children}</div>}
    {!ready && <main className="grid min-h-dvh w-full place-items-center overflow-y-auto px-6 py-10 max-md:items-start">
      <FieldSet className="w-full max-w-96 gap-7 rounded-xl border bg-card p-8 max-md:mt-[clamp(30px,12dvh,100px)] max-md:max-w-90 max-md:border-0 max-md:bg-transparent max-md:p-0">
        <div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-5 text-primary" />Mihomo Manager</div>
        <div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold">登录管理器</h1><FieldDescription>输入访问密码，继续管理 Mihomo。</FieldDescription></div>
        {state.phase === "checking" ? <FieldDescription role="status" className="flex items-center gap-2"><Spinner />正在确认访问状态</FieldDescription>
          : state.phase === "unavailable" ? <Alert><AlertDescription>访问认证服务暂不可用。<Button variant="outline" onClick={() => void refreshAccess()}>重新连接</Button></AlertDescription></Alert>
          : <form onSubmit={event => void login(event)}>
            <FieldGroup className="gap-5">
              <PasswordField id="login-password" label="访问密码" current value={password} onChange={value => { setPassword(value); setError("") }} disabled={busy} invalid={Boolean(error)} describedBy="login-error" />
              {error && <FieldError id="login-error" role="alert">{error}</FieldError>}
              <Button type="submit" className="h-11 w-full" disabled={busy || !password}>{busy ? <Spinner data-icon="inline-start" /> : null}登录<ArrowRight data-icon="inline-end" /></Button>
              {state.reason === "password-changed" && <FieldDescription role="status">密码已更新，请重新登录。</FieldDescription>}
              {state.reason === "expired" && mounted && <FieldDescription role="status">会话已失效，请重新登录。当前编辑内容保留在此页面。</FieldDescription>}
            </FieldGroup>
          </form>}
      </FieldSet>
    </main>}
  </>
}
