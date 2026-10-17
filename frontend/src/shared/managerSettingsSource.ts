import { parseDocument } from "yaml"
import type { ManagerOverrides } from "../api/configClient.ts"

// Audited DefaultRawConfig/parseSniffer in the exact official tags; see docs/requirements/settings-defaults.md.
const officialBinaries: Record<string, string> = {
  "v1.19.29": "bd2a08ae155b7dffc12a1bdf610ff5f17c45058414a1d2c562e28eb9309abff6",
  "v1.19.31": "b341a765412c192685264e038a6aad2ac1c67c12b8aceeb5c6f64955cf43f5ed",
}
export function coreSettingsDefaults(core: { version: string; sha256: string } | null): ManagerOverrides | null {
  if (!core || officialBinaries[core.version] !== core.sha256) return null
  return {
    mode: "rule", "log-level": "info", ipv6: true, "tcp-concurrent": false, "allow-lan": false,
    dns: { enable: false, listen: "", ipv6: false, "enhanced-mode": "redir-host",
      nameserver: ["https://doh.pub/dns-query", "tls://223.5.5.5:853"],
      "fake-ip-filter": ["dns.msftnsci.com", "www.msftnsci.com", "www.msftconnecttest.com"] },
    tun: { enable: false, stack: "gvisor", "auto-route": true, "auto-detect-interface": true, "dns-hijack": ["0.0.0.0:53"] },
    "interface-name": "", sniffer: { enable: false, sniff: {}, "skip-domain": [] },
  }
}

export function sourceSettingsDocument(content: string): Record<string, unknown> {
  const doc = parseDocument(content, { merge: true })
  if (doc.errors.length) throw new Error("所选源 YAML 无法解析；未使用运行参数代替")
  let source: unknown
  try { source = doc.toJS({ maxAliasCount: 100 }) } catch { throw new Error("所选源 YAML 无法解析；未使用运行参数代替") }
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("所选源 YAML 必须是配置映射")
  return source as Record<string, unknown>
}
