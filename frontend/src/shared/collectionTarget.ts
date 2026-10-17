import type { ConfigSnapshot } from "../api/configClient.ts"

export type CollectionSource = Pick<ConfigSnapshot, "name" | "sha256">
export type CollectionTarget = {
  source: CollectionSource | null
  invalid: boolean
  category: "proxy" | "rule" | null
  name: string | null
  repair: boolean
}

export type NavigationLocation = { pathname: string; search?: string; state?: unknown; key?: string }
const targetKeys = ["source", "sha256", "category", "collection", "repair"] as const

export function collectionNavigationState(location: Pick<NavigationLocation, "search" | "state">) {
  const params = new URLSearchParams(location.search)
  const state = location.state as { collectionTarget?: unknown } | null
  const stored = state?.collectionTarget
  const metadata: Record<string, string> = {}
  if (targetKeys.some((key) => params.has(key))) {
    for (const key of targetKeys) if (params.has(key)) metadata[key] = params.get(key)!
  } else if (stored != null) {
    if (typeof stored !== "object" || Array.isArray(stored)) metadata.source = ""
    else for (const key of targetKeys) {
      if (key in stored) {
        const value = (stored as Record<string, unknown>)[key]
        metadata[key] = typeof value === "string" ? value : ""
      }
    }
  }
  return { collectionTarget: metadata }
}

export function cleanCollectionLocation(location: NavigationLocation) {
  return { pathname: location.pathname, state: collectionNavigationState(location) }
}

export function readCollectionTarget(location: Pick<NavigationLocation, "search" | "state">): CollectionTarget {
  const params = new URLSearchParams(collectionNavigationState(location).collectionTarget)
  const name = params.get("source")
  const sha256 = params.get("sha256")
  const explicit = params.has("source") || params.has("sha256")
  const valid = Boolean(name && sha256 && /^[a-f0-9]{64}$/i.test(sha256))
  const category = params.get("category")
  return {
    source: valid ? { name: name!, sha256: sha256!.toLowerCase() } : null,
    invalid: explicit && !valid,
    category: category === "proxy" || category === "rule" ? category : null,
    name: params.get("collection"),
    repair: params.get("repair") === "true",
  }
}

export function collectionSourceMatches(snapshot: CollectionSource | null, source: CollectionSource | null) {
  return Boolean(snapshot && source && snapshot.name === source.name && snapshot.sha256 === source.sha256)
}

export function collectionEditLocation(source: CollectionSource, item?: { category: "proxy" | "rule"; name: string; repair?: boolean }) {
  const metadata: Record<string, string> = { source: source.name, sha256: source.sha256 }
  if (item) {
    metadata.category = item.category
    metadata.collection = item.name
    if (item.repair) metadata.repair = "true"
  }
  return { pathname: "/collections", state: { collectionTarget: metadata } }
}

export function configEditLocation(source: CollectionSource) {
  return { pathname: "/config-center", state: { collectionTarget: { source: source.name, sha256: source.sha256 } } }
}

export function configRenameLocation(location: NavigationLocation, from: CollectionSource, to: CollectionSource) {
  const destination = configEditLocation(to)
  return { ...destination, state: { ...destination.state, configRename: { locationKey: location.key, from, to } } }
}

export function isConfigRenameNavigation(current: NavigationLocation, next: NavigationLocation, action?: string) {
  if (action !== "REPLACE" || current.pathname !== "/config-center" || next.pathname !== current.pathname || next.search || !current.key) return false
  const rename = (next.state as { configRename?: { locationKey?: string; from?: CollectionSource; to?: CollectionSource } } | null)?.configRename
  const from = readCollectionTarget(current).source
  const to = readCollectionTarget(next).source
  return Boolean(rename?.locationKey === current.key && from && to && from.name !== to.name &&
    collectionSourceMatches(rename.from ?? null, from) && collectionSourceMatches(rename.to ?? null, to))
}
