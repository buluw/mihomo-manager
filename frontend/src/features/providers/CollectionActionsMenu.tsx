import { MobileSheetContent } from "@/components/patterns/mobile-sheet"
import { Fragment, useRef, useState } from "react"
import { MoreHorizontal, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetDescription, SheetTrigger } from "@/components/ui/sheet"

type CollectionAction = {
  label: string
  icon?: LucideIcon
  disabled?: boolean
  destructive?: boolean
  checked?: boolean
  onSelect: () => void
}

export function CollectionActionsMenu({ groups, description }: { groups: CollectionAction[][]; description?: string }) {
  const [open, setOpen] = useState(false)
  const pendingAction = useRef<(() => void) | null>(null)
  return <>
    <Sheet open={open} onOpenChange={setOpen} onOpenChangeComplete={next => {
      if (next) return
      const action = pendingAction.current
      pendingAction.current = null
      action?.()
    }}>
      <SheetTrigger render={<Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="集合更多操作" />}><MoreHorizontal /></SheetTrigger>
      <MobileSheetContent title="集合更多操作">
          {groups.map((group, index) => <Fragment key={index}>
            {index > 0 && <div className="px-4 py-2"><Separator /></div>}
            {group.map(({ icon: Icon, ...action }) => action.checked !== undefined
              ? <label key={action.label} className="flex min-h-13 items-center gap-3 rounded-lg px-4 py-2.5 text-sm">
                {Icon && <Icon className="size-5" />}<span className="min-w-0 flex-1 wrap-anywhere">{action.label}</span>
                <Checkbox checked={action.checked} disabled={action.disabled} onCheckedChange={() => { pendingAction.current = action.onSelect; setOpen(false) }} />
              </label>
              : <Button key={action.label} variant={action.destructive ? "destructive" : "ghost"} disabled={action.disabled} className="h-auto min-h-13 w-full justify-start gap-3 rounded-lg px-4 py-2.5 text-sm whitespace-normal has-data-[icon=inline-start]:pl-4 max-md:min-h-13 max-md:text-sm" onClick={() => { pendingAction.current = action.onSelect; setOpen(false) }}>
                {Icon && <Icon data-icon="inline-start" />}<span className="min-w-0 flex-1 text-left wrap-anywhere">{action.label}</span>
              </Button>)}
          </Fragment>)}
          {description && <SheetDescription className="px-4 py-2">{description}</SheetDescription>}
      </MobileSheetContent>
    </Sheet>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="hidden md:inline-flex @min-[800px]/collection:hidden" aria-label="集合更多操作" />}><MoreHorizontal /></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {groups.map((group, index) => <Fragment key={index}>
          {index > 0 && <DropdownMenuSeparator />}
          <DropdownMenuGroup>{group.map(({ icon: Icon, ...action }) => action.checked !== undefined
            ? <DropdownMenuCheckboxItem key={action.label} checked={action.checked} disabled={action.disabled} onCheckedChange={action.onSelect}>{action.label}</DropdownMenuCheckboxItem>
            : <DropdownMenuItem key={action.label} variant={action.destructive ? "destructive" : "default"} disabled={action.disabled} onClick={action.onSelect}>{Icon && <Icon />}{action.label}</DropdownMenuItem>)}</DropdownMenuGroup>
        </Fragment>)}
        {description && <p className="max-w-64 px-2 py-1 text-xs text-muted-foreground">{description}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  </>
}
