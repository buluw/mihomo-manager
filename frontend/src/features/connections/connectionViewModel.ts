import { formatBytes } from "../../shared/format.ts"
import type { Json } from "../../shared/types.ts"

export type ConnectionRate = { downloadRate: number; uploadRate: number }
export type ConnectionSortDirection = "asc" | "desc"
export type ConnectionSortKey =
  | "target"
  | "upload"
  | "download"
  | "downloadRate"
  | "uploadRate"
  | "age"
export type ConnectionColumnKey =
  | "close"
  | "target"
  | "type"
  | "process"
  | "sni"
  | "rule"
  | "policy"
  | "source"
  | "sourcePort"
  | "downloadRate"
  | "uploadRate"
  | "upload"
  | "download"
  | "age"
export type ConnectionColumnWidths = Record<ConnectionColumnKey, number>

export const MIN_CONNECTION_DATA_COLUMN_WIDTH = 48
export const CONNECTION_COLUMN_WIDTHS_STORAGE_KEY = "mihomo:connections:column-widths:v1"
export const CONNECTION_COLUMN_WIDTHS_STORAGE_VERSION = 1

export const defaultConnectionColumnOrder: ConnectionColumnKey[] = [
  "close",
  "target",
  "type",
  "process",
  "sni",
  "rule",
  "policy",
  "source",
  "sourcePort",
  "downloadRate",
  "uploadRate",
  "download",
  "upload",
  "age",
]

export const defaultConnectionColumnVisibility: Record<
  ConnectionColumnKey,
  boolean
> = {
  close: true,
  target: true,
  type: false,
  process: false,
  sni: false,
  rule: true,
  policy: true,
  source: true,
  sourcePort: false,
  downloadRate: true,
  uploadRate: true,
  download: true,
  upload: true,
  age: true,
}

export const connectionColumnDefinitions: Record<
  ConnectionColumnKey,
  {
    label: string
    minWidth: number
    width?: number
    sortKey?: ConnectionSortKey
  }
> = {
  close: { label: "关闭", width: 32, minWidth: 32 },
  target: { label: "目标地址", width: 190, minWidth: MIN_CONNECTION_DATA_COLUMN_WIDTH, sortKey: "target" },
  type: { label: "类型", width: 64, minWidth: MIN_CONNECTION_DATA_COLUMN_WIDTH },
  process: { label: "进程", width: 120, minWidth: MIN_CONNECTION_DATA_COLUMN_WIDTH },
  sni: { label: "嗅探域名", width: 180, minWidth: MIN_CONNECTION_DATA_COLUMN_WIDTH },
  rule: { label: "规则", width: 160, minWidth: MIN_CONNECTION_DATA_COLUMN_WIDTH },
  policy: { label: "链路", width: 180, minWidth: MIN_CONNECTION_DATA_COLUMN_WIDTH },
  source: { label: "源地址", width: 112, minWidth: MIN_CONNECTION_DATA_COLUMN_WIDTH },
  sourcePort: { label: "源端口", width: 72, minWidth: MIN_CONNECTION_DATA_COLUMN_WIDTH },
  downloadRate: {
    label: "下载速度",
    width: 96,
    minWidth: MIN_CONNECTION_DATA_COLUMN_WIDTH,
    sortKey: "downloadRate",
  },
  uploadRate: {
    label: "上传速度",
    width: 96,
    minWidth: MIN_CONNECTION_DATA_COLUMN_WIDTH,
    sortKey: "uploadRate",
  },
  download: {
    label: "下载量",
    width: 80,
    minWidth: MIN_CONNECTION_DATA_COLUMN_WIDTH,
    sortKey: "download",
  },
  upload: {
    label: "上传量",
    width: 80,
    minWidth: MIN_CONNECTION_DATA_COLUMN_WIDTH,
    sortKey: "upload",
  },
  age: { label: "建立时间", width: 88, minWidth: MIN_CONNECTION_DATA_COLUMN_WIDTH, sortKey: "age" },
}

export const defaultConnectionColumnWidths = Object.fromEntries(
  defaultConnectionColumnOrder.map((columnKey) => {
    const definition = connectionColumnDefinitions[columnKey]
    return [columnKey, definition.width ?? definition.minWidth]
  })
) as ConnectionColumnWidths

export const MAX_CONNECTION_COLUMN_WIDTH = 4_096

const adjustableConnectionColumnKeys = defaultConnectionColumnOrder.filter((columnKey) => columnKey !== "close")

export function parseConnectionColumnWidths(raw: string | null): ConnectionColumnWidths {
  const fallback = { ...defaultConnectionColumnWidths }
  if (!raw) return fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return fallback
    const record = parsed as Record<string, unknown>
    if (record.version !== CONNECTION_COLUMN_WIDTHS_STORAGE_VERSION || !record.widths || typeof record.widths !== "object") return fallback
    const stored = record.widths as Record<string, unknown>
    for (const [columnKey, width] of Object.entries(stored)) {
      if (!adjustableConnectionColumnKeys.includes(columnKey as Exclude<ConnectionColumnKey, "close">)) return fallback
      const definition = connectionColumnDefinitions[columnKey as ConnectionColumnKey]
      if (typeof width !== "number" || !Number.isFinite(width) || width < definition.minWidth || width > MAX_CONNECTION_COLUMN_WIDTH) return fallback
    }
    return {
      ...fallback,
      ...Object.fromEntries(Object.entries(stored).map(([columnKey, width]) => [columnKey, Math.round(width as number)])),
    }
  } catch {
    return fallback
  }
}

export function readConnectionColumnWidths(): ConnectionColumnWidths {
  if (typeof window === "undefined") return { ...defaultConnectionColumnWidths }
  try {
    return parseConnectionColumnWidths(window.localStorage.getItem(CONNECTION_COLUMN_WIDTHS_STORAGE_KEY))
  } catch {
    return { ...defaultConnectionColumnWidths }
  }
}

export function writeConnectionColumnWidths(widths: ConnectionColumnWidths) {
  if (typeof window === "undefined") return
  try {
    const stored = Object.fromEntries(adjustableConnectionColumnKeys.map((columnKey) => [
      columnKey,
      connectionColumnWidth(columnKey, widths),
    ]))
    window.localStorage.setItem(CONNECTION_COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify({
      version: CONNECTION_COLUMN_WIDTHS_STORAGE_VERSION,
      widths: stored,
    }))
  } catch {
    // Storage may be unavailable in private browsing or restricted documents.
  }
}

export function clearConnectionColumnWidths() {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(CONNECTION_COLUMN_WIDTHS_STORAGE_KEY)
  } catch {
    // Storage may be unavailable in private browsing or restricted documents.
  }
}

export function connectionColumnWidth(
  columnKey: ConnectionColumnKey,
  widths: ConnectionColumnWidths
) {
  const definition = connectionColumnDefinitions[columnKey]
  if (columnKey === "close") return definition.width ?? definition.minWidth
  const requested = widths[columnKey]
  const fallback = defaultConnectionColumnWidths[columnKey]
  return Math.min(
    MAX_CONNECTION_COLUMN_WIDTH,
    Math.max(
      definition.minWidth,
      Number.isFinite(requested) ? Math.round(requested) : fallback
    )
  )
}

export function resizeConnectionColumn(
  widths: ConnectionColumnWidths,
  columnKey: ConnectionColumnKey,
  requestedWidth: number
) {
  if (columnKey === "close") return widths
  const nextWidth = connectionColumnWidth(columnKey, {
    ...widths,
    [columnKey]: requestedWidth,
  })
  return widths[columnKey] === nextWidth
    ? widths
    : { ...widths, [columnKey]: nextWidth }
}

export function connectionTarget(connection: Json) {
  const metadata = connection.metadata || {}
  const host = metadata.host || metadata.destinationIP || "-"
  const port = metadata.destinationPort
  return port ? `${host}:${port}` : String(host)
}

export function connectionSource(connection: Json) {
  const metadata = connection.metadata || {}
  const host = metadata.sourceIP || "-"
  const port = metadata.sourcePort
  return port ? `${host}:${port}` : String(host)
}

export function connectionAgeSeconds(connection: Json, now = Date.now()) {
  const started = Date.parse(String(connection.start || ""))
  return Number.isFinite(started)
    ? Math.max(0, Math.floor((now - started) / 1000))
    : 0
}

export function calculateConnectionRates(
  previous: Json[] | undefined,
  current: Json[],
  elapsedMs: number
): Record<string, ConnectionRate> {
  if (!previous || elapsedMs <= 0) return {}
  const seconds = elapsedMs / 1000
  const byId = new Map(previous.map((item) => [String(item.id), item]))
  return Object.fromEntries(
    current.map((item) => {
      const prior = byId.get(String(item.id))
      return [
        String(item.id),
        {
          downloadRate: prior
            ? Math.max(
                0,
                Number(item.download || 0) - Number(prior.download || 0)
              ) / seconds
            : 0,
          uploadRate: prior
            ? Math.max(
                0,
                Number(item.upload || 0) - Number(prior.upload || 0)
              ) / seconds
            : 0,
        },
      ]
    })
  )
}

export function connectionSearchValues(connection: Json) {
  const metadata = connection.metadata || {}
  return [
    connectionTarget(connection),
    metadata.sniffHost || metadata.host || "",
    metadata.sourceIP || "",
    connection.rule || "",
    Array.isArray(connection.chains) ? connection.chains.join(" / ") : "",
  ]
}

export function connectionSortValue(
  connection: Json,
  sortKey: ConnectionSortKey,
  rates: Record<string, ConnectionRate>,
  now = Date.now()
) {
  const rate = rates[String(connection.id)] || {
    downloadRate: 0,
    uploadRate: 0,
  }
  switch (sortKey) {
    case "target":
      return connectionTarget(connection)
    case "upload":
      return Number(connection.upload || 0)
    case "download":
      return Number(connection.download || 0)
    case "downloadRate":
      return rate.downloadRate
    case "uploadRate":
      return rate.uploadRate
    case "age":
      return connectionAgeSeconds(connection, now)
  }
}

export function connectionColumnValue(
  connection: Json,
  columnKey: ConnectionColumnKey,
  rates: Record<string, ConnectionRate>,
  now = Date.now()
) {
  const metadata = connection.metadata || {}
  const rate = rates[String(connection.id)] || {
    downloadRate: 0,
    uploadRate: 0,
  }

  switch (columnKey) {
    case "close":
      return ""
    case "target":
      return connectionTarget(connection)
    case "type":
      return String(metadata.network || metadata.type || "-").toUpperCase()
    case "process":
      return String(metadata.process || metadata.processPath || "-")
    case "sni":
      return String(metadata.sniffHost || metadata.host || "-")
    case "rule":
      return [connection.rule, connection.rulePayload]
        .filter(Boolean)
        .join(" / ") || "-"
    case "policy":
      return Array.isArray(connection.chains) && connection.chains.length
        ? connection.chains.join(" / ")
        : "-"
    case "source":
      return String(metadata.sourceIP || "-")
    case "sourcePort":
      return metadata.sourcePort === undefined || metadata.sourcePort === null
        ? "-"
        : String(metadata.sourcePort)
    case "downloadRate":
      return `${formatBytes(rate.downloadRate)}/s`
    case "uploadRate":
      return `${formatBytes(rate.uploadRate)}/s`
    case "upload":
      return formatBytes(Number(connection.upload || 0))
    case "download":
      return formatBytes(Number(connection.download || 0))
    case "age":
      return formatDuration(connectionAgeSeconds(connection, now))
  }
}

export function connectionTableWidth(
  columns: ConnectionColumnKey[],
  widths: ConnectionColumnWidths
) {
  return columns.reduce(
    (total, columnKey) => total + connectionColumnWidth(columnKey, widths),
    0
  )
}

export function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(
    (seconds % 3600) / 60
  )}m`
}

export function formatMetricRate(rate: number) {
  const [value, unit] = formatBytes(rate).split(" ")
  return { value, unit: `${unit}/s` }
}
