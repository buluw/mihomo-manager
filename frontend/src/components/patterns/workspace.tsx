import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { cn } from "@/lib/utils"

type ToolbarVariant = "tabs" | "resource-tabs" | "editor" | "resource-editor"

const toolbarStyles: Record<ToolbarVariant, string> = {
  tabs: "min-h-13 border-b px-1 md:h-13 md:px-4",
  "resource-tabs": "min-h-11 shrink-0 border-b px-4 md:px-3",
  editor: "min-h-15 shrink-0 gap-2 border-b bg-card/35 px-2 py-2 md:h-12 md:min-h-12 md:px-3 md:py-0",
  "resource-editor": "min-h-17 shrink-0 gap-2 border-b bg-card/35 px-4 py-3 md:h-12 md:min-h-12 md:px-3 md:py-0",
}

export function WorkspaceToolbar({
  variant,
  children,
  className,
}: {
  variant: ToolbarVariant
  children: ReactNode
  className?: string
}) {
  return <div className={cn("flex min-w-0 items-center [&~[data-slot=alert]]:border-t-0", toolbarStyles[variant], className)}>{children}</div>
}

export function WorkspaceBody({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 overflow-hidden">{children}</div>
}

export function WorkspaceCategoryTabs({ value, onValueChange, items, disabled = false, className, layout = "page", listSpacing = "compact" }: {
  value: string
  onValueChange: (value: string) => void
  items: ReadonlyArray<{ value: string; label: string; icon: LucideIcon }>
  disabled?: boolean
  className?: string
  layout?: "page" | "list"
  listSpacing?: "compact" | "comfortable"
}) {
  return <Tabs value={value} onValueChange={next => next && onValueChange(next)} className={cn("min-w-0 flex-1 md:flex-none", layout === "list" && "h-full", className)}>
    <TabsList variant="line" className={cn("grid w-full auto-cols-fr grid-flow-col gap-0 p-0 max-md:min-h-11", layout === "list" ? "group-data-horizontal/tabs:h-full" : "group-data-horizontal/tabs:h-11 md:w-auto", layout === "list" && listSpacing === "comfortable" && "gap-1 md:gap-2")}>
      {items.map(({ value: itemValue, label, icon: Icon }) => <TabsTrigger key={itemValue} value={itemValue} disabled={disabled}
        className={cn("min-w-0 gap-2 text-sm group-data-horizontal/tabs:after:bottom-0", layout === "list" ? "h-full px-1" : "h-11 px-3 md:w-32", layout === "list" && listSpacing === "comfortable" && "px-2 md:px-3")}>
        {layout === "page" && <Icon data-icon="inline-start" />}{label}
      </TabsTrigger>)}
    </TabsList>
  </Tabs>
}

export function WorkspaceStatusBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-7 min-w-0 items-center gap-3 border-t px-3 text-xs">
      {children}
    </div>
  )
}
