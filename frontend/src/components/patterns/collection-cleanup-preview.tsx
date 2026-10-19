import { useId, useState } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"
import type { ManagedProviderFile, ProviderCleanupItem } from "@/api/configClient"
import { cleanupPresentation, cleanupReason } from "@/shared/collectionCleanup"
import { TableHeader } from "@/components/patterns/page-kit"
import { StatusBadge } from "@/components/patterns/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { cn } from "@/lib/utils"

export const cleanupItemKey = (item: ProviderCleanupItem) => item.category + "/" + item.fileName
const cleanupColumns = "@3xl/cleanup-preview:grid-cols-[20px_minmax(0,2fr)_minmax(0,1.2fr)_144px_124px_44px]"

export function CollectionCleanupPreview({ files, catalog = [], enabled = true, selected, onSelectionChange, busy = false, fill = false }: {
  files: ProviderCleanupItem[]; catalog?: ManagedProviderFile[]; enabled?: boolean; selected?: Set<string>; onSelectionChange?: (next: Set<string>) => void; busy?: boolean; fill?: boolean
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const id = useId()
  if (!files.length) return <Empty className={fill ? "min-h-0 flex-1" : undefined}><EmptyHeader><EmptyTitle>没有集合文件</EmptyTitle><EmptyDescription>当前范围没有可检查的磁盘文件，Inline 集合没有独立文件。</EmptyDescription></EmptyHeader></Empty>
  const selectable = files.filter(item => item.identity && item.sha256 && item.action !== "deleted")
  const count = selectable.filter(item => selected?.has(cleanupItemKey(item))).length
  return <div className={cn("@container/cleanup-preview flex min-h-0 flex-col", fill && "flex-1")}>
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
      {selected && onSelectionChange ? <label className="flex min-h-11 items-center gap-2 text-sm"><Checkbox disabled={busy || !selectable.length}
        checked={selectable.length > 0 && count === selectable.length} indeterminate={count > 0 && count < selectable.length}
        onCheckedChange={checked => onSelectionChange(new Set(checked ? selectable.map(cleanupItemKey) : []))} />全选</label> : <span className="text-sm">文件清理结果</span>}
      <span className="text-xs text-muted-foreground">共 {files.length} 个文件</span>
    </div>
    <div className={cn("min-h-0 overflow-y-auto overscroll-contain px-3 pb-2", fill ? "flex-1" : "max-h-64")} aria-label="集合文件清理预览">
      <TableHeader layoutClassName={cn("hidden @3xl/cleanup-preview:grid @3xl/cleanup-preview:gap-3", cleanupColumns)}>
        <span /><span>文件名称 / 路径</span><span>配置引用</span><span>最近成功加载记录</span><span>文件来源</span><span className="text-center">详情</span>
      </TableHeader>
      <div className="flex flex-col gap-1">
        {files.map((item, index) => {
          const key = cleanupItemKey(item)
          const view = cleanupPresentation(item, catalog.find(file => file.category === item.category && file.fileName === item.fileName))
          const chosen = selected?.has(key)
          const inputId = id + "-file-" + index
          return <Collapsible key={key} open={expanded === key} onOpenChange={open => setExpanded(open ? key : null)}>
            <div className={cn("grid min-h-18 min-w-0 grid-cols-[20px_minmax(0,1fr)_44px] items-center gap-3 rounded-md px-3 py-3", cleanupColumns, chosen && "bg-accent")}>
              {selected && onSelectionChange ? <Checkbox id={inputId} aria-label={"选择 " + item.fileName} checked={chosen}
                disabled={busy || !item.identity || !item.sha256 || item.action === "deleted"} onCheckedChange={checked => {
                  const next = new Set(selected); if (checked) next.add(key); else next.delete(key); onSelectionChange(next)
                }} /> : <span />}
              <label htmlFor={inputId} className="flex min-w-0 flex-col gap-1.5 text-left">
                <span className="truncate text-sm" title={item.fileName}>{item.fileName}</span>
                <span className="hidden truncate text-xs text-muted-foreground @3xl/cleanup-preview:block" title={view.path}>{view.path}</span>
                {!selected && <StatusBadge status={item.action === "deleted" ? "success" : enabled && item.action === "delete" ? "error" : "neutral"}>{item.action === "deleted" ? "已删除" : enabled && item.action === "delete" ? "将删除" : "保留"}</StatusBadge>}
                <span className="flex flex-wrap gap-1 @3xl/cleanup-preview:hidden">
                  <Badge variant="secondary">{view.configNames.length ? "配置引用 " + view.configNames.length : view.configUnknown ? "配置引用待确认" : "未发现配置引用"}</Badge>
                  <Badge variant="outline">{"加载记录：" + view.recordLabel}</Badge>
                  {view.maintained && <Badge variant="outline">自动维护</Badge>}
                  {view.runtimeUnknown && <Badge variant="outline">运行依赖未知</Badge>}
                </span>
              </label>
              <div className="hidden min-w-0 flex-col gap-1 text-xs @3xl/cleanup-preview:flex">
                {view.configNames.length ? view.configNames.map(name => <span key={name} className="break-all">{name}</span>) : <span className="text-muted-foreground">未发现引用</span>}
                {view.configUnknown && <span className="text-muted-foreground">部分配置引用待确认</span>}
              </div>
              <div className="hidden min-w-0 flex-col items-start gap-1.5 @3xl/cleanup-preview:flex"><Badge variant="secondary">{view.recordLabel}</Badge>{view.runtimeUnknown && <span className="text-xs text-muted-foreground">运行依赖未知</span>}</div>
              <div className="hidden min-w-0 flex-col items-start gap-1.5 @3xl/cleanup-preview:flex"><span className="text-xs">{view.source}</span>{view.maintained && <Badge variant="outline">自动维护</Badge>}</div>
              <CollapsibleTrigger render={<Button variant="ghost" size="icon-lg" className="size-11" />} aria-label={(expanded === key ? "收起 " : "查看 ") + item.fileName + " 引用详情"}>
                {expanded === key ? <ChevronUp /> : <ChevronDown />}
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent className="mx-3 mb-3 flex flex-col gap-3 rounded-md bg-muted/40 p-3">
              <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 text-xs">
                <dt className="text-muted-foreground">文件路径</dt><dd className="break-all">{view.path}</dd>
                <dt className="text-muted-foreground">配置引用</dt><dd className="break-all">{view.configNames.join("、") || "未发现已确认引用"}{view.configUnknown ? "；部分配置无法完整检查" : ""}</dd>
                <dt className="text-muted-foreground">加载记录</dt><dd>{view.recordLabel}；记录不代表 Core 当前完整依赖</dd>
                <dt className="text-muted-foreground">文件来源</dt><dd>{view.source}{view.maintained ? " · 自动维护" : ""}</dd>
              </dl>
              <p className="break-all text-xs text-muted-foreground">{!enabled && item.action === "delete" ? "未选择清理；" : ""}{cleanupReason(item)}</p>
              {view.maintained && <p className="text-xs text-muted-foreground">自动维护文件清理后可能再次生成。</p>}
              {(view.configNames.length > 0 || view.recordedReference) && <p className="text-xs text-muted-foreground">改名后，先让相关配置使用新路径并成功应用，再检查旧文件。</p>}
            </CollapsibleContent>
          </Collapsible>
        })}
      </div>
    </div>
  </div>
}
