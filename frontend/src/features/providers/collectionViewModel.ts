import { stringify } from "yaml"

export type ProviderCategory = "proxy" | "rule"
export type CollectionSection = ProviderCategory | "managed"

export function selectCollectionSection(
  currentCategory: ProviderCategory,
  section: CollectionSection,
) {
  return section === "managed"
    ? { category: currentCategory, managed: true }
    : { category: section, managed: false }
}

export function collectionEditorValidation(
  workspaceName: string | null,
  activeName: string | null,
  contentError: string | null,
  unavailableError: string | null = null,
) {
  const matches = Boolean(workspaceName && activeName && workspaceName === activeName)
  const error = unavailableError ?? (matches ? contentError : null)
  return { error, canSave: matches && !error }
}

export type CollectionMobileView = "list" | "editor"

export function nextCollectionMobileView(
  _current: CollectionMobileView,
  action: "category" | "edit" | "back"
): CollectionMobileView {
  return action === "edit" ? "editor" : "list"
}

export type CollectionMobileDocument = "yaml" | "payload"

export function nextCollectionMobileDocument(
  current: CollectionMobileDocument,
  action: "edit" | CollectionMobileDocument,
): CollectionMobileDocument {
  if (action === "edit" || action === "yaml") return "yaml"
  return current === "payload" ? current : "payload"
}
export type ProviderAction = "update" | "healthcheck"
export type ProviderPayload = Record<string, unknown>
export type ProviderMap = Record<string, ProviderPayload>

export type ProviderCategorySnapshot = {
  sourceKey: string
  providers: ProviderMap
  loading: boolean
  error?: string
}

export function collectionRuntimeLists(
  sourceKey: string,
  snapshots: Partial<Record<ProviderCategory, ProviderCategorySnapshot>>,
) {
  const providerMaps: Record<ProviderCategory, ProviderMap> = { proxy: {}, rule: {} }
  const loading = new Set<ProviderCategory>()
  const loadErrors: Partial<Record<ProviderCategory, string>> = {}
  for (const category of ["proxy", "rule"] as const) {
    const snapshot = snapshots[category]
    if (!snapshot || snapshot.sourceKey !== sourceKey) {
      loading.add(category)
      continue
    }
    if (snapshot.loading) loading.add(category)
    if (snapshot.error) loadErrors[category] = snapshot.error
    providerMaps[category] = snapshot.providers
  }
  return { providerMaps, loading, loadErrors }
}

export function collectionProviderCounts(
  runtime: boolean,
  providers: Record<ProviderCategory, ProviderMap>,
  managed: Record<ProviderCategory, Array<{ declared: boolean }>>,
) {
  const count = (category: ProviderCategory) => runtime
    ? Object.keys(providers[category]).length
    : managed[category].filter((item) => item.declared).length
  return { proxy: count("proxy"), rule: count("rule") }
}

export function providerActionKey(category: ProviderCategory, name: string) {
  return `${category}:${name}`
}

const sensitiveKey = /authorization|password|secret|token|url/i
const completeUrl = /[a-z][a-z\d+.-]*:\/\/\S+/i
const credentialText = /\b(?:authorization|password|secret|token)\s*[:=]|\bbearer\s+\S+/i

function sanitizeControllerText(value: string) {
  if (completeUrl.test(value)) return "[redacted URL]"
  if (credentialText.test(value)) return "[redacted]"
  return value
}

function sanitizeControllerValue(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "[redacted]"
  if (typeof value === "string") return sanitizeControllerText(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeControllerValue(item))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeControllerValue(entryValue, entryKey),
      ])
    )
  }
  return value
}

function documentText(value: unknown) {
  return stringify(sanitizeControllerValue(value), { lineWidth: 0 })
}

export function visibleProviderMap(
  category: ProviderCategory,
  providers: ProviderMap
) {
  if (category !== "proxy") return providers
  return Object.fromEntries(
    Object.entries(providers).filter(([name, provider]) =>
      name.toLocaleLowerCase() !== "default" &&
      String(provider.vehicleType ?? "").toLowerCase() !== "compatible")
  )
}

export function providerMetadataDocument(name: string, provider: ProviderPayload) {
  const metadata = Object.fromEntries(
    Object.entries(provider).filter(
      ([key]) => !["name", "payload", "proxies", "rules"].includes(key)
    )
  )
  return documentText({ name, ...metadata })
}

export function providerDisplayName(name: string) {
  return sanitizeControllerText(name)
}

export function providerMemberDocument(
  category: ProviderCategory,
  provider: ProviderPayload
) {
  if (category === "proxy") {
    return documentText({
      proxies: Array.isArray(provider.proxies) ? provider.proxies : [],
    })
  }

  if (Array.isArray(provider.rules)) return documentText({ rules: provider.rules })
  if (Array.isArray(provider.payload)) return documentText({ payload: provider.payload })

  const ruleCount = Number(provider.ruleCount)
  return [
    "# Mihomo Controller 未在 Provider 响应中返回规则明细。",
    `ruleCount: ${Number.isFinite(ruleCount) ? ruleCount : 0}`,
  ].join("\n")
}

export function providerSource(provider: ProviderPayload) {
  return sanitizeControllerText(String(provider.vehicleType || provider.type || "Unknown"))
}

export function providerItemCount(
  category: ProviderCategory,
  provider: ProviderPayload
) {
  const value =
    category === "proxy"
      ? Array.isArray(provider.proxies)
        ? provider.proxies.length
        : Number(provider.proxyCount)
      : Array.isArray(provider.rules)
        ? provider.rules.length
        : Array.isArray(provider.payload)
          ? provider.payload.length
          : Number(provider.ruleCount)
  return Number.isFinite(value) ? value : 0
}
