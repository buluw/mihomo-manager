import { Children, Fragment, useEffect, useState, type ReactNode } from "react"
import { ChevronRight, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Sheet } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { MobileChoiceSheet } from "@/components/patterns/mobile-choice-sheet"
import { MobileSheetContent, useMobileSheetViewport } from "@/components/patterns/mobile-sheet"
import { cn } from "@/lib/utils"

export const booleanItems = [{ value: "enabled", label: "启用" }, { value: "disabled", label: "停用" }]
export const settingRowClassName = "relative grid min-h-16 grid-cols-[minmax(0,1fr)_minmax(104px,47%)_44px] items-center gap-x-1.5 gap-y-2 px-3 py-2.5 md:min-h-[66px] md:grid-cols-[180px_minmax(0,1fr)_32px] md:gap-x-2.5 md:px-4 md:py-3 [&+&]:border-t"
export const settingLabelClassName = "min-w-0 text-[13px] leading-relaxed wrap-anywhere"
export const settingDetailClassName = "col-span-3 text-xs"
export const settingActionsClassName = "max-md:[&_button[data-slot]]:min-w-20 max-md:[&_button[data-slot]]:gap-1.5 max-md:[&_button[data-slot]]:px-3"

export function SettingsGroup({ title, children, description }: { title: string; children: ReactNode; description?: ReactNode }) {
  return <FieldSet className="min-w-0 gap-2" data-slot="settings-group">
    <FieldLegend variant="label" className="mb-2 px-0.5 text-muted-foreground">{title}</FieldLegend>
    <FieldGroup className="gap-0 overflow-hidden rounded-[10px] border bg-card">
      {Children.toArray(children).map((child, index) => <Fragment key={index}>{index > 0 && <Separator className="mx-3 data-horizontal:w-auto md:mx-4" />}{child}</Fragment>)}
    </FieldGroup>
    {description && <FieldDescription className="px-0.5 text-xs">{description}</FieldDescription>}
  </FieldSet>
}

export function SettingsToolRow({ label, description, children }: { label: string; description?: ReactNode; children: ReactNode }) {
  return <Field orientation="horizontal" className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 md:min-h-[66px] md:px-4 md:py-3">
    <div className="flex min-w-0 flex-col gap-1"><FieldTitle className={settingLabelClassName}>{label}</FieldTitle>{description && <FieldDescription className="text-xs">{description}</FieldDescription>}</div>
    <div className={cn("flex min-w-0 flex-wrap items-center justify-end gap-2", settingActionsClassName)}>{children}</div>
  </Field>
}

export function SelectField({ id, label, value, items, disabled, onChange, reset, status }: {
  id: string; label: string; value: string; items: Array<{ value: string; label: string }>
  disabled: boolean; onChange: (value: string) => void; reset: ReactNode; status?: string
}) {
  const isSwitch = items === booleanItems && value !== "follow"
  const placeholder = status?.startsWith("源配置") ? "配置值格式无效" : "跟随 Core"
  return <Field orientation="horizontal" className={settingRowClassName}>
    <FieldLabel htmlFor={isSwitch ? id : undefined} className={settingLabelClassName}>{label}</FieldLabel>
    <div className={cn("flex min-w-0 items-center", isSwitch && "justify-end")}>
      {isSwitch ? <Switch id={id} checked={value === "enabled"} onCheckedChange={checked => onChange(checked ? "enabled" : "disabled")} disabled={disabled} /> : <>
        <MobileChoiceSheet title={label} value={value} options={items} onChoose={onChange}
          trigger={<Button id={id} variant="outline" disabled={disabled} className="h-auto min-h-11 w-full min-w-0 justify-between gap-2 px-2 py-2 text-left whitespace-normal md:hidden" aria-label={label}>
            <span className="min-w-0 wrap-anywhere">{items.find(item => item.value === value)?.label ?? placeholder}</span><ChevronRight className="size-3.5 shrink-0 rotate-90" />
          </Button>} />
        <Select items={items} value={value === "follow" ? null : value} onValueChange={next => next && onChange(String(next))} disabled={disabled}>
          <SelectTrigger id={`${id}-desktop`} aria-label={label} className="hidden h-9 w-full md:flex"><SelectValue placeholder={placeholder} /></SelectTrigger>
          <SelectContent align="end"><SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </>}
    </div>
    <div className="flex items-center">{reset}</div>
    {status && status !== "跟随 Core" && <FieldDescription className={settingDetailClassName}>{status}</FieldDescription>}
  </Field>
}

export function TextSettingField({ id, label, description, value, disabled, multiline = false, onChange, known, reset, onRestore, canRestore, onEditingChange, status }: {
  id: string; label: string; description: string; value: string; disabled: boolean; multiline?: boolean
  onChange: (value: string) => void; known: boolean; reset: ReactNode; status?: string
  onRestore?: () => void; canRestore?: boolean; onEditingChange?: (id: string, editing: boolean) => void
}) {
  const [mode, setMode] = useState<"sheet" | "inline" | null>(null)
  const [text, setText] = useState("")
  const [initialText, setInitialText] = useState("")
  const [textEdited, setTextEdited] = useState(false)
  const viewportStyle = useMobileSheetViewport(mode === "sheet")
  const close = () => { setMode(null); onEditingChange?.(id, false) }
  const open = () => { if (disabled) return; setText(value); setInitialText(value); setTextEdited(false); setMode(window.matchMedia("(max-width: 767px)").matches ? "sheet" : "inline"); onEditingChange?.(id, true) }
  useEffect(() => () => onEditingChange?.(id, false), [id, onEditingChange])
  const lines = value.split(/\r?\n/).filter(line => line.trim())
  const summary = !known ? status ?? "跟随 Core" : lines.length ? lines.slice(0, 2).join("\n") : "空列表"
  const editor = <FieldGroup className="gap-3">
    <Field><FieldLabel htmlFor={`${id}-editor`} className="sr-only">{label}</FieldLabel><FieldDescription>{description}</FieldDescription>
      <Textarea id={`${id}-editor`} aria-label={label} value={text} disabled={disabled} onChange={event => { setText(event.target.value); setTextEdited(true) }}
        placeholder={known ? "空列表" : status ?? "跟随 Core；修改后保存明确值"} className="h-44 min-h-28 resize-y field-sizing-fixed md:h-32" />
    </Field>
  </FieldGroup>
  const actions = <>
    {onRestore ? <Button variant="ghost" size="sm" disabled={disabled || !canRestore} onClick={() => { onRestore(); close() }}><RotateCcw data-icon="inline-start" />恢复配置值</Button> : <span />}
    <div className="flex gap-2"><Button variant="outline" size="sm" onClick={close}>取消</Button><Button size="sm" disabled={disabled} onClick={() => { if (text !== initialText || !known && textEdited) onChange(text); close() }}>完成</Button></div>
  </>
  if (!multiline) return <Field orientation="horizontal" className={settingRowClassName} data-disabled={disabled || undefined}>
    <FieldLabel htmlFor={id} className={settingLabelClassName}>{label}</FieldLabel>
    <Input id={id} value={value} disabled={disabled} placeholder={known ? "空" : status?.startsWith("源配置") ? "配置值格式无效" : "跟随 Core"} onChange={event => onChange(event.target.value)} className="w-full md:h-9" />
    <div>{reset}</div><FieldDescription className={settingDetailClassName}>{description}</FieldDescription>
    {status && <FieldDescription className={settingDetailClassName}>{status}</FieldDescription>}
  </Field>
  return <Field className="gap-0" data-disabled={disabled || undefined}>
    <Button variant="ghost" disabled={disabled} onClick={() => mode ? close() : open()} aria-label={`编辑：${label}`} aria-expanded={mode !== null}
      className="grid h-auto min-h-16 max-md:min-h-16 w-full grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_20px] gap-3 rounded-none px-3 py-2.5 text-left whitespace-normal md:min-h-[66px] md:grid-cols-[180px_minmax(0,1fr)_32px] md:px-4 md:py-3">
      <span className={settingLabelClassName}>{label}</span>
      <span className="min-w-0 text-right text-xs font-normal text-muted-foreground"><span className="line-clamp-2 whitespace-pre-line wrap-anywhere">{summary}</span>{lines.length > 2 && <span className="mt-0.5 block">共 {lines.length} 项</span>}</span>
      <ChevronRight className={cn("size-4 justify-self-end", mode === "inline" && "rotate-90")} />
    </Button>
    {mode === "inline" && <div className="flex flex-col gap-3 px-4 pb-4"><Separator />{editor}<div className="flex items-center justify-between gap-2">{actions}</div></div>}
    <Sheet open={mode === "sheet"} onOpenChange={next => { if (!next) close() }}>
      <MobileSheetContent title={label} bodyClassName="px-4" style={viewportStyle} footer={actions}>{editor}</MobileSheetContent>
    </Sheet>
  </Field>
}
