import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProxyAddressReader, ProxyAddressSourceError, proxyCountryLookupUrl } from "../src/config/proxyAddresses.ts";

test("country lookup requests localized labels without exposing node data", () => {
  assert.equal(proxyCountryLookupUrl("203.0.113.8"), "http://ip-api.com/json/203.0.113.8?lang=zh-CN");
});

test("top-level addresses and candidates use default while named providers and inline reads stay isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-default-addresses-"));
  const resolved: string[] = [];
  const reader = new ProxyAddressReader({
    readSource: async () => ({ content: [
      "proxies:",
      "  - { name: vless-lab, type: vless, server: top.example.test, port: 443, uuid: fixture-id }",
      "  - { name: vmess-ws-lab, type: vmess, server: top.example.test, port: 8443, uuid: fixture-id }",
      "proxy-providers:",
      "  named:",
      "    type: inline",
      "    payload:",
      "      - { name: vless-lab, type: vless, server: named.example.test, port: 443, uuid: fixture-id }",
      "",
    ].join("\n") }),
    dataDir: root, providerDir: join(root, "providers"), countryCachePath: join(root, "countries.json"),
    resolveAddress: async (host) => { resolved.push(host); return host === "top.example.test" ? "8.8.8.8" : "1.1.1.1"; },
    lookupCountry: async (ip) => ip === "8.8.8.8"
      ? { countryCode: "JP", country: "Japan" } : { countryCode: "AU", country: "Australia" },
  });
  const addresses = await reader.read();
  assert.deepEqual(addresses.providers.default, addresses.inline);
  assert.equal(addresses.providers.named?.["vless-lab"], "named.example.test");
  assert.deepEqual(Object.keys(addresses.groups), ["default"]);
  assert.deepEqual(addresses.groups.default?.[0]?.members.map((node) => node.name), ["vless-lab", "vmess-ws-lab"]);
  for (const provider of ["default", ""]) {
    assert.equal((await reader.recognizeCountry({ provider, name: "vless-lab" })).countryCode, "JP");
  }
  assert.equal((await reader.recognizeCountry({ provider: "named", name: "vless-lab" })).countryCode, "AU");
  await assert.rejects(reader.recognizeCountry({ provider: "missing", name: "vless-lab" }), ProxyAddressSourceError);
  await assert.rejects(reader.recognizeCountry({ provider: "named", name: "vmess-ws-lab" }), ProxyAddressSourceError);
  assert.deepEqual(resolved, ["top.example.test", "top.example.test", "named.example.test"]);
  resolved.length = 0;
  assert.equal((await reader.refreshCountries()).recognized, 2);
  assert.deepEqual(resolved.sort(), ["named.example.test", "top.example.test"]);
});

test("single node country recognition uses stable provider identity and returns no address", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-proxy-address-single-"));
  const providerDir = join(root, "providers");
  await mkdir(providerDir);
  const configPath = join(root, "config.yaml");
  const countryCachePath = join(root, "countries.json");
  await writeFile(configPath, "proxy-providers:\n  fixture:\n    type: inline\n    payload:\n      - { name: shared, type: ss, server: edge.example.test }\n");
  const reader = new ProxyAddressReader({
    readSource: async () => ({ content: await readFile(configPath, "utf8") }), dataDir: root, providerDir, countryCachePath,
    resolveAddress: async () => "8.8.8.8",
    lookupCountry: async () => ({ countryCode: "JP", country: "Japan", region: "Tokyo" }),
  });
  const result = await reader.recognizeCountry({ provider: "fixture", name: "shared" });
  assert.deepEqual({ countryCode: result.countryCode, country: result.country, region: result.region }, {
    countryCode: "JP", country: "Japan", region: "Tokyo",
  });
  assert.equal("ip" in result, false);
  await assert.rejects(() => reader.recognizeCountry({ provider: "wrong", name: "shared" }), ProxyAddressSourceError);
});

test("single recognition survives a stale concurrent batch cache write", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-proxy-address-concurrent-"));
  const providerDir = join(root, "providers");
  await mkdir(providerDir);
  const configPath = join(root, "config.yaml");
  const countryCachePath = join(root, "countries.json");
  await writeFile(configPath, [
    "proxies:",
    "  - { name: alpha, type: ss, server: alpha.example.test }",
    "  - { name: beta, type: vmess, server: beta.example.test }",
    "",
  ].join("\n"));
  let releaseBatch!: () => void;
  let batchBlocked!: () => void;
  const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
  const batchReachedLookup = new Promise<void>((resolve) => { batchBlocked = resolve; });
  let alphaLookups = 0;
  const reader = new ProxyAddressReader({
    readSource: async () => ({ content: await readFile(configPath, "utf8") }), dataDir: root, providerDir, countryCachePath,
    resolveAddress: async (host) => host.startsWith("alpha") ? "8.8.8.8" : "1.1.1.1",
    lookupCountry: async (ip) => {
      if (ip === "8.8.8.8") {
        alphaLookups += 1;
        if (alphaLookups === 1) throw new Error("fixture batch miss");
        return { countryCode: "US", country: "United States" };
      }
      batchBlocked();
      await batchGate;
      return { countryCode: "AU", country: "Australia" };
    },
  });
  const batch = reader.refreshCountries();
  await batchReachedLookup;
  assert.equal(alphaLookups, 1);

  const single = await reader.recognizeCountry({ provider: "", name: "alpha" });
  assert.equal(single.countryCode, "US");
  assert.equal(alphaLookups, 2);

  releaseBatch();
  const batchResult = await batch;
  assert.deepEqual({ recognized: batchResult.recognized, failed: batchResult.failed }, {
    recognized: 1, failed: 1,
  });
  const persisted = JSON.parse(await readFile(countryCachePath, "utf8"));
  assert.deepEqual(Object.keys(persisted.entries).sort(), ["alpha.example.test", "beta.example.test"]);
});

test("reads inline and provider servers without exposing ports", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-proxy-addresses-"));
  const providerDir = join(root, "providers");
  const configPath = join(root, "config.yaml");
  const countryCachePath = join(root, "proxy-countries.json");
  await mkdir(providerDir);
  await writeFile(join(providerDir, "remote.yaml"), [
    "proxies:",
    "  - name: remote-node",
    "    type: vless",
    "    server: 203.0.113.9",
    "    port: 443",
    "",
  ].join("\n"));
  await writeFile(configPath, [
    "proxies:",
    "  - name: inline-node",
    "    type: socks5",
    "    server: inline.example.com",
    "    port: 1080",
    "proxy-providers:",
    "  remote:",
    "    type: file",
    "    path: ./providers/remote.yaml",
    "",
  ].join("\n"));

  const result = await new ProxyAddressReader({ readSource: async () => ({ content: await readFile(configPath, "utf8") }), dataDir: root, providerDir, countryCachePath }).read();
  assert.deepEqual(result, {
    inline: { "inline-node": "inline.example.com" },
    providers: { default: { "inline-node": "inline.example.com" }, remote: { "remote-node": "203.0.113.9" } },
    groups: {},
    countries: {},
  });
  assert.equal(JSON.stringify(result).includes("443"), false);
  assert.equal(JSON.stringify(result).includes("1080"), false);
});

test("ignores provider paths outside the controlled directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-proxy-addresses-"));
  const providerDir = join(root, "providers");
  const configPath = join(root, "config.yaml");
  const countryCachePath = join(root, "proxy-countries.json");
  await mkdir(providerDir);
  await writeFile(join(root, "outside.yaml"), "proxies:\n  - name: hidden\n    server: hidden.example.com\n");
  await writeFile(configPath, "proxy-providers:\n  outside:\n    path: ./outside.yaml\n");

  const result = await new ProxyAddressReader({ readSource: async () => ({ content: await readFile(configPath, "utf8") }), dataDir: root, providerDir, countryCachePath }).read();
  assert.deepEqual(result.providers, {});
});

test("country recognition resolves once and persists sanitized local cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-proxy-countries-"));
  const providerDir = join(root, "providers");
  const configPath = join(root, "config.yaml");
  const countryCachePath = join(root, "proxy-countries.json");
  await mkdir(providerDir);
  await writeFile(configPath, [
    "proxies:",
    "  - name: domain-node",
    "    server: edge.example.com",
    "  - name: ip-node",
    "    server: 8.8.8.8",
    "",
  ].join("\n"));
  const resolved: string[] = [];
  const lookedUp: string[] = [];
  const reader = new ProxyAddressReader({
    readSource: async () => ({ content: await readFile(configPath, 'utf8') }),
    dataDir: root,
    providerDir,
    countryCachePath,
    resolveAddress: async (host) => {
      resolved.push(host);
      return host === "edge.example.com" ? "1.1.1.1" : host;
    },
    lookupCountry: async (ip) => {
      lookedUp.push(ip);
      return ip === "1.1.1.1"
        ? { countryCode: "AU", country: "Australia", region: "Sydney" }
        : { countryCode: "US", country: "United States" };
    },
  });

  const refreshed = await reader.refreshCountries();
  assert.equal(refreshed.recognized, 2);
  assert.equal(refreshed.failed, 0);
  assert.deepEqual(resolved.sort(), ["8.8.8.8", "edge.example.com"]);
  assert.deepEqual(lookedUp.sort(), ["1.1.1.1", "8.8.8.8"]);
  const cached = await reader.read();
  assert.equal(cached.countries["edge.example.com"]?.countryCode, "AU");
  assert.equal(cached.countries["edge.example.com"]?.ip, "1.1.1.1");
  assert.equal(cached.countries["edge.example.com"]?.region, "Sydney");
  assert.equal(cached.countries["8.8.8.8"]?.countryCode, "US");
  assert.equal(cached.countries["8.8.8.8"]?.ip, "8.8.8.8");

  await reader.refreshCountries();
  assert.equal((await reader.read()).countries["8.8.8.8"]?.country, "United States");
});

test("groups supported self-hosted prefixes by provider, credential, and normalized suffix", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-proxy-groups-"));
  const providerDir = join(root, "providers");
  const countryCachePath = join(root, "proxy-countries.json");
  await mkdir(providerDir);
  const configPath = join(import.meta.dirname, "fixtures", "proxy-node-groups.yaml");

  const result = await new ProxyAddressReader({ readSource: async () => ({ content: await readFile(configPath, "utf8") }), dataDir: root, providerDir, countryCachePath }).read();
  const groups = result.groups.provider_a || [];
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.suffix, "lab-alpha");
  assert.deepEqual(groups[0]?.members.map(({ protocol, port }) => `${protocol}:${port}`), [
    "VLESS:443",
    "VMess:8443",
    "VMess:2087",
    "Hysteria2:8443",
    "TUIC:10443",
    "AnyTLS:9443",
  ]);
  assert.equal(result.groups.provider_b, undefined);
  const response = JSON.stringify(result);
  assert.equal(response.includes("00000000-0000-4000-8000-000000000001"), false);
  assert.equal(response.includes("fixture-password-b"), false);
});

test("batch recognition distinguishes an empty source from failed external lookups", async () => {
  const root = await mkdtemp(join(tmpdir(), 'mihomo-empty-countries-'));
  let content = 'proxies: []\n';
  let lookups = 0;
  const reader = new ProxyAddressReader({
    readSource: async () => ({ content }), dataDir: root, providerDir: join(root, 'providers'), countryCachePath: join(root, 'countries.json'),
    resolveAddress: async () => '8.8.8.8', lookupCountry: async () => { lookups += 1; throw new Error('fixture outage'); },
  });
  const empty = await reader.refreshCountries();
  assert.equal(empty.recognized, 0);
  assert.equal(empty.failed, 0);
  assert.equal(lookups, 0);
  content = 'proxies: [{ name: fixture, server: edge.example.test }]\n';
  const failed = await reader.refreshCountries();
  assert.equal(failed.recognized, 0);
  assert.equal(failed.failed, 1);
  assert.equal(lookups, 1);
});
