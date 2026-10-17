import { useEffect, useRef, useState } from "react"
import type { WebUiUpdateStatus } from "@/api/webuiUpdateClient"
import { useUiState } from "@/app/state/uiState"

// A first terminal snapshot belongs to the loaded document; only a newly observed
// installation can require another document. A reload therefore starts settled.
export function useWebUiRefresh(state: WebUiUpdateStatus | null, connected: boolean, waiting: boolean, blocked: boolean) {
  const { dirty, pendingWrite } = useUiState()
  const observed = useRef<{ id: string | null; pending: boolean } | null>(null)
  const [required, setRequired] = useState(false)
  useEffect(() => {
    if (!state || !connected) return
    const id = state.install?.id ?? null
    const switching = state.phase === "installing" || state.phase === "rolling-back"
    const previous = observed.current
    if (!previous || previous.id !== id) {
      observed.current = { id, pending: switching || Boolean(previous && id) }
    } else if (switching) previous.pending = true
    if (state.busy || !state.install?.finishedAt || !observed.current?.pending) return
    observed.current.pending = false
    if (!state.error && ["succeeded", "rolled-back"].includes(state.phase) && state.install.services.includes("web")) setRequired(true)
  }, [state, connected])

  const protectedEditing = dirty || pendingWrite || blocked
  // Keep the refresh prompt after an editing guard blocked it, even if a later
  // render clears that guard. The user chooses when to leave the preserved edit.
  const deferred = useRef(false)
  const reloading = useRef(false)
  useEffect(() => {
    if (!required || !connected || waiting || state?.error) return
    if (protectedEditing) { deferred.current = true; return }
    if (!deferred.current && !reloading.current) { reloading.current = true; window.location.reload() }
  }, [required, connected, waiting, state?.error, protectedEditing])
  const refresh = () => {
    if (protectedEditing || !connected || waiting || state?.error || reloading.current) return
    reloading.current = true
    window.location.reload()
  }
  return { required, protectedEditing, refresh }
}
