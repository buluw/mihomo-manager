import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parse } from "yaml";
import type { RuntimeLoadState } from "../managerSettings/service.js";

type JsonMap = Record<string, unknown>;

export interface ProxyAddresses {
  source?: ProxyAddressSource;
  inline: Record<string, string>;
  providers: Record<string, Record<string, string>>;
  groups: Record<string, ProxyNodeGroup[]>;
  countries: Record<string, ProxyCountry>;
}

export interface ProxyAddressSource {
  name: string;
  sha256: string;
  generatedVersion: string;
  loadVersion: number;
}

export class ProxyAddressSourceError extends Error {}

export function proxyAddressSource(applied: { state: RuntimeLoadState; content: string | null }) {
  const { state, content } = applied;
  const generated = state.lastSuccessful?.generated;
  if (!generated || content === null || !state.lastAttempt || ["pending", "unknown"].includes(state.lastAttempt.status)) {
    throw new ProxyAddressSourceError("节点来源无法确认，请选择配置并成功加载后重试");
  }
  return { content, source: {
    name: generated.sourceName, sha256: generated.sourceSha256,
    generatedVersion: generated.version, loadVersion: state.version,
  } };
}

export interface ProxyCountry {
  countryCode: string;
  country: string;
  region?: string;
  ip?: string;
  updatedAt: string;
}

export interface ProxyNodeGroup {
  suffix: string;
  members: Array<{ name: string; protocol: string; port: string }>;
}

export interface ProxyNodeIdentity {
  provider: string;
  name: string;
}

export interface ProxyAddressReaderOptions {
  readSource: () => Promise<{ content: string; source?: ProxyAddressSource }>;
  dataDir: string;
  providerDir: string;
  countryCachePath: string;
  countryLookupTimeoutMs?: number;
  resolveAddress?: (host: string) => Promise<string>;
  lookupCountry?: (ip: string) => Promise<Omit<ProxyCountry, "updatedAt">>;
}

function objectValue(value: unknown): JsonMap | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonMap
    : null;
}

const SELF_HOSTED_PREFIXES = [
  { prefix: "vless-reality-vision-", protocol: "VLESS", credential: "uuid" },
  { prefix: "vless-", protocol: "VLESS", credential: "uuid" },
  { prefix: "vmess-ws-", protocol: "VMess", credential: "uuid" },
  { prefix: "hysteria2-", protocol: "Hysteria2", credential: "password" },
  { prefix: "tuic5-", protocol: "TUIC", credential: "uuid" },
  { prefix: "anytls-", protocol: "AnyTLS", credential: "password" },
] as const;

type ProxyGroupCandidate = {
  credential: string;
  name: string;
  port: string;
  protocol: string;
  suffix: string;
};

function normalizedPort(value: unknown) {
  const port = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535 ? port : "";
}

function normalizeSuffix(suffix: string, protocol: string, port: string) {
  if (protocol !== "VMess" || !port) return suffix;
  const parts = suffix.split("-");
  const portIndex = parts.findIndex((part, index) => part === port && index < parts.length - 1);
  if (portIndex >= 0) parts.splice(portIndex, 1);
  return parts.join("-");
}

function proxyMetadataFrom(value: unknown) {
  const addresses: Record<string, string> = {};
  const candidates: ProxyGroupCandidate[] = [];
  if (!Array.isArray(value)) return { addresses, candidates };
  for (const entry of value) {
    const proxy = objectValue(entry);
    const name = typeof proxy?.name === "string" ? proxy.name.trim() : "";
    const server = typeof proxy?.server === "string" ? proxy.server.trim() : "";
    if (name && server) addresses[name] = server;
    const definition = SELF_HOSTED_PREFIXES.find(({ prefix }) => name.startsWith(prefix));
    if (!definition) continue;
    const credentialValue = proxy?.[definition.credential];
    const credential = typeof credentialValue === "string" ? credentialValue.trim() : "";
    const port = normalizedPort(proxy?.port);
    const suffix = normalizeSuffix(name.slice(definition.prefix.length), definition.protocol, port);
    if (!credential || !port || !suffix) continue;
    candidates.push({ credential, name, port, protocol: definition.protocol, suffix });
  }
  return { addresses, candidates };
}

function groupsFrom(candidates: ProxyGroupCandidate[]) {
  const grouped = new Map<string, ProxyGroupCandidate[]>();
  candidates.forEach((candidate) => {
    const key = `${candidate.credential}\u0000${candidate.suffix}`;
    grouped.set(key, [...(grouped.get(key) || []), candidate]);
  });
  return [...grouped.values()]
    .filter((members) => members.length > 1)
    .map((members) => ({
      suffix: members[0]?.suffix || "",
      members: members.map(({ name, protocol, port }) => ({ name, protocol, port })),
    }));
}

function isWithin(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function providerAddresses(path: string) {
  try {
    const parsed = objectValue(parse(await readFile(path, "utf8")));
    return proxyMetadataFrom(parsed?.proxies);
  } catch {
    return { addresses: {}, candidates: [] };
  }
}

function isPublicIp(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [first = 0, second = 0] = parts;
    return !(
      first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && [0, 168].includes(second)) ||
      (first === 198 && [18, 19, 51].includes(second)) ||
      (first === 203 && second === 0)
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPublicIp(normalized.slice(7));
    return normalized !== "::" && normalized !== "::1" &&
      !normalized.startsWith("fc") && !normalized.startsWith("fd") &&
      !normalized.startsWith("fe8") && !normalized.startsWith("fe9") &&
      !normalized.startsWith("fea") && !normalized.startsWith("feb") &&
      !normalized.startsWith("2001:db8");
  }
  return false;
}

async function resolvePublicAddress(host: string) {
  if (isIP(host)) return isPublicIp(host) ? host : "";
  const result = await lookup(host, { family: 0 });
  return isPublicIp(result.address) ? result.address : "";
}

export function proxyCountryLookupUrl(ip: string) {
  return `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN`;
}

async function requestCountry(ip: string, timeoutMs: number) {
  const response = await fetch(proxyCountryLookupUrl(ip), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("country lookup failed");
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > 32 * 1024) throw new Error("country response too large");
  const text = await response.text();
  if (text.length > 32 * 1024) throw new Error("country response too large");
  const payload: unknown = JSON.parse(text);
  const value = objectValue(payload);
  const countryCode = typeof value?.countryCode === "string" ? value.countryCode.toUpperCase() : "";
  const country = typeof value?.country === "string" ? value.country.trim() : "";
  const city = typeof value?.city === "string" ? value.city.trim() : "";
  if (value?.status !== "success" || !/^[A-Z]{2}$/.test(countryCode) || !country || country.length > 80) {
    throw new Error("country lookup unavailable");
  }
  return {
    countryCode,
    country,
    ...(city ? { region: city.slice(0, 80) } : {}),
  };
}

async function readCountryCache(path: string) {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const entries = objectValue(objectValue(parsed)?.entries);
    const countries: Record<string, ProxyCountry> = {};
    for (const [address, entryValue] of Object.entries(entries || {})) {
      const entry = objectValue(entryValue);
      if (
        typeof entry?.countryCode === "string" && /^[A-Z]{2}$/.test(entry.countryCode) &&
        typeof entry.country === "string" && entry.country.length <= 80 &&
        (entry.region === undefined || (typeof entry.region === "string" && entry.region.length <= 80)) &&
        (entry.ip === undefined || (typeof entry.ip === "string" && isIP(entry.ip))) &&
        typeof entry.updatedAt === "string"
      ) countries[address] = entry as unknown as ProxyCountry;
    }
    return countries;
  } catch {
    return {};
  }
}

async function writeCountryCache(path: string, entries: Record<string, ProxyCountry>) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export class ProxyAddressReader {
  private readonly refreshing = new Map<number | undefined, Promise<{ addresses: ProxyAddresses; recognized: number; failed: number }>>();
  private countryMutationTail: Promise<void> = Promise.resolve();
  private readonly countryLookups = new Map<string, Promise<Omit<ProxyCountry, "updatedAt">>>();
  private countryRequestTimes: number[] = [];

  constructor(private readonly options: ProxyAddressReaderOptions) {}

  private mutateCountryCache(delta: Record<string, ProxyCountry>) {
    const mutation = this.countryMutationTail.then(async () => {
      const current = await readCountryCache(this.options.countryCachePath);
      const next = { ...current, ...delta };
      await writeCountryCache(this.options.countryCachePath, next);
      return next;
    });
    this.countryMutationTail = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  private async lookupCountry(ip: string) {
    const existing = this.countryLookups.get(ip);
    if (existing) return existing;
    const lookup = (async () => {
      while (true) {
        const now = Date.now();
        this.countryRequestTimes = this.countryRequestTimes.filter((time) => now - time < 60_000);
        if (this.countryRequestTimes.length < 45) {
          this.countryRequestTimes.push(now);
          break;
        }
        const waitMs = Math.max(1, 60_000 - (now - (this.countryRequestTimes[0] ?? now)));
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      const lookupCountry = this.options.lookupCountry || ((value: string) => requestCountry(value, this.options.countryLookupTimeoutMs || 5_000));
      return lookupCountry(ip);
    })();
    this.countryLookups.set(ip, lookup);
    try {
      return await lookup;
    } finally {
      if (this.countryLookups.get(ip) === lookup) this.countryLookups.delete(ip);
    }
  }

  private async readAddresses(expectedLoadVersion?: number): Promise<Omit<ProxyAddresses, "countries">> {
    const { content, source } = await this.options.readSource();
    if (expectedLoadVersion !== undefined && source?.loadVersion !== expectedLoadVersion) {
      throw new ProxyAddressSourceError("节点来源已变化，请刷新后再识别");
    }
    const config = objectValue(parse(content));
    const inline = proxyMetadataFrom(config?.proxies);
    const result: Omit<ProxyAddresses, "countries"> = {
      ...(source ? { source } : {}),
      inline: inline.addresses,
      providers: {},
      groups: {},
    };
    // Controller exposes top-level proxies through its built-in default provider.
    if (Object.keys(inline.addresses).length) result.providers.default = inline.addresses;
    const inlineGroups = groupsFrom(inline.candidates);
    if (inlineGroups.length) result.groups.default = inlineGroups;
    const providers = objectValue(config?.["proxy-providers"]);
    if (!providers) return result;

    await Promise.all(Object.entries(providers).map(async ([providerName, value]) => {
      const provider = objectValue(value);
      const inlineProvider = proxyMetadataFrom(provider?.payload);
      if (Object.keys(inlineProvider.addresses).length > 0) {
        result.providers[providerName] = inlineProvider.addresses;
        const groups = groupsFrom(inlineProvider.candidates);
        if (groups.length > 0) result.groups[providerName] = groups;
        return;
      }
      if (typeof provider?.path !== "string" || !provider.path.trim()) return;
      const path = resolve(this.options.dataDir, provider.path);
      if (!isWithin(this.options.providerDir, path)) return;
      const metadata = await providerAddresses(path);
      if (Object.keys(metadata.addresses).length > 0) result.providers[providerName] = metadata.addresses;
      const groups = groupsFrom(metadata.candidates);
      if (groups.length > 0) result.groups[providerName] = groups;
    }));
    return result;
  }

  async read(): Promise<ProxyAddresses> {
    const [addresses, countries] = await Promise.all([
      this.readAddresses(),
      readCountryCache(this.options.countryCachePath),
    ]);
    return { ...addresses, countries };
  }

  async recognizeCountry(identity: ProxyNodeIdentity, expectedLoadVersion?: number) {
    const addresses = await this.readAddresses(expectedLoadVersion);
    const address = identity.provider
      ? addresses.providers[identity.provider]?.[identity.name]
      : addresses.inline[identity.name];
    if (!address) throw new ProxyAddressSourceError("当前节点没有可用的 Server 地址");
    const resolveHost = this.options.resolveAddress || resolvePublicAddress;
    const ip = await resolveHost(address);
    if (!ip) throw new ProxyAddressSourceError("当前节点没有可查询的公网地址");
    const country = await this.lookupCountry(ip);
    const saved = { ...country, ip, updatedAt: new Date().toISOString() };
    await this.mutateCountryCache({ [address]: saved });
    return {
      countryCode: saved.countryCode,
      country: saved.country,
      ...(saved.region ? { region: saved.region } : {}),
      updatedAt: saved.updatedAt,
    };
  }

  async refreshCountries(expectedLoadVersion?: number) {
    const addresses = await this.readAddresses(expectedLoadVersion);
    const key = addresses.source?.loadVersion;
    const existing = this.refreshing.get(key);
    if (existing) return existing;
    const refreshing = this.refreshCountriesUnqueued(addresses);
    this.refreshing.set(key, refreshing);
    try {
      return await refreshing;
    } finally {
      if (this.refreshing.get(key) === refreshing) this.refreshing.delete(key);
    }
  }

  private async refreshCountriesUnqueued(addresses: Omit<ProxyAddresses, "countries">) {
    const unique = [...new Set([
      ...Object.values(addresses.inline),
      ...Object.values(addresses.providers).flatMap(Object.values),
    ])];
    const delta: Record<string, ProxyCountry> = {};
    let recognized = 0;
    let failed = 0;
    const resolveHost = this.options.resolveAddress || resolvePublicAddress;
    for (let index = 0; index < unique.length; index += 3) {
      await Promise.all(unique.slice(index, index + 3).map(async (address) => {
        try {
          const ip = await resolveHost(address);
          if (!ip) throw new Error("non-public address");
          const country = await this.lookupCountry(ip);
          delta[address] = { ...country, ip, updatedAt: new Date().toISOString() };
          recognized += 1;
        } catch {
          failed += 1;
        }
      }));
    }
    const next = await this.mutateCountryCache(delta);
    return { addresses: { ...addresses, countries: next }, recognized, failed };
  }
}
