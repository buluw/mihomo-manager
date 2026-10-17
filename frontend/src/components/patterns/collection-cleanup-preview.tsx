import type { ProviderCleanupItem } from "@/api/configClient"
import { cleanupReason } from "@/shared/collectionCleanup"
import { StatusBadge } from "@/components/patterns/status-badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"

export const cleanupItemKey = (item: ProviderCleanupItem) => `${item.category}/${item.fileName}`

export function CollectionCleanupPreview({ files, enabled = true, selected, onSelectionChange, busy = false }: {
  files: ProviderCleanupItem[]; enabled?: boolean; selected?: Set<string>; onSelectionChange?: (next: Set<string>) => void; busy?: boolean
}) {
  if (!files.length) return <Empty><EmptyHeader><EmptyTitle>没有集合文件</EmptyTitle><EmptyDescription>当前范围没有可检查的磁盘文件，Inline 集合没有独立文件。</EmptyDescription></EmptyHeader></Empty>
  const selectable = files.filter((item) => item.identity && item.sha256 && item.action !== "deleted")
  const count = selectable.filter((item) => selected?.has(cleanupItemKey(item))).length
  return <div className="flex flex-col gap-2">
    {selected && onSelectionChange && <div className="flex items-center gap-2 border-b pb-2">
      <label className="flex max-md:min-h-11 max-md:px-3.5 items-center gap-1.5 text-sm"><Checkbox disabled={busy || !selectable.length}
        checked={selectable.length > 0 && count === selectable.length} indeterminate={count > 0 && count < selectable.length}
        onCheckedChange={(checked) => onSelectionChange(new Set(checked ? selectable.map(cleanupItemKey) : []))} />全选</label>
      <span className="text-sm">文件名称</span>
    </div>}
  <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto" aria-label="集合文件清理预览">
    {files.map((item, index) => <li key={`${item.category}/${item.fileName}/${index}`} className="flex max-md:min-h-11 max-md:px-3.5 max-md:py-3.5 items-start gap-2">
      {selected && onSelectionChange ? <Checkbox aria-label={`选择 ${item.fileName}`} checked={selected.has(cleanupItemKey(item))}
        disabled={busy || !item.identity || !item.sha256 || item.action === "deleted"} onCheckedChange={(checked) => {
          const next = new Set(selected); if (checked) next.add(cleanupItemKey(item)); else next.delete(cleanupItemKey(item)); onSelectionChange(next)
        }} /> : <StatusBadge status={item.action === "deleted" ? "success" : enabled && item.action === "delete" ? "error" : "neutral"}>{item.action === "deleted" ? "已删除" : enabled && item.action === "delete" ? "将删除" : "保留"}</StatusBadge>}
      <div className="min-w-0"><div className="break-all text-sm">{item.fileName}</div><p className="break-words text-xs text-muted-foreground">{!enabled && item.action === "delete" ? "未选择清理" : cleanupReason(item)}</p></div>
    </li>)}
  </ul></div>
}
