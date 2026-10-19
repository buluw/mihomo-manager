import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function ResourceListHeader({ children }: { children: ReactNode }) {
  return <div className="flex min-h-17 shrink-0 items-center gap-2 px-4 py-3 md:px-3">{children}</div>
}

export function ResourceListGroup({ children }: { children: ReactNode }) {
  return <div data-slot="resource-list-group" className="flex shrink-0 flex-col gap-1 empty:hidden">{children}</div>
}

export function ResourceListSurface({ selected, accent = "primary", children }: { selected?: boolean; accent?: "info" | "primary"; children: ReactNode }) {
  return <div data-slot="resource-list-row" data-selected={selected || undefined} className={cn(
    "group relative min-w-0 overflow-hidden rounded-md",
    selected && "bg-accent after:pointer-events-none after:absolute after:inset-y-0 after:left-0 after:w-[3px]",
    selected && (accent === "primary" ? "after:bg-primary" : "after:bg-status-info"),
  )}>{children}</div>
}

export function ResourceListRow({ name, metadata, status, extra, actions, actionCount = 1, selected, accent = "primary", disabled, description, onSelect }: {
  name: ReactNode
  metadata?: ReactNode
  status?: ReactNode
  extra?: ReactNode
  actions?: ReactNode
  actionCount?: 1 | 2
  selected?: boolean
  accent?: "info" | "primary"
  disabled?: boolean
  description?: string
  onSelect: () => void
}) {
  return <ResourceListSurface selected={selected} accent={accent}>
    <Button variant="ghost" disabled={disabled} aria-pressed={selected} aria-description={description}
      className="grid h-auto min-h-16 w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-1 px-3 py-3 text-left whitespace-normal" onClick={onSelect}>
      <span className={cn("flex min-w-0 items-center justify-between gap-2", actions && (actionCount === 2 ? "pr-22 md:pr-14" : "pr-11 md:pr-8"))}>
        <span className="flex min-w-0 flex-col gap-1">
          <span data-slot="resource-list-name" className="truncate text-sm leading-[21px] font-medium">{name}</span>
          {metadata && <span data-slot="resource-list-meta" className="truncate text-xs leading-[18px] font-normal text-muted-foreground">{metadata}</span>}
        </span>
        {status && <span data-slot="resource-list-status" className="shrink-0 text-xs font-normal text-muted-foreground">{status}</span>}
      </span>
      {extra && <span data-slot="resource-list-extra" className="mt-1 flex min-w-0 flex-col gap-2 text-xs leading-[18px] font-normal text-muted-foreground">{extra}</span>}
    </Button>
    {actions && <div className={cn("absolute right-1 flex items-center gap-0.5", extra ? "top-3.5" : "top-1/2 -translate-y-1/2")}>{actions}</div>}
  </ResourceListSurface>
}
