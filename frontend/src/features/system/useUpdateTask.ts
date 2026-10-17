import { useCallback, useEffect, useRef, useState } from "react"

type UpdateState = { busy: boolean; phase: string }

export function useUpdateTask<T extends UpdateState>({ active, read, message, onAccepted, onBusyChange }: {
  active: boolean
  read: (signal?: AbortSignal) => Promise<T>
  message: (error: Error) => string
  onAccepted?: (state: T) => void
  onBusyChange: (busy: boolean) => void
}) {
  const [state, setState] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [retry, setRetry] = useState(0)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const latestState = useRef<T | null>(null)
  const busy = sending || Boolean(state?.busy)

  const accept = useCallback((next: T) => {
    latestState.current = next
    setState(next)
    setReadError(null)
    onBusyChange(next.busy || request.current !== null)
    onAccepted?.(next)
  }, [onBusyChange, onAccepted])

  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const version = generation.current
      let interval = busy ? 1000 : active ? 15_000 : 60_000
      try {
        const next = await read(abort.signal)
        if (abort.signal.aborted) return
        if (version === generation.current) {
          accept(next)
          if (next.busy || request.current) interval = 1000
        }
      } catch (error) {
        if (!abort.signal.aborted && version === generation.current) setReadError(message(error as Error))
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), interval)
    }
    void poll()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [active, busy, retry, accept, read, message])

  useEffect(() => () => { request.current?.abort() }, [])

  const run = async (operation: (signal: AbortSignal) => Promise<unknown>) => {
    if (request.current || latestState.current?.busy) return
    const abort = new AbortController()
    request.current = abort
    generation.current++
    setSending(true)
    setError(null)
    onBusyChange(true)
    try {
      await operation(abort.signal)
      if (abort.signal.aborted) return
      generation.current++
      const next = await read(abort.signal)
      if (!abort.signal.aborted) accept(next)
    } catch (error) {
      if (!abort.signal.aborted) setError(message(error as Error))
    } finally {
      if (request.current === abort) {
        request.current = null
        if (!abort.signal.aborted) {
          setSending(false)
          onBusyChange(Boolean(latestState.current?.busy))
        }
      }
    }
  }

  return { state, busy, error, readError, run, refresh: () => setRetry(value => value + 1) }
}
