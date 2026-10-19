// 将 Provider 节点并入原生代理映射，并保留稳定的 Provider 身份。
import type { Json } from "../../shared/types";
import type { ProxyAddresses, ProxyMergeSettings, ProxyNodeGroup, ProxyNodeIdentity, ProxyNodeSettings } from "../../api/configClient";
import { proxyIdentityKey } from "./proxyMergeSettings.ts";
import { manualProxyRegion } from "./proxyNodeInfo.ts";
import { directDelayTestUrl } from "../../shared/directDelay.ts";
import { ControllerDelayError, type ControllerDelayFailure } from "../../api/controllerClient.ts";

export const PROXY_DELAY_TEST_URL = "http://www.gstatic.com/generate_204";
export const DIRECT_DELAY_TEST_URL = directDelayTestUrl();

export type ProxyDelaySample = {
  delay: number | null;
  testedAt: number;
  failure?: ControllerDelayFailure;
};

export type ProxySortKey = "name" | "protocol" | "region" | "latency";
export type ProxySortDirection = "asc" | "desc";

export function proxyDelaySample(node: Json | undefined): ProxyDelaySample {
  const history = node?.history;
  if (!Array.isArray(history) || !history.length) return { delay: null, testedAt: 0 };
  const latest = history[history.length - 1];
  const delay = Number(latest?.delay);
  const testedAt = Date.parse(String(latest?.time || ""));
  return {
    delay: delay > 0 ? delay : null,
    testedAt: Number.isFinite(testedAt) ? testedAt : 0,
  };
}

export function displayedProxyDelay(
  node: Json | undefined,
  manual?: ProxyDelaySample,
) {
  return displayedProxyDelaySample(node, manual).delay;
}

export function displayedProxyDelaySample(
  node: Json | undefined,
  manual?: ProxyDelaySample,
) {
  const runtime = proxyDelaySample(node);
  return manual && manual.testedAt > runtime.testedAt ? manual : runtime;
}

export function isDirectProxy(node: Json | undefined) {
  return String(node?.type || "").toLowerCase() === "direct";
}

export function delayTestUrl(node: Json | undefined, directUrl = DIRECT_DELAY_TEST_URL) {
  return isDirectProxy(node)
    ? directUrl
    : PROXY_DELAY_TEST_URL;
}

function delayRequest(endpoint: string, url: string) {
  return `${endpoint}?url=${encodeURIComponent(url)}&timeout=5000`;
}

export function proxyGroupDelayRequest(groupName: string) {
  return delayRequest(
    `/group/${encodeURIComponent(groupName)}/delay`,
    PROXY_DELAY_TEST_URL,
  );
}

export function proxyNodeDelayRequest(
  name: string,
  providerName: string | undefined,
  node: Json | undefined,
  directUrl = DIRECT_DELAY_TEST_URL,
) {
  const endpoint = providerName && providerName !== "default"
    ? `/providers/proxies/${encodeURIComponent(providerName)}/${encodeURIComponent(name)}/healthcheck`
    : `/proxies/${encodeURIComponent(name)}/delay`;
  return delayRequest(endpoint, delayTestUrl(node, directUrl));
}

export function proxyDirectDelayRequest(name: string, directUrl = DIRECT_DELAY_TEST_URL) {
  return delayRequest(
    `/proxies/${encodeURIComponent(name)}/delay`,
    directUrl,
  );
}

export function directProxyNames(
  names: string[],
  proxyMap: Record<string, Json>,
) {
  return names.filter((name) => isDirectProxy(proxyMap[name]));
}

export function proxyAddress(
  name: string,
  providerName: string | undefined,
  addresses: ProxyAddresses,
) {
  return (providerName ? addresses.providers[providerName]?.[name] : addresses.inline[name]) ?? null;
}

export function proxyCountryLabel(address: string | null, addresses: ProxyAddresses) {
  if (!address) return null;
  const country = addresses.countries[address];
  if (!country) return null;
  return formatProxyCountry(country);
}

export function formatProxyCountry(country: { countryCode: string; country: string; region?: string }) {
  const code = country.countryCode.toUpperCase();
  const countryName = ["HK", "TW", "MO"].includes(code) ? "中国"
    : new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(code) || country.country;
  const region = code === "HK" ? "香港" : code === "MO" ? "澳门"
    : (country.region || (code === "TW" ? "台湾" : countryName)).replace(/臺/g, "台");
  return `${code} · ${region} / ${countryName}`;
}

// Group adapters test their selected route; share the same in-flight leaf probe.
export function proxyDelayTarget(name: string, data: Record<string, Json>) {
  const seen = new Set<string>();
  while (!seen.has(name) && typeof data[name]?.now === "string") {
    seen.add(name);
    name = data[name].now;
  }
  return name;
}

export function proxyDelayIdentity(name: string, data: Record<string, Json>, providerByNode: Record<string, string>) {
  const target = proxyDelayTarget(name, data);
  return proxyIdentityKey({ provider: providerByNode[target] || "", name: target });
}

export function uniqueProxyDelayTargets(names: string[], data: Record<string, Json>, providerByNode: Record<string, string>) {
  const targets = new Map<string, { name: string }>();
  for (const name of names) targets.set(proxyDelayIdentity(name, data, providerByNode), { name: proxyDelayTarget(name, data) });
  return [...targets.values()];
}

export function proxyDelayFailure(error: unknown): ControllerDelayFailure {
  if (error instanceof ControllerDelayError) return error.kind;
  return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "api";
}

export function proxyRegionDisplayLabel(region: string | null) {
  return region || "未识别";
}

export function proxyCardRegion(
  name: string,
  providerByNode: Record<string, string>,
  addresses: ProxyAddresses,
  settings: ProxyNodeSettings,
  display: "full" | "code" = "full",
) {
  const manual = manualProxyRegion(settings, { provider: providerByNode[name] || "", name });
  if (manual) return display === "full" ? manual : /^[a-z]{2}$/i.test(manual) ? manual.toUpperCase() : null;

  const address = proxyAddress(name, providerByNode[name], addresses);
  return display === "code"
    ? (address ? addresses.countries[address]?.countryCode.toUpperCase() ?? null : null)
    : proxyCountryLabel(address, addresses);
}

export type ProxyCardModel = {
  key: string;
  label: string;
  members: ProxyNodeGroup["members"];
  provider: string;
  grouped: boolean;
};

export function canSwitchProxyCardProtocol(card: ProxyCardModel, optionCount: number) {
  return card.grouped && optionCount >= 2;
}

export function proxyCardDisplayLabel(card: ProxyCardModel, selectedName: string) {
  return card.label.trim() || selectedName;
}

export function proxyProtocolDisplayName(protocol: string) {
  return protocol.trim().toUpperCase() || "未知";
}

export function isCurrentProxyCard(card: ProxyCardModel, currentName: string | undefined) {
  return card.members.some((member) => member.name === currentName);
}

export function proxyDelayFailureLabel(sample: ProxyDelaySample) {
  if (sample.delay) return null;
  if (sample.failure === "api") return "接口错误";
  return sample.failure || sample.testedAt > 0 ? "嘎了" : null;
}

export function proxyProtocolOptionColumns(name: string, protocol: string, sample: ProxyDelaySample) {
  return {
    name,
    protocol: proxyProtocolDisplayName(protocol),
    delayLabel: sample.delay ? `${sample.delay} ms` : proxyDelayFailureLabel(sample) ?? "---",
  };
}

export function buildProxyCards(
  names: string[],
  proxyMap: Record<string, Json>,
  providerByNode: Record<string, string>,
  addresses: ProxyAddresses,
  settings?: ProxyMergeSettings,
) {
  const namesSet = new Set(names);
  const groupedByMember = new Map<string, ProxyCardModel>();
  settings?.groups.forEach((group) => {
      const members = group.members.flatMap((identity) => {
        const name = identity.name;
        if (
          !namesSet.has(name)
          || (providerByNode[name] || "") !== identity.provider
          || Array.isArray(proxyMap[name]?.all)
        ) return [];
        const known = addresses.groups[identity.provider]?.flatMap((entry) => entry.members)
          .find((member) => member.name === name);
        return [{ name, protocol: known?.protocol || String(proxyMap[name]?.type || "未知"), port: known?.port || "" }];
      });
      if (members.length < 2) return;
      const card = {
        key: `group:${group.id}`,
        label: group.displayName,
        members,
        provider: group.members.every((member) => member.provider === group.members[0]?.provider)
          ? group.members[0]?.provider || ""
          : "",
        grouped: true,
      };
      members.forEach(({ name }) => groupedByMember.set(proxyIdentityKey({ provider: providerByNode[name] || "", name }), card));
  });

  const emitted = new Set<string>();
  return names.flatMap((name) => {
    const grouped = groupedByMember.get(proxyIdentityKey({ provider: providerByNode[name] || "", name }));
    if (grouped) {
      if (emitted.has(grouped.key)) return [];
      emitted.add(grouped.key);
      return [grouped];
    }
    return [{
      key: `node:${name}`,
      label: name,
      members: [{ name, protocol: String(proxyMap[name]?.type || "未知"), port: "" }],
      provider: providerByNode[name] || "",
      grouped: false,
    }];
  });
}

export function proxyCardPreferenceKey(provider: string, proxyGroup: string, cardKey: string) {
  return `proxy-card-selection:${provider}:${proxyGroup}:${cardKey}`;
}

export function selectedProxyCardNode(
  card: ProxyCardModel,
  current: string,
  preferred: string | null,
) {
  const names = card.members.map(({ name }) => name);
  return names.includes(current) ? current : preferred && names.includes(preferred) ? preferred : names[0] || "";
}

export function actualProxyLeafName(
  proxyMap: Record<string, Json>,
  rootName: string,
) {
  let current = rootName;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const entry = proxyMap[current];
    if (!entry) return null;
    if (!Array.isArray(entry.all)) return current;
    const next = String(entry.now || "");
    if (!next || !entry.all.map(String).includes(next)) return null;
    current = next;
  }
  return null;
}

export function proxyNodeInfoTarget(
  proxyMap: Record<string, Json>,
  rootName: string,
  providerByNode: Record<string, string>,
  available: ProxyNodeIdentity[],
  ambiguousProviderNodes: ReadonlySet<string> = new Set(),
) {
  const name = actualProxyLeafName(proxyMap, rootName);
  if (!name) return null;
  if (ambiguousProviderNodes.has(name)) return null;
  const key = proxyIdentityKey({ provider: providerByNode[name] || "", name });
  return available.find((candidate) => proxyIdentityKey(candidate) === key) ?? null;
}

export function measurableProxyCardMembers(
  card: ProxyCardModel,
  proxyMap: Record<string, Json>,
  providerByNode: Record<string, string>,
) {
  const seen = new Set<string>();
  return card.members.flatMap((member) => {
    const identity = proxyIdentityKey({ provider: providerByNode[member.name] || "", name: member.name });
    if (seen.has(identity) || !proxyMap[member.name] || Array.isArray(proxyMap[member.name]?.all)) return [];
    seen.add(identity);
    return [{ name: member.name, provider: providerByNode[member.name] || "" }];
  });
}

export async function runProxyCardDelayTests<T extends { name: string }>(
  members: T[],
  request: (member: T) => Promise<number>,
) {
  let succeeded = 0;
  let cancelled = 0;
  const failures: Record<ControllerDelayFailure, number> = { timeout: 0, api: 0, unreachable: 0 };
  await Promise.allSettled(members.map(async (member) => {
    try {
      const delay = await request(member);
      if (!(delay > 0)) throw new ControllerDelayError("unreachable");
      succeeded++;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") { cancelled++; return; }
      const failure = proxyDelayFailure(error);
      failures[failure]++;
    }
  }));
  return { succeeded, failed: failures.timeout + failures.api + failures.unreachable, failures, cancelled };
}

export function setProxyGroupSelection(
  proxyMap: Record<string, Json>,
  group: string,
  name: string,
) {
  return {
    ...proxyMap,
    [group]: { ...proxyMap[group], now: name },
  };
}

export function applyPendingProxySelections(
  proxyMap: Record<string, Json>,
  pendingSelections: Record<string, string>,
) {
  return Object.entries(pendingSelections).reduce(
    (current, [group, selection]) => (
      current[group]
        ? setProxyGroupSelection(current, group, selection)
        : current
    ),
    proxyMap,
  );
}

export function listProxyGroups(proxyMap: Record<string, Json>, declaredOrder: readonly string[] = []) {
  const positions = new Map(declaredOrder.map((name, index) => [name, index]));
  return (Object.values(proxyMap).filter((proxy) => Array.isArray(proxy.all)) as Json[])
    .sort((left, right) => {
      if (left.name === "GLOBAL") return 1;
      if (right.name === "GLOBAL") return -1;
      return (positions.get(String(left.name)) ?? declaredOrder.length)
        - (positions.get(String(right.name)) ?? declaredOrder.length);
    });
}

export function sortProxyCards(
  cards: ProxyCardModel[],
  sortKey: ProxySortKey,
  direction: ProxySortDirection,
  selectedNode: (card: ProxyCardModel) => string,
  proxyMap: Record<string, Json>,
  providerByNode: Record<string, string>,
  addresses: ProxyAddresses,
  nodeSettings: ProxyNodeSettings,
  delays: Record<string, ProxyDelaySample>,
) {
  return [...cards].sort((left, right) => {
    const leftName = selectedNode(left);
    const rightName = selectedNode(right);
    const values: Record<ProxySortKey, [string | number, string | number]> = {
      name: [proxyCardDisplayLabel(left, leftName), proxyCardDisplayLabel(right, rightName)],
      protocol: [String(proxyMap[leftName]?.type || ""), String(proxyMap[rightName]?.type || "")],
      region: [
        proxyCardRegion(leftName, providerByNode, addresses, nodeSettings) || "",
        proxyCardRegion(rightName, providerByNode, addresses, nodeSettings) || "",
      ],
      latency: [
        displayedProxyDelay(proxyMap[leftName], delays[proxyDelayTarget(leftName, proxyMap)]) ?? Number.MAX_SAFE_INTEGER,
        displayedProxyDelay(proxyMap[rightName], delays[proxyDelayTarget(rightName, proxyMap)]) ?? Number.MAX_SAFE_INTEGER,
      ],
    };
    const [a, b] = values[sortKey];
    const result = typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), "zh-CN");
    return direction === "asc" ? result : -result;
  });
}

export function mergeProxyProviderNodes(
  proxyMap: Record<string, Json>,
  providers: Record<string, Json>,
) {
  const proxies = { ...proxyMap };
  const providerByNode: Record<string, string> = Object.fromEntries(
    Object.keys(proxyMap).map((name) => [name, "default"]),
  );
  const ambiguousProviderNodes = new Set<string>();
  Object.entries(providers).forEach(([providerName, provider]) => {
    // Compatible group views repeat top-level nodes; only default owns them.
    if (provider.vehicleType === "Compatible" && providerName !== "default") return;
    const nodes = Array.isArray(provider?.proxies) ? provider.proxies : [];
    nodes.forEach((node: Json) => {
      const name = String(node?.name || "");
      if (!name) return;
      if (providerByNode[name] && providerByNode[name] !== providerName) {
        ambiguousProviderNodes.add(name);
      }
      // Select the displayed node and its owner together; native/default wins.
      if (!providerByNode[name] || providerName === "default") {
        proxies[name] = { ...node, ...proxyMap[name] };
        providerByNode[name] = providerName;
      }
    });
  });
  return { proxies, providerByNode, ambiguousProviderNodes };
}
