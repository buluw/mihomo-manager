import type { ManagerOverrides } from "../../api/configClient.ts"
import { managerOverridesFromForm, managerSettingsForm, type ManagerSettingsForm } from "./managerSettingsForm.ts"

export const settingGroups = {
  mode: ["mode"], logLevel: ["logLevel"], ipv6: ["ipv6"], tcpConcurrent: ["tcpConcurrent"], allowLan: ["allowLan"],
  dnsEnable: ["dnsEnable"], dnsListen: ["dnsListenMode", "dnsListen"], dnsNameservers: ["dnsNameserverMode", "dnsNameservers"],
  dnsEnhancedMode: ["dnsEnhancedMode"], dnsFakeIpFilter: ["dnsFakeIpFilterMode", "dnsFakeIpFilter"], dnsIpv6: ["dnsIpv6"],
  tunEnable: ["tunEnable"], tunStack: ["tunStack"], tunAutoRoute: ["tunAutoRoute"],
  outboundMode: ["outboundMode", "interfaceName", "interfaceNameMode", "autoDetectInterface"], tunDnsHijack: ["tunDnsHijackMode", "tunDnsHijack"],
  snifferEnable: ["snifferEnable"], sniffProtocols: ["snifferProtocolsMode", "sniffProtocols", "httpPorts", "tlsPorts", "quicPorts"],
  snifferSkipDomain: ["snifferSkipDomainMode", "snifferSkipDomain"],
} as const satisfies Record<string, readonly (keyof ManagerSettingsForm)[]>
export type SettingGroup = keyof typeof settingGroups
export function settingIsExplicit(form: ManagerSettingsForm, group: SettingGroup) {
  if (group === "outboundMode") return form.interfaceNameMode === "override" || form.autoDetectInterface !== "follow"
  return form[settingGroups[group][0]] !== "follow"
}
export function restoreSetting(form: ManagerSettingsForm, group: SettingGroup): ManagerSettingsForm {
  const empty = managerSettingsForm({})
  return { ...form, ...Object.fromEntries(settingGroups[group].map(key => [key, empty[key]])) }
}
export function editSetting(draft: ManagerSettingsForm, effective: ManagerSettingsForm, group: SettingGroup, patch: Partial<ManagerSettingsForm>) {
  const fields = Object.fromEntries(settingGroups[group].map(key => [key, effective[key]]))
  const mode = settingGroups[group][0]
  if (mode.endsWith("Mode") && !["outboundMode", "dnsEnhancedMode"].includes(mode)) fields[mode] = "override"
  const next = { ...draft, ...fields, ...patch } as ManagerSettingsForm
  if (group === "outboundMode") {
    next.interfaceNameMode = "override"
    next.autoDetectInterface = next.outboundMode === "auto" ? "enabled" : "disabled"
    if (next.outboundMode !== "manual") next.interfaceName = ""
  }
  return next
}

const fieldPaths: Record<Exclude<SettingGroup, "outboundMode" | "sniffProtocols">, string[]> = {
  mode: ["mode"], logLevel: ["log-level"], ipv6: ["ipv6"], tcpConcurrent: ["tcp-concurrent"], allowLan: ["allow-lan"],
  dnsEnable: ["dns", "enable"], dnsListen: ["dns", "listen"], dnsNameservers: ["dns", "nameserver"],
  dnsEnhancedMode: ["dns", "enhanced-mode"], dnsFakeIpFilter: ["dns", "fake-ip-filter"], dnsIpv6: ["dns", "ipv6"],
  tunEnable: ["tun", "enable"], tunStack: ["tun", "stack"], tunAutoRoute: ["tun", "auto-route"], tunDnsHijack: ["tun", "dns-hijack"],
  snifferEnable: ["sniffer", "enable"], snifferSkipDomain: ["sniffer", "skip-domain"],
}
const choices: Partial<Record<SettingGroup, string[]>> = { mode: ["rule", "global", "direct"], logLevel: ["silent", "error", "warning", "info", "debug"], dnsEnhancedMode: ["fake-ip", "redir-host"], tunStack: ["system", "gvisor", "mixed"] }
const booleanGroups = new Set(["ipv6", "tcpConcurrent", "allowLan", "dnsEnable", "dnsIpv6", "tunEnable", "tunAutoRoute", "snifferEnable"])
const stringGroups = new Set(["dnsListen"])
const map = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value))
const at = (value: unknown, path: string[]): unknown => {
  for (const key of path) { if (value == null) return value; if (!map(value)) return null; value = value[key] }
  return value
}
const valid = (group: SettingGroup, value: unknown) => choices[group] ? choices[group]!.includes(String(value))
  : booleanGroups.has(group) ? typeof value === "boolean" : stringGroups.has(group) ? typeof value === "string"
    : Array.isArray(value) && value.every(item => typeof item === "string")

export function managerDraftOverrides(base: ManagerOverrides, draft: ManagerSettingsForm, edited: ReadonlySet<SettingGroup>): ManagerOverrides {
  const result = structuredClone(base) as Record<string, unknown>
  const converted = managerOverridesFromForm(base, draft)
  for (const group of edited) {
    const paths = group === "outboundMode" ? [["interface-name"], ["tun", "auto-detect-interface"]]
      : group === "sniffProtocols" ? [["sniffer", "sniff"]] : [fieldPaths[group]]
    for (const path of paths) {
      const value = at(converted, path)
      const parent = path.length === 1 ? result : (result[path[0]!] ??= {}) as Record<string, unknown>
      const key = path.at(-1)!
      if (value === undefined) delete parent[key]
      else parent[key] = structuredClone(value)
      if (path.length > 1 && Object.keys(parent).length === 0) delete result[path[0]!]
    }
  }
  return result as ManagerOverrides
}
export function settingsValuesEqual(left: ManagerOverrides, right: ManagerOverrides) {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : map(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}

export function resolveSettingsValues(draft: ManagerSettingsForm, source: Record<string, unknown>, defaults: ManagerOverrides | null) {
  const resolved: Record<string, unknown> = {}
  const known = new Set<SettingGroup>()
  const inherited = (path: string[]) => { const value = at(source, path); return value === undefined ? at(defaults, path) : value }
  for (const [group, path] of Object.entries(fieldPaths) as Array<[SettingGroup, string[]]>) {
    const value = inherited(path)
    if (value === undefined || !valid(group, value)) continue
    known.add(group)
    if (path.length === 1) resolved[path[0]!] = value
    else { const parent = (resolved[path[0]!] ??= {}) as Record<string, unknown>; parent[path[1]!] = value }
  }
  // Each persisted field inherits separately; the combined UI mode is derived afterwards.
  const name = draft.interfaceNameMode === "override" ? draft.interfaceName : inherited(["interface-name"])
  const auto = draft.autoDetectInterface === "follow" ? inherited(["tun", "auto-detect-interface"]) : draft.autoDetectInterface === "enabled"
  if (typeof name === "string" && (name.trim() || typeof auto === "boolean")) {
    known.add("outboundMode"); resolved["interface-name"] = name
    const tun = (resolved.tun ??= {}) as Record<string, unknown>; tun["auto-detect-interface"] = auto
  }
  let sniff = inherited(["sniffer", "sniff"])
  const legacy = at(source, ["sniffer", "sniffing"])
  if ((!map(sniff) || Object.keys(sniff).length === 0) && legacy !== undefined) {
    sniff = Array.isArray(legacy) && legacy.every(item => ["HTTP", "TLS", "QUIC"].includes(String(item).toUpperCase()))
      ? Object.fromEntries(legacy.map(item => [String(item).toUpperCase(), { ports: at(source, ["sniffer", "ports"]) ?? [] }])) : null
  }
  if (map(sniff) && Object.entries(sniff).every(([key, value]) => ["HTTP", "TLS", "QUIC"].includes(key) && map(value)
    && (value.ports === undefined || Array.isArray(value.ports) && value.ports.every(item => typeof item === "number" || typeof item === "string")))) {
    known.add("sniffProtocols")
    const sniffer = (resolved.sniffer ??= {}) as Record<string, unknown>
    sniffer.sniff = Object.fromEntries(Object.entries(sniff).map(([key, value]) => [key, { ports: (value as Record<string, unknown>).ports ?? [] }]))
  }
  const form = managerSettingsForm(resolved as ManagerOverrides)
  // Keep the user's manual selection while its required name is still being edited.
  if (draft.outboundMode === "manual") form.outboundMode = "manual"
  if (!known.has("sniffProtocols")) form.sniffProtocols = []
  // Disabled/missing protocol ports are unspecified, never invented recommended ports.
  for (const [protocol, key] of [["HTTP", "httpPorts"], ["TLS", "tlsPorts"], ["QUIC", "quicPorts"]] as const) {
    if (!form.sniffProtocols.includes(protocol)) form[key] = ""
  }
  const explicit = new Set<SettingGroup>()
  for (const group of Object.keys(settingGroups) as SettingGroup[]) {
    if (!settingIsExplicit(draft, group)) continue
    if (group === "outboundMode") { explicit.add(group); continue }
    known.add(group); explicit.add(group)
    Object.assign(form, Object.fromEntries(settingGroups[group].map(key => [key, draft[key]])))
  }
  return { form, known, explicit }
}
