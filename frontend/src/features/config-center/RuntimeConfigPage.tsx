import { ArrowLeft, FileSearch, RefreshCw, TriangleAlert } from "lucide-react"
import { useNavigate, useOutletContext } from "react-router"
import type { AppOutletContext } from "@/app/AppShell"
import { useRegisterPageRefresh } from "@/app/pageRefresh"
import { WorkspacePage } from "@/components/layout/page-frame"
import { MonacoWorkspace } from "@/components/patterns/monaco-workspace"
import { WorkspaceBody, WorkspaceStatusBar, WorkspaceToolbar } from "@/components/patterns/workspace"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { Notify } from "@/shared/types"
import { runtimeRecordMessage } from "./runtimeConfigActions"
import { useRuntimeRecord } from "./useRuntimeRecord"

export function RuntimeConfigPage(_props: { notify: Notify }) {
  const runtime = useRuntimeRecord("runtime")
  const { runtimeReturnTo } = useOutletContext<AppOutletContext>()
  const navigate = useNavigate()
  const successful = runtime.applied?.state.lastSuccessful
  useRegisterPageRefresh(runtime.refresh)
  return <WorkspacePage>
    <WorkspaceToolbar variant="editor">
      <FileSearch className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{successful?.generated.sourceName ?? "运行配置未知"}</span>
      <Button variant="outline" size="sm" onClick={() => navigate(runtimeReturnTo ?? "/config-center", { state: runtimeReturnTo?.state })}><ArrowLeft data-icon="inline-start" />返回</Button>
      <Button variant="outline" size="sm" disabled={runtime.loading} onClick={() => void runtime.refresh()}>
        {runtime.loading ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}刷新运行记录
      </Button>
    </WorkspaceToolbar>
    <WorkspaceBody>
      <div className="h-full min-h-0 min-w-0 flex-1">
        {runtime.loading ? <div className="flex h-full items-center justify-center gap-2" role="status"><Spinner />正在读取运行配置</div>
          : runtime.error || !successful || runtime.applied?.content == null ? <div className="p-4"><Alert variant={runtime.error ? "destructive" : "default"}>
            <TriangleAlert /><AlertTitle>运行配置未知</AlertTitle><AlertDescription>{runtime.error || "尚无可查看的成功加载记录"}</AlertDescription>
          </Alert></div>
          : <MonacoWorkspace path="config://runtime/applied.yaml" value={runtime.applied.content} readOnly ariaLabel="运行配置只读查看器" />}
      </div>
    </WorkspaceBody>
    <WorkspaceStatusBar><span className="truncate">{runtime.error ?? runtimeRecordMessage(runtime.state)}</span><span className="ml-auto shrink-0">只读 · YAML</span></WorkspaceStatusBar>
  </WorkspacePage>
}
