import { ResourceListGroup, ResourceListHeader, ResourceListRow } from "@/components/patterns/resource-list";
import { Button } from "@/components/ui/button";

import { Plus } from "lucide-react";
import type { useConfigWorkspace } from "./useConfigWorkspace";
import type { ReactNode } from "react";

type ConfigWorkspace = ReturnType<typeof useConfigWorkspace>

export function ConfigResourceList({
  workspace,
  onAdd,
  onSelectAccepted,
  mobileTitle,
}: {
  workspace: ConfigWorkspace
  onAdd: () => void
  onSelectAccepted?: () => void
  mobileTitle?: ReactNode
}) {
  const orderedFiles = workspace.loadedName
    ? [
        ...workspace.files.filter((file) => file.name === workspace.loadedName),
        ...workspace.files.filter((file) => file.name !== workspace.loadedName),
      ]
    : workspace.files

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]">
      {mobileTitle && <ResourceListHeader>
        {mobileTitle}
        <span className="text-xs text-muted-foreground tabular-nums">
          {workspace.files.length}
        </span>
        <Button
          size="sm"
          className="ml-auto h-10 min-w-24 max-md:min-h-10 max-md:min-w-24"
          disabled={workspace.unavailable || workspace.busy !== null || workspace.mutation !== null}
          onClick={onAdd}
        >
          <Plus data-icon="inline-start" />
          新建
        </Button>
      </ResourceListHeader>}
      <div className="flex min-h-0 flex-col overflow-y-auto p-2">
        <ResourceListGroup>
        {orderedFiles.map((file) => {
          const active = file.name === workspace.activeName
          const loaded = file.name === workspace.loadedName
          const missing = active ? workspace.providerIssues.filter(issue => issue.status === "missing").length : 0
          return <ResourceListRow key={file.name} name={file.name} selected={active}
            description={loaded ? "最近成功加载记录对应来源" : undefined}
            metadata={file.subscriptionManaged ? "订阅管理" : "本地配置"}
            status={active && workspace.unavailable ? "配置不可用" : active && workspace.contentState === "error" ? "读取失败"
              : missing ? <span className="text-status-warning">缺少 {missing} 项</span>
              : active && workspace.dirty ? <span className="text-status-info">未保存</span>
              : active && workspace.validation === "failed" ? "校验失败" : active && workspace.runtime.error ? "身份未知"
              : active && workspace.runtimeSaveState === "pending-apply" ? "待应用" : loaded ? "最近已加载" : "已保存"}
            onSelect={() => void workspace.selectFile(file.name, false, onSelectAccepted)}
            />
        })}
        </ResourceListGroup>
      </div>
    </div>
  )
}
