import { useEffect, useMemo, useRef, useState } from "react"
import { parseDocument, stringify } from "yaml"
import type { ConfigSnapshot } from "@/api/configClient"
import { MonacoWorkspace } from "@/components/patterns/monaco-workspace"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useUiState } from "@/app/state/uiState"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { managedConfigIdentity } from "./managedProviderState"
import { type ManagedProviderItem } from "./managedProviderModel"
import type { useManagedProviderWorkspace } from "./useManagedProviderWorkspace"
import { CollectionHttpFields } from "./CollectionHttpFields"
import { patchCollectionIdentity } from "./collectionNaming"
import { CollectionGroupChoices } from "./CollectionGroupChoices"

type Workspace = ReturnType<typeof useManagedProviderWorkspace>

export function CollectionSettingsDialog({ item, source, workspace, onClose, onDirtyChange }: {
  item: ManagedProviderItem
  source: Pick<ConfigSnapshot, "name" | "sha256">
  workspace: Workspace
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const [baseline] = useState(() => workspace.settingsDraft(item))
  const [snippet, setSnippet] = useState(baseline.snippet)
  const snippetRef = useRef(baseline.snippet)
  const editSnippet = (value: string) => { snippetRef.current = value; setSnippet(value) }
  const loaded = item.declared
  const [selectedGroups, setSelectedGroups] = useState(baseline.selectedGroups)
  const [newGroups, setNewGroups] = useState(baseline.newGroupNames)
  const [groupNameInput, setGroupNameInput] = useState("")
  const groupPending = Boolean(groupNameInput)
  const [tab, setTab] = useState<"settings" | "declaration">("settings")
  const [intervalValid, setIntervalValid] = useState(true)
  const expectedSource = source
  const { askConfirm } = useUiState()
  const changed = (text: string) => text !== baseline.snippet || loaded !== item.declared || JSON.stringify(selectedGroups) !== JSON.stringify(baseline.selectedGroups) || JSON.stringify(newGroups) !== JSON.stringify(baseline.newGroupNames)
  const dirty = groupPending || changed(snippet)

  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const parsed = useMemo(() => {
    try {
      const document = parseDocument(snippet)
      const value = document.toJS()
      if (document.errors.length || !value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length !== 1) throw new Error()
      const name = Object.keys(value)[0]!
      const declaration = value[name]
      if (!declaration || Array.isArray(declaration) || typeof declaration !== "object") throw new Error()
      if (declaration.type !== item.declaration?.type) return { name, declaration: declaration as Record<string, unknown>, error: "集合来源类型不能在此更改" }
      if (declaration.type === "http" && declaration.interval !== undefined && (!Number.isSafeInteger(declaration.interval) || declaration.interval < 0)) return { name, declaration: declaration as Record<string, unknown>, error: "更新周期须为非负整数秒" }
      return { name, declaration: declaration as Record<string, unknown>, error: null }
    } catch {
      return { name: "", declaration: null, error: "请保留一个集合名称及其 YAML 声明" }
    }
  }, [item.declaration?.type, snippet])

  const patch = (key: string, value: unknown) => {
    if (!parsed.declaration) return
    const declaration = { ...parsed.declaration }
    if (value === undefined) delete declaration[key]
    else declaration[key] = value
    editSnippet(stringify({ [parsed.name]: declaration }, { lineWidth: 0 }))
  }

  const http = item.access === "http"
  const interval = Number(parsed.declaration?.interval ?? 0)
  const disabled = workspace.writeDisabled
  const sourceChanged = workspace.identityStatus === "stale" || !managedConfigIdentity(workspace.snapshot, expectedSource.name, expectedSource.sha256)
  const close = async () => {
    if (workspace.busy) return
    if (!dirty || await askConfirm({ title: "放弃未保存的修改？", message: "集合设置尚未确认。", confirmLabel: "放弃修改", cancelLabel: "继续编辑", danger: true })) onClose()
  }
  const save = () => {
    const currentSnippet = snippetRef.current
    if (disabled || sourceChanged || groupPending || !changed(currentSnippet)) return
    void workspace.saveSettings(item, expectedSource, { snippet: currentSnippet, loaded, selectedGroups, newGroupNames: newGroups }).then((ok) => { if (ok) onClose() })
  }
  return <Dialog open onOpenChange={(open) => { if (!open) void close() }}>
    <DialogContent className="grid h-[min(82dvh,760px)] w-[calc(100vw-2rem)] max-w-5xl grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-5xl">
      <DialogHeader className="px-5 py-4">
        <DialogTitle>{item.name} · 设置</DialogTitle>
        <DialogDescription>来源：{source.name}。设置与声明加入共享草稿，使用顶部保存或应用。</DialogDescription>
      </DialogHeader>
      <Tabs value={tab} onValueChange={(value) => { if (value === "settings" || value === "declaration") setTab(value) }} className="border-y px-4">
        <TabsList variant="line"><TabsTrigger value="settings">设置</TabsTrigger><TabsTrigger value="declaration">集合声明</TabsTrigger></TabsList>
      </Tabs>
      <div className="relative min-h-0 overflow-hidden">
        <div className={tab === "declaration" ? "h-full min-h-0" : "hidden"}>
          <MonacoWorkspace
            path={`collection-settings://${encodeURIComponent(source.name)}/${source.sha256}/${item.category}/${encodeURIComponent(item.name)}.yaml`}
            ariaLabel={`${item.name} 集合声明`}
            value={snippet}
            onChange={editSnippet}
            onSave={save}
            transientModels
            readOnly={disabled}
            language="yaml"
          />
        </div>
        <div className={tab === "settings" ? "h-full overflow-y-auto p-5" : "hidden"}>
          <FieldGroup>
            <Field><FieldLabel htmlFor="collection-settings-name">集合名称</FieldLabel><Input id="collection-settings-name" value={parsed.name} disabled={disabled || !parsed.declaration} onChange={(event) => editSnippet(patchCollectionIdentity(snippetRef.current, { name: event.target.value }))} /></Field>
            {parsed.declaration?.type !== "inline" && <Field><FieldLabel htmlFor="collection-settings-filename">文件名</FieldLabel>
              <Input id="collection-settings-filename" value={String(parsed.declaration?.path ?? "").split(/[\\/]/).at(-1) ?? ""} disabled />
              <FieldDescription className="break-all">路径：{String(parsed.declaration?.path ?? "未设置")}{item.access === "local" || item.access === "subscription" ? "（自动提取文件）" : ""}</FieldDescription>
            </Field>}
            {item.category === "proxy" && loaded && <CollectionGroupChoices content={workspace.settingsContent} collectionName={parsed.name || item.name} selected={selectedGroups} newGroups={newGroups} pendingName={groupNameInput} disabled={disabled} onPendingNameChange={setGroupNameInput} onChange={(selected, names) => { setSelectedGroups(selected); setNewGroups(names) }} />}
            {http && <>
              <Field><FieldLabel htmlFor="collection-http-url">HTTP 地址</FieldLabel><Input id="collection-http-url" value={String(parsed.declaration?.url ?? "")} disabled={disabled || Boolean(parsed.error)} onChange={(event) => patch("url", event.target.value)} /></Field>
              <CollectionHttpFields interval={interval} disabled={disabled || Boolean(parsed.error)} onChange={(seconds) => patch("interval", seconds)} onValidChange={setIntervalValid} />
            </>}
            {item.category === "rule" && <Field><FieldLabel>规则行为</FieldLabel><Input value={String(parsed.declaration?.behavior ?? "classical")} disabled={disabled || Boolean(parsed.error)} onChange={(event) => patch("behavior", event.target.value)} /></Field>}
            <FieldDescription>文件名在管理集合中修改。完整设置可在“集合声明”中编辑。HTTP 缓存与自动提取正文保持只读。</FieldDescription>
          </FieldGroup>
        </div>
      </div>
      <div className="border-t">
        {parsed.error && <Alert variant="destructive"><AlertDescription>{parsed.error}</AlertDescription></Alert>}
        {sourceChanged ? <Alert variant="destructive"><AlertDescription>配置或版本已变化，输入已保留。请取消后重新读取，再打开设置。</AlertDescription></Alert>
          : workspace.identityStatus !== "ready" && <Alert><AlertDescription>{workspace.message}</AlertDescription></Alert>}
        <DialogFooter className="m-0 px-5 py-3"><Button variant="outline" disabled={workspace.busy} onClick={() => void close()}>取消</Button>
          <Button disabled={disabled || sourceChanged || groupPending || !dirty || (tab === "settings" && !intervalValid)} onClick={save}>确认</Button>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
}
