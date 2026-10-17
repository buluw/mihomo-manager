import { useCallback, useRef } from "react"
import { readCoreUpdate, type CoreUpdateStatus } from "@/api/systemClient"
import { systemErrorMessage } from "@/shared/systemMessages"
import { useUpdateTask } from "./useUpdateTask"

export function useCoreUpdate({ active, onRefresh, onBusyChange }: {
  active: boolean; onRefresh: () => Promise<void>; onBusyChange: (busy: boolean) => void
}) {
  const switching = useRef(false)
  const onAccepted = useCallback((state: CoreUpdateStatus) => {
    if (switching.current && !state.busy) void onRefresh()
    switching.current = ["installing", "rolling-back"].includes(state.phase)
  }, [onRefresh])
  const task = useUpdateTask({ active, read: readCoreUpdate, message: systemErrorMessage, onAccepted, onBusyChange })
  return { ...task, run: (operation: (signal: AbortSignal) => Promise<unknown>, switchesCore = false) => {
    if (switchesCore) switching.current = true
    return task.run(operation)
  } }
}
