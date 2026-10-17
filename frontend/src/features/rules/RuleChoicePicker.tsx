import { MobileSheetContent } from "@/components/patterns/mobile-sheet"
import { MobileChoiceRow } from "@/components/patterns/mobile-choice-sheet"
import { useRef, useState } from "react"
import { ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetTrigger } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { policyTone, ruleTypeTone } from "./ruleViewModel"

type Choice = { value: string; label: string }

export function RuleChoicePicker({ value, options, kind, label, inline = false, disabled = false, onChoose }: {
  value: string
  options: Choice[]
  kind: "policy" | "type"
  label: string
  inline?: boolean
  disabled?: boolean
  onChoose: (value: string) => boolean | Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const action = useRef(onChoose)
  const onOpen = (next: boolean) => {
    if (pendingRef.current) return
    if (next) action.current = onChoose
    setOpen(next)
  }
  const choose = async (next: string) => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(next)
    try { if (await action.current(next)) setOpen(false) }
    finally { pendingRef.current = false; setPending(null) }
  }
  const tone = (item: string) => kind === "policy" ? policyTone(item) : item === "all" ? undefined : ruleTypeTone(item)
  const currentLabel = options.find(option => option.value === value)?.label ?? value
  const text = (item: string, title: string) => <span className={cn("min-w-0 text-left whitespace-normal wrap-anywhere", tone(item))}>{title}</span>
  return <div className={cn("min-w-0", inline ? "max-w-full justify-self-start" : kind === "type" ? "flex-1 basis-28 sm:w-36 sm:flex-none" : "w-full")}>
    <Sheet open={open} onOpenChange={onOpen}>
      <SheetTrigger render={<Button variant={inline ? "ghost" : "outline"} size="sm" aria-label={label} disabled={disabled} className={cn("h-auto min-h-11 min-w-0 max-w-full justify-between gap-2 py-2 whitespace-normal sm:hidden", inline ? "px-1" : "w-full")} />}>
        {text(value, currentLabel)}{!inline && <ChevronDown data-icon="inline-end" />}
      </SheetTrigger>
      <MobileSheetContent title={kind === "policy" ? "选择策略" : "筛选规则类型"} bodyClassName="flex flex-col gap-1">
        {options.map(option => <MobileChoiceRow key={option.value} label={text(option.value, option.label)} selected={value === option.value} pending={pending === option.value} disabled={pending !== null} onChoose={() => void choose(option.value)} />)}
      </MobileSheetContent>
    </Sheet>
    {inline ? <DropdownMenu onOpenChange={next => { if (next) action.current = onChoose }}>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label={label} disabled={disabled} className="hidden h-7 min-w-0 max-w-full justify-start px-1 sm:flex" />}><span className={cn("truncate", tone(value))}>{currentLabel}</span></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-max min-w-64 max-w-[min(32rem,calc(100vw-2rem))]"><DropdownMenuGroup>{options.map(option => <DropdownMenuItem key={option.value} onClick={() => void action.current(option.value)}>{text(option.value, option.label)}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuContent>
    </DropdownMenu> : <Select items={options} value={value} disabled={disabled} onValueChange={next => { if (next !== null) void onChoose(next) }}>
      <SelectTrigger aria-label={label} className="hidden h-8 w-full min-w-0 sm:flex"><SelectValue>{text(value, currentLabel)}</SelectValue></SelectTrigger>
      <SelectContent align={kind === "type" ? "end" : "start"} className="w-max max-w-[min(32rem,calc(100vw-2rem))]"><SelectGroup>{options.map(option => <SelectItem key={option.value} value={option.value}>{text(option.value, option.label)}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>}
  </div>
}
