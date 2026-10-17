import { systemUpdateRequest, type CoreDownloadRoute, type CoreDownloadSource, type CoreUpdateStatus } from "./systemClient.ts"

export type WebUiProgram = { version: string; sha256: string; sourceSha256: string | null }
export interface WebUiUpdateStatus extends Omit<CoreUpdateStatus, "current" | "previous" | "candidate" | "checkState"> {
  current: { version: string; sourceSha256: string | null }
  previous: WebUiProgram | null
  candidate: (WebUiProgram & { verification: "official" | "local"; source: CoreDownloadSource; node: string; arch: string; platform: string; dirty: boolean }) | null
  checkState: CoreUpdateStatus["checkState"] | "unpublished" | "unavailable"
  available: boolean
  install: { id: string; startedAt: string; finishedAt: string | null; services: string[] } | null
}
export interface UpdatePolicy {
  autoCheck: boolean; intervalHours: number; autoDownload: boolean; scheduledInstall: boolean; installTime: string
  mode: "direct" | "core"; source: Exclude<CoreDownloadSource, "upload" | "custom">
}
export interface UpdatePolicyStatus {
  revision: number; settings: UpdatePolicy; timeZone: string; serverTime: string
  nextCheckAt: string | null; nextInstallAt: string | null; lastCheckAt: string | null; lastInstallAt: string | null
  error: string | null; running: boolean; available: boolean
}
export const readWebUiUpdate = (signal?: AbortSignal) => systemUpdateRequest<WebUiUpdateStatus>("/webui/update", undefined, signal)
export const checkWebUiUpdate = (route: CoreDownloadRoute, signal?: AbortSignal) => systemUpdateRequest("/webui/update/check", route, signal)
export const prepareWebUiDownload = (request: CoreDownloadRoute & { source: Exclude<CoreDownloadSource, "upload">; url?: string }, signal?: AbortSignal) => systemUpdateRequest("/webui/update/download", request, signal)
export const uploadWebUi = (file: File, signal?: AbortSignal) => systemUpdateRequest("/webui/update/upload", file, signal)
export const installWebUiUpdate = (sha256: string, signal?: AbortSignal) => systemUpdateRequest("/webui/update/install", { sha256 }, signal)
export const rollbackWebUiUpdate = (sha256: string, signal?: AbortSignal) => systemUpdateRequest("/webui/update/rollback", { sha256 }, signal)
export const readUpdatePolicy = (signal?: AbortSignal) => systemUpdateRequest<UpdatePolicyStatus>("/updates/settings", undefined, signal)
export const saveUpdatePolicy = (settings: UpdatePolicy, expectedRevision: number, signal?: AbortSignal) => systemUpdateRequest<UpdatePolicyStatus>("/updates/settings", { settings, expectedRevision }, signal)
