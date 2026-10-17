import { useRef, useState, type ReactElement, type ReactNode } from "react"
import { Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetTrigger } from "@/components/ui/sheet"
import { MobileSheetContent } from "@/components/patterns/mobile-sheet"
import { Spinner } from "@/components/ui/spinner"

type Choice = { value: string; label: string; disabled?: boolean; description?: string; dirty?: boolean }

export function MobileChoiceRow({ label, description, selected, pending, dirty, disabled, onChoose }: {
  label: ReactNode; description?: ReactNode; selected: boolean; pending?: boolean; dirty?: boolean
  disabled?: boolean; onChoose: () => void
}) {
  return <Button variant="ghost" disabled={disabled} aria-pressed={selected} data-slot="mobile-choice-row"
    className="h-auto min-h-13 w-full justify-between gap-3 rounded-lg px-4 py-3 text-sm whitespace-normal aria-pressed:bg-accent max-md:min-h-13 max-md:text-sm" onClick={onChoose}>
    <span className="min-w-0 flex-1 text-left wrap-anywhere">{label}{description && <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>}</span>
    {dirty && <><span className="size-1.5 shrink-0 rounded-full bg-status-warning" aria-hidden="true" /><span className="sr-only">有未保存修改</span></>}
    <span data-slot="mobile-choice-indicator" className="flex size-5 shrink-0 items-center justify-end" aria-hidden="true">{pending ? <Spinner className="size-5" /> : selected ? <Check className="size-5" /> : null}</span>
  </Button>
}

export function MobileChoiceSheet({ title, trigger, value, options, onChoose, onClosed }: {
  title: string
  trigger: ReactElement
  value: string
  options: Choice[]
  onChoose: (value: string) => void | boolean | Promise<void | boolean>
  onClosed?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const busy = useRef(false)
  const choose = async (option: Choice) => {
    if (busy.current || option.disabled) return
    busy.current = true
    setPending(option.value)
    try { if (await onChoose(option.value) !== false) setOpen(false) }
    finally { busy.current = false; setPending(null) }
  }
  return <Sheet open={open} onOpenChange={next => { if (!busy.current) setOpen(next) }} onOpenChangeComplete={next => { if (!next) onClosed?.() }}>
    <SheetTrigger render={trigger} />
    <MobileSheetContent title={title} bodyClassName="flex flex-col gap-1">
        {!options.length && <Button variant="ghost" disabled className="min-h-11 w-full">暂无选项</Button>}
        {options.map(option => <MobileChoiceRow key={option.value} {...option} selected={value === option.value} pending={pending === option.value}
          disabled={option.disabled || pending !== null} onChoose={() => void choose(option)} />)}
    </MobileSheetContent>
  </Sheet>
}
