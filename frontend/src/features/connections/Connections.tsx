import { useEffect, useMemo, useState } from "react"
import { Activity, ArrowDown, ArrowUp } from "lucide-react"

import { controllerApi } from "@/api/controllerClient"
import { StandardPage } from "@/components/layout/page-frame"
import type { Json, Notify } from "@/shared/types"

import { ConnectionToolbar } from "./ConnectionToolbar"
import { ConnectionViews } from "./ConnectionViews"
import {
  CONNECTIONS_PATH,
  connectionClosePath,
  deriveConnectionRows,
  nextConnectionSort,
  visibleConnectionColumns,
} from "./connectionLogic"
import {
  defaultConnectionColumnOrder,
  defaultConnectionColumnWidths,
  defaultConnectionColumnVisibility,
  formatMetricRate,
  connectionTarget,
  clearConnectionColumnWidths,
  readConnectionColumnWidths,
  resizeConnectionColumn,
  writeConnectionColumnWidths,
  type ConnectionColumnKey,
  type ConnectionSortDirection,
  type ConnectionSortKey,
} from "./connectionViewModel"
import { useConnectionsPolling } from "./useConnectionsPolling"

export function Connections({ notify }: { notify: Notify }) {
  const { connections, rates, load, cancelLoad } =
    useConnectionsPolling(notify)
  const [query, setQuery] = useState("")
  const [sortKey, setSortKey] =
    useState<ConnectionSortKey>("downloadRate")
  const [sortDirection, setSortDirection] =
    useState<ConnectionSortDirection>("desc")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [columnOrder, setColumnOrder] = useState<ConnectionColumnKey[]>(() => [
    ...defaultConnectionColumnOrder,
  ])
  const [columnVisibility, setColumnVisibility] = useState<
    Record<ConnectionColumnKey, boolean>
  >(() => ({ ...defaultConnectionColumnVisibility }))
  const [columnWidths, setColumnWidths] = useState(() => readConnectionColumnWidths())
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set())
  const [closingAll, setClosingAll] = useState(false)
  const [closeAllOpen, setCloseAllOpen] = useState(false)

  useEffect(() => {
    setSelectedId((current) => {
      if (
        current &&
        connections.some((connection) => String(connection.id) === current)
      ) {
        return current
      }
      const firstId = connections[0]?.id
      return firstId === undefined || firstId === null ? null : String(firstId)
    })
  }, [connections])

  const visible = useMemo(
    () =>
      deriveConnectionRows(
        connections,
        query,
        sortKey,
        sortDirection,
        rates
      ),
    [connections, query, rates, sortDirection, sortKey]
  )
  const visibleColumns = useMemo(
    () => visibleConnectionColumns(columnOrder, columnVisibility),
    [columnOrder, columnVisibility]
  )
  const currentDownloadRate = Object.values(rates).reduce(
    (total, rate) => total + rate.downloadRate,
    0
  )
  const currentUploadRate = Object.values(rates).reduce(
    (total, rate) => total + rate.uploadRate,
    0
  )
  const downloadMetric = formatMetricRate(currentDownloadRate)
  const uploadMetric = formatMetricRate(currentUploadRate)

  const changeSort = (nextKey: ConnectionSortKey) => {
    const next = nextConnectionSort(sortKey, sortDirection, nextKey)
    setSortKey(next.key)
    setSortDirection(next.direction)
  }

  const closeOne = async (connection: Json) => {
    if (connection.id === undefined || connection.id === null) return
    const id = String(connection.id)
    if (closingIds.has(id)) return

    setClosingIds((current) => new Set(current).add(id))
    cancelLoad()
    try {
      await controllerApi(connectionClosePath(id), { method: "DELETE" })
      notify(`已关闭连接 ${connectionTarget(connection)}`)
      await load()
    } catch (error) {
      notify((error as Error).message, "error")
    } finally {
      setClosingIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  const closeAll = async () => {
    if (connections.length === 0 || closingAll) return

    setClosingAll(true)
    cancelLoad()
    try {
      await controllerApi(CONNECTIONS_PATH, { method: "DELETE" })
      notify("活动连接已关闭")
      await load()
      setCloseAllOpen(false)
    } catch (error) {
      notify((error as Error).message, "error")
    } finally {
      setClosingAll(false)
    }
  }

  return (
    <StandardPage>
      <section className="grid overflow-hidden rounded-md border sm:grid-cols-3">
        {[
          {
            label: "活动连接",
            value: connections.length,
            unit: "条",
            icon: Activity,
          },
          {
            label: "当前下行",
            value: downloadMetric.value,
            unit: downloadMetric.unit,
            icon: ArrowDown,
          },
          {
            label: "当前上行",
            value: uploadMetric.value,
            unit: uploadMetric.unit,
            icon: ArrowUp,
          },
        ].map((item) => (
          <div
            key={item.label}
            className="flex h-14 items-center gap-2 border-b px-4 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0"
          >
            <item.icon className="size-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{item.label}</span>
            <span className="ml-auto text-lg font-semibold tabular-nums">
              {item.value}
            </span>
            <span className="text-xs text-muted-foreground">{item.unit}</span>
          </div>
        ))}
      </section>

      <section className="min-w-0 xl:overflow-hidden xl:rounded-md xl:border xl:bg-background">
        <ConnectionToolbar
          query={query}
          onQueryChange={setQuery}
          visibleCount={visible.length}
          totalCount={connections.length}
          columnOrder={columnOrder}
          columnVisibility={columnVisibility}
          onColumnOrderChange={setColumnOrder}
          onColumnVisibilityChange={(columnKey, visible) =>
            setColumnVisibility((current) => ({
              ...current,
              [columnKey]: visible,
            }))
          }
          onResetColumns={() => {
            setColumnOrder([...defaultConnectionColumnOrder])
            setColumnVisibility({ ...defaultConnectionColumnVisibility })
            setColumnWidths({ ...defaultConnectionColumnWidths })
            clearConnectionColumnWidths()
          }}
          closeAllOpen={closeAllOpen}
          onCloseAllOpenChange={setCloseAllOpen}
          closingAll={closingAll}
          onCloseAll={() => void closeAll()}
        />
        <ConnectionViews
          connections={visible}
          hasConnections={connections.length > 0}
          columns={visibleColumns}
          columnWidths={columnWidths}
          rates={rates}
          selectedId={selectedId}
          closingIds={closingIds}
          sortKey={sortKey}
          sortDirection={sortDirection}
          onSelect={setSelectedId}
          onClose={(connection) => void closeOne(connection)}
          onSort={changeSort}
          onColumnWidthChange={(columnKey, width) =>
            setColumnWidths((current) => {
              const next = resizeConnectionColumn(current, columnKey, width)
              if (next !== current) writeConnectionColumnWidths(next)
              return next
            })
          }
        />
      </section>
    </StandardPage>
  )
}
