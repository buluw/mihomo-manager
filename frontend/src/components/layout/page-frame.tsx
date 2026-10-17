import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

type StandardPageProps = {
  children: ReactNode
  horizontalOverflow?: "allow" | "clip"
}

export function StandardPage({ children, horizontalOverflow = "allow" }: StandardPageProps) {
  return (
    <div
      data-page-scroll
      className={cn(
        "h-full overflow-y-auto",
        horizontalOverflow === "clip" && "overflow-x-hidden"
      )}
    >
      <div className="flex min-h-full flex-col gap-4 p-5">{children}</div>
    </div>
  )
}

export function WorkspacePage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="h-full min-h-0 md:p-4">
      <div className={cn("grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_28px] overflow-hidden bg-background md:grid-rows-[52px_minmax(0,1fr)_28px] md:rounded-md md:border", className)}>
        {children}
      </div>
    </div>
  )
}
