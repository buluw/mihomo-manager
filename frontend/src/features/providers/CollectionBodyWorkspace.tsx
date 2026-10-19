import { useRef, useState } from "react"
import { ChevronRight, FilePlus2, FolderOpen, Upload } from "lucide-react"
import { MonacoWorkspace } from "@/components/patterns/monaco-workspace"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { providerFileIssueLabel } from "@/shared/configMessages"
import { cn } from "@/lib/utils"
import type { ManagedProviderItem } from "./managedProviderModel"
import type { useManagedProviderWorkspace } from "./useManagedProviderWorkspace"

type Workspace = ReturnType<typeof useManagedProviderWorkspace>

export function CollectionBodyWorkspace({ workspace, item, editable, pickerOpen, onPickerChange }: { workspace: Workspace; item: ManagedProviderItem; editable: boolean; pickerOpen: boolean; onPickerChange: (open: boolean) => void }) {
  const [existingOpen, setExistingOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const fileEditable = editable && item.declaration?.type === "file"
  const picking = fileEditable && item.fileIssue === "missing" && !item.sha256 && (pickerOpen || !workspace.contentReady)
  const files = workspace.files.filter(file => file.category === item.category && file.writable && ["manual", "external"].includes(file.source) && file.fileName !== item.fileName)
  const openEditor = () => { onPickerChange(false); setExistingOpen(false) }
  const upload = async (file?: File) => { if (file && editable && await workspace.uploadContent(item, file)) openEditor() }
  const resume = () => {
    if (!workspace.contentReady) workspace.editContent(item, item.category === "proxy" ? "proxies: []\n" : "payload: []\n")
    openEditor()
  }
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <input ref={input} type="file" accept=".yaml,.yml" className="hidden" aria-label="选择集合正文文件" onChange={event => { void upload(event.currentTarget.files?.[0]); event.currentTarget.value = "" }} />
    {picking ? <div className="flex min-h-0 flex-1 overflow-y-auto p-4">
      <Empty className={cn("min-h-72 w-full border-2 border-dashed border-muted-foreground/40", dragging && "border-primary")}
        onDragOver={event => { event.preventDefault(); if (!workspace.busy) setDragging(true) }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }}
        onDrop={event => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files[0]) }}>
        <EmptyHeader><EmptyMedia variant="icon"><Upload /></EmptyMedia><EmptyTitle>{dragging ? "松开以上传文件" : "选择集合文件"}</EmptyTitle>
          <EmptyDescription>{workspace.contentReady ? "草稿已保留，点击“新建文件”继续编辑。" : "拖入 YAML 文件，或在下方上传、新建。"}</EmptyDescription></EmptyHeader>
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" size="lg" disabled={workspace.busy} onClick={() => input.current?.click()}><Upload data-icon="inline-start" />上传文件</Button>
            <Button size="lg" disabled={workspace.busy} onClick={resume}><FilePlus2 data-icon="inline-start" />新建文件</Button>
          </div>
          <Button variant="ghost" size="lg" disabled={workspace.busy} onClick={() => setExistingOpen(!existingOpen)}><FolderOpen data-icon="inline-start" />已有文件<ChevronRight data-icon="inline-end" /></Button>
          {existingOpen && <div className="flex w-full flex-col gap-2">{files.length ? files.map(file => <Button key={file.fileName} variant="outline" size="lg" className="h-auto min-h-10 justify-start whitespace-normal wrap-anywhere" disabled={workspace.busy} onClick={() => void workspace.useExistingContent(item, file.fileName).then(selected => { if (selected) openEditor() })}>{file.fileName}</Button>) : <EmptyDescription>暂无可用的普通 File 文件</EmptyDescription>}</div>}
        </EmptyContent>
      </Empty>
    </div> : item.fileIssue && !workspace.contentReady ? <Empty className="min-h-0 flex-1"><EmptyHeader>
      <EmptyTitle>{providerFileIssueLabel(item.fileIssue)}</EmptyTitle><EmptyDescription>{item.access === "http" ? "HTTP 正文由 Core 下载，可使用“更新当前”读取。" : "请核对集合来源和文件状态。"}</EmptyDescription>
    </EmptyHeader></Empty> : <div className="relative min-h-0 flex-1">
      <div className={cn("h-full", !workspace.contentReady && "invisible pointer-events-none")}><MonacoWorkspace
        path={`collection://source/${encodeURIComponent(workspace.snapshot?.name ?? "current")}/${item.category}/${encodeURIComponent(item.id)}.yaml`}
        value={workspace.content} onChange={value => workspace.editContent(item, value)} onSave={() => void workspace.saveConfigDraft()}
        readOnly={!editable || Boolean(item.fileIssue && item.fileIssue !== "missing")} ariaLabel={`${item.name} 集合正文`}
      /></div>
      {!workspace.contentReady && <Empty className="absolute inset-0"><EmptyHeader><EmptyTitle>{workspace.contentError ? "集合正文读取失败" : "正在读取集合正文"}</EmptyTitle><EmptyDescription>来源未确认时可重新读取集合状态。</EmptyDescription></EmptyHeader></Empty>}
    </div>}
  </div>
}
