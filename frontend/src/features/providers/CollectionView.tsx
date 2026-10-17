import type { ReactNode } from "react"
import { Boxes, ListTree } from "lucide-react"
import { WorkspacePage } from "@/components/layout/page-frame"
import { WorkspaceBody, WorkspaceCategoryTabs, WorkspaceStatusBar, WorkspaceToolbar } from "@/components/patterns/workspace"
import type { ProviderCategory } from "./collectionViewModel"

export function CollectionView({ category, onCategoryChange, status, sourceName, children }: {
  category: ProviderCategory; onCategoryChange: (category: ProviderCategory) => void
  status: string; sourceName?: string; children: ReactNode
}) {
  return <WorkspacePage className="grid-rows-[0_minmax(0,1fr)_28px] md:grid-rows-[auto_minmax(0,1fr)_28px]">
    <WorkspaceToolbar variant="resource-tabs" className="max-md:h-0 max-md:min-h-0 max-md:border-0 max-md:p-0">
      <WorkspaceCategoryTabs value={category} onValueChange={value => onCategoryChange(value as ProviderCategory)}
        className="hidden md:flex"
        items={[{ value: "proxy", label: "代理集合", icon: Boxes }, { value: "rule", label: "规则集合", icon: ListTree }]} />
      <span className="ml-auto hidden min-w-0 truncate px-3 text-xs text-muted-foreground md:block" title={sourceName}>来源：{sourceName ?? "未知"}</span>
    </WorkspaceToolbar>
    <WorkspaceBody>{children}</WorkspaceBody>
    <WorkspaceStatusBar><span className="truncate">{status}</span><span className="ml-auto shrink-0">YAML</span></WorkspaceStatusBar>
  </WorkspacePage>
}
