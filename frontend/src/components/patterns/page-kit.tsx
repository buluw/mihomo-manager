import type { ReactNode } from "react"

import { Empty } from "@/components/ui/empty"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

type PanelDesktopSpan = 4 | 5 | 7 | 8

const panelDesktopSpans: Record<PanelDesktopSpan, string> = {
  4: "lg:col-span-4",
  5: "lg:col-span-5",
  7: "lg:col-span-7",
  8: "lg:col-span-8",
}

export function Panel({
  title,
  meta,
  actions,
  children,
  desktopSpan,
  headerClassName,
}: {
  title: string
  meta?: string
  actions?: ReactNode
  children: ReactNode
  desktopSpan?: PanelDesktopSpan
  headerClassName?: string
}) {
  return (
    <section
      className={cn(
        "min-w-0 overflow-hidden rounded-md border bg-background",
        desktopSpan && panelDesktopSpans[desktopSpan]
      )}
    >
      <div className={cn("flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5", headerClassName)}>
        <h2 className="shrink-0 text-sm font-semibold">{title}</h2>
        {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  ariaLabel: string
}) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(nextValue) => {
        if (nextValue[0]) onChange(nextValue[0] as T)
      }}
      spacing={0}
      className="inline-flex h-7 max-md:h-[50px] items-center rounded-md border bg-muted/40 p-0.5"
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className={cn(
            "h-6 min-w-0 rounded-[4px] px-2.5 text-xs font-normal text-muted-foreground shadow-none transition-colors hover:bg-transparent hover:text-muted-foreground",
            value === option.value && "bg-background font-medium text-foreground shadow-xs"
          )}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

export function TableHeader({
  children,
  layoutClassName,
}: {
  children: ReactNode
  layoutClassName: string
}) {
  return (
    <div
      className={cn(
        "grid h-9 min-w-0 items-center gap-2 border-b bg-muted/35 px-3 text-xs font-medium text-muted-foreground",
        layoutClassName
      )}
    >
      {children}
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <Empty className="h-32 flex-none gap-0 rounded-none p-0 text-left text-sm text-wrap text-muted-foreground">
      {children}
    </Empty>
  )
}

export function StatusDot({
  tone = "ok",
}: {
  tone?: "ok" | "warn" | "error" | "muted"
}) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone === "ok" && "bg-status-success",
        tone === "warn" && "bg-status-warning",
        tone === "error" && "bg-destructive",
        tone === "muted" && "bg-muted-foreground/50"
      )}
    />
  )
}
