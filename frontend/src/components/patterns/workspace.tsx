import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { cn } from "@/lib/utils"

type ToolbarVariant = "tabs" | "resource-tabs" | "editor" | "resource-editor"

const toolbarStyles: Record<ToolbarVariant, string> = {
  tabs: "min-h-13 border-b px-1 md:h-13 md:px-4",
  "resource-tabs": "min-h-11 shrink-0 border-b px-4 md:px-3",
  editor: "min-h-15 shrink-0 gap-2 border-b bg-card/35 px-2 py-2 md:min-h-12 md:px-3",
  "resource-editor": "min-h-17 shrink-0 gap-2 border-b bg-card/35 px-4 py-3 md:min-h-12 md:px-3 md:py-2",
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
  return <div className={cn("flex min-w-0 items-center", toolbarStyles[variant], className)}>{children}</div>
}

export function WorkspaceBody({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 overflow-hidden">{children}</div>
}

export function WorkspaceCategoryTabs({ value, onValueChange, items, disabled = false, className }: {
  value: string
  onValueChange: (value: string) => void
  items: ReadonlyArray<{ value: string; label: string; icon: LucideIcon }>
  disabled?: boolean
  className?: string
}) {
  return <Tabs value={value} onValueChange={next => next && onValueChange(next)} className={cn("min-w-0 flex-1 md:flex-none", className)}>
    <TabsList variant="line" className="grid w-full auto-cols-fr grid-flow-col gap-0 p-0 group-data-horizontal/tabs:h-11 max-md:min-h-11 md:w-auto">
      {items.map(({ value: itemValue, label, icon: Icon }) => <TabsTrigger key={itemValue} value={itemValue} disabled={disabled}
        className="h-11 min-w-0 gap-2 px-3 text-sm group-data-horizontal/tabs:after:bottom-0 md:w-32">
        <Icon data-icon="inline-start" />{label}
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
