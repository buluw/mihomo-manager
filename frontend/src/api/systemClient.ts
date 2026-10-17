import { accessFetch } from "./accessClient.ts";
export class SystemError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super("System request failed");
    this.code = code;
    this.status = status;
  }
}

export interface HostNetworkInterface {
  name: string;
  kind?: "loopback" | "tun" | "other" | "unknown";
  state: "up" | "down" | "unknown" | "dormant" | "lowerlayerdown" | "notpresent" | "testing";
  addresses: Array<{ address: string; family: "IPv4" | "IPv6"; cidr: string | null }>;
}

export interface CoreServiceStatus {
  state: "active" | "inactive" | "activating" | "deactivating" | "failed" | "unknown";
  running: boolean;
  failure: string | null;
  exitStatus: number | null;
  busy: boolean;
}

export interface ProjectServiceResource {
  id: "core" | "configd" | "logd" | "sysinfo" | "web";
  available: boolean;
  state: CoreServiceStatus["state"];
  running: boolean;
  failure: string | null;
  exitStatus: number | null;
  memoryBytes: number | null;
  memoryUnavailable: "service-unavailable" | "not-running" | "not-accounted" | "not-reported" | null;
}
export interface ProjectResources {
  sampledAt: string;
  containerMemory: {
    source: "lxcfs" | null;
    usedBytes: number | null;
    limitBytes: number | null;
    usagePercent: number | null;
  };
  services: ProjectServiceResource[];
  disks: Array<{ id: "program" | "data" | "logs"; bytes: number | null }>;
}

export async function readProjectResources(signal?: AbortSignal, refreshDisks = false): Promise<ProjectResources> {
  const timeout = 8000;
  let response: Response;
  try {
    response = await accessFetch("/api/system/resources", {
      signal,
      ...(refreshDisks ? { headers: { "Cache-Control": "no-cache" } } : {}),
    }, timeout);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SystemError("resources_request_failed", 0);
  }
  if (!response.ok) throw new SystemError("resources_unavailable", response.status);
  try {
    const value = await response.json() as ProjectResources;
    const validBytes = (bytes: unknown) => bytes === null || (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0);
    const serviceIds = ["core", "configd", "logd", "sysinfo", "web"];
    const diskIds = ["program", "data", "logs"];
    const memory = value?.containerMemory;
    if (!value || typeof value.sampledAt !== "string" || !Number.isFinite(Date.parse(value.sampledAt))
      || !Array.isArray(value.services) || value.services.length !== serviceIds.length
      || !serviceIds.every(id => value.services.filter(item => item?.id === id).length === 1)
      || !value.services.every(item => typeof item.available === "boolean" && typeof item.running === "boolean"
        && ["active", "inactive", "activating", "deactivating", "failed", "unknown"].includes(item.state)
        && (item.failure === null || typeof item.failure === "string") && validBytes(item.exitStatus) && validBytes(item.memoryBytes)
        && [null, "service-unavailable", "not-running", "not-accounted", "not-reported"].includes(item.memoryUnavailable))
      || !memory || ![null, "lxcfs"].includes(memory.source) || !validBytes(memory.usedBytes) || !validBytes(memory.limitBytes)
      || (memory.limitBytes !== null && memory.limitBytes === 0)
      || (memory.source === null && (memory.usedBytes !== null || memory.limitBytes !== null || memory.usagePercent !== null))
      || (memory.usedBytes === null || memory.limitBytes === null
        ? memory.usagePercent !== null
        : memory.usedBytes > memory.limitBytes || typeof memory.usagePercent !== "number" || !Number.isFinite(memory.usagePercent)
          || Math.abs(memory.usagePercent - memory.usedBytes / memory.limitBytes * 100) > 0.001)
      || !Array.isArray(value.disks) || value.disks.length !== diskIds.length
      || !diskIds.every(id => value.disks.filter(item => item?.id === id).length === 1)
      || !value.disks.every(item => validBytes(item.bytes))) throw new Error();
    return value;
  } catch { throw new SystemError("resources_invalid_response", response.status); }
}

async function coreRequest(action?: "start" | "restart", signal?: AbortSignal): Promise<CoreServiceStatus> {
  let response: Response;
  try {
    const timeout = action ? 35_000 : 6_000;
    response = await accessFetch(`/api/system/core${action ? `/${action}` : ""}`, {
      method: action ? "POST" : "GET", signal,
    }, timeout);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SystemError(action ? "core_action_unconfirmed" : "core_status_unavailable", 0);
  }
  if (!response.ok) {
    if (response.status === 409) throw new SystemError("core_service_busy", response.status);
    throw new SystemError(action ? "core_action_failed" : "core_status_unavailable", response.status);
  }
  let value: CoreServiceStatus;
  try { value = await response.json() as CoreServiceStatus; }
  catch { throw new SystemError("core_status_invalid_response", response.status); }
  if (!value || typeof value !== "object") throw new SystemError("core_status_invalid_response", response.status);
  if (!["active", "inactive", "activating", "deactivating", "failed", "unknown"].includes(value.state) ||
      typeof value.running !== "boolean" || typeof value.busy !== "boolean") throw new SystemError("core_status_invalid_response", response.status);
  return value;
}

export const readCoreServiceStatus = (signal?: AbortSignal) => coreRequest(undefined, signal);
export const operateCoreService = (action: "start" | "restart", signal?: AbortSignal) => coreRequest(action, signal);

export type CoreDownloadRoute = { mode: "direct" | "core" | "external"; proxy?: string };
export type CoreDownloadSource = "github" | "ghfast" | "ghproxy" | "ghproxynet" | "custom" | "upload";
type CoreBinary = { version: string; sha256: string };
export interface CoreUpdateStatus {
  phase: "idle" | "checking" | "downloading" | "uploading" | "validating" | "ready" | "installing" | "rolling-back" | "succeeded" | "rolled-back" | "failed";
  busy: boolean;
  error: string | null;
  current: CoreBinary | null;
  previous: CoreBinary | null;
  latest: { version: string; releaseNotes: string | null } | null;
  checkState: "unchecked" | "checking" | "succeeded" | "failed";
  checkedAt: string | null;
  candidate: (CoreBinary & { verification: "official" | "local"; source: CoreDownloadSource }) | null;
  source: CoreDownloadSource | null;
  route: CoreDownloadRoute["mode"] | null;
  bytes: number;
  total: number | null;
}

export async function systemUpdateRequest<T>(path: string, body?: object | File, signal?: AbortSignal): Promise<T> {
  const timeout = body instanceof Blob ? 180_000 : 20_000;
  let response: Response;
  try {
    response = await accessFetch("/api/system" + path, {
      method: body === undefined ? "GET" : "POST",
      ...(body ? { body: body instanceof Blob ? body : JSON.stringify(body), headers: { "Content-Type": body instanceof Blob ? "application/octet-stream" : "application/json" } } : {}),
      signal,
    }, timeout);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SystemError("update_request_unconfirmed", 0);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new SystemError(response.status === 413 ? "file_too_large" : data.error ?? "update_failed", response.status);
  }
  return response.json() as Promise<T>;
}
const updateRequest = <T,>(action: string, body?: object | File, signal?: AbortSignal) => systemUpdateRequest<T>("/core/update" + (action ? "/" + action : ""), body, signal);
export const readCoreUpdate = (signal?: AbortSignal) => updateRequest<CoreUpdateStatus>("", undefined, signal);
export const checkCoreUpdate = (route: CoreDownloadRoute, signal?: AbortSignal) => updateRequest("check", route, signal);
export const prepareCoreDownload = (request: CoreDownloadRoute & { source: Exclude<CoreDownloadSource, "upload">; url?: string }, signal?: AbortSignal) => updateRequest("download", request, signal);
export const uploadCore = (file: File, signal?: AbortSignal) => updateRequest("upload", file, signal);
export const installCoreUpdate = (sha256: string, signal?: AbortSignal) => updateRequest("install", { sha256 }, signal);
export const rollbackCoreUpdate = (sha256: string, signal?: AbortSignal) => updateRequest("rollback", { sha256 }, signal);

export async function readNetworkInterfaces(signal?: AbortSignal): Promise<HostNetworkInterface[]> {
  const timeout = 6_000;
  let response: Response;
  try {
    response = await accessFetch("/api/system/interfaces", {
      signal,
    }, timeout);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SystemError("interfaces_request_failed", 0);
  }
  if (!response.ok) throw new SystemError("interfaces_http_error", response.status);
  try {
    const data = await response.json() as { interfaces: HostNetworkInterface[] };
    if (!Array.isArray(data.interfaces) || !data.interfaces.every(item => item && typeof item.name === "string"
      && Array.isArray(item.addresses) && [undefined, "loopback", "tun", "other", "unknown"].includes(item.kind))) throw new Error();
    return data.interfaces;
  } catch {
    throw new SystemError("interfaces_invalid_response", response.status);
  }
}
