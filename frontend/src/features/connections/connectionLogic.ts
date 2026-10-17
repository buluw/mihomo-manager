import type { Json } from "../../shared/types.ts"
import {
  connectionSearchValues,
  connectionSortValue,
  type ConnectionColumnKey,
  type ConnectionRate,
  type ConnectionSortDirection,
  type ConnectionSortKey,
} from "./connectionViewModel.ts"

export const CONNECTION_POLL_INTERVAL_MS = 2_500
export const CONNECTIONS_PATH = "/connections"

export function connectionClosePath(id: string) {
  return `${CONNECTIONS_PATH}/${encodeURIComponent(id)}`
}

export function deriveConnectionRows(
  connections: Json[],
  query: string,
  sortKey: ConnectionSortKey,
  direction: ConnectionSortDirection,
  rates: Record<string, ConnectionRate>,
  now = Date.now()
) {
  const normalized = query.trim().toLocaleLowerCase("zh-CN")
  return connections
    .map((item, index) => ({ item, index }))
    .filter(({ item }) =>
      normalized
        ? connectionSearchValues(item).some((value) =>
            String(value).toLocaleLowerCase("zh-CN").includes(normalized)
          )
        : true
    )
    .sort((left, right) => {
      const a = connectionSortValue(left.item, sortKey, rates, now)
      const b = connectionSortValue(right.item, sortKey, rates, now)
      const result =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), "zh-CN")
      return (direction === "asc" ? result : -result) || left.index - right.index
    })
    .map(({ item }) => item)
}

export function nextConnectionSort(
  currentKey: ConnectionSortKey,
  currentDirection: ConnectionSortDirection,
  nextKey: ConnectionSortKey
): { key: ConnectionSortKey; direction: ConnectionSortDirection } {
  return nextKey === currentKey
    ? {
        key: currentKey,
        direction: currentDirection === "asc" ? "desc" : "asc",
      }
    : { key: nextKey, direction: "asc" }
}

export function moveConnectionColumn(
  order: ConnectionColumnKey[],
  active: ConnectionColumnKey,
  over: ConnectionColumnKey
) {
  const from = order.indexOf(active)
  const to = order.indexOf(over)
  if (from === -1 || to === -1 || from === to) return order
  const next = [...order]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function visibleConnectionColumns(
  order: ConnectionColumnKey[],
  visibility: Record<ConnectionColumnKey, boolean>
) {
  return order.filter((columnKey) => visibility[columnKey])
}
