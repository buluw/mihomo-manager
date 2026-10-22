import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { proxyCollectionGroups } from "./proxyCollectionImport"
import type { CollectionFileRow } from "./collectionFileManagement"
import type { useManagedProviderWorkspace } from "./useManagedProviderWorkspace"
import { CollectionGroupChoices } from "./CollectionGroupChoices"

export function CollectionReferenceForm({ row, workspace, onClose, onDirtyChange }: {
  row: CollectionFileRow; workspace: ReturnType<typeof useManagedProviderWorkspace>; onClose: () => void; onDirtyChange: (value: boolean) => void
}) {
  const [name, setName] = useState(row.savedBindings[0]?.name ?? row.draft?.name ?? row.item.name.split("/").at(-1) ?? "")
  const [selected, setSelected] = useState(row.savedBindings[0]?.selectedGroups ?? [])
  const [newGroups, setNewGroups] = useState<string[]>([])
  const [groupNameInput, setGroupNameInput] = useState("")
  const groupPending = Boolean(groupNameInput)
  const [policy, setPolicy] = useState("DIRECT")
  const [behavior, setBehavior] = useState(String(row.item.declaration?.behavior ?? "classical"))
  const groups = proxyCollectionGroups(workspace.configContent)
  useEffect(() => { onDirtyChange(true); return () => onDirtyChange(false) }, [onDirtyChange])
  const disabled = workspace.writeDisabled
  return <FieldGroup className="grid min-w-0 gap-4 whitespace-normal lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)_auto] lg:items-start">
    <Field className="min-w-0"><FieldLabel htmlFor="reference-name">集合名称</FieldLabel><Input id="reference-name" disabled={disabled} value={name} onChange={event => setName(event.target.value)} /></Field>
    {row.item.category === "proxy" ? <CollectionGroupChoices content={workspace.configContent} collectionName={name} selected={selected} newGroups={newGroups} pendingName={groupNameInput} disabled={disabled} onPendingNameChange={setGroupNameInput} onChange={(selected, names) => { setSelected(selected); setNewGroups(names) }} /> : <FieldGroup className="grid min-w-0 gap-3 sm:grid-cols-2"><Field><FieldLabel>规则行为</FieldLabel><Select value={behavior} disabled={disabled} onValueChange={value => value && setBehavior(value)}><SelectTrigger aria-label="引用规则行为"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{["classical", "domain", "ipcidr"].map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
      <Field><FieldLabel>匹配后去向</FieldLabel><Select value={policy} disabled={disabled} onValueChange={value => value && setPolicy(value)}><SelectTrigger aria-label="引用规则去向"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{["DIRECT", ...groups.map(group => group.name).filter(name => name !== "DIRECT")].map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectGroup></SelectContent></Select></Field></FieldGroup>}
    <div className="flex justify-end gap-2 lg:pt-6"><Button variant="outline" disabled={workspace.busy} onClick={onClose}>取消</Button><Button disabled={disabled || !name.trim() || groupPending} onClick={() => {
      if (workspace.referenceFile(row, { operationId: row.id, name: name.trim(), content: row.item.content, groupNames: selected, newGroupNames: newGroups, behavior, interval: Number(row.item.declaration?.interval ?? 0), ruleSetRules: row.item.category === "rule" ? ["RULE-SET," + name.trim() + "," + policy] : undefined })) onClose()
    }}>确认</Button></div>
  </FieldGroup>
}
