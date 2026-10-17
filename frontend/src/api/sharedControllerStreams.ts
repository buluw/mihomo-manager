import { accessFetch } from "./accessClient.ts";
// Worker 内按原生路径和鉴权共享持续流，页面只持有消息端口。
export type ControllerStreamPath = "/traffic" | "/memory";
export type ControllerStreamEvent =
  | { type: "data"; data: unknown }
  | { type: "state"; connected: boolean };
export type ControllerStreamCommand =
  | { type: "subscribe"; path: ControllerStreamPath; secret: string }
  | { type: "unsubscribe" };

const CONTROLLER_BASE = "/api/controller";

export function subscribeControllerStream<T>(
  path: ControllerStreamPath,
  secret: string,
  onData: (data: T) => void,
  onState?: (connected: boolean) => void,
  request: typeof fetch = (input, options) => accessFetch(input, options, 0),
  reconnectDelay = 1500,
  openTimeout = 6000,
) {
  let active: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  // /traffic 和 /memory 原生支持逐行 JSON；HTTP 连接由 Core 的 HTTP server 负责释放。
  const connect = async () => {
    if (disposed) return;
    const current = new AbortController();
    active = current;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const openTimer = globalThis.setTimeout(() => current.abort(), openTimeout);
    const isCurrent = () => !disposed && active === current && !current.signal.aborted;
    const publish = (line: string) => {
      if (!isCurrent() || !line.trim()) return;
      try { onData(JSON.parse(line) as T); } catch { /* ignore malformed native events */ }
    };
    try {
      const headers = new Headers();
      if (secret) headers.set("Authorization", `Bearer ${secret}`);
      const response = await request(`${CONTROLLER_BASE}${path}`, {
        headers, signal: current.signal, cache: "no-store",
      });
      reader = response.body?.getReader();
      if (!isCurrent() || !response.ok || !reader) return;
      globalThis.clearTimeout(openTimer);
      onState?.(true);
      const decoder = new TextDecoder();
      let pending = "";
      while (isCurrent()) {
        const { value, done } = await reader.read();
        if (!isCurrent()) break;
        pending += decoder.decode(value, { stream: !done });
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          publish(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
        if (done) {
          publish(pending);
          break;
        }
      }
    } catch {
      // Transport errors never expose Controller URLs, headers or response content.
    } finally {
      globalThis.clearTimeout(openTimer);
      current.abort();
      if (reader) {
        try { await reader.cancel(); } catch { /* already aborted */ }
        reader.releaseLock();
      }
      if (active === current) active = null;
      if (!disposed) {
        onState?.(false);
        timer = globalThis.setTimeout(() => void connect(), reconnectDelay);
      }
    }
  };
  void connect();
  return () => {
    disposed = true;
    if (timer !== null) globalThis.clearTimeout(timer);
    timer = null;
    active?.abort();
    active = null;
  };
}

type StreamGroup = {
  ports: Set<MessagePort>;
  connected: boolean;
  latest?: ControllerStreamEvent;
  stop: () => void;
};

export class SharedControllerStreams {
  private readonly groups = new Map<string, StreamGroup>();
  private readonly startStream: typeof subscribeControllerStream;

  constructor(startStream = subscribeControllerStream) {
    this.startStream = startStream;
  }

  connect(port: MessagePort) {
    let release: (() => void) | undefined;
    port.onmessage = ({ data }: MessageEvent<ControllerStreamCommand>) => {
      release?.();
      release = undefined;
      if (data.type === "unsubscribe") {
        port.close();
        return;
      }
      if (data.type !== "subscribe" ||
          (data.path !== "/traffic" && data.path !== "/memory") || typeof data.secret !== "string") return;
      // Secret 仅作 Worker 内存中的身份，不进入 Worker 名称、URL 或广播消息。
      const key = JSON.stringify([data.path, data.secret]);
      let group = this.groups.get(key);
      if (!group) {
        const created: StreamGroup = { ports: new Set([port]), connected: false, stop: () => {} };
        group = created;
        this.groups.set(key, created);
        const publish = (event: ControllerStreamEvent) => {
          if (this.groups.get(key) !== created) return;
          for (const subscriber of created.ports) subscriber.postMessage(event);
        };
        created.stop = this.startStream(data.path, data.secret, (value) => {
          created.latest = { type: "data", data: value };
          publish(created.latest);
        }, (connected) => {
          created.connected = connected;
          if (!connected) created.latest = undefined;
          publish({ type: "state", connected });
        });
      } else {
        group.ports.add(port);
        port.postMessage({ type: "state", connected: group.connected } satisfies ControllerStreamEvent);
        if (group.latest) port.postMessage(group.latest);
      }
      const subscribed = group;
      release = () => {
        subscribed.ports.delete(port);
        if (!subscribed.ports.size) {
          this.groups.delete(key);
          subscribed.stop();
        }
      };
    };
    port.start();
  }
}
