import { useId, useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { collectionGroupNameError } from "./collectionGroupDraft"
import { proxyCollectionGroups } from "./proxyCollectionImport"

export function CollectionGroupChoices({ content, collectionName, selected, newGroups, pendingName, onChange, disabled, onPendingNameChange }: {
  content: string; collectionName: string; selected: string[]; newGroups: string[]
  onChange: (selected: string[], newGroups: string[]) => void; disabled?: boolean
  pendingName: string; onPendingNameChange: (name: string) => void
}) {
  const id = useId()
  const [adding, setAdding] = useState(Boolean(pendingName))
  const [error, setError] = useState<string | null>(null)
  const groups = [...proxyCollectionGroups(content), ...newGroups.map(name => ({ name, implicit: false }))]
  const cancel = () => { setAdding(false); onPendingNameChange(""); setError(null) }
  const confirm = () => {
    if (disabled) return
    const error = collectionGroupNameError(content, pendingName, newGroups, collectionName)
    if (error) { setError(error); return }
    const next = pendingName.trim()
    onChange([...new Set([...selected, next])], [...newGroups, next])
    cancel()
  }
  return <FieldSet className="min-w-0 gap-2"><FieldLegend variant="label">所属代理组</FieldLegend>
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">{groups.map(group => <label key={group.name} className="flex min-h-8 min-w-0 max-w-full items-center gap-2 text-sm">
      <Checkbox className="shrink-0" checked={group.implicit || selected.includes(group.name)} disabled={disabled || group.implicit} onCheckedChange={checked => onChange(checked ? [...new Set([...selected, group.name])] : selected.filter(name => name !== group.name), newGroups)} />
      <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{group.name}{group.implicit ? "（自动包含所有集合）" : ""}</span>
    </label>)}{!adding && <Button variant="ghost" size="sm" className="w-fit" disabled={disabled} onClick={() => setAdding(true)}><Plus data-icon="inline-start" />新建代理组</Button>}</div>
    {adding && <Field className="min-w-0" data-invalid={Boolean(error)}><FieldLabel htmlFor={id} className="sr-only">新代理组名称</FieldLabel>
      <div className="flex min-w-0 flex-wrap items-center gap-2"><Input id={id} className="min-w-0 basis-32 flex-1" placeholder="新代理组名称" value={pendingName} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={error ? id + "-error" : undefined} onChange={event => { onPendingNameChange(event.target.value); setError(null) }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); confirm() } }} />
        <Button variant="outline" size="sm" disabled={disabled} onClick={confirm}>确认</Button><Button variant="ghost" size="sm" disabled={disabled} onClick={cancel}>取消</Button></div>
      {error && <FieldError id={id + "-error"}>{error}</FieldError>}
    </Field>}
  </FieldSet>
}
