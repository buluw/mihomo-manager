import { getAccessState, refreshAccess, subscribeAccess } from "./accessClient.ts"

// Own the native connection while preserving the clients' EventSource contract.
export function createAccessEventSource(url: string): EventSource {
  let native: EventSource | null = null
  let closed = false
  const target = new EventTarget()
  const source = Object.assign(target, {
    onopen: null as EventSource["onopen"], onerror: null as EventSource["onerror"], onmessage: null as EventSource["onmessage"],
    url, withCredentials: false, CONNECTING: 0 as const, OPEN: 1 as const, CLOSED: 2 as const,
    close: () => { closed = true; stop(); native?.close(); native = null },
  }) as EventSource
  Object.defineProperty(source, "readyState", { get: () => closed ? 2 : native?.readyState ?? 0 })
  const connect = () => {
    if (closed) return
    if (getAccessState().phase !== "ready") { native?.close(); native = null; return }
    if (native) return
    const current = new EventSource(url)
    native = current
    current.onopen = event => { if (native === current) { source.onopen?.call(source, event); target.dispatchEvent(new Event("open")) } }
    current.onmessage = event => {
      if (native === current) { source.onmessage?.call(source, event); target.dispatchEvent(new MessageEvent("message", { data: event.data, lastEventId: event.lastEventId })) }
    }
    current.onerror = event => {
      if (native !== current) return
      void refreshAccess()
      source.onerror?.call(source, event)
      target.dispatchEvent(new Event("error"))
    }
  }
  const stop = subscribeAccess(connect)
  connect()
  return source
}

export function createAccessWebSocket(url: string) {
  if (getAccessState().phase !== "ready") throw new Error("access_required")
  const socket = new WebSocket(url)
  const stop = subscribeAccess(() => { if (getAccessState().phase !== "ready") socket.close() })
  socket.addEventListener("close", () => { stop(); void refreshAccess() }, { once: true })
  return socket
}
