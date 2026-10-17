import { useEffect, useState, type ComponentProps, type ReactNode } from "react"

import { SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

export function useMobileSheetViewport(open: boolean, ratio = 0.85) {
  const [viewportSize, setViewportSize] = useState<{ height: number; bottom: number } | null>(null)
  useEffect(() => {
    if (!open || !window.visualViewport) return
    const viewport = window.visualViewport
    const update = () => setViewportSize({ height: viewport.height, bottom: Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) })
    update()
    viewport.addEventListener("resize", update)
    viewport.addEventListener("scroll", update)
    window.addEventListener("resize", update)
    return () => {
      viewport.removeEventListener("resize", update)
      viewport.removeEventListener("scroll", update)
      window.removeEventListener("resize", update)
    }
  }, [open])
  return open && viewportSize ? { maxHeight: viewportSize.height * ratio, bottom: viewportSize.bottom } : undefined
}

export function MobileSheetContent({ title, description, children, footer, bodyClassName, className, ...props }: Omit<ComponentProps<typeof SheetContent>, "title" | "side"> & {
  title: ReactNode
  description?: ReactNode
  footer?: ReactNode
  bodyClassName?: string
}) {
  return <SheetContent {...props} side="bottom" className={cn("max-h-[85dvh] overflow-hidden rounded-t-[20px] px-4 pt-2.5", className)}>
    <SheetHeader className="min-h-13 shrink-0 justify-center px-4 py-2 pr-12 max-md:pr-12">
      <SheetTitle className="text-[15px]">{title}</SheetTitle>
      {description && <SheetDescription>{description}</SheetDescription>}
    </SheetHeader>
    <div className={cn("min-h-0 overflow-y-auto overscroll-contain pb-[max(1rem,env(safe-area-inset-bottom))]", bodyClassName)}>{children}</div>
    {footer && <SheetFooter className="shrink-0 flex-row items-center justify-between px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</SheetFooter>}
  </SheetContent>
}
