import { accessFetch, getAccessState, subscribeAccess } from "./accessClient.ts";
import { createAccessWebSocket } from "./accessEvents.ts";
// Controller Client 原样转发 Mihomo 路径，并集中管理鉴权、超时和实时流生命周期。
import type { Json } from "../shared/types";
import type { ControllerStreamCommand, ControllerStreamEvent, ControllerStreamPath } from "./sharedControllerStreams.ts";

const CONTROLLER_BASE = "/api/controller";
const CONTROLLER_SECRET_KEY = "mihomo-controller-secret";
const DEFAULT_TIMEOUT_MS = 6_000;
const LONG_OPERATION_TIMEOUT_MS = 30_000;
export const PROVIDER_OPERATION_TIMEOUT_MS = 120_000;
let memorySecret = "";

export class ControllerError extends Error {
  readonly status: number;

  constructor(
    message: string,
    status: number,
  ) {
    super(message);
    this.name = "ControllerError";
    this.status = status;
  }
}

export type ControllerRulesResponse = {
  rules: Json[];
};

export type DnsQueryRecord = {
  name: string;
  type: number;
  TTL: number;
  data: string;
};

export type DnsQueryResponse = {
  Status: number;
  Question?: Array<{ name: string; type: number }>;
  Answer?: DnsQueryRecord[];
  Authority?: DnsQueryRecord[];
  Additional?: DnsQueryRecord[];
};

function controllerSecret() {
  if (memorySecret) return memorySecret;
  try {
    return sessionStorage.getItem(CONTROLLER_SECRET_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

export async function controllerApi<T = Json>(
  path: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  // REST 请求按 Mihomo 原生约定使用 Bearer；错误消息不读取响应正文，避免回显敏感信息。
  const headers = new Headers(options.headers);
  if (options.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const secret = controllerSecret();
  if (secret) headers.set("Authorization", `Bearer ${secret}`);
  let response: Response;
  try {
    response = await accessFetch(`${CONTROLLER_BASE}${path}`, { ...options, headers }, timeoutMs);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if ((error instanceof Error && error.name === "TimeoutError")) {
      throw new DOMException("Controller 请求超时", "TimeoutError");
    }
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error("Controller 连接失败");
  }
  if (!response.ok) {
    throw new ControllerError(`Controller 请求失败 (${response.status})`, response.status);
  }
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json() as Promise<T>;
  return response.text() as Promise<T>;
}

export function loadControllerConfig(path?: string) {
  return controllerApi<void>(
    "/configs?force=true",
    { method: "PUT", body: JSON.stringify(path ? { path } : {}) },
    LONG_OPERATION_TIMEOUT_MS,
  );
}

export function patchControllerMode(mode: "rule" | "direct" | "global") {
  return controllerApi<void>("/configs", { method: "PATCH", body: JSON.stringify({ mode }) });
}

export function readControllerRules(signal?: AbortSignal) {
  return controllerApi<ControllerRulesResponse>("/rules", signal ? { signal } : {});
}

export function reloadProxyProvider(providerName: string) {
  return controllerApi<void>(`/providers/proxies/${encodeURIComponent(providerName)}`, {
    method: "PUT",
  });
}

export function restartController() {
  return controllerApi<void>("/restart", { method: "POST" });
}

export function flushFakeIpCache() {
  return controllerApi<void>("/cache/fakeip/flush", { method: "POST" });
}

export function flushDnsCache() {
  return controllerApi<void>("/cache/dns/flush", { method: "POST" });
}

export function queryDns(name: string, type: "A" | "AAAA" | "CNAME" | "TXT") {
  const query = new URLSearchParams({ name, type });
  return controllerApi<DnsQueryResponse>(`/dns/query?${query.toString()}`);
}

export function updateGeoData() {
  return controllerApi<void>("/configs/geo", {
    method: "POST",
    body: JSON.stringify({}),
  }, PROVIDER_OPERATION_TIMEOUT_MS);
}

export function controllerWebSocketPath(path: string) {
  // Mihomo WebSocket 原生接口要求 query token，且 URL 只在内存中构造，不进入日志或界面。
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${window.location.host}${CONTROLLER_BASE}${path}`);
  const secret = controllerSecret();
  if (secret) url.searchParams.set("token", secret);
  return url.toString();
}

export function createControllerWebSocket(path: string) {
  return createAccessWebSocket(controllerWebSocketPath(path));
}

export function subscribeController<T>(
  path: ControllerStreamPath,
  onData: (data: T) => void,
  onState?: (connected: boolean) => void,
  createWorker = () => new SharedWorker(new URL("./controllerStream.worker.ts", import.meta.url), {
    type: "module", name: "mihomo-controller-streams",
  }),
  reconnectDelay = 1500,
) {
  let active: SharedWorker | null = null;
  let timer: number | null = null;
  let suspended = false;
  let disposed = false;
  const disconnect = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    const worker = active;
    active = null;
    if (!worker) return;
    worker.port.onmessage = null;
    worker.onerror = null;
    worker.port.postMessage({ type: "unsubscribe" } satisfies ControllerStreamCommand);
    worker.port.close();
  };
  const retry = () => {
    disconnect();
    onState?.(false);
    if (disposed || suspended) return;
    timer = window.setTimeout(() => {
      timer = null;
      connect();
    }, reconnectDelay);
  };
  const connect = () => {
    if (disposed || suspended || active || timer !== null || getAccessState().phase !== "ready") return;
    let worker: SharedWorker;
    try {
      worker = createWorker();
    } catch {
      retry();
      return;
    }
    active = worker;
    worker.port.onmessage = ({ data }: MessageEvent<ControllerStreamEvent>) => {
      if (disposed || active !== worker) return;
      if (data.type === "data") onData(data.data as T);
      else onState?.(data.connected);
    };
    worker.onerror = () => {
      if (disposed || active !== worker) return;
      retry();
    };
    worker.port.start();
    worker.port.postMessage({ type: "subscribe", path, secret: controllerSecret() } satisfies ControllerStreamCommand);
  };
  const hide = () => {
    suspended = true;
    disconnect();
  };
  const show = () => {
    suspended = false;
    connect();
  };
  // 页面离开（包括进入 bfcache）移除本端口；返回时重新加入现有共享流。
  const stopAccess = subscribeAccess(() => {
    if (getAccessState().phase === "ready") connect();
    else { disconnect(); onState?.(false); }
  });
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", show);
  connect();
  return () => {
    disposed = true;
    stopAccess();
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", show);
    disconnect();
  };
}

export function setControllerSecret(secret: string, rememberForSession = true) {
  const next = secret.trim();
  memorySecret = next;
  try {
    if (rememberForSession && next) sessionStorage.setItem(CONTROLLER_SECRET_KEY, next);
    else sessionStorage.removeItem(CONTROLLER_SECRET_KEY);
  } catch {
    // Memory-only credentials remain usable when storage is unavailable.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("mihomo-controller-secret-change"));
  }
}

export function controllerSecretState() {
  let remembered = false;
  try {
    remembered = Boolean(sessionStorage.getItem(CONTROLLER_SECRET_KEY)?.trim());
  } catch {
    remembered = false;
  }
  return { configured: Boolean(controllerSecret()), remembered };
}
