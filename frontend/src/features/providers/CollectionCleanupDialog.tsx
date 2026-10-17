import { useEffect, useRef, useState } from "react"
import { cleanupSelectedProviderFiles, previewProviderCleanup, type CollectionCategory, type ProviderCleanupResult } from "@/api/configClient"
import { CollectionCleanupPreview, cleanupItemKey } from "@/components/patterns/collection-cleanup-preview"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { cleanupSummary } from "@/shared/collectionCleanup"
import type { Notify } from "@/shared/types"

export function CollectionCleanupDialog({ category, onClose, onDone, onBusyChange, notify }: {
  category: CollectionCategory; onClose: () => void; onDone: () => Promise<void>; onBusyChange: (value: boolean) => void; notify: Notify
}) {
  const [preview, setPreview] = useState<ProviderCleanupResult | null>(null)
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
    void previewProviderCleanup(category, controller.signal).then((result) => { if (!controller.signal.aborted) setPreview(result) })
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
  return <Dialog open onOpenChange={(open) => { if (!open && !busyRef.current) onClose() }}><DialogContent showCloseButton={!busy}><DialogHeader>
    <DialogTitle>清理集合文件</DialogTitle><DialogDescription>当前范围：{category === "proxy" ? "代理集合" : "规则集合"}。只删除勾选的文件。改名后请先让相关配置改用新路径并成功应用，再检查旧文件。列表按最新源配置和成功加载记录重新检查；运行依赖未知时由你确认是否清理。删除仍被引用的路径会造成文件缺失，自动维护的文件可能再次生成。</DialogDescription>
  </DialogHeader>
    {message && <Alert><AlertDescription>{message}</AlertDescription></Alert>}
    {refreshError && <Alert variant="destructive"><AlertDescription>{refreshError}</AlertDescription></Alert>}
    {preview ? <CollectionCleanupPreview files={preview.files} selected={complete ? undefined : selection} onSelectionChange={complete ? undefined : setSelection} busy={busy} /> : !message && <div className="flex items-center gap-2"><Spinner />正在检查文件</div>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>{complete ? "关闭" : "取消"}</Button>
      {!complete && <Button variant="destructive" disabled={busy || !selection.size} onClick={() => void confirm()}>{busy && <Spinner data-icon="inline-start" />}确认清理</Button>}
    </DialogFooter>
  </DialogContent></Dialog>
}
