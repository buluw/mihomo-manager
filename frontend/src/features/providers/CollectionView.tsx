import type { ReactNode } from "react"
import { WorkspacePage } from "@/components/layout/page-frame"
import { WorkspaceBody, WorkspaceStatusBar } from "@/components/patterns/workspace"

export function CollectionView({ status, sourceName, children }: {
  status: string; sourceName?: string; children: ReactNode
}) {
  return <WorkspacePage className="grid-rows-[minmax(0,1fr)_28px] md:grid-rows-[minmax(0,1fr)_28px]">

    <WorkspaceBody>{children}</WorkspaceBody>
    <WorkspaceStatusBar><span className="truncate">{status}</span><span className="ml-auto min-w-0 truncate">来源：{sourceName ?? "未知"}</span></WorkspaceStatusBar>
  </WorkspacePage>
}
