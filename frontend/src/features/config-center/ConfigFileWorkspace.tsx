import { type ConfigSnapshot, type ProviderFileIssue } from "@/api/configClient";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { providerFileIssueLabel } from "../../shared/configMessages.ts";
import { ConfigAddDialog, ConfigRenameDialog } from "./ConfigFileDialogs";
import { ConfigResourceList } from "./ConfigResourceList";
import { ConfigFileToolbar } from "./ConfigFileToolbar";

import { MonacoWorkspace } from "@/components/patterns/monaco-workspace";
import { StatusDot } from "@/components/patterns/page-kit";
import { WorkspaceStatusBar } from "@/components/patterns/workspace";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { ConfigDeleteDialog } from "./ConfigDeleteDialog";
import { newConfigFileName, validUploadedConfigName } from "./configWorkspaceState";
import { runtimeRecordMessage } from "./runtimeConfigActions";
import type { useConfigWorkspace } from "./useConfigWorkspace";

type ConfigWorkspace = ReturnType<typeof useConfigWorkspace>

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col gap-3 p-4" role="status" aria-label={label}>
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="mt-3 h-4 w-11/12" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  )
}

export function ConfigFileWorkspace({
  workspace: config,
  onOpenCollections,
  mobileListTitle,
  onOpenDetail,
  children,
}: {
  workspace: ConfigWorkspace
  onOpenCollections: (source?: ConfigSnapshot, item?: ProviderFileIssue) => Promise<void>
  mobileListTitle: ReactNode
  onOpenDetail: () => void
  children: (view: {
    resources: ReactNode
    mobileResources: ReactNode
    editor: () => ReactNode
    status: ReactNode
    deleteDialog: ReactNode
    addDialog: ReactNode
  }) => ReactNode
}) {
  const [addOpen, setAddOpen] = useState(false)
  const [addMode, setAddMode] = useState<"new" | "upload">("new")
  const [newName, setNewName] = useState("")
  const [uploadName, setUploadName] = useState("")
  const [uploadContent, setUploadContent] = useState<string | null>(null)
  const [uploadLabel, setUploadLabel] = useState("")
  const [nameError, setNameError] = useState<string | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameSource, setRenameSource] = useState("")
  const [renameName, setRenameName] = useState("")
  const [renameError, setRenameError] = useState<string | null>(null)

  useEffect(() => {
    if (!config.createError) return
    if (renameOpen) setRenameError(config.createError)
    else {
      setNameError(config.createError)
      setAddOpen(true)
    }
    config.clearCreateError()
  }, [config.createError, renameOpen])

  const openAddDialog = () => {
    setNewName("")
    setUploadName("")
    setUploadContent(null)
    setUploadLabel("")
    setAddMode("new")
    setNameError(null)
    setAddOpen(true)
  }

  const createDraft = async () => {
    const fileName = newConfigFileName(newName)
    if (!fileName) {
      setNameError("请输入有效名称，不要包含路径或扩展名")
      return
    }
    if (config.files.some((file) => file.name.toLowerCase() === fileName.toLowerCase())) {
      setNameError("同名配置文件已存在")
      return
    }
    if (!(await config.createDraft(fileName, ""))) return
    setAddOpen(false)
    onOpenDetail()
  }

  const chooseUpload = async (file: File | undefined) => {
    setNameError(null)
    setUploadContent(null)
    setUploadLabel("")
    if (!file) return
    if (!/\.ya?ml$/i.test(file.name)) {
      setNameError("只支持 .yaml 或 .yml 文件")
      return
    }
    try {
      const content = await file.text()
      setUploadName(file.name)
      setUploadLabel(file.name)
      setUploadContent(content)
    } catch {
      setNameError("文件读取失败，请重新选择")
    }
  }

  const uploadFile = async () => {
    const fileName = uploadName.trim()
    if (!validUploadedConfigName(fileName)) {
      setNameError("请输入有效的 .yaml 或 .yml 文件名，不要包含路径")
      return
    }
    if (uploadContent == null) {
      setNameError("请先选择 YAML 文件")
      return
    }
    if (config.files.some((file) => file.name.toLowerCase() === fileName.toLowerCase())) {
      setNameError("同名配置文件已存在")
      return
    }
    const created = await config.createDraft(fileName, uploadContent, "upload")
    if (!created) return
    setAddOpen(false)
    onOpenDetail()
    if (created.providerIssues?.length) void onOpenCollections(created)
  }

  const openRenameDialog = (name: string) => {
    setRenameSource(name)
    setRenameName(name)
    setRenameError(null)
    setRenameOpen(true)
  }

  const renameFile = async () => {
    const nextName = renameName.trim()
    if (!validUploadedConfigName(nextName)) {
      setRenameError("请输入有效的 .yaml 或 .yml 文件名，不要包含路径")
      return
    }
    if (nextName === renameSource) {
      setRenameOpen(false)
      return
    }
    if (config.files.some((file) => file.name.toLowerCase() === nextName.toLowerCase())) {
      setRenameError("同名配置文件已存在")
      return
    }
    if (await config.renameFile(renameSource, nextName)) setRenameOpen(false)
  }

  const resourceList = (mobile = false) => (
    <ConfigResourceList
      workspace={config}
      onAdd={openAddDialog}
      mobileTitle={mobile ? mobileListTitle : undefined}
      onSelectAccepted={onOpenDetail}
    />
  )

  const validationLabel =
    config.validation === "running"
      ? "正在校验"
      : config.validation === "passed"
        ? "校验通过"
        : config.validation === "failed"
          ? "校验失败"
          : "尚未校验"

  return children({
    resources: resourceList(),
    mobileResources: resourceList(true),
    editor: () => (
      <div className="@container/config-editor grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden">
        <ConfigFileToolbar workspace={config} onAdd={openAddDialog} onRename={() => config.activeName && openRenameDialog(config.activeName)} />
        <div className="min-h-0 min-w-0 overflow-hidden">
          {config.unavailable ? (
            <div className="flex h-full items-center justify-center p-5">
              <Alert variant="destructive" className="max-w-md">
                <TriangleAlert />
                <AlertTitle>配置功能暂不可用</AlertTitle>
                <AlertDescription>
                  配置服务未连接。
                </AlertDescription>
                <AlertAction>
                  <Button
                    variant="outline"
                    onClick={() => void config.load()}
                    disabled={config.busy === "load"}
                  >
                    {config.busy === "load" ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <RefreshCw data-icon="inline-start" />
                    )}
                    重试
                  </Button>
                </AlertAction>
              </Alert>
            </div>
          ) : config.contentState === "loading" ? (
            <LoadingState label="正在读取配置" />
          ) : config.contentState === "error" ? (
            <div className="flex h-full items-center justify-center p-5">
              <Alert variant="destructive" className="max-w-md">
                <TriangleAlert />
                <AlertTitle>配置读取失败</AlertTitle>
                <AlertDescription>{config.contentError}</AlertDescription>
                <AlertAction>
                  <Button variant="outline" onClick={config.retryContent}>
                    <RefreshCw data-icon="inline-start" />
                    重试
                  </Button>
                </AlertAction>
              </Alert>
            </div>
          ) : !config.activeName ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无配置文件，请先添加配置</div>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
            {config.providerIssues.length > 0 && <Alert className="shrink-0 rounded-none border-x-0"><TriangleAlert /><AlertTitle>配套集合文件尚未就绪</AlertTitle><AlertDescription>
              <span>{config.providerIssues.map((issue) => `${issue.name}：${providerFileIssueLabel(issue.status)}`).join("；")}。集合文件就绪后才能加载 Core。</span>
              <div className="flex flex-wrap gap-2">{config.providerIssues.map((issue) => <Button key={`${issue.category}:${issue.name}`} variant="outline" size="sm"
                disabled={config.busy !== null || config.mutation !== null} onClick={() => void onOpenCollections(undefined, issue)}>{issue.name}：编辑集合</Button>)}</div>
            </AlertDescription></Alert>}
            {config.validationError && <Alert variant="destructive" className="shrink-0 rounded-none border-x-0"><AlertDescription>{config.validationError}</AlertDescription></Alert>}
            <div className="min-h-0 flex-1"><MonacoWorkspace
              path={config.activeName ? `config://file/${encodeURIComponent(config.activeName)}` : undefined}
              value={config.content}
              issues={config.editorIssues}
              onChange={config.edit}
              onSave={() => void config.saveConfig()}
              readOnly={config.busy === "save" || config.busy === "apply" || config.contentState !== "ready"}
              ariaLabel="配置编辑器"
            /></div></div>
          )}
        </div>
      </div>
    ),
    status: (
      <WorkspaceStatusBar>
        <StatusDot
          tone={
            config.unavailable || config.validation === "failed"
              ? "error"
              : config.validation === "passed" ||
                  config.runtimeSaveState === "synced"
                ? "ok"
                : config.validation === "running" ||
                    config.dirty ||
                    config.runtimeSaveState === "pending-apply"
                  ? "warn"
                  : "muted"
          }
        />
        <span
          className={cn(
            "truncate",
            config.unavailable || config.validation === "failed"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          {config.unavailable || config.busy === "load" || config.contentState !== "ready"
            ? config.message
            : validationLabel}
        </span>
        <Tooltip><TooltipTrigger render={<span />}
          className={cn(
            "ml-auto truncate text-muted-foreground",
            config.runtimeSaveState === "disk-only" && "text-destructive",
            config.runtimeSaveState === "pending-apply" && "text-status-warning"
          )}

        >
          {config.applyError || config.runtime.error || (config.runtimeSaveState === "disk-only"
            ? runtimeRecordMessage(config.runtime.state)
            : config.runtimeSaveState === "pending-apply"
              ? "磁盘：已保存待应用"
            : `磁盘：${config.activeName || "未选择"} · 最近成功加载：${config.loadedName || "未知"}`)}
        </TooltipTrigger><TooltipContent>{config.sha256 ? `SHA256 ${config.sha256}` : "暂无文件版本"}</TooltipContent></Tooltip>
      </WorkspaceStatusBar>
    ),
    deleteDialog: config.deleteTarget ? <ConfigDeleteDialog key={`${config.deleteTarget.name}/${config.deleteTarget.sha256}`} file={config.deleteTarget} onClose={config.closeDelete} onConfirm={(file, cleanup) => void config.confirmDelete(file, cleanup)} /> : null,
    addDialog: (
      <>
      <ConfigAddDialog
        addOpen={addOpen} setAddOpen={setAddOpen} addMode={addMode} setAddMode={setAddMode}
        newName={newName} setNewName={setNewName} uploadName={uploadName} setUploadName={setUploadName}
        uploadContent={uploadContent} uploadLabel={uploadLabel} nameError={nameError} setNameError={setNameError}
        chooseUpload={chooseUpload} createDraft={createDraft} uploadFile={uploadFile} creating={config.mutation === "create"}
      />
      <ConfigRenameDialog
        renameOpen={renameOpen} setRenameOpen={setRenameOpen} renameSource={renameSource} renameName={renameName} setRenameName={setRenameName}
        renameError={renameError} setRenameError={setRenameError} renameFile={renameFile} renaming={config.mutation === "rename"}
      />
      </>
    ),
  })
}
