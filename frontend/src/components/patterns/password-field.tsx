import { useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { Field, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"

export function PasswordField({ id, label, value, onChange, current = false, disabled = false, invalid = false, describedBy }: {
  id: string; label: string; value: string; onChange: (value: string) => void
  current?: boolean; disabled?: boolean; invalid?: boolean; describedBy?: string
}) {
  const [visible, setVisible] = useState(false)
  return <Field data-invalid={invalid || undefined} data-disabled={disabled || undefined} className="gap-2">
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <InputGroup className="h-11">
      <InputGroupInput id={id} name={id} type={visible ? "text" : "password"} value={value} onChange={event => onChange(event.target.value)}
        autoComplete={current ? "current-password" : "new-password"} required minLength={current ? undefined : 8} maxLength={128}
        placeholder={current ? "请输入访问密码" : "请输入新密码"} disabled={disabled} aria-invalid={invalid} aria-describedby={describedBy} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton size="icon-sm" className="size-11" aria-label={(visible ? "隐藏" : "显示") + label} aria-pressed={visible}
          disabled={disabled} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff /> : <Eye />}</InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  </Field>
}
