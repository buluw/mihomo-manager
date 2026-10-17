import { useEffect, useRef, useState } from "react"
import { readUpdatePolicy, saveUpdatePolicy, type UpdatePolicy, type UpdatePolicyStatus } from "@/api/webuiUpdateClient"
import { webUiRequestMessage } from "@/shared/webuiUpdateMessages"

export function useUpdatePolicy(active: boolean) {
  const [state, setState] = useState<UpdatePolicyStatus | null>(null)
  const [draft, setDraft] = useState<{ settings: UpdatePolicy; revision: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const version = generation.current
      try {
        const next = await readUpdatePolicy(abort.signal)
        if (!abort.signal.aborted && version === generation.current) { setState(next); setReadError(null) }
      } catch (failure) {
        if (!abort.signal.aborted && version === generation.current) setReadError(webUiRequestMessage(failure as Error))
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), active ? 30_000 : 60_000)
    }
    void poll()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [active, retry])
  useEffect(() => () => request.current?.abort(), [])
  const change = (settings: UpdatePolicy) => {
    if (!state || saving) return
    setDraft({ settings, revision: draft?.revision ?? state.revision }); setSaved(false)
  }
  const save = async (settings: UpdatePolicy) => {
    if (!state || request.current) return
    const abort = new AbortController(); request.current = abort; generation.current++
    setSaving(true); setError(null); setSaved(false)
    try {
      const next = await saveUpdatePolicy(settings, draft?.revision ?? state.revision, abort.signal)
      if (!abort.signal.aborted) { generation.current++; setState(next); setDraft(null); setSaved(true) }
    } catch (failure) { if (!abort.signal.aborted) setError(webUiRequestMessage(failure as Error)) }
    finally { request.current = null; if (!abort.signal.aborted) setSaving(false) }
  }
  return { state, settings: draft?.settings ?? state?.settings, dirty: Boolean(draft), change, save, saving, saved, error: error || readError,
    refresh: () => { setDraft(null); setError(null); setReadError(null); setSaved(false); setRetry(value => value + 1) } }
}
