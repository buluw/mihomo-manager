import { useEffect, useState } from "react"
import { previewConfigDelete, type ConfigFileRecord, type ProviderCleanupResult, type ProviderCleanupItem } from "@/api/configClient"
import { CollectionCleanupPreview } from "@/components/patterns/collection-cleanup-preview"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel, FieldGroup } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"

export function ConfigDeleteDialog({ file, onClose, onConfirm }: {
  file: ConfigFileRecord; onClose: () => void; onConfirm: (file: ConfigFileRecord, cleanup?: ProviderCleanupItem[]) => void
}) {
  const [cleanup, setCleanup] = useState(true)
  const [preview, setPreview] = useState<ProviderCleanupResult | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    const request = new AbortController()
    void previewConfigDelete(file.name, file.sha256, request.signal).then((result) => {
      if (!request.signal.aborted) setPreview(result)
    }).catch(() => { if (!request.signal.aborted) setError("依赖预览读取失败。请重新打开，或取消集合文件清理后仅删除配置。") })
    return () => request.abort()
  }, [file.name, file.sha256])
  return <AlertDialog open onOpenChange={(open) => { if (!open) onClose() }}><AlertDialogContent><AlertDialogHeader>
    <AlertDialogTitle>删除 {file.name}？</AlertDialogTitle>
    <AlertDialogDescription>删除此源文件及其未保存草稿。最近成功加载来源须先成功切换到其他配置；自动清理保留仍有引用或使用状态未知的集合。</AlertDialogDescription>
  </AlertDialogHeader>
    <FieldGroup><Field orientation="horizontal"><Checkbox id="delete-config-collections" checked={cleanup} onCheckedChange={(value) => setCleanup(value === true)} /><FieldLabel htmlFor="delete-config-collections">同时删除不再使用的集合文件</FieldLabel></Field></FieldGroup>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
      : preview ? <CollectionCleanupPreview files={preview.files} enabled={cleanup} /> : <div className="flex items-center gap-2"><Spinner />正在检查依赖</div>}
    <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={cleanup && !preview} onClick={() => {
      onClose(); onConfirm(file, cleanup ? preview!.files.filter((item) => item.action === "delete") : undefined)
    }}>删除配置</AlertDialogAction></AlertDialogFooter>
  </AlertDialogContent></AlertDialog>
}
