import { accessFetch } from "./accessClient.ts";
import { createAccessEventSource } from "./accessEvents.ts";
const LOG_BASE = "/api/logs";
const DEFAULT_TIMEOUT_MS = 6_000;

export interface PersistedLogEntry {
  id: string;
  timestamp: number;
  level: string;
  message: string;
  line: string;
}

export interface LogSettings {
  retentionDays: number;
}

async function logRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await accessFetch(`${LOG_BASE}${path}`, {
      ...options,
      headers,
    }, DEFAULT_TIMEOUT_MS);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error("日志服务暂不可用");
  }
  if (!response.ok) throw new Error(`日志服务请求失败 (${response.status})`);
  return response.json() as Promise<T>;
}

export async function listLogEntries(options: {
  limit?: number;
  level?: string;
  search?: string;
  since?: number;
  until?: number;
  signal?: AbortSignal;
} = {}) {
  const params = new URLSearchParams({ limit: String(options.limit ?? 1500) });
  if (options.level && options.level !== "ALL") params.set("level", options.level.toLowerCase());
  if (options.search?.trim()) params.set("search", options.search.trim());
  if (options.since != null) params.set("since", String(options.since));
  if (options.until != null) params.set("until", String(options.until));
  return logRequest<{ entries: PersistedLogEntry[]; hasMore: boolean }>(
    `/entries?${params}`,
    { signal: options.signal },
  );
}

export function getLogSettings(signal?: AbortSignal) {
  return logRequest<LogSettings>("/settings", { signal });
}

export function updateLogSettings(retentionDays: number, signal?: AbortSignal) {
  return logRequest<LogSettings & { removed: number }>("/settings", {
    method: "PUT",
    body: JSON.stringify({ retentionDays }),
    signal,
  });
}

export function createLogEventSource(path = "/stream") {
  return createAccessEventSource(`${LOG_BASE}${path}`);
}

export type LogStreamState = "connecting" | "live" | "reconnecting" | "offline";

export type LogStreamSocket = {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close: () => void;
};

type LogStreamSubscriber = {
  connection: (state: LogStreamState) => void;
  entries: (entries: PersistedLogEntry[]) => void;
  invalidEvent: () => void;
};

export class LogEventStream {
  private socket: LogStreamSocket | null = null;
  private reconnectTimer: number | null = null;
  private openTimer: number | null = null;
  private disposed = false;
  private readonly publish: LogStreamSubscriber;
  private readonly reconnectDelay: number;
  private readonly openTimeout: number;
  private readonly createSocket: (path: string) => LogStreamSocket;

  constructor(publish: LogStreamSubscriber, reconnectDelay = 1500,
    createSocket: (path: string) => LogStreamSocket = createLogEventSource, openTimeout = 6000) {
    this.publish = publish;
    this.reconnectDelay = reconnectDelay;
    this.createSocket = createSocket;
    this.openTimeout = openTimeout;
  }

  start() {
    this.publish.connection("connecting");
    this.connect();
  }

  restart() {
    if (this.disposed) return;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    if (this.openTimer !== null) window.clearTimeout(this.openTimer);
    this.reconnectTimer = null;
    this.openTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.publish.connection("connecting");
    this.connect();
  }

  private connect() {
    if (this.disposed) return;
    // 当前 socket 身份用于屏蔽旧连接事件；EventSource.close 不产生 close 事件。
    const socket = this.createSocket("/stream");
    this.socket = socket;
    this.openTimer = window.setTimeout(() => this.disconnectAndReconnect(socket), this.openTimeout);
    socket.onopen = () => {
      if (this.disposed || this.socket !== socket) return;
      if (this.openTimer !== null) window.clearTimeout(this.openTimer);
      this.openTimer = null;
      this.publish.connection("live");
    };
    socket.onmessage = (event) => {
      if (this.disposed || this.socket !== socket) return;
      try {
        const events = JSON.parse(event.data) as PersistedLogEntry[];
        this.publish.entries(Array.isArray(events) ? events : []);
      } catch {
        this.publish.invalidEvent();
      }
    };
    socket.onerror = () => {
      this.disconnectAndReconnect(socket);
    };
  }

  private disconnectAndReconnect(socket: LogStreamSocket) {
    if (this.disposed || this.socket !== socket) return;
    if (this.openTimer !== null) window.clearTimeout(this.openTimer);
    this.openTimer = null;
    socket.close();
    this.socket = null;
    this.publish.connection("offline");
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) {
        this.publish.connection("reconnecting");
        this.connect();
      }
    }, this.reconnectDelay);
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    if (this.openTimer !== null) window.clearTimeout(this.openTimer);
    this.reconnectTimer = null;
    this.openTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
