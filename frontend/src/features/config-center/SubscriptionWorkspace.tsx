import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CloudDownload, Plus, RefreshCw, Save, TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import { SubscriptionEditor } from "./SubscriptionEditor"
import { SubscriptionResourceList } from "./SubscriptionResourceList"

import { StatusDot } from "@/components/patterns/page-kit"
import { WorkspaceStatusBar, WorkspaceToolbar } from "@/components/patterns/workspace"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"

import type { useSubscriptionWorkspace } from "./useSubscriptionWorkspace"

type SubscriptionWorkspaceState = ReturnType<
  typeof useSubscriptionWorkspace
>

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
      <Spinner />
      {label}
    </div>
  )
}

export function SubscriptionWorkspace({
  workspace: subscription,
  count,
  mobileListTitle,
  onOpenDetail,
  children,
}: {
  workspace: SubscriptionWorkspaceState
  count: number
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
  const createDraft = async () => {
    if (!(await subscription.createDraft())) return
    onOpenDetail()
  }

  const resourceList = (mobile = false) => (
    <SubscriptionResourceList
      workspace={subscription}
      count={count}
      onAdd={() => void createDraft()}
      mobileTitle={mobile ? mobileListTitle : undefined}
      onSelected={onOpenDetail}
    />
  )

  return children({
    resources: resourceList(),
    mobileResources: resourceList(true),
    editor: () => (
      <div className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
        <WorkspaceToolbar variant="resource-editor">
          <Button variant="outline" size="sm" className="hidden md:inline-flex" disabled={subscription.unavailable || subscription.writeLocked} onClick={() => void createDraft()}><Plus data-icon="inline-start" />新增订阅</Button>
          {subscription.dirty && (
            <span className="hidden shrink-0 items-center gap-1.5 text-xs text-status-warning sm:flex">
              <StatusDot tone="warn" />
              未保存
            </span>
          )}
          {subscription.active?.status === "error" && (
            <span className="hidden shrink-0 text-xs text-destructive sm:inline">
              更新失败
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Tooltip><TooltipTrigger render={<span className="inline-flex" />}><Button
              variant="outline"
              size="sm"
              aria-label="更新订阅"
              aria-busy={subscription.activeId !== null && subscription.updatingId === subscription.activeId}
              className="disabled:aria-busy:opacity-100"
              disabled={
                subscription.writeLocked ||
                !subscription.activeId ||
                subscription.dirty ||
                subscription.unavailable
              }
              onClick={() => void subscription.updateActive()}
            >
              {subscription.activeId !== null && subscription.updatingId === subscription.activeId ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <CloudDownload data-icon="inline-start" />
              )}
              <span>更新订阅</span>
            </Button></TooltipTrigger><TooltipContent>{subscription.dirty ? "请先保存当前订阅设置再更新" : "更新当前订阅"}</TooltipContent></Tooltip>
            <Button
              variant="default"
              size="sm"
              aria-label="保存"
              aria-busy={subscription.busy === "save"}
              className="disabled:aria-busy:opacity-100"
              disabled={
                subscription.writeLocked ||
                !subscription.dirty ||
                !subscription.valid ||
                subscription.unavailable
              }
              onClick={() => void subscription.save()}
            >
              {subscription.busy === "save" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              <span>保存</span>
            </Button>
          </div>
        </WorkspaceToolbar>
        <div className="min-h-0 min-w-0 overflow-hidden">
          {subscription.unavailable ? (
            <div className="flex h-full items-center justify-center p-5">
              <Alert variant="destructive" className="max-w-md">
                <TriangleAlert />
                <AlertTitle>订阅功能暂不可用</AlertTitle>
                <AlertDescription>
                  configd 未连接。Controller 页面不受影响。
                </AlertDescription>
                <AlertAction>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void subscription.load(
                        subscription.activeId ?? undefined,
                        true
                      )
                    }
                    disabled={subscription.busy === "load"}
                  >
                    {subscription.busy === "load" ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <RefreshCw data-icon="inline-start" />
                    )}
                    重试
                  </Button>
                </AlertAction>
              </Alert>
            </div>
          ) : subscription.busy === "load" &&
            !subscription.active &&
            !subscription.newDraft ? (
            <LoadingState label="正在读取订阅" />
          ) : subscription.active || subscription.newDraft ? (
            <SubscriptionEditor
              form={subscription.form}
              item={subscription.active}
              disabled={subscription.writeLocked}
              onChange={subscription.edit}
              filterDraft={subscription.filterDraft}
              filterError={subscription.filterError}
              filterPreview={subscription.filterPreview}
              filterPreviewPending={subscription.filterPreviewPending}
              onFilterChange={subscription.setFilterDraft}
              onFilterPreview={() => void subscription.previewActiveFilter()}
              onFilterSave={() => void subscription.saveActiveFilter()}
            />
          ) : (
            <Empty className="h-full p-5">
              <EmptyHeader>
                <EmptyDescription>
                  选择“新增订阅”开始配置
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    ),
    status: (
      <WorkspaceStatusBar>
        <StatusDot
          tone={
            subscription.unavailable
              ? "error"
              : subscription.dirty
                ? "warn"
                : "ok"
          }
        />
        <span className="truncate text-muted-foreground">
          {subscription.unavailable
            ? "configd 不可用"
            : subscription.dirty
              ? "订阅设置有未保存更改"
              : subscription.busy === "load"
                ? "正在读取订阅"
                : "订阅设置已保存"}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          订阅地址仅在编辑区显示原文
        </span>
      </WorkspaceStatusBar>
    ),
    deleteDialog: (
      <AlertDialog
        open={Boolean(subscription.pendingDelete)}
        onOpenChange={(open) => !open && subscription.cancelDelete()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除订阅</AlertDialogTitle>
            <AlertDialogDescription>
              确认删除 {subscription.pendingDelete?.name}？已生成的 Provider
              文件会保留。
              {!subscription.newDraft &&
                subscription.pendingDelete?.id === subscription.activeId &&
                subscription.dirty &&
                " 当前未保存的编辑也会丢失。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void subscription.removePending()}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
    addDialog: null,
  })
}
