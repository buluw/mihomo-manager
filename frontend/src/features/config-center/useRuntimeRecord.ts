import { useCallback, useEffect, useRef, useState } from "react"
import { readAppliedRuntime, readManagerSettings, readRuntimeLoadState, type RuntimeLoadState } from "@/api/configClient"
import { LatestRequestController } from "@/shared/requestLifecycle"

export type RuntimeConfigView = "edit" | "runtime"

export function useRuntimeRecord(initialView: RuntimeConfigView = "edit") {
  const [state, setState] = useState<RuntimeLoadState | null>(null)
  const [settingsVersion, setSettingsVersion] = useState<number | null>(null)
  const [applied, setApplied] = useState<Awaited<ReturnType<typeof readAppliedRuntime>> | null>(null)
  const [view, setView] = useState<RuntimeConfigView>(initialView)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stateRef = useRef<RuntimeLoadState | null>(null)
  const requests = useRef(new LatestRequestController())

  useEffect(() => setView(initialView), [initialView])

  const publish = useCallback((next: RuntimeLoadState) => {
    if (stateRef.current && next.version < stateRef.current.version) return false
    stateRef.current = next
    setState(next)
    setError(null)
    return true
  }, [])

  const refresh = useCallback(async () => {
    const request = requests.current.begin()
    setLoading(true)
    try {
      const [next, settings] = await Promise.all([
        view === "runtime" ? readAppliedRuntime(request.signal)
          : readRuntimeLoadState(request.signal).then((record) => ({ state: record, content: null })),
        readManagerSettings(request.signal),
      ])
      if (!request.isCurrent() || (stateRef.current && next.state.version < stateRef.current.version)) return
      publish(next.state)
      setSettingsVersion(settings.version)
      if (view === "runtime") setApplied(next)
    } catch {
      if (!request.isCurrent()) return
      setError("共享加载记录读取失败，运行身份未知")
      setApplied(null)
    } finally {
      if (request.finish()) setLoading(false)
    }
  }, [view, publish])

  useEffect(() => {
    requests.current = new LatestRequestController()
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener("focus", onFocus)
    return () => {
      requests.current.dispose()
      window.removeEventListener("focus", onFocus)
    }
  }, [refresh])

  return { state, stateRef, settingsVersion, applied, view, setView, loading, error, refresh, publish }
}
