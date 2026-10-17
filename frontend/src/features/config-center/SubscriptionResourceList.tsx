import type { ConfigSubscription } from "@/api/configClient"
import { ResourceListGroup, ResourceListHeader, ResourceListRow } from "@/components/patterns/resource-list"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MoreHorizontal, Plus, RefreshCw, Trash2 } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import {
  formatSubscriptionBytes,
  subscriptionDomain,
  subscriptionRelativeTime,
  subscriptionUpdateControls,
  subscriptionUsage,
} from "./subscriptionWorkspaceState"
import type { useSubscriptionWorkspace } from "./useSubscriptionWorkspace"

type SubscriptionWorkspaceState = ReturnType<
  typeof useSubscriptionWorkspace
>

function RowMenu({
  label,
  onDelete,
  disabled = false,
}: {
  label: string
  onDelete?: () => void
  disabled?: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-50 group-focus-within:opacity-100 group-hover:opacity-100"
            aria-label={label}
            disabled={disabled}
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 data-icon="inline-start" />
            删除
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SubscriptionListRow({
  item,
  now,
  active,
  dirty,
  failed,
  selectionDisabled = false,
  actionDisabled = false,
  refreshDisabled = false,
  refreshReason,
  label,
  onSelect,
  onDelete,
  onUpdate,
  updating,
}: {
  item: ConfigSubscription
  now: number
  active: boolean
  dirty: boolean
  failed: boolean
  selectionDisabled?: boolean
  actionDisabled?: boolean
  refreshDisabled?: boolean
  refreshReason?: string | null
  label: string
  onSelect: () => void
  onDelete: () => void
  onUpdate: () => void
  updating: boolean
}) {
  const { used, progress } = subscriptionUsage(item)
  const showProgress = progress != null
  return (
    <ResourceListRow name={item.name} selected={active} marked={active} disabled={selectionDisabled} onSelect={onSelect} actionCount={2}
      metadata={<><span>{subscriptionDomain(item.url)}</span>{dirty && <span className="text-status-warning">未保存</span>}{failed && <span className="text-destructive">更新失败</span>}</>}
      extra={<>
        {used != null && <span className="flex justify-between gap-2"><span>{formatSubscriptionBytes(used)}{item.totalBytes != null ? ` / ${formatSubscriptionBytes(item.totalBytes)}` : ""}</span>{showProgress && <span>{Math.round(progress)}%</span>}</span>}
        {showProgress && <span className="h-1 overflow-hidden rounded-full bg-muted-foreground/40" role="progressbar" aria-label="流量使用" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
          <span className="block h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
        </span>}
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Tooltip><TooltipTrigger render={<span />}>{subscriptionRelativeTime(item.lastUpdatedAt, now)}</TooltipTrigger><TooltipContent>{exactTime(item.lastUpdatedAt)}</TooltipContent></Tooltip>
          {item.expiresAt && <Tooltip><TooltipTrigger render={<span />}>到期 {shortDate(item.expiresAt)}</TooltipTrigger><TooltipContent>{exactTime(item.expiresAt)}</TooltipContent></Tooltip>}
        </span>
      </>}
      actions={<>
        <Tooltip><TooltipTrigger render={<span className="inline-flex" />}><Button
          variant="ghost"
          size="icon-xs"
          aria-label={`更新 ${item.name}`}
          aria-busy={updating}
          className="disabled:aria-busy:opacity-100"
          disabled={refreshDisabled || updating}
          onClick={onUpdate}
        >
          {updating ? <Spinner /> : <RefreshCw />}
        </Button></TooltipTrigger><TooltipContent>{refreshReason ?? "更新当前订阅"}</TooltipContent></Tooltip>
        <RowMenu label={label} onDelete={onDelete} disabled={actionDisabled || updating} />
      </>}
    />
  )
}

function exactTime(value: string | null) {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "时间不可用" : date.toLocaleString()
}

function shortDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "日期不可用" : date.toLocaleDateString()
}

export function SubscriptionResourceList({
  workspace: subscription,
  count,
  onAdd,
  onSelected,
  mobileTitle,
}: {
  workspace: SubscriptionWorkspaceState
  count: number
  onAdd: () => void
  onSelected: () => void
  mobileTitle?: ReactNode
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]">
      {mobileTitle && <ResourceListHeader>
        {mobileTitle}
        <span className="text-xs text-muted-foreground tabular-nums">
          {count}
        </span>
        <Button
          size="sm"
          className="ml-auto h-9"
          disabled={subscription.unavailable || subscription.writeLocked}
          onClick={onAdd}
        >
          <Plus data-icon="inline-start" />
          新增订阅
        </Button>
      </ResourceListHeader>}
      <div className="flex min-h-0 flex-col overflow-y-auto px-4 pt-1 pb-5 md:px-3">
        <ResourceListGroup>
        {subscription.newDraft && (
          <SubscriptionListRow
            item={{
              id: "draft",
              name: subscription.form.name || "新订阅",
              url: subscription.form.url ?? "",
              configFileName: null,
            extractProvider: false,
            providerName: "",
            providerNameMode: "follow",
            providerSha256: null,
            mergeIntoConfig: false,
              configName: "",
              groupNames: [],
              binding: null,
              autoUpdate: false,
              intervalMinutes: 60,
              status: "idle",
              nodeCount: 0,
              lastAttemptAt: null,
              lastUpdatedAt: null,
              nextUpdateAt: null,
              uploadBytes: null,
              downloadBytes: null,
              totalBytes: null,
              expiresAt: null,
              urlConfigured: false,
              filterSettings: { version: 0, enabled: false, rules: [] },
            }}
            now={now}
            active
            dirty
            failed={false}
            selectionDisabled={subscription.busy !== null}
            actionDisabled={subscription.writeLocked}
            refreshDisabled
            label="新订阅操作"
            onSelect={onSelected}
            onDelete={() => void subscription.discardDraft()}
            onUpdate={() => undefined}
            updating={false}
          />
        )}
        {subscription.items.map((item) => {
          const controls = subscriptionUpdateControls({
            busy: subscription.busy,
            updatingId: subscription.updatingId,
            itemId: item.id,
            activeId: subscription.activeId,
            dirty: subscription.dirty,
          })
          return <SubscriptionListRow
            key={item.id}
            item={item}
            now={now}
            active={!subscription.newDraft && item.id === subscription.activeId}
            dirty={
              !subscription.newDraft &&
              item.id === subscription.activeId &&
              subscription.dirty
            }
            failed={item.status === "error"}
            selectionDisabled={!controls.canSelect}
            actionDisabled={controls.writeLocked}
            refreshDisabled={!controls.canRefresh}
            refreshReason={controls.reason}
            label={`${item.name} 操作`}
            onSelect={() =>
              void subscription.requestSelection(item).then((selected) => {
                if (selected) onSelected()
              })
            }
            onDelete={() => subscription.requestDelete(item)}
            onUpdate={() => void subscription.updateItem(item)}
            updating={subscription.updatingId === item.id}
          />
        })}
        </ResourceListGroup>
        {!subscription.busy &&
          !subscription.unavailable &&
          subscription.items.length === 0 &&
          !subscription.newDraft && (
            <Empty className="min-h-24 flex-none gap-0 p-0">
              <EmptyHeader>
                <EmptyDescription>还没有订阅</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
      </div>
    </div>
  )
}
