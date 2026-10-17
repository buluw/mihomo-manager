import { ArrowRightLeft, MoreHorizontal, Pencil, Plus, RefreshCw, Save, ShieldCheck, Trash2 } from "lucide-react"
import { StatusDot } from "@/components/patterns/page-kit"
import { WorkspaceToolbar } from "@/components/patterns/workspace"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { confirmedRuntimeSource } from "@/shared/runtimeApplication"
import { configApplyControl } from "./configWorkspaceState"
import type { useConfigWorkspace } from "./useConfigWorkspace"

type ConfigWorkspace = ReturnType<typeof useConfigWorkspace>

function ApplyConfigButton({ workspace }: { workspace: ConfigWorkspace }) {
  const control = configApplyControl({ ...workspace, loadedName: workspace.runtime.error ? null : confirmedRuntimeSource(workspace.runtime.state)?.name ?? null })
  const applying = workspace.busy === "apply" || workspace.busy === "save"
  const ActionIcon = control.icon === "switch" ? ArrowRightLeft : RefreshCw
  return (
    <Tooltip><TooltipTrigger render={<span className="inline-flex" />}><Button
      variant="default"
      size="sm"
      aria-label="应用配置"
      aria-busy={applying}
      className="disabled:aria-busy:opacity-100"
      disabled={
        workspace.busy !== null ||
        workspace.mutation !== null ||
        workspace.unavailable ||
        (!workspace.dirty && workspace.providerIssues.length > 0) ||
        workspace.contentState !== "ready" ||
        !workspace.content || !workspace.sha256 || !workspace.path || control.disabled
      }
      onClick={() => void workspace.applyConfig()}
    >
      {applying ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <ActionIcon data-icon="inline-start" />
      )}
      <span>应用配置</span>
    </Button></TooltipTrigger><TooltipContent>{control.reason ?? control.label}</TooltipContent></Tooltip>
  )
}

export function ConfigFileToolbar({ workspace: config, onAdd, onRename }: { workspace: ConfigWorkspace; onAdd: () => void; onRename: () => void }) {
  const locked = config.unavailable || config.busy !== null || config.mutation !== null
  const currentDisabled = locked || !config.activeName
  return (
        <WorkspaceToolbar variant="resource-editor" className="flex-wrap">
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="outline" size="sm" className="hidden md:inline-flex" disabled={locked} onClick={onAdd}><Plus data-icon="inline-start" />新建</Button>
            <div className="hidden items-center gap-1 @min-[800px]/config-editor:flex">
              <Button variant="outline" size="sm" disabled={currentDisabled} onClick={onRename}><Pencil data-icon="inline-start" />重命名</Button>
              <Button variant="destructive" size="sm" disabled={currentDisabled} onClick={() => config.activeName && config.removeFile(config.activeName)}><Trash2 data-icon="inline-start" />删除</Button>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" className="@min-[800px]/config-editor:hidden" aria-label="文件更多操作" disabled={currentDisabled} />}><MoreHorizontal /></DropdownMenuTrigger>
              <DropdownMenuContent align="start"><DropdownMenuGroup>
                <DropdownMenuItem disabled={currentDisabled} onClick={onRename}><Pencil data-icon="inline-start" />重命名</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" disabled={currentDisabled} onClick={() => config.activeName && config.removeFile(config.activeName)}><Trash2 data-icon="inline-start" />删除</DropdownMenuItem>
              </DropdownMenuGroup></DropdownMenuContent>
            </DropdownMenu>
          </div>
              {config.dirty ? (
            <span className="hidden shrink-0 items-center gap-1.5 text-xs text-status-warning sm:flex">
              <StatusDot tone="warn" />
              未保存
            </span>
              ) : config.activeName && config.loadedName === config.activeName && config.loadedSha256 === config.sha256 ? (
            <span className="hidden shrink-0 items-center gap-1.5 text-xs text-status-success sm:flex">
              <StatusDot tone="ok" />
                最近已加载
            </span>
          ) : null}
          {config.validation === "failed" && (
            <span className="hidden shrink-0 text-xs text-destructive sm:inline">
              校验失败
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-0.5 md:gap-1">
            <Tooltip><TooltipTrigger render={<span className="inline-flex" />}><Button
              variant="outline"
              size="sm"
              aria-label="刷新配置"
              aria-busy={config.busy === "load"}
              className="disabled:aria-busy:opacity-100"
              disabled={!config.activeName || config.busy !== null || config.mutation !== null}
              onClick={() => void config.load(true)}
            >
              {config.busy === "load" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCw data-icon="inline-start" />
              )}
              <span className="hidden xl:inline">刷新配置</span>
            </Button></TooltipTrigger><TooltipContent>刷新配置</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger render={<span className="inline-flex" />}><Button
              variant="outline"
              size="sm"
              aria-label="校验"
              aria-busy={config.busy === "validate"}
              className="disabled:aria-busy:opacity-100"
              disabled={
                config.busy !== null ||
                config.mutation !== null ||
                config.unavailable ||
                config.contentState !== "ready" ||
                !config.content
              }
              onClick={() => void config.validate()}
            >
              {config.busy === "validate" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <ShieldCheck data-icon="inline-start" />
              )}
              <span className="hidden xl:inline">校验</span>
            </Button></TooltipTrigger><TooltipContent>校验</TooltipContent></Tooltip>
            <Button variant="outline" size="sm" disabled={!config.activeName || config.busy !== null || config.mutation !== null || config.unavailable || config.contentState !== "ready"}
              onClick={() => void config.saveConfig()}>
              {config.busy === "save" ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}保存配置
            </Button>
            <ApplyConfigButton workspace={config} />
          </div>
        </WorkspaceToolbar>
  )
}
