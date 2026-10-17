import { controllerApi } from "../../api/controllerClient.ts"
import { readAppliedRuntime, type RuntimeLoadState } from "../../api/configClient.ts"
import { operateCoreService, readCoreServiceStatus, readNetworkInterfaces, type HostNetworkInterface } from "../../api/systemClient.ts"
import { sourceSettingsDocument } from "../../shared/managerSettingsSource.ts"
import { confirmedRuntimeSource } from "../../shared/runtimeApplication.ts"
import { coreFailureMessage, readControllerConnection } from "./settingsActions.ts"
import type { Json } from "../../shared/types.ts"

export type TunRuntime = { enabled: boolean; device: string }
export type TunObservation = TunRuntime & { state: "enabled" | "clear" | "residual" | "unconfirmed"; remainingDevices: string[] }

export async function readTunRuntime(signal?: AbortSignal): Promise<TunRuntime> {
  const config = await controllerApi("/configs", { signal })
  return tunRuntimeFromConfig(config)
}

export function tunRuntimeFromConfig(config: Json): TunRuntime {
  if (typeof config.tun?.enable !== "boolean" || typeof config.tun.device !== "string"
    || (config.tun.enable && !config.tun.device.trim())) {
    throw new Error("TUN 运行状态无法确认，请重新读取")
  }
  return { enabled: config.tun.enable, device: config.tun.device }
}

export function outboundInterfaces(interfaces: HostNetworkInterface[]) {
  return interfaces.filter(item => item.kind === "other")
}

export function observeTun(runtime: TunRuntime, interfaces: HostNetworkInterface[], previousDevices: string[] = []): TunObservation {
  const targets = new Set([...previousDevices, runtime.device].filter(device => device.trim()))
  const matches = interfaces.filter(item => targets.has(item.name)).map(item => item.name)
  if (runtime.enabled) return { ...runtime, remainingDevices: matches, state: "enabled" }
  if (matches.length) return { ...runtime, remainingDevices: matches, state: "residual" }
  if (targets.size) return { ...runtime, remainingDevices: [], state: "clear" }

  const tunDevices = interfaces.filter(item => item.kind === "tun").map(item => item.name)
  if (tunDevices.length) return { ...runtime, remainingDevices: tunDevices, state: "residual" }
  const unknownType = interfaces.some(item => item.kind !== "other" && item.kind !== "loopback")
  return { ...runtime, remainingDevices: [], state: unknownType ? "unconfirmed" : "clear" }
}

type AppliedRuntime = { state: RuntimeLoadState; content: string | null }
export function tunStartupKey(applied: AppliedRuntime) {
  if (!confirmedRuntimeSource(applied.state) || !applied.content) throw new Error("已确认的启动配置无法读取；未执行恢复")
  const document = sourceSettingsDocument(applied.content)
  if (!document.tun || typeof document.tun !== "object" || (document.tun as Record<string, unknown>).enable !== false) {
    throw new Error("已确认的启动配置尚未明确关闭 TUN；请先关闭 TUN 并成功应用，未执行恢复")
  }
  const generated = applied.state.lastSuccessful!.generated
  return JSON.stringify([applied.state.version, generated.version, generated.sourceName, generated.sourceSha256,
    generated.settingsVersion, generated.contentSha256])
}

const dependencies = {
  tun: readTunRuntime, interfaces: readNetworkInterfaces, applied: readAppliedRuntime,
  service: readCoreServiceStatus, connection: readControllerConnection, control: operateCoreService,
  wait: (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
}

// This recovery always restarts the fixed service, including while Controller is online.
export async function recoverTunAndRefresh(
  devices: string[], signal: AbortSignal, refresh: () => Promise<void>, services = dependencies,
): Promise<TunObservation | null> {
  const firstKey = tunStartupKey(await services.applied(signal))
  const [tun, interfaces, service] = await Promise.all([services.tun(signal), services.interfaces(signal), services.service(signal)])
  if (signal.aborted) return null
  const before = observeTun(tun, interfaces, devices)
  if (before.enabled) throw new Error("TUN 正在开启，设备存在属于正常状态；未执行恢复")
  if (before.state === "unconfirmed") throw new Error("网卡类型未知，暂时无法确认目标设备是否释放；未执行恢复")
  if (before.state === "clear") return before
  if (service.busy || service.state === "deactivating") throw new Error("核心服务正在执行操作，请稍后重试")
  if (tunStartupKey(await services.applied(signal)) !== firstKey) throw new Error("启动配置或加载版本已变化；请重新核对后再恢复")
  if (signal.aborted) return null
  await services.control("restart", signal)
  for (let attempt = 0; attempt < 15; attempt++) {
    await services.wait(1_000)
    if (signal.aborted) return null
    const [current, connection] = await Promise.all([services.service(signal), services.connection(signal)])
    if (signal.aborted) return null
    if (connection === "authentication-failed") throw new Error("服务已重启，但 Controller 认证失败；恢复尚未确认")
    if (!current.running && current.failure) throw new Error(coreFailureMessage(current) ?? "核心服务启动失败")
    if (!current.running || connection !== "online") continue
    const [nextTun, nextInterfaces, applied] = await Promise.all([services.tun(signal), services.interfaces(signal), services.applied(signal)])
    if (signal.aborted) return null
    if (tunStartupKey(applied) !== firstKey) throw new Error("恢复期间启动配置或加载版本已变化；请重新核对运行状态")
    const after = observeTun(nextTun, nextInterfaces, before.remainingDevices)
    if (after.enabled) throw new Error("服务已重启，但 TUN 仍开启；恢复未完成，请检查运行配置")
    if (after.state === "unconfirmed") throw new Error("服务已重启，但网卡类型未知，暂时无法确认目标设备是否释放")
    if (after.state !== "clear") continue
    await refresh()
    return signal.aborted ? null : after
  }
  throw new Error("服务重启已执行，但服务、Controller、TUN 关闭或设备释放尚未全部确认；请重新读取后处理")
}
