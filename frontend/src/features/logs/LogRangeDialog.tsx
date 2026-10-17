import { useEffect, useMemo, useState } from "react"
import { CalendarClock, Filter } from "lucide-react"
import type { DateRange } from "react-day-picker"
import { zhCN } from "date-fns/locale"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet } from "@/components/ui/sheet"
import { MobileSheetContent, useMobileSheetViewport } from "@/components/patterns/mobile-sheet"
import { customLogRange, type LogTimeRange } from "./logEntries"

const hourItems = Array.from({ length: 24 }, (_, value) => ({ value: String(value), label: String(value).padStart(2, "0") }))
const minuteItems = Array.from({ length: 60 }, (_, value) => ({ value: String(value), label: String(value).padStart(2, "0") }))

type ClockValue = { hour: string; minute: string; second: string }

function clockValue(date: Date): ClockValue {
  return { hour: String(date.getHours()), minute: String(date.getMinutes()), second: String(date.getSeconds()) }
}

function timestamp(date: Date | undefined, clock: ClockValue) {
  if (!date || Object.entries(clock).some(([key, value]) => !/^\d{1,2}$/.test(value) || Number(value) > (key === "hour" ? 23 : 59))) return Number.NaN
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Number(clock.hour),
    Number(clock.minute),
    Number(clock.second),
  ).getTime()
}

function TimeFields({ label, value, onChange, mobile = false }: { label: string; value: ClockValue; onChange: (value: ClockValue) => void; mobile?: boolean }) {
  if (mobile) return <FieldSet className="gap-2">
    <FieldLegend variant="label">{label}</FieldLegend>
    <FieldGroup className="grid grid-cols-3 gap-2">
      {(["hour", "minute", "second"] as const).map((key, index) => <Field key={key} className="gap-1">
        <FieldLabel htmlFor={`log-${key}-${label}`}>{["小时", "分钟", "秒"][index]}</FieldLabel>
        <Input id={`log-${key}-${label}`} aria-label={`${label}${["小时", "分钟", "秒"][index]}`} type="number" inputMode="numeric" min={0} max={key === "hour" ? 23 : 59} step={1} value={value[key]} onChange={event => onChange({ ...value, [key]: event.target.value })} />
      </Field>)}
    </FieldGroup>
  </FieldSet>
  const field = (key: keyof ClockValue, items: typeof minuteItems, ariaLabel: string) => (
    <Select items={items} value={value[key]} onValueChange={(next) => next != null && onChange({ ...value, [key]: String(next) })}>
      <SelectTrigger size="sm" className="w-16" aria-label={`${label}${ariaLabel}`}><SelectValue /></SelectTrigger>
      <SelectContent alignItemWithTrigger={false}><SelectGroup>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>
  )
  return <div className="grid grid-cols-[3rem_repeat(3,4rem)] items-center gap-1.5"><span className="text-muted-foreground">{label}</span>{field("hour", hourItems, "小时")}{field("minute", minuteItems, "分钟")}{field("second", minuteItems, "秒")}</div>
}

export function LogCustomRangePicker({ range, onApply, open, onOpenChange }: {
  range: LogTimeRange
  onApply: (range: LogTimeRange) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches)
  const mobileViewport = useMobileSheetViewport(open && mobile, 0.9)
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)")
    const update = () => setMobile(media.matches)
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  const initialEnd = new Date(range.mode === "custom" && range.until != null ? range.until : Date.now())
  const initialStart = new Date(range.mode === "custom" && range.since != null ? range.since : initialEnd.getTime() - 60 * 60 * 1000)
  const [dates, setDates] = useState<DateRange>({ from: initialStart, to: initialEnd })
  const [startClock, setStartClock] = useState(() => clockValue(initialStart))
  const [endClock, setEndClock] = useState(() => clockValue(initialEnd))
  const candidate = useMemo(
    () => customLogRange(timestamp(dates.from, startClock), timestamp(dates.to, endClock)),
    [dates.from, dates.to, endClock, startClock],
  )
  const apply = () => {
    if (!candidate) return
    onApply(candidate)
    onOpenChange(false)
  }

  if (mobile) return <Sheet open={open} onOpenChange={onOpenChange}>
    <MobileSheetContent title="自定义时间范围" description="选择本地日期和起止时分秒" bodyClassName="px-4"
      style={mobileViewport}
      footer={<>
        <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>取消</Button>
        <Button className="flex-1" disabled={!candidate} onClick={apply}><Filter data-icon="inline-start" />应用范围</Button>
      </>}>
        <FieldGroup className="gap-4">
          <Field className="items-center"><Calendar className="p-0 [--cell-size:--spacing(11)]" mode="range" selected={dates} onSelect={next => next && setDates(next)} locale={zhCN} defaultMonth={dates.from} /></Field>
          <TimeFields mobile label="开始" value={startClock} onChange={setStartClock} />
          <TimeFields mobile label="结束" value={endClock} onChange={setEndClock} />
        </FieldGroup>
    </MobileSheetContent>
  </Sheet>

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="invisible absolute inset-0 w-full max-w-56 justify-start md:visible md:static md:w-auto" />}>
        <CalendarClock data-icon="inline-start" />
        <span className="truncate">{range.mode === "custom" ? range.label : "选择日期与时间"}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[min(var(--available-height),calc(100dvh-2rem))] w-auto max-w-[calc(100vw-1rem)] gap-3 overflow-y-auto p-2 md:max-w-[calc(100vw-2rem)] md:p-3">
        <PopoverHeader><PopoverTitle>自定义时间范围</PopoverTitle><PopoverDescription>选择本地日期和起止时分秒</PopoverDescription></PopoverHeader>
        <Calendar className="p-0 [--cell-size:--spacing(11)] md:p-3 md:[--cell-size:--spacing(6)]" mode="range" selected={dates} onSelect={(next) => next && setDates(next)} locale={zhCN} defaultMonth={dates.from} />
        <div className="grid gap-2 border-t pt-3">
          <TimeFields label="开始" value={startClock} onChange={setStartClock} />
          <TimeFields label="结束" value={endClock} onChange={setEndClock} />
        </div>
        <Button size="sm" disabled={!candidate} onClick={apply}><Filter data-icon="inline-start" />应用范围</Button>
      </PopoverContent>
    </Popover>
  )
}
