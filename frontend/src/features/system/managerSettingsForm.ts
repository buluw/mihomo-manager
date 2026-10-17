import type { ManagerOverrides } from "../../api/configClient.ts"

export type BooleanOverride = "follow" | "enabled" | "disabled"
export type ValueOverride = "follow" | "override"
export type SniffProtocol = "HTTP" | "TLS" | "QUIC"

export type ManagerSettingsForm = {
  mode: "follow" | "rule" | "global" | "direct"
  logLevel: "follow" | "silent" | "error" | "warning" | "info" | "debug"
  ipv6: BooleanOverride
  tcpConcurrent: BooleanOverride
  allowLan: BooleanOverride
  dnsEnable: BooleanOverride
  dnsListenMode: ValueOverride
  dnsListen: string
  dnsNameserverMode: ValueOverride
  dnsNameservers: string
  dnsEnhancedMode: "follow" | "fake-ip" | "redir-host"
  dnsFakeIpFilterMode: ValueOverride
  dnsFakeIpFilter: string
  dnsIpv6: BooleanOverride
  tunEnable: BooleanOverride
  tunStack: "follow" | "system" | "gvisor" | "mixed"
  tunAutoRoute: BooleanOverride
  outboundMode: "follow" | "auto" | "manual" | "system"
  interfaceName: string
  interfaceNameMode: ValueOverride
  autoDetectInterface: BooleanOverride
  tunDnsHijackMode: ValueOverride
  tunDnsHijack: string
  snifferEnable: BooleanOverride
  snifferProtocolsMode: ValueOverride
  sniffProtocols: SniffProtocol[]
  httpPorts: string
  tlsPorts: string
  quicPorts: string
  snifferSkipDomainMode: ValueOverride
  snifferSkipDomain: string
}

function booleanOverride(value: boolean | undefined): BooleanOverride {
  return value === undefined ? "follow" : value ? "enabled" : "disabled"
}

function booleanValue(value: BooleanOverride) {
  return value === "follow" ? undefined : value === "enabled"
}

function lines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function text(value: string[] | undefined) {
  return value?.join("\n") ?? ""
}

function portText(value: (string | number)[] | undefined, fallback: string) {
  return value === undefined ? fallback : value.join("\n")
}

function portList(value: string) {
  return value.split(/[\r\n,/]+/).map((item) => item.trim()).filter(Boolean).map((item) =>
    /^\d+$/.test(item) ? Number(item) : item)
}

function invalidPortList(value: string) {
  return portList(value).some((port) => {
    if (typeof port === "number") return !Number.isInteger(port) || port < 0 || port > 65535
    const match = port.match(/^(\d{1,5})-(\d{1,5})$/)
    if (!match) return true
    const start = Number(match[1])
    const end = Number(match[2])
    return start > end || end > 65535
  })
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stable(item)]))
}

function cleanup(overrides: ManagerOverrides) {
  if (overrides.dns && Object.keys(overrides.dns).length === 0) delete overrides.dns
  if (overrides.tun && Object.keys(overrides.tun).length === 0) delete overrides.tun
  if (overrides.sniffer && Object.keys(overrides.sniffer).length === 0) delete overrides.sniffer
  return overrides
}

function outboundMode(overrides: ManagerOverrides): ManagerSettingsForm["outboundMode"] {
  if (overrides["interface-name"] !== undefined) {
    if (overrides["interface-name"].trim()) return "manual"
    if (overrides.tun?.["auto-detect-interface"] !== undefined) return overrides.tun["auto-detect-interface"] ? "auto" : "system"
  }
  return "follow"
}

export function managerSettingsForm(overrides: ManagerOverrides): ManagerSettingsForm {
  return {
    mode: overrides.mode ?? "follow",
    logLevel: overrides["log-level"] ?? "follow",
    ipv6: booleanOverride(overrides.ipv6),
    tcpConcurrent: booleanOverride(overrides["tcp-concurrent"]),
    allowLan: booleanOverride(overrides["allow-lan"]),
    dnsEnable: booleanOverride(overrides.dns?.enable),
    dnsListenMode: overrides.dns?.listen === undefined ? "follow" : "override",
    dnsListen: overrides.dns?.listen ?? "",
    dnsNameserverMode: overrides.dns?.nameserver === undefined ? "follow" : "override",
    dnsNameservers: text(overrides.dns?.nameserver),
    dnsEnhancedMode: overrides.dns?.["enhanced-mode"] ?? "follow",
    dnsFakeIpFilterMode: overrides.dns?.["fake-ip-filter"] === undefined ? "follow" : "override",
    dnsFakeIpFilter: text(overrides.dns?.["fake-ip-filter"]),
    dnsIpv6: booleanOverride(overrides.dns?.ipv6),
    tunEnable: booleanOverride(overrides.tun?.enable),
    tunStack: overrides.tun?.stack ?? "follow",
    tunAutoRoute: booleanOverride(overrides.tun?.["auto-route"]),
    outboundMode: outboundMode(overrides),
    interfaceName: overrides["interface-name"] ?? "",
    interfaceNameMode: overrides["interface-name"] === undefined ? "follow" : "override",
    autoDetectInterface: booleanOverride(overrides.tun?.["auto-detect-interface"]),
    tunDnsHijackMode: overrides.tun?.["dns-hijack"] === undefined ? "follow" : "override",
    tunDnsHijack: text(overrides.tun?.["dns-hijack"]),
    snifferEnable: booleanOverride(overrides.sniffer?.enable),
    snifferProtocolsMode: overrides.sniffer?.sniff === undefined ? "follow" : "override",
    sniffProtocols: overrides.sniffer?.sniff === undefined
      ? ["HTTP", "TLS", "QUIC"]
      : (["HTTP", "TLS", "QUIC"] as const).filter((protocol) => Object.hasOwn(overrides.sniffer!.sniff!, protocol)),
    httpPorts: portText(overrides.sniffer?.sniff?.HTTP?.ports, ""),
    tlsPorts: portText(overrides.sniffer?.sniff?.TLS?.ports, ""),
    quicPorts: portText(overrides.sniffer?.sniff?.QUIC?.ports, ""),
    snifferSkipDomainMode: overrides.sniffer?.["skip-domain"] === undefined ? "follow" : "override",
    snifferSkipDomain: text(overrides.sniffer?.["skip-domain"]),
  }
}

export function managerOverridesFromForm(base: ManagerOverrides, form: ManagerSettingsForm) {
  const next = structuredClone(base)
  delete next.mode
  delete next["log-level"]
  delete next.ipv6
  delete next["tcp-concurrent"]
  delete next["allow-lan"]
  if (form.mode !== "follow") next.mode = form.mode
  if (form.logLevel !== "follow") next["log-level"] = form.logLevel
  const ipv6 = booleanValue(form.ipv6)
  if (ipv6 !== undefined) next.ipv6 = ipv6
  const tcpConcurrent = booleanValue(form.tcpConcurrent)
  if (tcpConcurrent !== undefined) next["tcp-concurrent"] = tcpConcurrent
  const allowLan = booleanValue(form.allowLan)
  if (allowLan !== undefined) next["allow-lan"] = allowLan

  const dns = { ...next.dns }
  delete dns.enable
  delete dns.listen
  delete dns.nameserver
  delete dns["enhanced-mode"]
  delete dns["fake-ip-filter"]
  delete dns.ipv6

  const enable = booleanValue(form.dnsEnable)
  if (enable !== undefined) dns.enable = enable
  if (form.dnsListenMode === "override") dns.listen = form.dnsListen.trim()
  if (form.dnsNameserverMode === "override") dns.nameserver = lines(form.dnsNameservers)
  if (form.dnsEnhancedMode !== "follow") dns["enhanced-mode"] = form.dnsEnhancedMode
  if (form.dnsFakeIpFilterMode === "override") dns["fake-ip-filter"] = lines(form.dnsFakeIpFilter)
  const dnsIpv6 = booleanValue(form.dnsIpv6)
  if (dnsIpv6 !== undefined) dns.ipv6 = dnsIpv6

  const tun = { ...next.tun }
  delete tun.enable
  delete tun.stack
  delete tun["auto-route"]
  delete tun["auto-detect-interface"]
  delete tun["dns-hijack"]
  delete next["interface-name"]

  const tunEnable = booleanValue(form.tunEnable)
  if (tunEnable !== undefined) tun.enable = tunEnable
  if (form.tunStack !== "follow") tun.stack = form.tunStack
  const autoRoute = booleanValue(form.tunAutoRoute)
  if (autoRoute !== undefined) tun["auto-route"] = autoRoute
  if (form.outboundMode === "auto") {
    tun["auto-detect-interface"] = true
    next["interface-name"] = ""
  } else if (form.outboundMode === "manual") {
    tun["auto-detect-interface"] = false
    next["interface-name"] = form.interfaceName.trim()
  } else if (form.outboundMode === "system") {
    tun["auto-detect-interface"] = false
    next["interface-name"] = ""
  }
  if (form.tunDnsHijackMode === "override") tun["dns-hijack"] = lines(form.tunDnsHijack)

  const sniffer = { ...next.sniffer }
  delete sniffer.enable
  delete sniffer.sniff
  delete sniffer["skip-domain"]
  const snifferEnable = booleanValue(form.snifferEnable)
  if (snifferEnable !== undefined) sniffer.enable = snifferEnable
  if (form.snifferProtocolsMode === "override") {
    const sniff: NonNullable<NonNullable<ManagerOverrides["sniffer"]>["sniff"]> = {}
    for (const protocol of form.sniffProtocols) {
      const values = portList(protocol === "HTTP" ? form.httpPorts : protocol === "TLS" ? form.tlsPorts : form.quicPorts)
      sniff[protocol] = { ports: values }
    }
    sniffer.sniff = sniff
  }
  if (form.snifferSkipDomainMode === "override") sniffer["skip-domain"] = lines(form.snifferSkipDomain)

  next.dns = dns
  next.tun = tun
  next.sniffer = sniffer
  return cleanup(next)
}

export function managerSettingsFormError(form: ManagerSettingsForm) {
  if (form.outboundMode === "manual" && !form.interfaceName.trim()) {
    return "手动出口模式必须填写网卡名称"
  }
  if (form.snifferEnable !== "disabled" && form.snifferProtocolsMode === "override" && form.sniffProtocols.length === 0) {
    return "至少选择一种嗅探协议；停用嗅探请关闭总开关"
  }
  if (form.snifferProtocolsMode === "override") {
    for (const [protocol, value] of [["HTTP", form.httpPorts], ["TLS", form.tlsPorts], ["QUIC", form.quicPorts]] as const) {
      if (!form.sniffProtocols.includes(protocol)) continue
      if (invalidPortList(value)) return `${protocol} 端口范围无效`
    }
  }
  return null
}

export function managerSettingsDirty(
  base: ManagerOverrides,
  form: ManagerSettingsForm,
  saved: ManagerOverrides,
) {
  return JSON.stringify(stable(managerOverridesFromForm(base, form))) !== JSON.stringify(stable(saved))
}
