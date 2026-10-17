import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { ArrowDown, ArrowUp, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { Json } from "@/shared/types"

import {
  connectionColumnDefinitions,
  connectionColumnWidth,
  connectionColumnValue,
  connectionTableWidth,
  connectionTarget,
  MAX_CONNECTION_COLUMN_WIDTH,
  type ConnectionColumnKey,
  type ConnectionColumnWidths,
  type ConnectionRate,
  type ConnectionSortDirection,
  type ConnectionSortKey,
} from "./connectionViewModel"

type ConnectionViewsProps = {
  connections: Json[]
  hasConnections: boolean
  columns: ConnectionColumnKey[]
  columnWidths: ConnectionColumnWidths
  rates: Record<string, ConnectionRate>
  selectedId: string | null
  closingIds: ReadonlySet<string>
  sortKey: ConnectionSortKey
  sortDirection: ConnectionSortDirection
  onSelect: (id: string) => void
  onClose: (connection: Json) => void
  onSort: (key: ConnectionSortKey) => void
  onColumnWidthChange: (columnKey: ConnectionColumnKey, width: number) => void
}

const numericColumns: ConnectionColumnKey[] = [
  "source",
  "sourcePort",
  "upload",
  "download",
  "downloadRate",
  "uploadRate",
  "age",
]

const wrappingColumns: ConnectionColumnKey[] = [
  "target",
  "rule",
  "policy",
  "sni",
]

export function ConnectionViews({
  connections,
  hasConnections,
  columns,
  columnWidths,
  rates,
  selectedId,
  closingIds,
  sortKey,
  sortDirection,
  onSelect,
  onClose,
  onSort,
  onColumnWidthChange,
}: ConnectionViewsProps) {
  return (
    <>
      <div className="mt-2 flex flex-col gap-2 xl:hidden">
        {connections.map((connection) => {
          const id = String(connection.id)
          return (
            <article
              key={id}
              onClick={() => onSelect(id)}
              className={cn(
                "rounded-md border bg-background p-3 transition-colors",
                selectedId === id && "border-primary/45 bg-accent/50"
              )}
            >
              {columns.length > 0 && (
                <dl className="grid grid-cols-2 md:grid-cols-3">
                  {columns.map((columnKey, columnIndex) => (
                    <ConnectionCardField
                      key={columnKey}
                      className={connectionCardFieldClass(
                        columnIndex,
                        columns.length
                      )}
                      connection={connection}
                      columnKey={columnKey}
                      rates={rates}
                      closing={closingIds.has(id)}
                      onClose={() => onClose(connection)}
                    />
                  ))}
                </dl>
              )}
            </article>
          )
        })}
        {connections.length === 0 && (
          <ConnectionEmpty hasConnections={hasConnections} className="h-40 border" />
        )}
      </div>

      <div className="hidden xl:block">
        <ConnectionDesktopTable
          connections={connections}
          hasConnections={hasConnections}
          columns={columns}
          columnWidths={columnWidths}
          rates={rates}
          selectedId={selectedId}
          closingIds={closingIds}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSelect={onSelect}
          onClose={onClose}
          onSort={onSort}
          onColumnWidthChange={onColumnWidthChange}
        />
      </div>
    </>
  )
}

function ConnectionDesktopTable({
  connections,
  hasConnections,
  columns,
  columnWidths,
  rates,
  selectedId,
  closingIds,
  sortKey,
  sortDirection,
  onSelect,
  onClose,
  onSort,
  onColumnWidthChange,
}: ConnectionViewsProps) {
  const tableColumns = columns.length > 0 ? columns : [null]
  const tableWidth = connectionTableWidth(columns, columnWidths)

  return (
    <Table
      className="table-fixed"
      style={{
        width: columns.length ? `max(100%, ${tableWidth}px)` : "100%",
        minWidth: columns.length ? tableWidth : undefined,
      }}
    >
      <colgroup>
        {tableColumns.map((columnKey, index) => {
          const width = columnKey
            ? connectionColumnWidth(columnKey, columnWidths)
            : null
          return (
            <col
              key={columnKey || `empty-${index}`}
              style={
                width
                  ? {
                      width,
                      minWidth: width,
                    }
                  : undefined
              }
            />
          )
        })}
      </colgroup>
      <TableHeader className="bg-muted/35">
        <TableRow>
          {columns.length > 0 ? (
            columns.map((columnKey, columnIndex) => (
              <TableHead
                key={columnKey}
                className="relative h-11 md:h-9 px-1 first:pl-3 last:pr-3"
              >
                <ConnectionColumnHeader
                  columnKey={columnKey}
                  activeKey={sortKey}
                  direction={sortDirection}
                  onSort={onSort}
                />
                {columnKey !== "close" && columnIndex < columns.length - 1 && (
                  <ConnectionColumnResizeHandle
                    columnKey={columnKey}
                    width={connectionColumnWidth(columnKey, columnWidths)}
                    onResize={(width) => onColumnWidthChange(columnKey, width)}
                  />
                )}
              </TableHead>
            ))
          ) : (
            <TableHead className="h-9" aria-label="未显示列" />
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {connections.map((connection) => {
          const id = String(connection.id)
          return (
            <TableRow
              key={id}
              className="h-11"
              data-state={selectedId === id ? "selected" : undefined}
              onClick={() => onSelect(id)}
            >
              {columns.length > 0 ? (
                columns.map((columnKey) => (
                  <TableCell
                    key={columnKey}
                    className="px-1 first:pl-3 last:pr-3"
                  >
                    <ConnectionTableValue
                      connection={connection}
                      columnKey={columnKey}
                      rates={rates}
                      closing={closingIds.has(id)}
                      onClose={() => onClose(connection)}
                    />
                  </TableCell>
                ))
              ) : (
                <TableCell className="h-11 p-0" aria-hidden="true" />
              )}
            </TableRow>
          )
        })}
        {connections.length === 0 && (
          <TableRow>
            <TableCell
              colSpan={Math.max(columns.length, 1)}
              className="h-52 p-0"
            >
              <ConnectionEmpty hasConnections={hasConnections} className="h-52" />
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}

function ConnectionCardField({
  connection,
  columnKey,
  rates,
  closing,
  onClose,
  className,
}: {
  connection: Json
  columnKey: ConnectionColumnKey
  rates: Record<string, ConnectionRate>
  closing: boolean
  onClose: () => void
  className?: string
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs text-muted-foreground">
        {connectionColumnDefinitions[columnKey].label}
      </dt>
      <dd
        className={cn(
          "mt-1 min-w-0 text-xs",
          wrappingColumns.includes(columnKey) ? "break-words" : "truncate",
          columnKey === "target" && "text-sm font-medium",
          numericColumns.includes(columnKey) && "font-mono tabular-nums"
        )}
      >
        {columnKey === "close" ? (
          <ConnectionCloseButton
            connection={connection}
            closing={closing}
            onClose={onClose}
          />
        ) : (
          connectionColumnValue(connection, columnKey, rates)
        )}
      </dd>
    </div>
  )
}

function ConnectionColumnHeader({
  columnKey,
  activeKey,
  direction,
  onSort,
}: {
  columnKey: ConnectionColumnKey
  activeKey: ConnectionSortKey
  direction: ConnectionSortDirection
  onSort: (key: ConnectionSortKey) => void
}) {
  const definition = connectionColumnDefinitions[columnKey]
  if (columnKey === "close") return <span aria-label="关闭" />
  if (!definition.sortKey)
    return <span className="text-muted-foreground">{definition.label}</span>

  return (
    <div className="text-muted-foreground">
      <SortHeader
        label={definition.label}
        sortKey={definition.sortKey}
        activeKey={activeKey}
        direction={direction}
        onSort={onSort}
      />
    </div>
  )
}

function ConnectionColumnResizeHandle({
  columnKey,
  width,
  onResize,
}: {
  columnKey: ConnectionColumnKey
  width: number
  onResize: (width: number) => void
}) {
  const drag = useRef<{
    pointerId: number
    startX: number
    startWidth: number
  } | null>(null)
  const [dragging, setDragging] = useState(false)
  const definition = connectionColumnDefinitions[columnKey]

  const finishPointerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    event.stopPropagation()
  }

  return (
    <Tooltip><TooltipTrigger render={    <div
      role="separator"
      aria-label={`调整${definition.label}列宽`}
      aria-orientation="vertical"
      aria-valuemin={definition.minWidth}
      aria-valuemax={MAX_CONNECTION_COLUMN_WIDTH}
      aria-valuenow={width}
      aria-valuetext={`${width} 像素`}
      tabIndex={0}
      data-dragging={dragging || undefined}
      className="absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize touch-none select-none outline-none before:absolute before:inset-y-1 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border before:transition-colors hover:before:bg-primary focus-visible:before:bg-primary data-[dragging=true]:before:bg-primary"
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
      }}
      onPointerMove={(event) => {
        const active = drag.current
        if (!active || active.pointerId !== event.pointerId) return
        event.preventDefault()
        event.stopPropagation()
        onResize(active.startWidth + event.clientX - active.startX)
      }}
      onPointerUp={finishPointerResize}
      onPointerCancel={finishPointerResize}
      onLostPointerCapture={() => {
        drag.current = null
        setDragging(false)
      }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        event.preventDefault()
        event.stopPropagation()
        const direction = event.key === "ArrowLeft" ? -1 : 1
        onResize(width + direction * (event.shiftKey ? 32 : 8))
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    />} /><TooltipContent>{`调整${definition.label}列宽`}</TooltipContent></Tooltip>
  )
}

function ConnectionTableValue({
  connection,
  columnKey,
  rates,
  closing,
  onClose,
}: {
  connection: Json
  columnKey: ConnectionColumnKey
  rates: Record<string, ConnectionRate>
  closing: boolean
  onClose: () => void
}) {
  if (columnKey === "close") {
    return (
      <ConnectionCloseButton
        connection={connection}
        closing={closing}
        onClose={onClose}
      />
    )
  }

  return (
    <span
      className={cn(
        "block min-w-0 text-xs",
        columnKey === "rule"
          ? "whitespace-nowrap text-muted-foreground"
          : "truncate",
        columnKey === "target" && "font-medium",
        numericColumns.includes(columnKey) && "font-mono tabular-nums"
      )}
    >
      {connectionColumnValue(connection, columnKey, rates)}
    </span>
  )
}

function ConnectionCloseButton({
  connection,
  closing,
  onClose,
}: {
  connection: Json
  closing: boolean
  onClose: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      disabled={closing}
      onClick={(event) => {
        event.stopPropagation()
        onClose()
      }}
      aria-label={`关闭 ${connectionTarget(connection)}`}
    >
      <X className={cn(closing && "animate-pulse")} />
    </Button>
  )
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
}: {
  label: string
  sortKey: ConnectionSortKey
  activeKey: ConnectionSortKey
  direction: ConnectionSortDirection
  onSort: (key: ConnectionSortKey) => void
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      className="w-fit px-0"
      onClick={() => onSort(sortKey)}
    >
      {label}
      {activeKey === sortKey &&
        (direction === "asc" ? (
          <ArrowUp data-icon="inline-end" />
        ) : (
          <ArrowDown data-icon="inline-end" />
        ))}
    </Button>
  )
}

function ConnectionEmpty({ hasConnections, className }: { hasConnections: boolean; className?: string }) {
  return (
    <Empty className={cn("border-0", className)}>
      <EmptyHeader>
        <EmptyTitle>{hasConnections ? "没有匹配的连接" : "当前没有连接"}</EmptyTitle>
        <EmptyDescription>{hasConnections ? "调整搜索内容或清空搜索条件。" : "新的连接建立后会自动显示。"}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function connectionCardFieldClass(index: number, columnCount: number) {
  const lastTwoColumnRow = index >= columnCount - (columnCount % 2 || 2)
  const lastThreeColumnRow = index >= columnCount - (columnCount % 3 || 3)
  const threeColumnPosition = index % 3
  return cn(
    "border-b py-3",
    index < 2 && "pt-0",
    lastTwoColumnRow && "border-b-0 pb-0",
    index % 2 === 0 ? "pr-4" : "border-l pl-4",
    index < 3 ? "md:pt-0" : "md:pt-3",
    lastThreeColumnRow ? "md:border-b-0 md:pb-0" : "md:border-b md:pb-3",
    threeColumnPosition === 0 && "md:border-l-0 md:pr-4 md:pl-0",
    threeColumnPosition === 1 && "md:border-l md:px-4",
    threeColumnPosition === 2 && "md:border-l md:pr-0 md:pl-4"
  )
}
