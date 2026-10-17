import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export function ResourceListHeader({ children }: { children: ReactNode }) {
  return <div className="flex min-h-17 shrink-0 items-center gap-2 px-4 py-3 md:px-3">{children}</div>
}

export function ResourceListGroup({ children }: { children: ReactNode }) {
  return <div data-slot="resource-list-group" className="shrink-0 overflow-hidden rounded-[10px] border bg-card empty:hidden [&>[data-slot=resource-list-row]:first-child>[data-slot=separator]]:hidden">{children}</div>
}

export function ResourceListRow({ name, metadata, extra, actions, actionCount = 1, selected, marked, mobileMarker = false, disabled, description, onSelect }: {
  name: ReactNode
  metadata?: ReactNode
  extra?: ReactNode
  actions?: ReactNode
  actionCount?: 1 | 2
  selected?: boolean
  marked?: boolean
  mobileMarker?: boolean
  disabled?: boolean
  description?: string
  onSelect: () => void
}) {
  return <div data-slot="resource-list-row" data-selected={selected || undefined} data-marked={marked || undefined} className={cn(
    "group relative min-w-0",
    selected && "md:bg-accent",
    marked && (mobileMarker
      ? "after:pointer-events-none after:absolute after:inset-y-0 after:left-0 after:w-0.5 after:bg-mode-rule"
      : "md:after:pointer-events-none md:after:absolute md:after:inset-y-0 md:after:left-0 md:after:w-0.5 md:after:bg-mode-rule"),
  )}>
    <Separator className="absolute inset-x-3 top-0 w-auto data-horizontal:w-auto" />
    <Button variant="ghost" disabled={disabled} aria-pressed={selected} aria-description={description}
      className="grid h-auto min-h-[74px] w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-1 rounded-none border-0 px-3 py-3.5 text-left whitespace-normal max-md:min-h-[74px]" onClick={onSelect}>
      <span className={cn("flex min-w-0 flex-col gap-1", actions && (actionCount === 2 ? "min-h-11 pr-22 md:pr-14" : "pr-11 md:pr-8"))}>
        <span data-slot="resource-list-name" className="text-sm leading-[21px] font-medium wrap-anywhere">{name}</span>
        {metadata && <span data-slot="resource-list-meta" className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-[18px] font-normal text-muted-foreground wrap-anywhere">{metadata}</span>}
      </span>
      {extra && <span data-slot="resource-list-extra" className="mt-1 flex min-w-0 flex-col gap-2 text-xs leading-[18px] font-normal text-muted-foreground">{extra}</span>}
    </Button>
    {actions && <div className={cn("absolute right-1 flex items-center gap-0.5", extra ? "top-3.5" : "top-1/2 -translate-y-1/2")}>{actions}</div>}
  </div>
}
