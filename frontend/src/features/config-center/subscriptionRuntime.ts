import { isMap, parseDocument } from "yaml"
import { listManagedProviderFiles, readAppliedRuntime, readRuntimeLoadState, type updateSubscriptionProvider } from "../../api/configClient.ts"
import { ControllerError, controllerApi } from "../../api/controllerClient.ts"
import { confirmedRuntimeSource } from "../../shared/runtimeApplication.ts"

type UpdatedProvider = Awaited<ReturnType<typeof updateSubscriptionProvider>>
export type SubscriptionRuntimeTarget =
  | { status: "matched"; names: string[] }
  | { status: "unreferenced" | "unknown"; names?: never }
export type SubscriptionRefreshStatus = "not-required" | "unreferenced" | "unknown" | "refreshed"

// Only compare explicit paths in the same namespace. Unresolved absolute/relative
// aliases remain unknown instead of guessing the Core's working directory.
function fileReference(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null
  const parts = value.replaceAll("\\", "/").split("/")
  if (parts.includes("..")) return null
  return (value.startsWith("/") ? "/" : "") + parts.filter(part => part && part !== ".").join("/")
}

export async function readSubscriptionRuntimeTargets(
  id: string,
  result: UpdatedProvider,
  readers = {
    applied: readAppliedRuntime,
    files: listManagedProviderFiles,
    state: readRuntimeLoadState,
    providers: () => controllerApi<{ providers: Record<string, { vehicleType?: string }> }>("/providers/proxies"),
  },
): Promise<SubscriptionRuntimeTarget> {
  try {
    const path = fileReference(result.providerPath)
    if (!path || !result.providerSha256) return { status: "unknown" }
    const applied = await readers.applied()
    if (!confirmedRuntimeSource(applied.state) || applied.content === null) return { status: "unknown" }
    const document = parseDocument(applied.content)
    if (document.errors.length) return { status: "unknown" }
    const declarations = document.get("proxy-providers", true)
    if (declarations == null) return { status: "unreferenced" }
    if (!isMap(declarations)) return { status: "unknown" }
    const names: string[] = []
    let unresolved = false
    for (const item of declarations.items) {
      if (!isMap(item.value)) { unresolved = true; continue }
      const declaration = item.value
      if (declaration.get("type") !== "file") continue
      const reference = fileReference(declaration.get("path"))
      if (!reference || reference.startsWith("/") !== path.startsWith("/")) { unresolved = true; continue }
      if (reference === path) names.push(String(item.key))
    }
    if (!names.length) return { status: unresolved ? "unknown" : "unreferenced" }
    const [files, runtime] = await Promise.all([readers.files(), readers.providers()])
    const owned = files.find(file => file.category === "proxy" && file.source === "subscription"
      && file.ownerId === id && fileReference(file.referencePath) === path && file.sha256 === result.providerSha256)
    if (!owned || names.some(name => runtime.providers?.[name]?.vehicleType !== "File")) return { status: "unknown" }
    const state = await readers.state()
    if (!confirmedRuntimeSource(state) || state.version !== applied.state.version
      || state.lastSuccessful?.generated.contentSha256 !== applied.state.lastSuccessful?.generated.contentSha256) return { status: "unknown" }
    return { status: "matched", names }
  } catch {
    return { status: "unknown" }
  }
}

export function subscriptionRefreshMessage(result: { nodeCount: number; runtimeRefresh: SubscriptionRefreshStatus }) {
  const saved = `订阅已更新，共 ${result.nodeCount} 个节点`
  if (result.runtimeRefresh === "refreshed") return `${saved}；运行中的代理集合已刷新`
  if (result.runtimeRefresh === "unknown") return `${saved}；运行集合身份未确认，未刷新`
  if (result.runtimeRefresh === "unreferenced") return `${saved}；已记录运行配置未引用本次集合文件`
  return saved
}

export function providerRefreshFailureMessage(cause: unknown) {
  const detail = cause instanceof ControllerError ? `Controller HTTP ${cause.status}`
    : cause instanceof Error && cause.name === "TimeoutError" ? "Controller 请求超时"
    : cause instanceof Error && cause.message === "Controller 连接失败" ? "Controller 连接失败"
    : "Controller 刷新请求失败"
  return `订阅已更新，但运行中的代理集合刷新失败（${detail}）`
}
