import { useEffect, useRef, useState } from "react"
import { cleanupSelectedProviderFiles, listManagedProviderFiles, previewProviderCleanup, type CollectionCategory, type ManagedProviderFile, type ProviderCleanupResult } from "@/api/configClient"
import { CollectionCleanupPreview, cleanupItemKey } from "@/components/patterns/collection-cleanup-preview"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { cleanupSelectionHint, cleanupSummary } from "@/shared/collectionCleanup"
import type { Notify } from "@/shared/types"

export function CollectionCleanupDialog({ category, onClose, onDone, onBusyChange, notify }: {
  category: CollectionCategory; onClose: () => void; onDone: () => Promise<void>; onBusyChange: (value: boolean) => void; notify: Notify
}) {
  const [preview, setPreview] = useState<ProviderCleanupResult | null>(null)
  const [catalog, setCatalog] = useState<ManagedProviderFile[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [refreshError, setRefreshError] = useState("")
  const [complete, setComplete] = useState(false)
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  const busyRef = useRef(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController(); request.current = controller
    onBusyChange(true)
    void Promise.all([previewProviderCleanup(category, controller.signal), listManagedProviderFiles(controller.signal).catch(() => [])]).then(([result, files]) => { if (!controller.signal.aborted) { setPreview(result); setCatalog(files) } })
      .catch(() => { if (!controller.signal.aborted) setMessage("清理预览读取失败，请关闭后重试") })
    return () => { controller.abort(); onBusyChange(false) }
  }, [category, onBusyChange])
  const confirm = async () => {
    const controller = request.current
    if (busyRef.current || !preview || complete || !controller || controller.signal.aborted) return
    busyRef.current = true; setBusy(true)
    try {
      const selected = preview.files.filter((item) => selection.has(cleanupItemKey(item)))
      if (!selected.length) return
      const result = await cleanupSelectedProviderFiles(category, selected, controller.signal)
      if (controller.signal.aborted) return
      const retained = preview.files.filter((item) => !selection.has(cleanupItemKey(item)))
      setPreview({ files: [...result.files, ...retained] }); setComplete(true); setMessage(cleanupSummary(result))
      try { await onDone() } catch {
        if (!controller.signal.aborted) setRefreshError("列表刷新失败，请关闭后重新刷新；清理结果如上")
        return
      }
      if (!controller.signal.aborted && result.files.length === selected.length && result.files.every((item) => item.action === "deleted")) {
        notify(cleanupSummary(result))
        onClose()
      }
    } catch { if (!controller.signal.aborted) setMessage("清理未全部完成，请关闭并重新检查文件状态") }
    finally { if (!controller.signal.aborted) { busyRef.current = false; setBusy(false) } }
  }
  const selectedFiles = preview?.files.filter(item => selection.has(cleanupItemKey(item))) ?? []
  return <Dialog open onOpenChange={(open) => { if (!open && !busyRef.current) onClose() }}><DialogContent showCloseButton={!busy} className="flex h-[min(600px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl lg:w-[calc(100vw-4rem)] lg:max-w-[1120px]"><DialogHeader className="shrink-0 gap-2 px-4 pt-4 pb-3 pr-12">
    <div className="flex flex-wrap items-center gap-2"><DialogTitle>清理集合文件</DialogTitle><Badge variant="secondary">{category === "proxy" ? "代理集合" : "规则集合"}</Badge></div>
    <DialogDescription>只删除勾选的文件，删除后无法撤销。加载记录仅供参考，列表状态不是安全删除的保证。</DialogDescription>
  </DialogHeader>
    <Separator />
    {message && <Alert className="max-h-24 shrink-0 overflow-y-auto rounded-none"><AlertDescription>{message}</AlertDescription></Alert>}
    {refreshError && <Alert variant="destructive" className="shrink-0 rounded-none"><AlertDescription>{refreshError}</AlertDescription></Alert>}
    {preview ? <CollectionCleanupPreview files={preview.files} catalog={catalog} selected={complete ? undefined : selection} onSelectionChange={complete ? undefined : setSelection} busy={busy} fill /> : <div className="flex min-h-0 flex-1 items-center justify-center gap-2">{!message && <><Spinner />正在检查文件</>}</div>}
    <Separator />
    <DialogFooter className="m-0 shrink-0 flex-col gap-3 p-4 sm:flex-col lg:flex-row lg:items-center lg:justify-between">
      <p role="status" className="min-w-0 text-xs text-muted-foreground lg:flex-1">{complete ? "请核对清理结果和保留文件。" : cleanupSelectionHint(selectedFiles, catalog)}</p>
      <div className="flex items-center justify-between gap-3 lg:gap-5"><span className="shrink-0 text-xs text-muted-foreground">已选 {complete ? 0 : selection.size} 个</span>
        <div className="flex items-center gap-2"><Button variant="outline" className="h-10 min-w-16" disabled={busy} onClick={onClose}>{complete ? "关闭" : "取消"}</Button>
          {!complete && <Button variant="destructive" className="h-10 min-w-24" disabled={busy || !selection.size} onClick={() => void confirm()}>{busy && <Spinner data-icon="inline-start" />}{selection.size ? "清理 " + selection.size + " 个" : "清理文件"}</Button>}
        </div>
      </div>
    </DialogFooter>
  </DialogContent></Dialog>
}
