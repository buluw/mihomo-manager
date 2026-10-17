export type AccessStatus = { enabled: boolean; authenticated: boolean; expiresAt: number | null }
export type AccessState = {
  phase: "checking" | "ready" | "login" | "unavailable"
  status: AccessStatus | null
  reset: number
  reason: "expired" | "logout" | "password-changed" | null
}
export class AccessError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code }
}
const listeners = new Set<() => void>()
let state: AccessState = { phase: typeof location === "undefined" ? "ready" : "checking", status: null, reset: 0, reason: null }
let pause = new AbortController()
let revision = 0
let checking: Promise<void> | null = null
let expiry: ReturnType<typeof setTimeout> | null = null
const channel = typeof location !== "undefined" && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("mihomo-website-access") : null

export const getAccessState = () => state
export const subscribeAccess = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function publish(next: AccessState) {
  const wasReady = state.phase === "ready"
  state = next
  if (next.phase !== "ready" && wasReady) pause.abort()
  if (next.phase === "ready" && pause.signal.aborted) pause = new AbortController()
  if (expiry) clearTimeout(expiry)
  expiry = next.phase === "ready" && next.status?.expiresAt ? setTimeout(() => {
    revision++
    publish({ ...state, phase: "login", reason: "expired" })
  }, Math.max(0, next.status.expiresAt - Date.now())) : null
  listeners.forEach(listener => listener())
}

export function refreshAccess(): Promise<void> {
  if (checking) return checking
  const version = revision
  checking = (async () => {
    try {
      const response = await fetch("/api/access/status", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(6000) })
      if (!response.ok) throw new Error()
      const value = await response.json() as AccessStatus
      if (typeof value.enabled !== "boolean" || typeof value.authenticated !== "boolean"
        || !(value.expiresAt === null || typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt))) throw new Error()
      if (version === revision) publish({ ...state, phase: value.authenticated ? "ready" : "login", status: value,
        reason: value.authenticated ? null : state.reason ?? "expired" })
    } catch { if (version === revision) publish({ ...state, phase: "unavailable" }) }
  })().finally(() => { checking = null })
  return checking
}
if (channel) channel.onmessage = () => { void refreshAccess() }

export function waitForAccess(signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (state.phase === "ready") return Promise.resolve()
  return new Promise((resolve, reject) => {
    const stop = subscribeAccess(() => { if (state.phase === "ready") { cleanup(); resolve() } })
    const abort = () => { cleanup(); reject(signal?.reason) }
    const cleanup = () => { stop(); signal?.removeEventListener("abort", abort) }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

// Request timeouts start after the gate opens. Reads can resume; writes are never replayed.
export async function accessFetch(input: RequestInfo | URL, options: RequestInit = {}, timeoutMs = 6000): Promise<Response> {
  const read = ["GET", "HEAD"].includes((options.method ?? "GET").toUpperCase())
  for (;;) {
    if (!read && state.phase !== "ready") throw new AccessError("access_required")
    await waitForAccess(options.signal)
    const generation = pause
    const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : null
    const signals = [...(read ? [generation.signal] : []), ...(options.signal ? [options.signal] : []), ...(timeout ? [timeout] : [])]
    try {
      const response = await fetch(input, { ...options, signal: AbortSignal.any(signals) })
      const denied = response.headers.get("X-Access-State")
      if (denied === "required" || denied === "unavailable") {
        await response.body?.cancel()
        revision++
        publish({ ...state, phase: denied === "required" ? "login" : "unavailable", reason: "expired" })
        if (!read) throw new AccessError(denied === "required" ? "access_required" : "access_unavailable")
        continue
      }
      return response
    } catch (error) {
      if (read && generation.signal.aborted && !options.signal?.aborted) continue
      if (!options.signal?.aborted && timeout?.aborted && !(error instanceof AccessError)) throw timeout.reason
      throw error
    }
  }
}

export async function changeAccess(operation: "login" | "logout" | "enable" | "password" | "disable", body: { password?: string; currentPassword?: string } = {}) {
  const response = await fetch("/api/access/" + operation, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    credentials: "same-origin", signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string }
    if (response.headers.get("X-Access-State") === "required") {
      revision++; publish({ ...state, phase: "login", reason: "expired" })
    }
    throw new AccessError(result.error ?? "access_unavailable")
  }
  revision++
  if (operation === "logout" || operation === "password") publish({ ...state, phase: "login", reset: state.reset + 1,
    reason: operation === "password" ? "password-changed" : "logout" })
  if (checking) await checking
  await refreshAccess()
  channel?.postMessage("changed")
}
