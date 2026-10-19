import { ArrowRightLeft, MoreHorizontal, Pencil, Plus, RefreshCw, Save, ShieldCheck, Trash2 } from "lucide-react"
import { StatusDot } from "@/components/patterns/page-kit"
import { WorkspaceToolbar } from "@/components/patterns/workspace"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { confirmedRuntimeSource } from "@/shared/runtimeApplication"
import { configApplyControl } from "./configWorkspaceState"
import { ConfigDetailHeader } from "./ConfigMobileNavigation"
import type { useConfigWorkspace } from "./useConfigWorkspace"

type ConfigWorkspace = ReturnType<typeof useConfigWorkspace>

function ApplyConfigButton({ workspace }: { workspace: ConfigWorkspace }) {
  const control = configApplyControl({ ...workspace, loadedName: workspace.runtime.error ? null : confirmedRuntimeSource(workspace.runtime.state)?.name ?? null })
  const applying = workspace.busy === "apply" || workspace.busy === "save"
  const ActionIcon = control.icon === "switch" ? ArrowRightLeft : RefreshCw
  return (
    <Tooltip><TooltipTrigger render={<span className="inline-flex" />}><Button
      variant="default"
      size="lg"
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
        <ActionIcon className="hidden md:block" data-icon="inline-start" />
      )}
      <span>应用<span className="hidden md:inline">配置</span></span>
    </Button></TooltipTrigger><TooltipContent>{control.reason ?? control.label}</TooltipContent></Tooltip>
  )
}

export function ConfigFileToolbar({ workspace: config, onBack, onAdd, onRename }: { workspace: ConfigWorkspace; onBack: () => void; onAdd: () => void; onRename: () => void }) {
  const locked = config.unavailable || config.busy !== null || config.mutation !== null
  const currentDisabled = locked || !config.activeName
  const more = <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="outline" size="icon-lg" aria-label="文件更多操作" />}><MoreHorizontal /></DropdownMenuTrigger>
    <DropdownMenuContent align="end"><DropdownMenuGroup>
      <DropdownMenuItem disabled={locked} onClick={onAdd}><Plus data-icon="inline-start" />新建配置</DropdownMenuItem>
      <DropdownMenuItem disabled={currentDisabled} onClick={onRename}><Pencil data-icon="inline-start" />重命名配置</DropdownMenuItem>
      <DropdownMenuItem className="hidden md:flex" disabled={currentDisabled} onClick={() => void config.load(true)}><RefreshCw data-icon="inline-start" />重新读取</DropdownMenuItem>
      <DropdownMenuItem variant="destructive" disabled={currentDisabled} onClick={() => config.activeName && config.removeFile(config.activeName)}><Trash2 data-icon="inline-start" />删除配置</DropdownMenuItem>
    </DropdownMenuGroup></DropdownMenuContent>
  </DropdownMenu>
  return <>
    <ConfigDetailHeader title={config.activeName || "配置文件"} onBack={onBack} disabled={config.busy !== null || config.mutation !== null} />
    <WorkspaceToolbar variant="resource-editor" className="max-md:min-h-14 max-md:px-3 max-md:py-1">
      <div className="mr-auto md:hidden">{more}</div>
      <div className="hidden min-w-0 flex-1 items-center gap-2 md:flex">
        <span className="truncate text-sm font-medium" title={config.activeName ?? undefined}>{config.activeName || "配置文件"}</span>
        <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground md:flex"><StatusDot tone={config.dirty ? "warn" : "muted"} />{config.dirty ? "未保存" : config.runtimeSaveState === "pending-apply" ? "待应用" : config.loadedName === config.activeName && config.loadedSha256 === config.sha256 ? "最近已加载" : "已保存"}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2" aria-label="配置统一操作">
        <Button variant="outline" size="lg" className="md:hidden" disabled={currentDisabled} onClick={() => void config.load(true)}>重载</Button>
        <Button variant="outline" size="lg" disabled={locked || config.contentState !== "ready" || !config.content} onClick={() => void config.validate()}>
          {config.busy === "validate" ? <Spinner data-icon="inline-start" /> : <ShieldCheck className="hidden md:block" data-icon="inline-start" />}校验
        </Button>
        <Button variant="outline" size="lg" aria-label="保存配置" disabled={locked || !config.activeName || config.contentState !== "ready"} onClick={() => void config.saveConfig()}>
          {config.busy === "save" ? <Spinner data-icon="inline-start" /> : <Save className="hidden md:block" data-icon="inline-start" />}<span>保存<span className="hidden md:inline">配置</span></span>
        </Button>
        <ApplyConfigButton workspace={config} />
        <div className="hidden md:block">{more}</div>
      </div>
    </WorkspaceToolbar>
  </>
}
