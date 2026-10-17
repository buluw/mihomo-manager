import { useCallback, useRef, useState, type ReactNode } from "react"
import { CoreUpdateCard } from "./CoreUpdateDialog"
import { WebUiUpdateCard } from "./WebUiUpdateCard"
import { UpdateSettings, type DownloadSettings } from "./UpdateSettings"
import { useUpdatePolicy } from "./useUpdatePolicy"

export function UpdatesMaintenance({ active, disabled, updateBusy, onRefresh, onBusyChange, children }: {
  active: boolean; disabled: boolean; updateBusy: boolean
  onRefresh: () => Promise<void>; onBusyChange: (busy: boolean) => void; children: ReactNode
}) {
  const policy = useUpdatePolicy(active)
  const [settings, setSettings] = useState<DownloadSettings>({ mode: "direct", proxy: "", source: "github", url: "", webuiUrl: "" })
  const [busy, setBusy] = useState({ core: false, webui: false })
  const busyRef = useRef(busy)
  const report = useCallback((key: "core" | "webui", value: boolean) => {
    const next = { ...busyRef.current, [key]: value }; busyRef.current = next
    setBusy(previous => previous[key] === value ? previous : next)
    onBusyChange(next.core || next.webui)
  }, [onBusyChange])
  const coreBusy = useCallback((value: boolean) => report("core", value), [report])
  const webuiBusy = useCallback((value: boolean) => report("webui", value), [report])
  return <div className="mx-auto flex w-full max-w-[680px] flex-col gap-6">
    <CoreUpdateCard active={active} settings={settings} disabled={disabled || busy.webui} onRefresh={onRefresh} onBusyChange={coreBusy} />
    <WebUiUpdateCard active={active} settings={settings} disabled={disabled || busy.core} refreshBlocked={policy.dirty || policy.saving} onBusyChange={webuiBusy} />
    <UpdateSettings policy={policy} value={settings} onChange={setSettings} disabled={disabled || updateBusy} />
    {children}
  </div>
}
