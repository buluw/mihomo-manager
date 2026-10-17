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
          className="ml-auto h-9"
          disabled={workspace.unavailable || workspace.busy !== null || workspace.mutation !== null}
          onClick={onAdd}
        >
          <Plus data-icon="inline-start" />
          新建
        </Button>
      </ResourceListHeader>}
      <div className="flex min-h-0 flex-col overflow-y-auto px-4 pt-1 pb-5 md:px-3">
        <ResourceListGroup>
        {orderedFiles.map((file) => {
          const active = file.name === workspace.activeName
          const loaded = file.name === workspace.loadedName
          return <ResourceListRow key={file.name} name={file.name} selected={active} marked={loaded} mobileMarker
            description={loaded ? "最近成功加载记录对应来源" : undefined}
            metadata={<><span>{file.subscriptionManaged ? "订阅管理" : "本地配置"}</span>
              {active && workspace.dirty && <span className="text-status-warning">未保存</span>}
              {active && workspace.contentState === "error" && <span className="text-destructive">读取失败</span>}
              {active && workspace.validation === "failed" && <span className="text-destructive">校验失败</span>}
              {active && workspace.unavailable && <span className="text-destructive">配置不可用</span>}
              {active && workspace.runtime.error && <span className="text-status-warning">加载身份未知</span>}
            </>}
            onSelect={() => void workspace.selectFile(file.name, false, onSelectAccepted)}
            />
        })}
        </ResourceListGroup>
      </div>
    </div>
  )
}
