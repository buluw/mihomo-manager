import type { Json } from "@/shared/types"
import type { RuleItem } from "./ruleViewModel.ts"

const RULE_DISPLAY_SNAPSHOT_KEY = "mihomo-rule-display-snapshot:"
const RULE_DISPLAY_SNAPSHOT_VERSION = 2

export type RuleDisplayRecord = {
  id: string
  type: string
  payload: string
  proxy: string
}

export type RuleDisplaySnapshot = {
  version: typeof RULE_DISPLAY_SNAPSHOT_VERSION
  configName: string
  sha256: string
  updatedAt: string
  rules: RuleDisplayRecord[]
}

function browserStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function isSnapshot(value: unknown): value is RuleDisplaySnapshot {
  if (!value || typeof value !== "object") return false
  const snapshot = value as Partial<RuleDisplaySnapshot>
  return snapshot.version === RULE_DISPLAY_SNAPSHOT_VERSION &&
    typeof snapshot.updatedAt === "string" &&
    typeof snapshot.configName === "string" &&
    typeof snapshot.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(snapshot.sha256) &&
    Number.isFinite(Date.parse(snapshot.updatedAt)) &&
    Array.isArray(snapshot.rules) &&
    snapshot.rules.every((rule) =>
      rule != null &&
      typeof rule === "object" &&
      typeof rule.id === "string" &&
      typeof rule.type === "string" &&
      typeof rule.payload === "string" &&
      typeof rule.proxy === "string"
    )
}

export function createRuleDisplaySnapshot(
  configName: string,
  sha256: string,
  rules: Array<Json | RuleItem>,
  now = new Date(),
): RuleDisplaySnapshot {
  return {
    version: RULE_DISPLAY_SNAPSHOT_VERSION,
    configName,
    sha256,
    updatedAt: now.toISOString(),
    rules: rules.map((rule, index) => ({
      id: typeof rule.id === "string" ? rule.id : `${String(rule.type)}\u0000${String(rule.payload)}\u0000${String((rule as Json).proxy)}\u0000${index}`,
      type: String(rule.type || "Unknown"),
      payload: String(rule.payload || ""),
      proxy: String("policy" in rule ? rule.policy || "-" : (rule as Json).proxy || "-"),
    })),
  }
}

export class RuleDisplaySnapshotCache {
  private memory = new Map<string, RuleDisplaySnapshot>()

  read(configName: string, storage: Pick<Storage, "getItem"> | null = browserStorage()) {
    const remembered = this.memory.get(configName)
    if (remembered) return remembered
    if (!storage) return null
    try {
      const raw = storage.getItem(`${RULE_DISPLAY_SNAPSHOT_KEY}${encodeURIComponent(configName)}`)
      if (!raw) return null
      const snapshot: unknown = JSON.parse(raw)
      if (!isSnapshot(snapshot)) return null
      if (snapshot.configName !== configName) return null
      this.memory.set(configName, snapshot)
      return snapshot
    } catch {
      return null
    }
  }

  write(
    configName: string,
    sha256: string,
    rules: Array<Json | RuleItem>,
    now = new Date(),
    storage: Pick<Storage, "setItem"> | null = browserStorage(),
  ) {
    const snapshot = createRuleDisplaySnapshot(configName, sha256, rules, now)
    this.memory.set(configName, snapshot)
    try {
      storage?.setItem(`${RULE_DISPLAY_SNAPSHOT_KEY}${encodeURIComponent(configName)}`, JSON.stringify(snapshot))
    } catch {
      // The in-memory snapshot remains available when persistent storage is unavailable.
    }
    return snapshot
  }
}

export const ruleDisplaySnapshotCache = new RuleDisplaySnapshotCache()

export type RuleSnapshotFrame = {
  cacheHit: boolean
  rules: RuleItem[]
  sha256: string | null
  updatedAt: string | null
}

export function readRuleSnapshotFrame(
  configName: string | null,
  cache: RuleDisplaySnapshotCache = ruleDisplaySnapshotCache,
  storage?: Pick<Storage, "getItem"> | null,
): RuleSnapshotFrame {
  if (!configName) return { cacheHit: false, rules: [], sha256: null, updatedAt: null }
  const snapshot = storage === undefined ? cache.read(configName) : cache.read(configName, storage)
  if (!snapshot) return { cacheHit: false, rules: [], sha256: null, updatedAt: null }
  return {
    cacheHit: true,
    rules: snapshot.rules.map((rule) => ({
      id: rule.id,
      type: rule.type,
      payload: rule.payload,
      policy: rule.proxy,
    })),
    sha256: snapshot.sha256,
    updatedAt: snapshot.updatedAt,
  }
}

export function ruleTargetLoading(cacheHit: boolean, targetResolved: boolean) {
  return !cacheHit && !targetResolved
}
