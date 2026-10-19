import { useEffect, useMemo, useRef, useState } from "react"
import { parseDocument, stringify } from "yaml"
import type { ConfigSnapshot } from "@/api/configClient"
import { MonacoWorkspace } from "@/components/patterns/monaco-workspace"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useUiState } from "@/app/state/uiState"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { managedConfigIdentity } from "./managedProviderState"
import { managedProviderDeclarationSnippet, type ManagedProviderItem } from "./managedProviderModel"
import type { useManagedProviderWorkspace } from "./useManagedProviderWorkspace"
import { CollectionHttpFields } from "./CollectionHttpFields"
import { patchCollectionIdentity } from "./collectionNaming"

type Workspace = ReturnType<typeof useManagedProviderWorkspace>

export function CollectionSettingsDialog({ item, source, workspace, onClose, onDirtyChange }: {
  item: ManagedProviderItem
  source: Pick<ConfigSnapshot, "name" | "sha256">
  workspace: Workspace
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const baseline = useMemo(() => managedProviderDeclarationSnippet({ ...item, declared: true }), [item])
  const [snippet, setSnippet] = useState(baseline)
  const snippetRef = useRef(baseline)
  const editSnippet = (value: string) => { snippetRef.current = value; setSnippet(value) }
  const [loaded, setLoaded] = useState(item.declared)
  const [selectedGroups, setSelectedGroups] = useState(item.selectedGroups)
  const [tab, setTab] = useState<"settings" | "declaration">("settings")
  const [intervalValid, setIntervalValid] = useState(true)
  const [expectedSource, setExpectedSource] = useState(source)
  const { askConfirm } = useUiState()
  const dirty = snippet !== baseline || loaded !== item.declared || JSON.stringify(selectedGroups) !== JSON.stringify(item.selectedGroups)

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
  const staged = item.declaration?.type === "file" && item.writable && ["manual", "external"].includes(item.access) && item.fileIssue === "missing" && !item.sha256
  const sourceChanged = workspace.identityStatus === "stale" || !managedConfigIdentity(workspace.snapshot, expectedSource.name, expectedSource.sha256)
  const close = async () => {
    if (workspace.busy) return
    if (!dirty || await askConfirm({ title: "放弃未保存的修改？", message: "集合设置还没有保存。", confirmLabel: "放弃修改", cancelLabel: "继续编辑", danger: true })) onClose()
  }
  const save = () => {
    const currentSnippet = snippetRef.current
    const changed = currentSnippet !== baseline || loaded !== item.declared || JSON.stringify(selectedGroups) !== JSON.stringify(item.selectedGroups)
    if (disabled || sourceChanged || !changed) return
    void workspace.saveSettings(item, expectedSource, { snippet: currentSnippet, loaded, selectedGroups }, setExpectedSource).then((ok) => { if (ok) onClose() })
  }
  return <Dialog open onOpenChange={(open) => { if (!open) void close() }}>
    <DialogContent className="grid h-[min(82dvh,760px)] w-[calc(100vw-2rem)] max-w-5xl grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-5xl">
      <DialogHeader className="px-5 py-4">
        <DialogTitle>{item.name} · 设置</DialogTitle>
        <DialogDescription>{staged ? "设置加入当前集合草稿，统一保存或应用时发布。" : workspace.dirty ? "保存时先保存当前配置及正文草稿，再更新集合设置；应用后改变 Core。" : `保存到 ${source.name}，应用后改变 Core。`}</DialogDescription>
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
              <Input id="collection-settings-filename" value={String(parsed.declaration?.path ?? "").split(/[\\/]/).at(-1) ?? ""} disabled={disabled || !parsed.declaration || item.access === "local" || item.access === "subscription"} onChange={(event) => {
                if (/[\\/]/.test(event.target.value)) return
                const path = String(parsed.declaration?.path ?? "").replaceAll("\\", "/")
                patch("path", (path.replace(/[^/]*$/, "") || "./") + event.target.value)
              }} />
              <FieldDescription className="break-all">路径：{String(parsed.declaration?.path ?? "未设置")}{item.access === "local" || item.access === "subscription" ? "（自动提取文件）" : ""}</FieldDescription>
            </Field>}
            <Field orientation="horizontal"><div className="flex-1"><FieldLabel htmlFor="collection-reference">在此配置中使用</FieldLabel><FieldDescription>引用开关只修改本弹窗草稿。</FieldDescription></div>
              <Switch id="collection-reference" checked={loaded} disabled={disabled} onCheckedChange={setLoaded} />
            </Field>
            {item.category === "proxy" && loaded && <Field><FieldLabel>所属代理组</FieldLabel>
              <div className="flex flex-wrap gap-4">{item.groups.map((name) => <label key={name} className="flex max-md:min-h-11 max-md:px-3.5 items-center gap-2 text-sm">
                <Checkbox checked={item.implicitGroups?.includes(name) || selectedGroups.includes(name)} disabled={disabled || item.implicitGroups?.includes(name)}
                  onCheckedChange={(checked) => setSelectedGroups((current) => checked ? [...new Set([...current, name])] : current.filter((group) => group !== name))} />{name}
              </label>)}</div>
            </Field>}
            {http && <>
              <Field><FieldLabel htmlFor="collection-http-url">HTTP 地址</FieldLabel><Input id="collection-http-url" value={String(parsed.declaration?.url ?? "")} disabled={disabled || Boolean(parsed.error)} onChange={(event) => patch("url", event.target.value)} /></Field>
              <CollectionHttpFields interval={interval} disabled={disabled || Boolean(parsed.error)} onChange={(seconds) => patch("interval", seconds)} onValidChange={setIntervalValid} />
            </>}
            {item.category === "rule" && <Field><FieldLabel>规则行为</FieldLabel><Input value={String(parsed.declaration?.behavior ?? "classical")} disabled={disabled || Boolean(parsed.error)} onChange={(event) => patch("behavior", event.target.value)} /></Field>}
            <FieldDescription>完整设置可在“集合声明”中编辑。HTTP 缓存与自动提取正文保持只读。</FieldDescription>
          </FieldGroup>
        </div>
      </div>
      <div className="border-t">
        {parsed.error && <Alert variant="destructive"><AlertDescription>{parsed.error}</AlertDescription></Alert>}
        {sourceChanged ? <Alert variant="destructive"><AlertDescription>配置或版本已变化，输入已保留。请取消后重新读取，再打开设置。</AlertDescription></Alert>
          : workspace.identityStatus !== "ready" && <Alert><AlertDescription>{workspace.message}</AlertDescription></Alert>}
        <DialogFooter className="m-0 px-5 py-3"><Button variant="outline" disabled={workspace.busy} onClick={() => void close()}>取消</Button>
          <Button disabled={disabled || sourceChanged || !dirty || (tab === "settings" && !intervalValid)} onClick={save}>{staged ? "加入草稿" : "保存配置"}</Button>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
}
