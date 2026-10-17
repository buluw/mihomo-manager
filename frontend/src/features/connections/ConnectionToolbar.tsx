import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  sortableKeyboardCoordinates,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  CircleAlert,
  GripVertical,
  RotateCcw,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

import { moveConnectionColumn } from "./connectionLogic"
import {
  connectionColumnDefinitions,
  type ConnectionColumnKey,
} from "./connectionViewModel"

type ConnectionToolbarProps = {
  query: string
  onQueryChange: (query: string) => void
  visibleCount: number
  totalCount: number
  columnOrder: ConnectionColumnKey[]
  columnVisibility: Record<ConnectionColumnKey, boolean>
  onColumnOrderChange: (order: ConnectionColumnKey[]) => void
  onColumnVisibilityChange: (
    columnKey: ConnectionColumnKey,
    visible: boolean
  ) => void
  onResetColumns: () => void
  closeAllOpen: boolean
  onCloseAllOpenChange: (open: boolean) => void
  closingAll: boolean
  onCloseAll: () => void
}

export function ConnectionToolbar({
  query,
  onQueryChange,
  visibleCount,
  totalCount,
  columnOrder,
  columnVisibility,
  onColumnOrderChange,
  onColumnVisibilityChange,
  onResetColumns,
  closeAllOpen,
  onCloseAllOpenChange,
  closingAll,
  onCloseAll,
}: ConnectionToolbarProps) {
  const columnSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleColumnDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    onColumnOrderChange(
      moveConnectionColumn(
        columnOrder,
        active.id as ConnectionColumnKey,
        over.id as ConnectionColumnKey
      )
    )
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md border p-3 xl:h-12 xl:grid-cols-[auto_1fr_320px_auto] xl:items-center xl:rounded-none xl:border-0 xl:border-b xl:p-0 xl:px-3">
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="truncate text-sm font-semibold">活动连接</h2>
        <span className="shrink-0 text-xs text-muted-foreground">
          {visibleCount} / {totalCount} 条
        </span>
      </div>
      <InputGroup className="col-span-2 row-start-2 w-full xl:col-span-1 xl:col-start-3 xl:row-start-1">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索连接"
          aria-label="搜索活动连接"
        />
        {query && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              onClick={() => onQueryChange("")}
              aria-label="清空搜索"
            >
              <X />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      <div className="col-start-2 row-start-1 flex shrink-0 items-center gap-2 xl:col-start-4">
        <Dialog>
          <DialogTrigger
            render={<Button variant="outline" size="sm" aria-label="列设置" />}
          >
            <Settings2 data-icon="inline-start" />
            <span className="hidden sm:inline">列设置</span>
          </DialogTrigger>
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-hidden sm:max-w-md">
            <DialogHeader>
              <DialogTitle>连接列设置</DialogTitle>
              <DialogDescription>
                拖动调整显示顺序，开关控制桌面列和移动端卡片字段。
              </DialogDescription>
            </DialogHeader>
            <DndContext
              sensors={columnSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleColumnDragEnd}
            >
              <SortableContext
                items={columnOrder}
                strategy={verticalListSortingStrategy}
              >
                <div className="max-h-[min(440px,55dvh)] overflow-y-auto rounded-md border">
                  {columnOrder.map((columnKey) => (
                    <SortableColumnSetting
                      key={columnKey}
                      columnKey={columnKey}
                      checked={columnVisibility[columnKey]}
                      onCheckedChange={(checked) =>
                        onColumnVisibilityChange(columnKey, checked)
                      }
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            <DialogFooter>
              <Button variant="outline" onClick={onResetColumns}>
                <RotateCcw data-icon="inline-start" />
                恢复默认
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AlertDialog
          open={closeAllOpen}
          onOpenChange={(open) => {
            if (!closingAll) onCloseAllOpenChange(open)
          }}
        >
          <AlertDialogTrigger
            render={
              <Button
                variant="destructive"
                size="sm"
                disabled={totalCount === 0 || closingAll}
              />
            }
          >
            <Trash2 data-icon="inline-start" />
            批量关闭
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>关闭全部连接</AlertDialogTitle>
              <AlertDialogDescription>
                将关闭当前 {totalCount} 条活动连接，可能中断正在传输的数据。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={closingAll}>取消</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={closingAll || totalCount === 0}
                onClick={onCloseAll}
              >
                <CircleAlert data-icon="inline-start" />
                确认批量关闭
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}

function SortableColumnSetting({
  columnKey,
  checked,
  onCheckedChange,
}: {
  columnKey: ConnectionColumnKey
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: columnKey })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "grid h-11 grid-cols-[32px_minmax(0,1fr)_32px] items-center gap-2 border-b px-2 last:border-b-0",
        isDragging && "relative z-10 bg-accent opacity-80 shadow-sm"
      )}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon"
        className="cursor-grab active:cursor-grabbing"
        aria-label={`拖动${connectionColumnDefinitions[columnKey].label}列`}
        {...attributes}
        {...listeners}
      >
        <GripVertical />
      </Button>
      <span
        className={cn(
          "truncate text-sm",
          !checked && "text-muted-foreground"
        )}
      >
        {connectionColumnDefinitions[columnKey].label}
      </span>
      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={`显示${connectionColumnDefinitions[columnKey].label}列`}
      />
    </div>
  )
}
