import { sanitizeLogMessage } from "./sanitize.js";
import type { LogStore } from "./store.js";
import type { NewLogEntry, StoredLogEntry } from "./types.js";

type CollectorOptions = {
  controllerUrl: string;
  secret?: string;
  level?: "info" | "debug";
  store: LogStore;
  publish: (entries: StoredLogEntry[]) => void;
  reconnectDelayMs?: number;
  flushIntervalMs?: number;
};

export class LogCollector {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private queue: NewLogEntry[] = [];
  private stopped = false;

  constructor(private readonly options: CollectorOptions) {}

  start() {
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    const url = new URL(this.options.controllerUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/logs";
    url.search = "";
    url.searchParams.set("level", this.options.level ?? "info");
    if (this.options.secret) url.searchParams.set("token", this.options.secret);
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onmessage = (event) => {
      if (this.stopped || this.socket !== socket) return;
      try {
        const data = JSON.parse(String(event.data)) as { type?: string; payload?: string };
        const nativeLevel = String(data.type || "info").toLowerCase();
        const level = nativeLevel === "warning" ? "warn" : nativeLevel;
        this.queue.push({
          timestamp: Date.now(),
          level,
          message: sanitizeLogMessage(String(data.payload || "")),
        });
        if (this.queue.length >= 500) this.flush();
        else this.scheduleFlush();
      } catch {
        // Ignore malformed native events without persisting their payload.
      }
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(
          () => this.connect(),
          this.options.reconnectDelayMs ?? 1500,
        );
      }
    };
    socket.onerror = () => socket.close();
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(
      () => this.flush(),
      this.options.flushIntervalMs ?? 250,
    );
  }

  private flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.queue.length === 0) return;
    const entries = this.queue;
    this.queue = [];
    this.options.publish(this.options.store.insert(entries));
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.reconnectTimer = undefined;
    this.flushTimer = undefined;
    this.socket?.close();
    this.socket = null;
    this.flush();
  }
}
