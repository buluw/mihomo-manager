// 按原生日志游标去重并限制前端日志容量。
export type LogEntry = {
  id: string;
  line: string;
  level?: string;
  message?: string;
  receivedAt?: string;
  timestamp?: number;
};

export interface LogTimeRange {
  mode: string;
  label: string;
  since?: number;
  until?: number;
}

export type LogSortDirection = "asc" | "desc";

type LogProjectionOptions = {
  query: string;
  timeRange: LogTimeRange;
  selectedLevel?: string;
  selectedProtocol?: string;
  sortDirection: LogSortDirection;
};

const REDACTED_LOG_VALUE = "[REDACTED]";
const CREDENTIAL_KEY = String.raw`(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|x[_-]?api[_-]?key|api[_-]?key|apikey|client[_-]?secret|secret(?:[_-]?key)?|password|passwd|pwd|credentials?)`;
const CREDENTIALED_URL = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s?#@]+)@/gi;
const AUTHORIZATION_VALUE = /\b((?:proxy[-_ ]?)?authorization\s*[:=]\s*)(?:(bearer|basic|token)(\s+))?([^\s,;]+)/gi;
const BEARER_VALUE = /\b(bearer)(\s+)([^\s,;]+)/gi;
const DOUBLE_QUOTED_CREDENTIAL = new RegExp(
  `((?:["']?\\b${CREDENTIAL_KEY}\\b["']?)\\s*[:=]\\s*")((?:\\\\.|[^"\\\\])*)(")`,
  "gi",
);
const SINGLE_QUOTED_CREDENTIAL = new RegExp(
  `((?:["']?\\b${CREDENTIAL_KEY}\\b["']?)\\s*[:=]\\s*')((?:\\\\.|[^'\\\\])*)(')`,
  "gi",
);
const PLAIN_CREDENTIAL = new RegExp(
  `(\\b${CREDENTIAL_KEY}\\b\\s*[:=]\\s*)(\\[REDACTED\\]|[^\\s,;}&\\]"'()#]+)`,
  "gi",
);

function redactLogText(text: string) {
  return text
    .replace(CREDENTIALED_URL, (_match, scheme: string) => `${scheme}${REDACTED_LOG_VALUE}@`)
    .replace(
      AUTHORIZATION_VALUE,
      (_match, prefix: string, scheme?: string, spacing?: string) =>
        `${prefix}${scheme ? `${scheme}${spacing}` : ""}${REDACTED_LOG_VALUE}`,
    )
    .replace(BEARER_VALUE, (_match, bearer: string, spacing: string) =>
      `${bearer}${spacing}${REDACTED_LOG_VALUE}`)
    .replace(DOUBLE_QUOTED_CREDENTIAL, `$1${REDACTED_LOG_VALUE}$3`)
    .replace(SINGLE_QUOTED_CREDENTIAL, `$1${REDACTED_LOG_VALUE}$3`)
    .replace(PLAIN_CREDENTIAL, `$1${REDACTED_LOG_VALUE}`);
}

function redactLogEntry(entry: LogEntry): LogEntry {
  const line = redactLogText(entry.line);
  const message = entry.message == null ? entry.message : redactLogText(entry.message);
  const level = entry.level == null ? entry.level : redactLogText(entry.level);
  return line === entry.line && message === entry.message && level === entry.level
    ? entry
    : { ...entry, line, message, level };
}

export function presetLogRange(mode: string, now = Date.now()): LogTimeRange {
  const current = new Date(now);
  if (mode === "today") {
    const start = new Date(current);
    start.setHours(0, 0, 0, 0);
    return { mode, label: "今天", since: start.getTime(), until: now };
  }
  if (mode === "yesterday") {
    const end = new Date(current);
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - 1);
    return { mode, label: "昨天", since: start.getTime(), until: end.getTime() - 1 };
  }
  const presets: Record<string, { hours: number; label: string }> = {
    "15m": { hours: 0.25, label: "最近 15 分钟" },
    "1h": { hours: 1, label: "最近 1 小时" },
    "6h": { hours: 6, label: "最近 6 小时" },
    "24h": { hours: 24, label: "最近 24 小时" },
    "7d": { hours: 7 * 24, label: "最近 7 天" },
    "30d": { hours: 30 * 24, label: "最近 30 天" },
  };
  const preset = presets[mode] || presets["24h"]!;
  return { mode, label: preset.label, since: now - preset.hours * 60 * 60 * 1000, until: now };
}

export function resolveLogTimeRange(range: LogTimeRange, now = Date.now()) {
  return range.mode === "custom" ? range : presetLogRange(range.mode, now);
}

export function resolveLogDisplayRange(range: LogTimeRange, now = Date.now()): LogTimeRange {
  const resolved = resolveLogTimeRange(range, now);
  // 实时窗口持续接收新日志；固定历史范围仍保留结束时间。
  return range.mode === "custom" || range.mode === "yesterday"
    ? resolved
    : { ...resolved, until: undefined };
}

export function customLogRange(since: number, until: number): LogTimeRange | null {
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) return null;
  const format = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return { mode: "custom", label: `${format.format(since)} - ${format.format(until)}`, since, until };
}

export function mergeLogEntries(current: LogEntry[], incoming: LogEntry[]) {
  const unique = new Map<string, { entry: LogEntry; order: number }>();
  [...current, ...incoming].map(redactLogEntry).forEach((entry, order) => {
    if (entry.id && entry.line && !unique.has(entry.id)) unique.set(entry.id, { entry, order });
  });
  return [...unique.values()]
    .sort((left, right) => Number(left.entry.timestamp ?? 0) - Number(right.entry.timestamp ?? 0) || left.order - right.order)
    .slice(-1500)
    .map(({ entry }) => entry);
}

export function filterLogEntriesByRange(entries: LogEntry[], timeRange: LogTimeRange) {
  return entries.filter((entry) => {
    const timestamp = entry.timestamp;
    return timestamp != null && Number.isFinite(timestamp) &&
      (timeRange.since == null || timestamp >= timeRange.since) &&
      (timeRange.until == null || timestamp <= timeRange.until);
  });
}

export function mergeLogEntriesInRange(
  current: LogEntry[],
  incoming: LogEntry[],
  timeRange: LogTimeRange,
) {
  return mergeLogEntries(
    filterLogEntriesByRange(current, timeRange),
    filterLogEntriesByRange(incoming, timeRange),
  );
}

export const logEntryLevel = (entry: LogEntry) => {
  const level = (entry.level || entry.line.match(/^level=(\w+)/)?.[1] || "info").toLowerCase();
  return level === "warn" ? "warning" : level;
};
export const logEntryMessage = (entry: LogEntry) => entry.message || entry.line.replace(/^level=\w+\s*/, "");
export function logEntryProtocol(entry: LogEntry) {
  const message = logEntryMessage(entry);
  return message.match(/^\[([A-Za-z0-9_-]+)\]/)?.[1]?.toUpperCase() ||
    message.match(/\b(TCP|UDP|DNS|HTTP|HTTPS)\b/i)?.[1]?.toUpperCase() || "CORE";
}

export function logEntryProtocols(entries: LogEntry[]) {
  return [...new Set(entries.map(logEntryProtocol))].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

export function retainLogProtocolSelection(selected: string, protocols: readonly string[]) {
  return selected === "all" || protocols.includes(selected) ? selected : "all";
}

export function filterAndSortLogEntries(
  entries: LogEntry[],
  { query, timeRange, selectedLevel = "all", selectedProtocol = "all", sortDirection }: LogProjectionOptions,
) {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  return filterLogEntriesByRange(entries, timeRange).filter((entry) => (
    (!normalized || entry.line.toLocaleLowerCase("zh-CN").includes(normalized)) &&
    (selectedLevel === "all" || logEntryLevel(entry) === selectedLevel) &&
    (selectedProtocol === "all" || logEntryProtocol(entry) === selectedProtocol)
  )).sort((a, b) => {
    const result = Number(a.timestamp || 0) - Number(b.timestamp || 0);
    return sortDirection === "asc" ? result : -result;
  });
}
