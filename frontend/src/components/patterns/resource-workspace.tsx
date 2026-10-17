import { useEffect, useState, type ReactNode } from "react"
import { PanelLeftOpen } from "lucide-react"
import { cn } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

const DESKTOP_RESOURCES_QUERY = "(min-width: 48rem)"

const mobileSheetWidthStyles = {
  304: "w-[min(88vw,304px)] p-0",
  320: "w-[min(88vw,320px)] p-0",
} as const

function useDesktopResources() {
  const [desktop, setDesktop] = useState(() =>
    window.matchMedia(DESKTOP_RESOURCES_QUERY).matches
  )

  useEffect(() => {
    const query = window.matchMedia(DESKTOP_RESOURCES_QUERY)
    const sync = () => setDesktop(query.matches)
    sync()
    query.addEventListener("change", sync)
    return () => query.removeEventListener("change", sync)
  }, [])

  return desktop
}

export function ResourceWorkspace({
  idPrefix,
  resources,
  mobileResources,
  mobileListOpen,
  onMobileListOpenChange,
  onDesktop,
  resizeHandleLabel,
  mobileTriggerLabel,
  mobileSheetWidth,
  mobileTitle,
  mobileDescription,
  mobileNavigation,
  children,
}: {
  idPrefix: "config-center" | "collection"
  resources: ReactNode
  mobileResources: ReactNode
  mobileListOpen?: boolean
  onMobileListOpenChange?: (open: boolean) => void
  onDesktop?: () => void
  resizeHandleLabel: string
  mobileTriggerLabel?: string
  mobileSheetWidth?: keyof typeof mobileSheetWidthStyles
  mobileTitle?: ReactNode
  mobileDescription?: ReactNode
  mobileNavigation?: { detailOpen: boolean; header: ReactNode }
  children: (mobileResourceSheet: ReactNode) => ReactNode
}) {
  const desktopResources = useDesktopResources()

  useEffect(() => {
    if (desktopResources) onDesktop?.()
  }, [desktopResources, onDesktop])

  const mobileResourceSheet = mobileNavigation ? null : (
    <Sheet open={mobileListOpen} onOpenChange={onMobileListOpenChange}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label={mobileTriggerLabel}
          />
        }
      >
        <PanelLeftOpen />
      </SheetTrigger>
      <SheetContent
        side="left"
        className={mobileSheetWidthStyles[mobileSheetWidth ?? 320]}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{mobileTitle}</SheetTitle>
          <SheetDescription>{mobileDescription}</SheetDescription>
        </SheetHeader>
        {mobileResources}
      </SheetContent>
    </Sheet>
  )

  return (<>
    {mobileNavigation && <div className={cn("min-h-0 min-w-0 flex-1 md:hidden", mobileNavigation.detailOpen && "hidden")}>{mobileResources}</div>}
    <div className={cn("flex min-h-0 min-w-0 flex-1", mobileNavigation && !mobileNavigation.detailOpen && "max-md:hidden")}>
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-0 min-w-0 flex-1"
    >
      {desktopResources && (
        <>
          <ResizablePanel
            id={`${idPrefix}-resources`}
            defaultSize={248}
            minSize={224}
            maxSize={304}
            groupResizeBehavior="preserve-pixel-size"
            className="min-h-0 min-w-0"
            style={{ overflow: "hidden" }}
          >
            <aside className="h-full min-h-0">{resources}</aside>
          </ResizablePanel>
          <ResizableHandle
            id={`${idPrefix}-resize-handle`}
            aria-label={resizeHandleLabel}
            disableDoubleClick
          />
        </>
      )}
      <ResizablePanel
        id={`${idPrefix}-editor`}
        minSize={0}
        className="min-h-0 min-w-0"
        style={{ overflow: "hidden" }}
      >
        <div className="flex h-full min-h-0 flex-col">
          {mobileNavigation?.header}
          <div className="min-h-0 flex-1">{children(mobileResourceSheet)}</div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
    </div>
    </>
  )
}
