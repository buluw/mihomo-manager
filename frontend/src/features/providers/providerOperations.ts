import { controllerApi, PROVIDER_OPERATION_TIMEOUT_MS } from "../../api/controllerClient.ts"
import type { Json } from "../../shared/types.ts"

import {
  visibleProviderMap,
  type ProviderCategory,
  type ProviderMap,
} from "./collectionViewModel.ts"

const endpointSegment: Record<ProviderCategory, "proxies" | "rules"> = {
  proxy: "proxies",
  rule: "rules",
}

export type CollectionControllerRequest = (
  path: string,
  options?: RequestInit,
  timeoutMs?: number,
) => Promise<Json>

export type ManagedProviderRemovalResult = {
  applied: {
    snapshot: { name: string; sha256: string }
    category: ProviderCategory
  } | null
}

export type ManagedProviderApplyResult = {
  snapshot: { name: string; sha256: string }
  category: ProviderCategory
  runtimeProviders: ProviderMap
  removedNames: string[]
}

export async function finalizeManagedProviderRemoval(
  category: ProviderCategory,
  config: { name: string; sha256: string; path: string } | null,
  runtimeChanged: boolean,
  applyConfig: (config: { name: string; sha256: string }) => Promise<unknown>,
): Promise<ManagedProviderRemovalResult> {
  if (!config || !runtimeChanged) return { applied: null }
  await applyConfig(config)
  return {
    applied: { snapshot: { name: config.name, sha256: config.sha256 }, category },
  }
}

const requestController: CollectionControllerRequest = (path, options, timeoutMs) =>
  controllerApi<Json>(path, options, timeoutMs)

export async function readCollectionProviders(
  category: ProviderCategory,
  signal: AbortSignal,
  request: CollectionControllerRequest = requestController
): Promise<ProviderMap> {
  const data = await request(`/providers/${endpointSegment[category]}`, { signal })
  const rawProviders = data.providers
  const providers =
    rawProviders && typeof rawProviders === "object" && !Array.isArray(rawProviders)
      ? (rawProviders as ProviderMap)
      : {}
  return visibleProviderMap(category, providers)
}

export async function updateCollectionProvider(
  category: ProviderCategory,
  name: string,
  signal: AbortSignal,
  request: CollectionControllerRequest = requestController
) {
  await request(`/providers/${endpointSegment[category]}/${encodeURIComponent(name)}`, {
    method: "PUT",
    signal,
  }, PROVIDER_OPERATION_TIMEOUT_MS)
}

export async function readCollectionProvider(
  category: ProviderCategory,
  name: string,
  signal: AbortSignal,
  request: CollectionControllerRequest = requestController,
): Promise<ProviderMap> {
  // Mihomo exposes an individual GET for proxy providers; rules use its native list.
  const provider = category === "proxy"
    ? await request(`/providers/proxies/${encodeURIComponent(name)}`, { signal })
    : (await readCollectionProviders(category, signal, request))[name]
  if (!provider) throw new Error("当前集合运行状态读取失败")
  return { [name]: provider }
}

export type CollectionProviderRuntimeStatus = "available" | "update-failed" | "failed" | "declared"

export function collectionProviderRuntimeStatus(
  category: ProviderCategory,
  provider: ProviderMap[string] | undefined,
  updateFailed = false,
): CollectionProviderRuntimeStatus {
  const count = Number(provider?.[category === "proxy" ? "proxyCount" : "ruleCount"])
  const payload = provider?.[category === "proxy" ? "proxies" : "rules"]
  const downloaded = typeof provider?.updatedAt === "string" && Date.parse(provider.updatedAt) > 0
  const usable = downloaded || (Number.isFinite(count) ? count > 0 : Array.isArray(payload) && payload.length > 0)
  if (usable) return updateFailed ? "update-failed" : "available"
  return updateFailed ? "failed" : "declared"
}

export function mergeCollectionProviderTargets(
  current: ProviderMap,
  updates: ProviderMap,
) {
  return { ...current, ...updates }
}

export async function updateAndReadCollectionProviderStatuses(
  category: ProviderCategory,
  names: readonly string[],
  signal: AbortSignal,
  update: typeof updateCollectionProvider = updateCollectionProvider,
  read: typeof readCollectionProviders = readCollectionProviders,
) {
  const updateResults = await Promise.allSettled(names.map((name) => update(category, name, signal)))
  const updateFailedNames = new Set(names.filter((_, index) => updateResults[index]?.status === "rejected"))
  try {
    const providers = await read(category, signal)
    const statuses = Object.fromEntries(names.map((name) => [
      name,
      collectionProviderRuntimeStatus(category, providers[name], updateFailedNames.has(name)),
    ])) as Record<string, CollectionProviderRuntimeStatus>
    return { providers, statuses, updateFailedNames, verificationFailed: false as const }
  } catch {
    return {
      statuses: {} as Record<string, CollectionProviderRuntimeStatus>,
      updateFailedNames,
      verificationFailed: true as const,
    }
  }
}

export async function updateCollectionProviders(
  category: ProviderCategory,
  names: readonly string[],
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void = () => undefined,
  update: typeof updateCollectionProvider = updateCollectionProvider,
) {
  let completed = 0
  const results = await Promise.allSettled(names.map(async (name) => {
    try {
      await update(category, name, signal)
    } finally {
      completed += 1
      onProgress(completed, names.length)
    }
  }))
  return {
    success: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length,
  }
}

export async function syncAppliedProviderCategory(
  category: ProviderCategory,
  selectedName: string | undefined,
  invalidateSource: (category: ProviderCategory, name: string) => void,
  loadCategory: (category: ProviderCategory) => Promise<unknown>,
) {
  if (selectedName) invalidateSource(category, selectedName)
  await loadCategory(category)
}

export async function healthCheckCollectionProvider(
  name: string,
  signal: AbortSignal,
  request: CollectionControllerRequest = requestController
) {
  await request(`/providers/proxies/${encodeURIComponent(name)}/healthcheck`, { signal }, PROVIDER_OPERATION_TIMEOUT_MS)
}
