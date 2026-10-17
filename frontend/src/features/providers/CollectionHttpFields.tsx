import { useEffect, useRef, useState } from "react"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { httpIntervalSeconds } from "./managedProviderModel"

function cycle(interval: number) {
  return interval > 0 && interval % 86400 === 0
    ? { value: String(interval / 86400), unit: "days" as const }
    : { value: String((interval > 0 ? interval : 3600) / 3600), unit: "hours" as const }
}

export function CollectionHttpFields({ interval, disabled, onChange, onValidChange }: {
  interval: number; disabled?: boolean; onChange: (seconds: number) => void; onValidChange: (valid: boolean) => void
}) {
  const [draft, setDraft] = useState(() => cycle(interval))
  const published = useRef(interval)
  const enabled = interval > 0
  let seconds = 0
  try { seconds = httpIntervalSeconds(Number(draft.value), draft.unit) } catch { /* Keep incomplete input. */ }
  useEffect(() => {
    if (interval !== published.current && interval > 0) setDraft(cycle(interval))
    published.current = interval
  }, [interval])
  useEffect(() => { onValidChange(!enabled || seconds > 0) }, [enabled, onValidChange, seconds])
  const publish = (next: number) => { published.current = next; onChange(next) }
  const edit = (next: typeof draft) => {
    setDraft(next)
    if (enabled) {
      try { publish(httpIntervalSeconds(Number(next.value), next.unit)) } catch { /* Save stays disabled. */ }
    }
  }
  return <>
    <Field orientation="horizontal"><div className="flex-1"><FieldLabel htmlFor="collection-auto-update">自动更新</FieldLabel><FieldDescription>由 Core 按周期更新。关闭后仍可手动更新当前集合。</FieldDescription></div>
      <Switch id="collection-auto-update" checked={enabled} disabled={disabled} onCheckedChange={(checked) => publish(checked ? seconds || 3600 : 0)} />
    </Field>
    <Field data-invalid={enabled && !seconds}><FieldLabel htmlFor="collection-interval">更新周期</FieldLabel>
      <div className="flex gap-2"><Input id="collection-interval" type="number" min={1 / 3600} step="any" value={draft.value}
        disabled={disabled || !enabled} aria-invalid={enabled && !seconds} onChange={(event) => edit({ ...draft, value: event.target.value })} />
        <Select value={draft.unit} disabled={disabled || !enabled} onValueChange={(unit) => { if (unit === "hours" || unit === "days") edit({ ...draft, unit }) }}>
          <SelectTrigger className="w-24 shrink-0" aria-label="更新周期单位"><SelectValue>{draft.unit === "hours" ? "小时" : "天"}</SelectValue></SelectTrigger>
          <SelectContent><SelectGroup><SelectItem value="hours">小时</SelectItem><SelectItem value="days">天</SelectItem></SelectGroup></SelectContent>
        </Select>
      </div>
    </Field>
  </>
}
