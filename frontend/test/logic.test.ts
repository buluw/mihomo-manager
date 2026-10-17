import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { defaultDirectDelayTest, directDelayPresets, directDelayTestError, directDelayTestUrl } from "../src/shared/directDelay.ts";

import { isExactConfigTabPath } from "../src/app/navigation.ts";
import { statusAfterFailure } from "../src/app/statusRequest.ts";
import {
  CONNECTION_POLL_INTERVAL_MS,
  CONNECTIONS_PATH,
  connectionClosePath,
  deriveConnectionRows,
  moveConnectionColumn,
  nextConnectionSort,
  visibleConnectionColumns,
} from "../src/features/connections/connectionLogic.ts";
import { LatestRequestController } from "../src/shared/requestLifecycle.ts";

test("direct delay presets and custom HTTP URLs affect only DIRECT request targets", () => {
  assert.equal(defaultDirectDelayTest.preset, "xiaomi");
  assert.equal(directDelayTestUrl(), "http://connect.rom.miui.com/generate_204");
  for (const preset of directDelayPresets) {
    const value = { version: 1, preset: preset.value, url: "https://example.com/204?test=1" };
    const url = directDelayTestUrl(value);
    assert.equal(url, preset.value === "custom" ? value.url : preset.url);
    assert.equal(directDelayTestError(value), null);
    const direct = new URL(proxyNodeDelayRequest("DIRECT", "default", { type: "Direct" }, url), "http://controller");
    assert.equal(direct.pathname, "/proxies/DIRECT/delay");
    assert.equal(direct.searchParams.get("url"), url);
    assert.equal(new URL(proxyDirectDelayRequest("DIRECT", url), "http://controller").searchParams.get("url"), url);
    const ordinary = new URL(proxyNodeDelayRequest("Node", "Pool", { type: "Vless" }, url), "http://controller");
    assert.equal(ordinary.searchParams.get("url"), PROXY_DELAY_TEST_URL);
  }
  // Choosing the ordinary test URL as a custom DIRECT target must not change the raw DIRECT endpoint.
  assert.match(proxyNodeDelayRequest("DIRECT", "default", { type: "Direct" }, PROXY_DELAY_TEST_URL), /^\/proxies\/DIRECT\/delay\?/);
  for (const url of ["", "not a URL", "ftp://example.com", "https://bad host/204"]) assert.ok(directDelayTestError({ preset: "custom", url }));
  assert.equal(directDelayTestError({ preset: "custom", url: "http://example.com/204" }), null);
});
import {
  connectionColumnWidth,
  connectionTableWidth,
  CONNECTION_COLUMN_WIDTHS_STORAGE_VERSION,
  defaultConnectionColumnOrder,
  defaultConnectionColumnWidths,
  defaultConnectionColumnVisibility,
  MIN_CONNECTION_DATA_COLUMN_WIDTH,
  parseConnectionColumnWidths,
  resizeConnectionColumn,
  type ConnectionRate,
} from "../src/features/connections/connectionViewModel.ts";
import {
  filterAndSortLogEntries,
  filterLogEntriesByRange,
  logEntryLevel,
  logEntryMessage,
  logEntryProtocol,
  logEntryProtocols,
  retainLogProtocolSelection,
  mergeLogEntries,
  mergeLogEntriesInRange,
  presetLogRange,
  resolveLogTimeRange,
  customLogRange,
} from "../src/features/logs/logEntries.ts";
import {
  applyPendingProxySelections,
  buildProxyCards,
  canSwitchProxyCardProtocol,
  delayTestUrl,
  DIRECT_DELAY_TEST_URL,
  directProxyNames,
  displayedProxyDelay,
  listProxyGroups,
  mergeProxyProviderNodes,
  proxyProtocolOptionColumns,
  measurableProxyCardMembers,
  runProxyCardDelayTests,
  PROXY_DELAY_TEST_URL,
  proxyAddress,
  proxyCardPreferenceKey,
  proxyCardDisplayLabel,
  proxyCardRegion,
  proxyCountryLabel,
  formatProxyCountry,
  proxyDelayTarget,
  requestProxyDelay,
  proxyRegionDisplayLabel,
  proxyDirectDelayRequest,
  proxyGroupDelayRequest,
  proxyNodeDelayRequest,
  selectedProxyCardNode,
  setProxyGroupSelection,
  sortProxyCards,
} from "../src/features/proxies/proxyLogic.ts";
import { proxyConfigActionLabel, proxyConfigListFailure } from "../src/features/proxies/proxyConfigSwitcherState.ts";
import { previewAutomaticProxyRegion } from "../src/features/proxies/proxyNodeInfo.ts";
import {
  addMergeGroupMembers,
  applyAutomaticRecognition,
  automaticRecognitionFeedback,
  availableProxyNodes,
  beginProxyMergeDrag,
  beginProxyMergeGroupDrag,
  beginProxyMergeDraft,
  cancelProxyMergeDrag,
  createManualMergeGroup,
  createProxyMergeGroupId,
  endProxyMergeDrag,
  isSelectableProxyNode,
  mergeGroupAvailability,
  moveMergeGroupMember,
  removeMergeGroupMember,
  renameMergeGroup,
  persistProxyMergeDraft,
  persistLoadedProxyMergeDraft,
  previewProxyMergeDrag,
  previewProxyMergeDragToUnmerged,
  proxyIdentityKey,
  proxyMergeGroupsForDisplay,
  splitMergeGroup,
} from "../src/features/proxies/proxyMergeSettings.ts";
import {
  analyzeProxyNodeRename,
  commitProxyRegionDrafts,
  displayedProxyRegion,
  migrateManualProxyRegion,
  ProxyNodeInfoSaveGuard,
  renameInlineProxyNode,
  proxyRegionDraftValue,
  setManualProxyRegion,
} from "../src/features/proxies/proxyNodeInfo.ts";
import {
  readOptionalProxyAddresses,
  readOptionalProxyGroupOrder,
  readProxyRuntimeSnapshot,
} from "../src/features/proxies/proxyRuntime.ts";
import type { RuntimeLoadState } from "../src/api/configClient.ts";

test("proxy group order follows the applied declaration and keeps GLOBAL last", () => {
  const proxies = {
    GLOBAL: { name: "GLOBAL", all: [] },
    first: { name: "first", all: [] },
    extra: { name: "extra", all: [] },
    second: { name: "second", all: [] },
    DIRECT: { name: "DIRECT", type: "Direct" },
  };
  assert.deepEqual(listProxyGroups(proxies, ["second", "GLOBAL", "missing", "first"]).map((group) => group.name), ["second", "first", "extra", "GLOBAL"]);
  assert.deepEqual(listProxyGroups(proxies).map((group) => group.name), ["first", "extra", "second", "GLOBAL"]);
});

test("proxy group order reads YAML only when the successful runtime version changes", async () => {
  const generated = { schemaVersion: 1 as const, version: "v1", sourceName: "source.yaml", sourceSha256: "source-1", settingsVersion: 1, contentSha256: "content-1", generatedAt: "2026-10-14T00:00:00Z", path: "/runtime/v1.yaml" };
  let state: RuntimeLoadState = { schemaVersion: 1, version: 2, lastAttempt: { id: "a1", generated, status: "succeeded", startedAt: "now", finishedAt: "now" }, lastSuccessful: { generated, loadedAt: "now" } };
  let content = "proxy-groups:\n  - name: Second\n  - name: First\n";
  let bodyReads = 0;
  const readers = { state: async () => state, applied: async () => { bodyReads++; return { state, content }; } };
  const signal = new AbortController().signal;
  const first = await readOptionalProxyGroupOrder(signal, null, readers);
  assert.deepEqual(first?.names, ["Second", "First"]);
  // A saved source/candidate does not change the successful runtime record.
  content = "proxy-groups:\n  - name: First\n  - name: Second\n";
  assert.equal(await readOptionalProxyGroupOrder(signal, first, readers), first);
  assert.equal(bodyReads, 1);
  const next = { ...generated, version: "v2", contentSha256: "content-2" };
  state = { ...state, version: 4, lastAttempt: { ...state.lastAttempt!, generated: next }, lastSuccessful: { generated: next, loadedAt: "later" } };
  const updated = await readOptionalProxyGroupOrder(signal, first, readers);
  assert.deepEqual(updated?.names, ["First", "Second"]);
  assert.equal(bodyReads, 2);
  state = { ...state, lastAttempt: { ...state.lastAttempt!, status: "failed" } };
  assert.equal(await readOptionalProxyGroupOrder(signal, updated, readers), updated);
  state = { ...state, lastAttempt: { ...state.lastAttempt!, status: "unknown" } };
  assert.equal(await readOptionalProxyGroupOrder(signal, updated, readers), null);
  assert.equal(bodyReads, 2);
  state = { ...state, lastAttempt: { ...state.lastAttempt!, status: "succeeded" } };
  assert.equal(await readOptionalProxyGroupOrder(signal, null, { ...readers, applied: async () => ({ state, content: "proxy-groups: [broken" }) }), null);
  assert.equal(await readOptionalProxyGroupOrder(signal, null, { ...readers, state: async () => { throw new Error("unavailable"); } }), null);
  assert.equal(await readOptionalProxyGroupOrder(signal, null, { ...readers, applied: async () => ({ state: { ...state, lastSuccessful: { generated, loadedAt: "old" } }, content }) }), null);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(await readOptionalProxyGroupOrder(cancelled.signal, updated, readers), null);
});

test("health failure invalidates the previous successful status", () => {
  assert.equal(statusAfterFailure(), null);
});

test("merge candidates follow the complete known AdapterType allowlist and fail closed", () => {
  const allowed = [
    "Shadowsocks", "ShadowsocksR", "Snell", "Socks5", "Http", "Vmess", "Vless", "Trojan",
    "Hysteria", "Hysteria2", "WireGuard", "Tuic", "Ssh", "Mieru", "AnyTLS", "Sudoku",
    "Masque", "TrustTunnel", "OpenVPN", "Tailscale", "GostRelay",
  ];
  const excluded = [
    "Direct", "Reject", "RejectDrop", "Compatible", "Pass", "PassRule", "Rematch", "Dns",
    "Relay", "Selector", "Fallback", "URLTest", "LoadBalance", "Group", "UnknownFutureType", "",
  ];
  allowed.forEach((type) => assert.equal(isSelectableProxyNode({ type }), true, type));
  excluded.forEach((type) => assert.equal(isSelectableProxyNode({ type }), false, type));
  assert.equal(isSelectableProxyNode({ type: "Vless", all: ["node"] }), false);

  const names = ["vless", "rm", "dns", "pass-rule", "unknown"];
  const data = {
    group: { type: "Selector", all: names },
    vless: { type: "Vless" }, rm: { type: "Rematch" }, dns: { type: "Dns" },
    "pass-rule": { type: "PassRule" }, unknown: { type: "Future" },
  };
  assert.deepEqual(availableProxyNodes(data, {}).map((node) => node.name), ["vless"]);
});

test("drag move adds unmerged nodes and dissolves a source left with one member", () => {
  const a = { provider: "p", name: "a" }, b = { provider: "p", name: "b" };
  const c = { provider: "p", name: "c" }, d = { provider: "p", name: "d" };
  const initial = { schemaVersion: 1 as const, version: 3, exclusions: [d], groups: [
    { id: "left", displayName: "Left", source: "automatic" as const, members: [a, b] },
    { id: "right", displayName: "Right", source: "manual" as const, members: [c, d] },
  ] };
  const moved = moveMergeGroupMember(initial, a, "right");
  assert.equal(moved.groups.some((group) => group.id === "left"), false);
  assert.deepEqual(moved.groups.find((group) => group.id === "right")?.members, [c, d, a]);
  assert.equal(moved.groups.some((group) => group.members.length < 2), false);
  const withUnmerged = moveMergeGroupMember(moved, { provider: "p", name: "e" }, "right");
  assert.equal(withUnmerged.groups[0]?.members.at(-1)?.name, "e");
});

test("only multi-member merged proxy cards can switch protocols", () => {
  const member = { name: "node-a", protocol: "Vless" };
  const single = { key: "node-a", label: "node-a", provider: "", grouped: false, members: [member] };
  const groupedSingle = { ...single, key: "group-one", label: "Group One", grouped: true };
  const grouped = {
    ...single,
    key: "group-two",
    label: "Group Two",
    grouped: true,
    members: [member, { name: "node-b", protocol: "Vmess" }],
  };

  assert.equal(canSwitchProxyCardProtocol(single, 1), false);
  assert.equal(canSwitchProxyCardProtocol(groupedSingle, 1), false);
  assert.equal(canSwitchProxyCardProtocol(grouped, 2), true);
});

test("node rename safely updates exact simple and logical Mihomo policy references", () => {
  const yaml = "proxies:\n  - name: old\n    type: ss\n  - name: other\n    type: ss\nproxy-groups:\n  - name: group\n    type: select\n    proxies: [old, other]\nrules:\n  - DOMAIN,example.test,old,no-resolve\n  - MATCH,old\n  - AND,((DOMAIN,a.example),(NETWORK,TCP)), old , no-resolve\n  - OR,((DOMAIN,b.example),(NETWORK,UDP)),old\n  - NOT,(DOMAIN,c.example),old\n  - SUB-RULE,child,old\nsub-rules:\n  child:\n    - MATCH,old\ndialer-proxy: old\n";
  const renamed = renameInlineProxyNode(yaml, "old", "new");
  const result = parse(renamed) as { rules: string[]; "sub-rules": Record<string, string[]> };
  assert.equal(analyzeProxyNodeRename(renamed, { provider: "", name: "new" }).status, "unique");
  assert.deepEqual(result.rules, [
    "DOMAIN,example.test,new,no-resolve",
    "MATCH,new",
    "AND,((DOMAIN,a.example),(NETWORK,TCP)), new , no-resolve",
    "OR,((DOMAIN,b.example),(NETWORK,UDP)),new",
    "NOT,(DOMAIN,c.example),new",
    "SUB-RULE,child,old",
  ]);
  assert.deepEqual(result["sub-rules"].child, ["MATCH,new"]);
  assert.equal(analyzeProxyNodeRename(yaml, { provider: "source", name: "old" }).status, "provider");
  assert.equal(analyzeProxyNodeRename(yaml, { provider: "", name: "missing" }).status, "missing");
  assert.equal(analyzeProxyNodeRename(yaml, { provider: "", name: "old" }, "other").conflict, true);
  assert.equal(analyzeProxyNodeRename("proxies:\n - {name: old}\n - {name: old}\n", { provider: "", name: "old" }).status, "ambiguous");
  assert.throws(
    () => renameInlineProxyNode("proxies:\n - {name: old}\nrules:\n - AND,((DOMAIN,a.example),old\n", "old", "new"),
    /括号不平衡/,
  );
});

test("manual regions override automatic values, can be cleared, and migrate with renames", () => {
  const oldIdentity = { provider: "", name: "old" };
  const newIdentity = { provider: "", name: "new" };
  const empty = { schemaVersion: 1 as const, version: 0, regions: [] };
  const manual = setManualProxyRegion(empty, oldIdentity, "Manual Region");
  assert.equal(displayedProxyRegion("Automatic", manual, oldIdentity), "Manual Region");
  assert.equal(displayedProxyRegion("Automatic", setManualProxyRegion(manual, oldIdentity, ""), oldIdentity), "Automatic");
  const migrated = migrateManualProxyRegion(manual, oldIdentity, newIdentity);
  assert.equal(displayedProxyRegion("Automatic", migrated, oldIdentity), "Automatic");
  assert.equal(displayedProxyRegion("Automatic", migrated, newIdentity), "Manual Region");
});

test("proxy region drafts preserve per-node edits and merged rows use the selected member", () => {
  const first = { provider: "source", name: "first" };
  const second = { provider: "source", name: "second" };
  const settings = {
    schemaVersion: 1 as const,
    version: 3,
    regions: [{ ...first, label: "人工地区" }],
  };
  const drafts = { [`source\0first`]: null, [`source\0second`]: "第二地区" };
  assert.equal(proxyRegionDraftValue(drafts, settings, first, "JP · 东京 / 日本"), "JP · 东京 / 日本");
  assert.equal(proxyRegionDraftValue(drafts, settings, second, "US · 美国"), "第二地区");
  assert.deepEqual(commitProxyRegionDrafts(settings, [first, second], drafts).regions, [
    { ...second, label: "第二地区" },
  ]);

  const card = {
    key: "group:machine",
    label: "Machine",
    provider: "source",
    grouped: true,
    members: [
      { name: "first", protocol: "Vless", port: "443" },
      { name: "second", protocol: "Trojan", port: "443" },
    ],
  };
  const addresses = {
    inline: {},
    providers: { source: { first: "edge.example.test", second: "203.0.113.9" } },
    groups: {},
    countries: {
      "edge.example.test": { countryCode: "US", country: "美国", updatedAt: "2026-08-11T00:00:00Z" },
      "203.0.113.9": { countryCode: "JP", country: "日本", region: "东京", updatedAt: "2026-08-11T00:00:00Z" },
    },
  };
  const providers = { first: "source", second: "source" };
  const automatic = { ...settings, regions: [] };
  assert.equal(proxyCardRegion(card.members[0].name, providers, addresses, automatic), "US · 美国 / 美国");
  assert.equal(proxyCardRegion(card.members[1].name, providers, addresses, automatic), "JP · 东京 / 日本");
  assert.equal(proxyCardRegion("first", providers, addresses, automatic, "code"), "US");
  assert.equal(proxyCardRegion("second", providers, addresses, automatic, "code"), "JP");
  assert.equal(proxyCardRegion("first", providers, addresses, settings, "code"), null);
  assert.equal(proxyCardRegion("first", providers, addresses, settings), "人工地区");
  assert.equal(proxyCardRegion("second", providers, addresses, settings), "JP · 东京 / 日本");
  const manualCode = setManualProxyRegion(settings, second, "gb");
  assert.equal(proxyCardRegion("second", providers, addresses, manualCode), "gb");
  assert.equal(proxyCardRegion("second", providers, addresses, manualCode, "code"), "GB");
  assert.equal(proxyCardRegion("second", providers, addresses, setManualProxyRegion(settings, { provider: "other", name: "second" }, "GB")), "JP · 东京 / 日本");
  const conflicting = {
    ...addresses,
    providers: { source: { first: "203.0.113.8", second: "203.0.113.9" } },
    countries: {
      ...addresses.countries,
      "203.0.113.8": { countryCode: "US", country: "美国", updatedAt: "2026-08-11T00:00:00Z" },
    },
  };
  assert.equal(proxyCardRegion("first", providers, conflicting, automatic), "US · 美国 / 美国");
  assert.equal(proxyCardRegion("second", providers, conflicting, automatic), "JP · 东京 / 日本");
  const unrecognized = { ...addresses, countries: { "203.0.113.9": addresses.countries["203.0.113.9"] } };
  assert.equal(proxyRegionDisplayLabel(proxyCardRegion("first", providers, unrecognized, automatic)), "未识别");
  assert.equal(proxyRegionDisplayLabel(proxyCardRegion("first", providers, unrecognized, automatic, "code")), "未识别");
});

test("proxy region display never falls back to a node address", () => {
  const card = {
    key: "node:domain",
    label: "Domain node",
    provider: "source",
    grouped: false,
    members: [{ name: "domain", protocol: "Vless", port: "443" }],
  };
  const withoutCountry = {
    inline: {}, providers: { source: { domain: "edge.example.test" } }, groups: {}, countries: {},
  };
  const recognized = {
    ...withoutCountry,
    countries: {
      "edge.example.test": { countryCode: "JP", country: "日本", region: "东京", updatedAt: "2026-08-11T00:00:00Z" },
    },
  };
  assert.equal(proxyRegionDisplayLabel(proxyCardRegion(card.members[0].name, { domain: "source" }, withoutCountry, { schemaVersion: 1, version: 0, regions: [] })), "未识别");
  assert.equal(proxyRegionDisplayLabel(proxyCardRegion(card.members[0].name, { domain: "source" }, recognized, { schemaVersion: 1, version: 0, regions: [] })), "JP · 东京 / 日本");
});

test("proxy node info save guard blocks every draft mutation until release", () => {
  const guard = new ProxyNodeInfoSaveGuard();
  const state = { identity: "A", region: "Tokyo", drafts: ["A:Tokyo"], open: true, saves: 0 };
  assert.equal(guard.acquire(), true);
  assert.equal(guard.edit(() => { state.identity = "B"; }), false);
  assert.equal(guard.edit(() => { state.region = "Osaka"; state.drafts.push("A:Osaka"); }), false);
  assert.equal(guard.edit(() => { state.region = "Auto"; state.drafts.length = 0; }), false);
  assert.equal(guard.edit(() => { state.open = false; state.drafts.length = 0; }), false);
  assert.equal(guard.acquire(), false);
  assert.deepEqual(state, { identity: "A", region: "Tokyo", drafts: ["A:Tokyo"], open: true, saves: 0 });
  guard.release();
  assert.equal(guard.edit(() => { state.region = "Osaka"; state.drafts.push("A:Osaka"); }), true);
  assert.equal(state.region, "Osaka");
  assert.deepEqual(state.drafts, ["A:Tokyo", "A:Osaka"]);
});

test("proxy region sorting uses the same manual override shown in node rows", () => {
  const proxyMap = { alpha: { type: "Vless" }, beta: { type: "Trojan" }, gamma: { type: "WireGuard" } };
  const addresses = {
    inline: { alpha: "192.0.2.1", beta: "192.0.2.2" }, providers: {}, groups: {},
    countries: {
      "192.0.2.1": { countryCode: "US", country: "United States", updatedAt: "2026-08-10T00:00:00Z" },
      "192.0.2.2": { countryCode: "JP", country: "Japan", updatedAt: "2026-08-10T00:00:00Z" },
    },
  };
  const cards = buildProxyCards(["alpha", "beta", "gamma"], proxyMap, {}, addresses);
  const select = (card: ProxyCardModel) => card.members[0]?.name || "";
  const settings = {
    schemaVersion: 1 as const,
    version: 1,
    regions: [
      { provider: "", name: "alpha", label: "A Manual" },
      { provider: "", name: "beta", label: "Z Manual" },
      { provider: "", name: "gamma", label: "M Manual" },
    ],
  };
  assert.deepEqual(
    sortProxyCards(cards, "region", "asc", select, proxyMap, {}, addresses, settings, {}).map((card) => card.label),
    ["alpha", "gamma", "beta"],
  );
  const automatic = setManualProxyRegion(setManualProxyRegion(settings, { provider: "", name: "alpha" }, ""), { provider: "", name: "beta" }, "");
  assert.deepEqual(
    sortProxyCards(cards.slice(0, 2), "region", "asc", select, proxyMap, {}, addresses, automatic, {}).map((card) => card.label),
    ["beta", "alpha"],
  );
});

test("merged row region sorting follows the selected landing node and its manual region", () => {
  const proxyMap = {
    landing: { type: "Vless", "dialer-proxy": "transit" },
    alternate: { type: "Trojan" },
    reference: { type: "Vless" },
    transit: { type: "Vless" },
  };
  const addresses = {
    inline: { landing: "landing.example.test", alternate: "192.0.2.2", reference: "192.0.2.3", transit: "192.0.2.4" },
    providers: {}, groups: {},
    countries: {
      "landing.example.test": { countryCode: "JP", country: "Japan", updatedAt: "2026-10-15T00:00:00Z" },
      "192.0.2.2": { countryCode: "US", country: "United States", updatedAt: "2026-10-15T00:00:00Z" },
      "192.0.2.3": { countryCode: "SG", country: "Singapore", updatedAt: "2026-10-15T00:00:00Z" },
      "192.0.2.4": { countryCode: "DE", country: "Germany", updatedAt: "2026-10-15T00:00:00Z" },
    },
  };
  const cards = buildProxyCards(["landing", "alternate", "reference"], proxyMap, {}, addresses);
  const merged = { ...cards[0], key: "merged", label: "Landing", grouped: true, members: [...cards[0].members, ...cards[1].members] };
  const rows = [merged, cards[2]];
  const settings = { schemaVersion: 1 as const, version: 0, regions: [] };
  let selected = "landing";
  const select = (card: ProxyCardModel) => card === merged ? selected : card.members[0].name;
  const sorted = (values: ReturnType<typeof setManualProxyRegion> = settings) => sortProxyCards(rows, "region", "asc", select, proxyMap, {}, addresses, values, {}).map(card => card.key);
  assert.equal(proxyCardRegion(select(merged), {}, addresses, settings), "JP · 日本 / 日本");
  assert.equal(proxyCardRegion(select(merged), {}, addresses, settings, "code"), "JP");
  assert.deepEqual(sorted(), [merged.key, cards[2].key]);
  selected = "alternate";
  assert.equal(proxyCardRegion(select(merged), {}, addresses, settings, "code"), "US");
  assert.deepEqual(sorted(), [cards[2].key, merged.key]);
  const manual = setManualProxyRegion(settings, { provider: "", name: "alternate" }, "GB");
  assert.equal(proxyCardRegion(select(merged), {}, addresses, manual, "code"), "GB");
  assert.deepEqual(sorted(manual), [merged.key, cards[2].key]);
});

test("config tab routes reject missing and extra path segments", () => {
  const tabs = ["profiles", "subscriptions"];
  assert.equal(isExactConfigTabPath("/config/profiles", tabs), true);
  assert.equal(isExactConfigTabPath("/config/profiles/extra", tabs), false);
  assert.equal(isExactConfigTabPath("/config", tabs), false);
});

test("log entries deduplicate only by cursor and preserve repeated text", () => {
  const merged = mergeLogEntries(
    [{ id: "a", line: "same" }],
    [
      { id: "b", line: "same" },
      { id: "a", line: "changed duplicate cursor" },
    ],
  );
  assert.deepEqual(merged, [
    { id: "a", line: "same" },
    { id: "b", line: "same" },
  ]);
});

test("log history remains capped at the production retention limit", () => {
  const entries = Array.from({ length: 1501 }, (_, index) => ({
    id: String(index),
    line: `line ${index}`,
  }));
  const merged = mergeLogEntries([], entries);
  assert.equal(merged.length, 1500);
  assert.equal(merged[0].id, "1");
});

test("log range merge keeps a full older history window ahead of newer cached entries", () => {
  const targetRange = { mode: "custom", label: "older fixture", since: 1_000, until: 2_499 };
  const newerCache = Array.from({ length: 1_500 }, (_, index) => ({
    id: `newer-${index}`,
    timestamp: 10_000 + index,
    line: `level=info [UDP] newer ${index}`,
  }));
  const targetHistory = Array.from({ length: 1_500 }, (_, index) => ({
    id: `target-${index}`,
    timestamp: 1_000 + index,
    line: `level=info [TCP] target ${index}`,
  }));

  const merged = mergeLogEntriesInRange(newerCache, [
    ...targetHistory,
    { ...targetHistory[0]!, line: "level=error [HTTPS] duplicate must not replace" },
  ], targetRange);

  assert.equal(merged.length, 1_500);
  assert.equal(merged[0]?.id, "target-0");
  assert.equal(merged[0]?.line, "level=info [TCP] target 0");
  assert.equal(merged.at(-1)?.id, "target-1499");
  assert.deepEqual(logEntryProtocols(filterLogEntriesByRange(merged, targetRange)), ["TCP"]);
});

test("out-of-range live flow cannot evict a fixed range history window", () => {
  const fixedRange = { mode: "custom", label: "fixed fixture", since: 2_000, until: 3_499 };
  const history = Array.from({ length: 1_500 }, (_, index) => ({
    id: `history-${index}`,
    timestamp: 2_000 + index,
    line: `level=info [DNS] history ${index}`,
  }));
  const outsideLive = Array.from({ length: 1_500 }, (_, index) => ({
    id: `live-${index}`,
    timestamp: 20_000 + index,
    line: `level=info [UDP] live ${index}`,
  }));

  const initial = mergeLogEntriesInRange([], history, fixedRange);
  const afterLive = mergeLogEntriesInRange(initial, outsideLive, fixedRange);

  assert.equal(afterLive.length, 1_500);
  assert.deepEqual(afterLive.map(({ id }) => id), initial.map(({ id }) => id));
  assert.deepEqual(logEntryProtocols(afterLive), ["DNS"]);
});

test("log time range defaults can be converted to an indexed timestamp", () => {
  const now = Date.UTC(2026, 7, 1, 12);
  assert.equal(presetLogRange("1h", now).since, now - 60 * 60 * 1000);
  assert.equal(presetLogRange("24h", now).since, now - 24 * 60 * 60 * 1000);
  const today = presetLogRange("today", now);
  assert.ok(today.since && today.since < now);
  const yesterday = presetLogRange("yesterday", now);
  assert.ok(yesterday.since && yesterday.until && yesterday.since < yesterday.until);
  const rolling = presetLogRange("1h", now);
  assert.equal(resolveLogTimeRange(rolling, now + 30_000).since, now - 60 * 60 * 1000 + 30_000);
  const fixed = customLogRange(now - 10_000, now);
  assert.ok(fixed);
  assert.deepEqual(resolveLogTimeRange(fixed, now + 30_000), fixed);
  assert.equal(customLogRange(now, now), null);
});

test("log view projection preserves parsing, filters, sorting, and source order", () => {
  const entries = [
    { id: "a", timestamp: 10, level: "info", line: "level=info [TCP] Alpha" },
    { id: "b", timestamp: 20, level: "warning", line: "level=warning [DNS] Beta" },
    { id: "c", timestamp: 30, level: "error", line: "level=error [UDP] Gamma" },
  ];
  const originalOrder = entries.map(({ id }) => id);

  assert.deepEqual(
    filterAndSortLogEntries(entries, {
      query: "",
      timeRange: { mode: "custom", label: "fixture range", since: 15, until: 35 },
      selectedProtocol: "UDP",
      sortDirection: "desc",
    }).map(({ id }) => id),
    ["c"],
  );
  assert.deepEqual(
    filterAndSortLogEntries(entries, {
      query: "BETA",
      timeRange: { mode: "custom", label: "fixture", since: 0, until: 25 },
      selectedLevel: "warning",
      sortDirection: "asc",
    }).map(({ id }) => id),
    ["b"],
  );
  assert.deepEqual(entries.map(({ id }) => id), originalOrder);
  assert.equal(logEntryLevel({ id: "one", line: "level=warn [https] fixture" }), "warning");
  assert.equal(logEntryMessage({ id: "one", line: "level=warn [https] fixture" }), "[https] fixture");
  assert.equal(logEntryProtocol({ id: "one", line: "level=warn [https] fixture" }), "HTTPS");
  assert.deepEqual(logEntryProtocols(entries), ["DNS", "TCP", "UDP"]);
  assert.equal(retainLogProtocolSelection("UDP", ["TCP"]), "all");
  assert.equal(retainLogProtocolSelection("TCP", ["TCP"]), "TCP");
});

test("connection requests cancel older loads and reject publication after disposal", () => {
  const requests = new LatestRequestController();
  const first = requests.begin();
  const second = requests.begin();

  assert.equal(CONNECTION_POLL_INTERVAL_MS, 2_500);
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.signal.aborted, false);
  assert.equal(second.isCurrent(), true);
  assert.equal(second.finish(), true);
  assert.equal(second.isCurrent(), false);

  const pendingAtUnmount = requests.begin();
  requests.dispose();
  assert.equal(pendingAtUnmount.signal.aborted, true);
  assert.equal(pendingAtUnmount.isCurrent(), false);

  const afterUnmount = requests.begin();
  assert.equal(afterUnmount.signal.aborted, true);
  assert.equal(afterUnmount.isCurrent(), false);
});

test("connection API paths preserve the native Controller contract", () => {
  assert.equal(CONNECTIONS_PATH, "/connections");
  assert.equal(connectionClosePath("connection/id"), "/connections/connection%2Fid");
});

test("connection search and sorting use native fields with stable tie ordering", () => {
  const connections = [
    {
      id: "first",
      download: 200,
      metadata: {
        host: "alpha.example",
        sniffHost: "sniff.alpha.example",
        sourceIP: "192.0.2.10",
      },
      rule: "MATCH",
      chains: ["DIRECT"],
    },
    {
      id: "second",
      download: 100,
      metadata: { destinationIP: "198.51.100.8", sourceIP: "192.0.2.20" },
      rule: "DOMAIN-SUFFIX",
      chains: ["Proxy", "Node A"],
    },
    {
      id: "third",
      download: 100,
      metadata: { host: "gamma.example", sourceIP: "192.0.2.30" },
      rule: "MATCH",
      chains: ["DIRECT"],
    },
  ];
  const rates: Record<string, ConnectionRate> = {
    first: { downloadRate: 30, uploadRate: 3 },
    second: { downloadRate: 10, uploadRate: 1 },
    third: { downloadRate: 10, uploadRate: 2 },
  };

  assert.deepEqual(
    deriveConnectionRows(connections, "node a", "downloadRate", "asc", rates).map(
      ({ id }) => id,
    ),
    ["second"],
  );
  assert.deepEqual(
    deriveConnectionRows(connections, "192.0.2", "download", "asc", rates).map(
      ({ id }) => id,
    ),
    ["second", "third", "first"],
  );
  assert.deepEqual(
    deriveConnectionRows(connections, "sniff.alpha", "target", "desc", rates).map(
      ({ id }) => id,
    ),
    ["first"],
  );
});

test("connection sort direction and shared column state remain explicit", () => {
  assert.deepEqual(nextConnectionSort("downloadRate", "desc", "target"), {
    key: "target",
    direction: "asc",
  });
  assert.deepEqual(nextConnectionSort("target", "asc", "target"), {
    key: "target",
    direction: "desc",
  });

  const reordered = moveConnectionColumn(
    defaultConnectionColumnOrder,
    "download",
    "target",
  );
  assert.notEqual(reordered, defaultConnectionColumnOrder);
  assert.equal(reordered[1], "download");
  assert.equal(defaultConnectionColumnOrder[1], "target");

  const visibility = { ...defaultConnectionColumnVisibility, close: false, rule: false };
  assert.deepEqual(visibleConnectionColumns(reordered, visibility), [
    "download",
    "target",
    "policy",
    "source",
    "downloadRate",
    "uploadRate",
    "upload",
    "age",
  ]);

  const widened = resizeConnectionColumn(
    defaultConnectionColumnWidths,
    "target",
    defaultConnectionColumnWidths.target + 144,
  );
  const clamped = resizeConnectionColumn(widened, "rule", 1);
  assert.notEqual(widened, defaultConnectionColumnWidths);
  assert.equal(connectionColumnWidth("target", clamped), defaultConnectionColumnWidths.target + 144);
  assert.equal(connectionColumnWidth("rule", clamped), MIN_CONNECTION_DATA_COLUMN_WIDTH);
  assert.equal(defaultConnectionColumnWidths.target, 190);
  assert.equal(resizeConnectionColumn(clamped, "close", 500), clamped);

  const resizedVisible = visibleConnectionColumns(reordered, visibility);
  assert.equal(
    connectionTableWidth(resizedVisible, clamped),
    resizedVisible.reduce(
      (total, columnKey) => total + connectionColumnWidth(columnKey, clamped),
      0,
    ),
  );
  assert.equal(connectionColumnWidth("target", clamped), connectionColumnWidth("target", widened));
  assert.deepEqual({ ...defaultConnectionColumnWidths }, defaultConnectionColumnWidths);

  const persisted = parseConnectionColumnWidths(JSON.stringify({
    version: CONNECTION_COLUMN_WIDTHS_STORAGE_VERSION,
    widths: { target: 256, rule: MIN_CONNECTION_DATA_COLUMN_WIDTH },
  }));
  assert.equal(persisted.target, 256);
  assert.equal(persisted.rule, MIN_CONNECTION_DATA_COLUMN_WIDTH);
  assert.equal(parseConnectionColumnWidths(JSON.stringify({ version: 99, widths: { target: 256 } })).target, defaultConnectionColumnWidths.target);
  assert.equal(parseConnectionColumnWidths(JSON.stringify({ version: CONNECTION_COLUMN_WIDTHS_STORAGE_VERSION, widths: { target: 1 } })).target, defaultConnectionColumnWidths.target);
  assert.equal(parseConnectionColumnWidths(JSON.stringify({ version: CONNECTION_COLUMN_WIDTHS_STORAGE_VERSION, widths: { unknown: 100 } })).target, defaultConnectionColumnWidths.target);
});

test("inline provider nodes are merged with their native provider identity", () => {
  const merged = mergeProxyProviderNodes(
    { PROXY: { name: "PROXY", type: "Selector", all: ["inline-node"] } },
    {
      inline_provider: {
        vehicleType: "Inline",
        proxies: [{ name: "inline-node", type: "Vless", alive: true }],
      },
    },
  );

  assert.equal(merged.proxies["inline-node"].type, "Vless");
  assert.equal(merged.providerByNode["inline-node"], "inline_provider");
  assert.equal(merged.proxies.PROXY.type, "Selector");
});

test("the first provider identity and displayed node stay together when providers share a node", () => {
  const merged = mergeProxyProviderNodes({}, {
    first: { proxies: [{ name: "shared", type: "Vless", alive: false }] },
    second: { proxies: [{ name: "shared", type: "Reject", alive: true }] },
  });
  assert.equal(merged.providerByNode.shared, "first");
  assert.equal(merged.proxies.shared.type, "Vless");
  assert.equal(merged.proxies.shared.alive, false);
  assert.equal(merged.ambiguousProviderNodes.has("shared"), true);
  assert.match(proxyNodeDelayRequest("shared", merged.providerByNode.shared, merged.proxies.shared), /^\/providers\/proxies\/first\/shared\/healthcheck\?/);
});

test("runtime proxy ownership follows native and default nodes through group delay resolution in either provider order", () => {
  // Shape captured from the isolated Core CollisionPool regression fixture.
  const native = {
    DIRECT: { name: "DIRECT", type: "Direct", history: [{ delay: 30 }] },
    LocalDirect: { name: "LocalDirect", type: "Direct" },
    SmokeSelect: { name: "SmokeSelect", type: "Selector", all: ["DIRECT", "LocalDirect", "InlineDirect"], now: "DIRECT" },
  };
  const providers = {
    CollisionPool: { vehicleType: "Inline", proxies: [{ name: "DIRECT", type: "Reject" }, { name: "LocalDirect", type: "Reject" }] },
    InlineProxy: { vehicleType: "Inline", proxies: [{ name: "InlineDirect", type: "Direct" }] },
    FileProxy: { vehicleType: "File", proxies: [{ name: "FileDirect", type: "Direct" }] },
    HttpProxy: { vehicleType: "HTTP", proxies: [{ name: "HttpDirect", type: "Direct" }] },
    SmokeSelect: { vehicleType: "Compatible", proxies: Object.values(native) },
    default: { vehicleType: "Compatible", proxies: Object.values(native) },
  };
  const original = structuredClone({ native, providers });
  const entries = Object.entries(providers);
  for (const ordered of [providers, Object.fromEntries([...entries].reverse()), Object.fromEntries(entries.filter(([name]) => name !== "default"))]) {
    const merged = mergeProxyProviderNodes(native, ordered);
    const request = (name: string) => {
      const target = proxyDelayTarget(name, merged.proxies);
      return new URL(proxyNodeDelayRequest(target, merged.providerByNode[target], merged.proxies[target], "http://example.test/204"), "http://controller");
    };
    for (const name of ["DIRECT", "LocalDirect"]) {
      assert.equal(merged.proxies[name].type, "Direct");
      assert.equal(merged.providerByNode[name], "default");
      assert.equal(request(name).pathname, `/proxies/${name}/delay`);
      assert.equal(request(name).searchParams.get("url"), "http://example.test/204");
      assert.equal(merged.ambiguousProviderNodes.has(name), true);
    }
    assert.equal(request("SmokeSelect").pathname, "/proxies/DIRECT/delay");
    for (const [name, provider] of [["InlineDirect", "InlineProxy"], ["FileDirect", "FileProxy"], ["HttpDirect", "HttpProxy"]]) {
      assert.equal(merged.proxies[name].type, "Direct");
      assert.equal(request(name).pathname, `/providers/proxies/${provider}/${name}/healthcheck`);
      assert.equal(request(name).searchParams.get("url"), "http://example.test/204");
    }
  }
  assert.deepEqual({ native, providers }, original);
});

test("provider-only DIRECT retains provider ownership while default-only nodes take precedence", () => {
  const provider = { vehicleType: "Inline", proxies: [{ name: "DIRECT", type: "Direct" }] };
  const merged = mergeProxyProviderNodes({}, { pool: provider });
  assert.equal(merged.providerByNode.DIRECT, "pool");
  assert.match(proxyNodeDelayRequest("DIRECT", merged.providerByNode.DIRECT, merged.proxies.DIRECT), /^\/providers\/proxies\/pool\/DIRECT\/healthcheck\?/);
  const defaults = { vehicleType: "Compatible", proxies: [{ name: "DIRECT", type: "Reject" }] };
  for (const providers of [{ pool: provider, default: defaults }, { default: defaults, pool: provider }]) {
    const selected = mergeProxyProviderNodes({}, providers);
    assert.equal(selected.providerByNode.DIRECT, "default");
    assert.equal(selected.proxies.DIRECT.type, "Reject");
    assert.match(proxyNodeDelayRequest("DIRECT", selected.providerByNode.DIRECT, selected.proxies.DIRECT), /^\/proxies\/DIRECT\/delay\?/);
  }
});

test("merged protocol menu keeps original node name, protocol, and delay in stable columns", () => {
  assert.deepEqual(proxyProtocolOptionColumns("L1|fixture-region|fixture-line|2x", "VLESS", { delay: 42, testedAt: 1 }), {
    name: "L1|fixture-region|fixture-line|2x", protocol: "VLESS", delayLabel: "42 ms",
  });
  assert.equal(proxyProtocolOptionColumns("untested", "Trojan", { delay: null, testedAt: 0 }).delayLabel, "---");
  assert.equal(proxyProtocolOptionColumns("failed", "Trojan", { delay: null, testedAt: 1 }).delayLabel, "失败");
});

test("automatic region preview preserves saved manual values until save, and cancel discards it", () => {
  const identity = { provider: "fixture", name: "node" };
  const settings = { schemaVersion: 1 as const, version: 4, regions: [{ ...identity, label: "日本" }] };
  const original = structuredClone(settings);
  const draft = previewAutomaticProxyRegion({}, proxyIdentityKey(identity));
  assert.equal(proxyRegionDraftValue(draft, settings, identity, "美国"), "美国");
  assert.deepEqual(settings, original);
  assert.equal(proxyRegionDraftValue({}, settings, identity, "美国"), "日本");
  const committed = commitProxyRegionDrafts(settings, [identity], draft);
  assert.deepEqual(committed.regions, []);
  assert.equal(proxyRegionDraftValue({}, committed, identity, "美国"), "美国");
  assert.deepEqual(settings, original);
});

test("failed recognition leaves saved manual regions and drafts intact", async () => {
  const identity = { provider: "fixture", name: "node" };
  const settings = { schemaVersion: 1 as const, version: 4, regions: [{ ...identity, label: "日本" }] };
  let draft = { [proxyIdentityKey(identity)]: "draft-region" };
  await assert.rejects((async () => {
    await Promise.reject(new Error("lookup failed"));
    draft = previewAutomaticProxyRegion(draft, proxyIdentityKey(identity)) as typeof draft;
  })());
  assert.equal(draft[proxyIdentityKey(identity)], "draft-region");
  assert.equal(settings.regions[0]?.label, "日本");
});

test("merged card delay targets deduplicate stable real members and exclude groups", () => {
  const card = {
    key: "group:fixture", label: "fixture", provider: "", grouped: true,
    members: [
      { name: "alpha", protocol: "ss", port: "" },
      { name: "alpha", protocol: "ss", port: "" },
      { name: "beta", protocol: "vmess", port: "" },
      { name: "nested", protocol: "Selector", port: "" },
    ],
  };
  assert.deepEqual(measurableProxyCardMembers(card, {
    alpha: { type: "ss" }, beta: { type: "vmess" }, nested: { all: ["alpha"] },
  }, { alpha: "one", beta: "two" }), [
    { name: "alpha", provider: "one" }, { name: "beta", provider: "two" },
  ]);
});

test("merged card delay tests publish each member as it settles and isolate failures", async () => {
  let resolveAlpha!: (delay: number) => void;
  const alpha = new Promise<number>((resolve) => { resolveAlpha = resolve; });
  const published: Array<[string, number | null]> = [];
  const running = runProxyCardDelayTests(
    [{ name: "alpha" }, { name: "beta" }, { name: "broken" }],
    ({ name }) => name === "alpha" ? alpha : name === "beta" ? Promise.resolve(35) : Promise.reject(new Error("fixture")),
    (name, delay) => published.push([name, delay]),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(published.some(([name, delay]) => name === "beta" && delay === 35), true);
  assert.equal(published.some(([name, delay]) => name === "broken" && delay === null), true);
  assert.equal(published.some(([name]) => name === "alpha"), false);
  resolveAlpha(68);
  assert.deepEqual(await running, { succeeded: 2, failed: 1 });
  assert.equal(published.some(([name, delay]) => name === "alpha" && delay === 68), true);
});

test("provider direct nodes use their native healthcheck and configured direct URL", () => {
  const endpoint = new URL(proxyNodeDelayRequest("direct/node", "pool/name", { type: "Direct" }, "http://example.test/204"), "http://controller");
  assert.equal(endpoint.pathname, "/providers/proxies/pool%2Fname/direct%2Fnode/healthcheck");
  assert.equal(endpoint.searchParams.get("url"), "http://example.test/204");
  assert.equal(endpoint.searchParams.get("timeout"), "5000");
  assert.match(proxyNodeDelayRequest("LocalDirect", "default", { type: "Direct" }), /^\/proxies\/LocalDirect\/delay\?/);
});

test("proxy config selection labels switch and reload without performing an action", () => {
  let loads = 0;
  const selectOnly = (target: string, loaded: string | null) => {
    loads += 0;
    return proxyConfigActionLabel(target, loaded);
  };
  assert.equal(selectOnly("next.yaml", "current.yaml"), "切换配置");
  assert.equal(selectOnly("current.yaml", "current.yaml"), "重载配置");
  assert.equal(loads, 0);
});

test("proxy config list pending and cached failures do not report initial unavailability", () => {
  assert.deepEqual(proxyConfigListFailure(true, false), {
    preserveSnapshot: true,
    notify: false,
    message: "配置列表刷新失败，继续显示上次快照",
  });
  assert.equal(proxyConfigListFailure(false, false).notify, true);
  assert.equal(proxyConfigListFailure(false, true).notify, false);
});

test("proxy runtime reads keep native Controller payloads independent from optional configd addresses", async () => {
  const calls: string[] = [];
  let rejectAddresses!: (error: unknown) => void;
  const pendingAddresses = new Promise<never>((_resolve, reject) => {
    rejectAddresses = reject;
  });
  const signal = new AbortController().signal;

  const addresses = readOptionalProxyAddresses(signal, () => pendingAddresses);
  const snapshot = await readProxyRuntimeSnapshot(signal, async (path) => {
    calls.push(path);
    if (path === "/proxies") {
      return { proxies: { AUTO: { name: "AUTO", all: ["node-a"], now: "node-a" } } };
    }
    return { providers: { provider_a: { proxies: [{ name: "node-a", type: "Vless" }] } } };
  });

  assert.deepEqual(calls, ["/proxies", "/providers/proxies"]);
  assert.equal(snapshot.proxies.AUTO.now, "node-a");
  assert.equal(snapshot.providers.provider_a.proxies[0]?.name, "node-a");

  rejectAddresses(new Error("configd unavailable"));
  assert.equal(await addresses, null);
});

test("proxy delay display keeps the newest manual or runtime sample", () => {
  const node = { history: [{ delay: 252, time: "2026-08-02T08:51:38.000Z" }] };
  assert.equal(
    displayedProxyDelay(node, { delay: 321, testedAt: Date.parse("2026-08-02T09:09:54.000Z") }),
    321,
  );
  assert.equal(
    displayedProxyDelay(node, { delay: 321, testedAt: Date.parse("2026-08-02T08:00:00.000Z") }),
    252,
  );
});

test("proxy address uses provider identity and never needs a port", () => {
  const addresses = {
    inline: { shared: "inline.example.com" },
    providers: { default: { shared: "inline.example.com" }, first: { shared: "203.0.113.8" } },
    groups: {},
    countries: {},
  };
  assert.equal(proxyAddress("shared", "first", addresses), "203.0.113.8");
  assert.equal(proxyAddress("shared", "default", addresses), "inline.example.com");
  assert.equal(proxyAddress("shared", "missing-provider", addresses), null);
  assert.equal(proxyAddress("shared", undefined, addresses), "inline.example.com");
  assert.equal(proxyAddress("missing", undefined, addresses), null);
});

test("Controller default nodes merge with matching candidates and retain saved identities and manual regions", () => {
  const nodes = [{ name: "vless-lab", type: "Vless" }, { name: "vmess-ws-lab", type: "Vmess" }];
  const runtime = mergeProxyProviderNodes({ PROXY: { name: "PROXY", type: "Selector", all: nodes.map((node) => node.name) } }, { default: { vehicleType: "Compatible", proxies: nodes }, PROXY: { vehicleType: "Compatible", proxies: nodes } });
  const available = availableProxyNodes(runtime.proxies, runtime.providerByNode);
  assert.equal(available.length, 2);
  assert.equal(runtime.ambiguousProviderNodes.size, 0);
  assert.ok(available.every((node) => node.provider === "default"));
  const inline = { "vless-lab": "top.example.test", "vmess-ws-lab": "top.example.test" };
  const addresses = { inline, providers: { default: inline }, countries: {}, groups: {
    default: [{ suffix: "lab", members: available.map((node) => ({ ...node, port: "443" })) }],
  } };
  const saved = { schemaVersion: 1 as const, version: 3, exclusions: [], groups: Array.from({ length: 8 }, (_, index) => ({
    id: `saved-${index}`, displayName: `manual-${index}`, source: "manual" as const,
    members: [{ provider: index ? "named" : "", name: `old-${index}-a` }, { provider: index ? "named" : "", name: `old-${index}-b` }],
  })) };
  const before = structuredClone(saved);
  const next = applyAutomaticRecognition(saved, addresses, available, () => "default-group");
  assert.equal(next.groups.length, 9);
  assert.deepEqual(next.groups.slice(0, 8), before.groups);
  assert.deepEqual(saved, before);
  assert.deepEqual(next.groups[8]?.members, nodes.map(({ name }) => ({ provider: "default", name })));
  assert.equal(applyAutomaticRecognition(next, addresses, available, () => "unused"), next);
  assert.match(automaticRecognitionFeedback(next, next, addresses, available), /已读取 2 个节点地址.*已合并/);
  const settings = { schemaVersion: 1 as const, version: 4, regions: [
    { provider: "default", name: "vless-lab", label: "人工地区" },
    { provider: "", name: "vless-lab", label: "旧身份地区" },
  ] };
  const original = structuredClone(settings);
  assert.equal(displayedProxyRegion("JP", settings, { provider: "default", name: "vless-lab" }), "人工地区");
  assert.equal(displayedProxyRegion("JP", settings, { provider: "", name: "vless-lab" }), "旧身份地区");
  assert.equal(displayedProxyRegion("JP", settings, { provider: "named", name: "vless-lab" }), "JP");
  assert.deepEqual(settings, original);
});

test("proxy country labels use the cached country code and optimistic selection is immutable", () => {
  const addresses = {
    inline: { node: "8.8.8.8" },
    providers: {},
    groups: {},
    countries: {
      "8.8.8.8": {
        countryCode: "US",
        country: "United States",
        region: "Los Angeles",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    },
  };
  assert.equal(proxyCountryLabel("8.8.8.8", addresses), "US · Los Angeles / 美国");
  assert.equal(proxyCountryLabel("1.1.1.1", addresses), null);

  const current = { group: { name: "group", now: "old", all: ["old", "new"] } };
  const next = setProxyGroupSelection(current, "group", "new");
  assert.equal(current.group.now, "old");
  assert.equal(next.group.now, "new");
});

test("proxy cards merge only declared members inside the same provider", () => {
  const names = ["self-a", "self-b", "subscription", "DIRECT", "nested"];
  const proxyMap = {
    "self-a": { type: "Vless" },
    "self-b": { type: "Vmess" },
    subscription: { type: "Trojan" },
    DIRECT: { type: "Direct" },
    nested: { type: "Selector", all: ["self-a"] },
  };
  const addresses = {
    inline: {},
    providers: { provider_a: { "self-a": "198.51.100.8", "self-b": "edge.example.test" } },
    groups: {
      provider_a: [{
        suffix: "server-alpha",
        members: [
          { name: "self-a", protocol: "VLESS", port: "443" },
          { name: "self-b", protocol: "VMess", port: "8443" },
        ],
      }],
    },
    countries: {
      "edge.example.test": {
        countryCode: "US",
        country: "United States",
        ip: "198.51.100.8",
        updatedAt: "2026-08-02T00:00:00.000Z",
      },
    },
  };
  const cards = buildProxyCards(
    names,
    proxyMap,
    { "self-a": "provider_a", "self-b": "provider_a", subscription: "provider_b" },
    addresses,
    {
      schemaVersion: 1,
      version: 1,
      groups: [{
        id: "group-a",
        displayName: "server-alpha",
        source: "automatic",
        members: [
          { provider: "provider_a", name: "self-a" },
          { provider: "provider_a", name: "self-b" },
        ],
      }],
      exclusions: [],
    },
  );

  assert.equal(cards.length, 4);
  assert.equal(cards[0]?.label, "server-alpha");
  assert.deepEqual(cards[0]?.members.map(({ name }) => name), ["self-a", "self-b"]);
  assert.equal(cards.find((card) => card.label === "nested")?.grouped, false);
  const crossProvider = buildProxyCards(
    ["self-a", "self-b"],
    proxyMap,
    { "self-a": "provider_a", "self-b": "provider_b" },
    addresses,
    {
      schemaVersion: 1,
      version: 1,
      groups: [{
        id: "group-a",
        displayName: "server-alpha",
        source: "automatic",
        members: [
          { provider: "provider_a", name: "self-a" },
          { provider: "provider_a", name: "self-b" },
        ],
      }],
      exclusions: [],
    },
  );
  assert.equal(crossProvider.length, 2);
  assert.equal(crossProvider.some((card) => card.grouped), false);
});

test("proxy view ordering keeps GLOBAL last and applies the selected card protocol", () => {
  const proxyMap = {
    GLOBAL: { name: "GLOBAL", type: "Selector", all: ["slow", "fast"], now: "slow" },
    AUTO: { name: "AUTO", type: "Selector", all: ["slow", "fast"], now: "fast" },
    slow: { name: "slow", type: "Vless", history: [{ delay: 320, time: "2026-08-02T09:00:00.000Z" }] },
    fast: { name: "fast", type: "Trojan", history: [{ delay: 80, time: "2026-08-02T09:00:00.000Z" }] },
  };
  assert.deepEqual(listProxyGroups(proxyMap).map(({ name }) => name), ["AUTO", "GLOBAL"]);

  const cards = buildProxyCards(["slow", "fast"], proxyMap, {}, {
    inline: {},
    providers: {},
    groups: {},
    countries: {},
  });
  const sorted = sortProxyCards(
    cards,
    "latency",
    "asc",
    (card) => card.members[0]?.name || "",
    proxyMap,
    {},
    { inline: {}, providers: {}, groups: {}, countries: {} },
    { schemaVersion: 1, version: 0, regions: [] },
    {},
  );
  assert.deepEqual(sorted.map(({ label }) => label), ["fast", "slow"]);

  const named = buildProxyCards(["D", "B", "A", "C"], {
    A: { type: "Vless" }, B: { type: "Vless" }, C: { type: "Vless" }, D: { type: "Vless" },
  }, {}, { inline: {}, providers: {}, groups: {}, countries: {} });
  assert.deepEqual(sortProxyCards(
    named,
    "name",
    "asc",
    (card) => card.members[0]?.name || "",
    {},
    {},
    { inline: {}, providers: {}, groups: {}, countries: {} },
    { schemaVersion: 1, version: 0, regions: [] },
    {},
  ).map(({ label }) => label), ["A", "B", "C", "D"]);
});

test("proxy merge drafts preserve manual groups, stale identities, and repeatable explicit auto runs", () => {
  const runtime = {
    SELECT: { name: "SELECT", all: ["a-vless", "a-vmess", "b-vless", "b-vmess", "new-node"] },
    "a-vless": { type: "Vless" },
    "a-vmess": { type: "VMess" },
    "b-vless": { type: "Vless" },
    "b-vmess": { type: "VMess" },
    "new-node": { type: "Trojan" },
  };
  const providers = {
    "a-vless": "provider-a", "a-vmess": "provider-a",
    "b-vless": "provider-a", "b-vmess": "provider-a", "new-node": "provider-a",
  };
  const available = availableProxyNodes(runtime, providers);
  const addresses = {
    inline: {}, providers: {}, countries: {},
    groups: { "provider-a": [
      { suffix: "machine-a", members: [
        { name: "a-vless", protocol: "VLESS", port: "443" },
        { name: "a-vmess", protocol: "VMess", port: "8443" },
      ] },
      { suffix: "machine-b", members: [
        { name: "b-vless", protocol: "VLESS", port: "443" },
        { name: "b-vmess", protocol: "VMess", port: "8443" },
      ] },
    ] },
  };
  let draft = createManualMergeGroup(
    { schemaVersion: 1, version: 0, groups: [], exclusions: [] },
    "manual-a",
    "Manual A",
    available.filter(({ name }) => name.startsWith("a-")),
  );
  draft = applyAutomaticRecognition(draft, addresses, available, () => "auto-b");
  assert.deepEqual(draft.groups.map(({ id }) => id), ["manual-a", "auto-b"]);
  assert.equal(draft.groups[0]?.displayName, "Manual A");

  draft = renameMergeGroup(draft, "manual-a", "Renamed A");
  draft = splitMergeGroup(draft, "auto-b");
  assert.equal(draft.groups[0]?.displayName, "Renamed A");
  assert.equal(draft.exclusions.length, 0);
  assert.equal(applyAutomaticRecognition(draft, addresses, available, () => "recognized-again").groups.length, 2);

  const regrouped = createManualMergeGroup(
    draft,
    "manual-b",
    "Manual B",
    available.filter(({ name }) => name.startsWith("b-")),
  );
  assert.equal(regrouped.groups.length, 2);
  assert.equal(regrouped.exclusions.length, 0);

  const withNewCandidate = {
    ...addresses,
    groups: { "provider-a": [...addresses.groups["provider-a"], {
      suffix: "new-machine",
      members: [
        { name: "new-node", protocol: "Trojan", port: "443" },
        { name: "missing-until-refresh", protocol: "VMess", port: "8443" },
      ],
    }] },
  };
  assert.equal(regrouped.groups.length, 2);
  assert.equal(applyAutomaticRecognition(regrouped, withNewCandidate, available, () => "new-auto").groups.length, 2);

  const stale = { provider: "provider-a", name: "gone-node" };
  const withStale = addMergeGroupMembers(regrouped, "manual-a", [stale]);
  assert.equal(mergeGroupAvailability(withStale.groups[0]!, available).at(-1)?.available, false);
  const unchangedAtTwo = removeMergeGroupMember({
    ...withStale,
    groups: [{ ...withStale.groups[0]!, members: withStale.groups[0]!.members.slice(0, 2) }],
  }, "manual-a", withStale.groups[0]!.members[0]!);
  assert.equal(unchangedAtTwo.groups.length, 0);
});

test("proxy merge draft cancel and failed save leave the published settings unchanged", async () => {
  const published = { schemaVersion: 1 as const, version: 4, groups: [], exclusions: [] };
  const draft = beginProxyMergeDraft(published);
  draft.exclusions.push({ provider: "provider-a", name: "node-a" });
  assert.deepEqual(published.exclusions, []);

  let calls = 0;
  await assert.rejects(persistProxyMergeDraft(draft, async () => {
    calls += 1;
    throw new Error("injected save failure");
  }));
  assert.equal(calls, 1);
  assert.equal(draft.exclusions.length, 1);
  assert.deepEqual(published.exclusions, []);
});

test("proxy merge display hides absent identities without losing them on another edit or save", async () => {
  const node = (name: string, provider = "p") => ({ name, provider });
  const original = {
    schemaVersion: 1 as const, version: 8,
    groups: [
      { id: "partial", displayName: "Partial", source: "manual" as const, members: [node("missing"), node("a"), node("b")] },
      { id: "single", displayName: "Single", source: "manual" as const, members: [node("c"), node("missing-c")] },
      { id: "absent", displayName: "Absent", source: "automatic" as const, members: [node("a", "other"), node("gone")] },
    ],
    exclusions: [node("excluded")],
  };
  const available = ["a", "b", "c"].map((name) => ({ ...node(name), protocol: "VLESS" }));
  const draft = beginProxyMergeDraft(original);
  const display = proxyMergeGroupsForDisplay(draft, available);
  assert.deepEqual(display.current.map(({ id }) => id), ["partial", "single"]);
  assert.deepEqual(display.absent.map(({ id }) => id), ["absent"]);
  assert.equal(mergeGroupAvailability(display.current[1]!, available).filter((member) => member.available).length, 1);
  assert.equal(buildProxyCards(["c"], { c: { name: "c", type: "Vless" } }, { c: "p" }, { inline: {}, providers: {}, groups: {}, countries: {} }, draft)[0]?.grouped, false);
  assert.deepEqual(proxyMergeGroupsForDisplay(draft, null), { current: draft.groups, absent: [] });
  assert.deepEqual(proxyMergeGroupsForDisplay(draft, []).absent, draft.groups);
  const renamed = renameMergeGroup(draft, "partial", "Renamed");
  let submitted: typeof renamed | undefined;
  await persistLoadedProxyMergeDraft(renamed, true, false, async (value) => {
    submitted = structuredClone(value);
    return { ...value, version: value.version + 1 };
  });
  assert.deepEqual(submitted?.groups.map(({ members }) => members), original.groups.map(({ members }) => members));
  assert.deepEqual(submitted?.exclusions, original.exclusions);
  assert.equal(submitted?.groups[0]?.displayName, "Renamed");
  assert.equal(original.groups[0]?.displayName, "Partial");
  const reappeared = [...available, ...original.groups[2]!.members.map((identity) => ({ ...identity, protocol: "VLESS" }))];
  assert.deepEqual(proxyMergeGroupsForDisplay(renamed, reappeared).absent, []);
  assert.deepEqual(proxyMergeGroupsForDisplay(renamed, reappeared).current.map(({ id }) => id), ["partial", "single", "absent"]);
});

test("proxy merge drag targets retain full member indices and preserve collapsed members", () => {
  const node = (name: string) => ({ provider: "p", name });
  const original = {
    schemaVersion: 1 as const, version: 3, exclusions: [node("excluded")],
    groups: [
      { id: "target", displayName: "Target", source: "manual" as const, members: [node("missing-first"), node("a"), node("missing-middle"), node("b")] },
      { id: "hidden", displayName: "Hidden", source: "automatic" as const, members: [node("hidden-a"), node("hidden-b")] },
    ],
  };
  const available = ["a", "b"].map((name) => ({ ...node(name), protocol: "VLESS" }));
  const visible = mergeGroupAvailability(original.groups[0]!, available).filter((member) => member.available);
  assert.deepEqual(visible.map(({ index }) => index), [1, 3]);
  const target = visible[1]!;
  const inserted = endProxyMergeDrag(previewProxyMergeDrag(beginProxyMergeDrag(original, node("new")), "target", target.index, target));
  assert.deepEqual(inserted.groups[0]?.members.map(({ name }) => name), ["missing-first", "a", "missing-middle", "new", "b"]);
  assert.deepEqual(inserted.groups[1], original.groups[1]);
  assert.deepEqual(inserted.exclusions, original.exclusions);
  const reordered = previewProxyMergeDrag(beginProxyMergeDrag(original, node("b")), "target", visible[0]!.index, visible[0]);
  assert.deepEqual(endProxyMergeDrag(reordered).groups[0]?.members.map(({ name }) => name), ["missing-first", "b", "a", "missing-middle"]);
  assert.deepEqual(cancelProxyMergeDrag(reordered), original);
  assert.equal(renameMergeGroup(original, "hidden", "Renamed hidden").groups[1]?.displayName, "Renamed hidden");
  assert.deepEqual(removeMergeGroupMember(original, "target", node("missing-first")).groups[0]?.members.map(({ name }) => name), ["a", "missing-middle", "b"]);
  assert.equal(splitMergeGroup(original, "hidden").groups.some(({ id }) => id === "hidden"), false);
});

test("proxy merge group IDs fall back to distinct RFC 4122 v4 UUIDs without randomUUID", () => {
  let seed = 0;
  const cryptoFixture = {
    getRandomValues: (bytes: Uint8Array) => {
      seed += 1;
      bytes.forEach((_value, index) => { bytes[index] = seed + index; });
      return bytes;
    },
  };
  const manualId = createProxyMergeGroupId(cryptoFixture);
  const automaticId = createProxyMergeGroupId(cryptoFixture);
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(manualId, uuidV4);
  assert.match(automaticId, uuidV4);
  assert.notEqual(manualId, automaticId);
  const nodes = [
    { provider: "provider-a", name: "manual-a", protocol: "VLESS" },
    { provider: "provider-a", name: "manual-b", protocol: "VMess" },
    { provider: "provider-a", name: "auto-a", protocol: "Trojan" },
    { provider: "provider-a", name: "auto-b", protocol: "Hysteria2" },
  ];
  const manual = createManualMergeGroup(
    { schemaVersion: 1, version: 0, groups: [], exclusions: [] },
    manualId,
    "Manual",
    nodes.slice(0, 2),
  );
  const automatic = applyAutomaticRecognition(manual, {
    inline: {}, providers: {}, countries: {},
    groups: { "provider-a": [{ suffix: "Auto", members: [
      { name: "auto-a", protocol: "Trojan", port: "443" },
      { name: "auto-b", protocol: "Hysteria2", port: "8443" },
    ] }] },
  }, nodes, () => automaticId);
  assert.deepEqual(automatic.groups.map(({ id }) => id), [manualId, automaticId]);

  const nativeId = "12345678-1234-4123-8123-123456789abc";
  assert.equal(createProxyMergeGroupId({
    randomUUID: () => nativeId,
    getRandomValues: () => { throw new Error("fallback must not run"); },
  }), nativeId);
  const afterThrow = createProxyMergeGroupId({
    randomUUID: () => { throw new Error("unsupported context"); },
    getRandomValues: cryptoFixture.getRandomValues,
  });
  assert.match(afterThrow, uuidV4);
});

test("proxy merge session save requires a successful open-session load", async () => {
  const freshDraft = { schemaVersion: 1 as const, version: 7, groups: [], exclusions: [] };
  let puts = 0;
  const save = async (value: typeof freshDraft) => {
    puts += 1;
    return { ...value, version: value.version + 1 };
  };
  assert.equal(await persistLoadedProxyMergeDraft(freshDraft, false, false, save), null);
  assert.equal(puts, 0);
  assert.equal(await persistLoadedProxyMergeDraft(freshDraft, true, true, save), null);
  assert.equal(puts, 0);
  assert.equal((await persistLoadedProxyMergeDraft(freshDraft, true, false, save))?.version, 8);
  assert.equal(puts, 1);
});

test("explicit automatic recognition augments only one exact automatic subset", () => {
  const identities = ["a", "b", "c", "d", "e"].map((name) => ({
    provider: "provider-a",
    name,
    protocol: "VLESS",
  }));
  const addressesFor = (names: string[]) => ({
    inline: {}, providers: {}, countries: {},
    groups: { "provider-a": [{
      suffix: "Machine",
      members: names.map((name) => ({ name, protocol: "VLESS", port: "443" })),
    }] },
  });
  const empty = { schemaVersion: 1 as const, version: 0, groups: [], exclusions: [] };
  const first = applyAutomaticRecognition(empty, addressesFor(["a", "b"]), identities.slice(0, 2), () => "auto-1");
  assert.deepEqual(first.groups[0]?.members.map(({ name }) => name), ["a", "b"]);
  assert.equal(first.groups[0]?.id, "auto-1");

  const renamedFirst = {
    ...first,
    groups: [{ ...first.groups[0]!, displayName: "Custom Machine" }],
  };
  const beforeSecondClick = structuredClone(renamedFirst);
  assert.deepEqual(beforeSecondClick.groups[0]?.members.map(({ name }) => name), ["a", "b"]);
  const augmented = applyAutomaticRecognition(renamedFirst, addressesFor(["a", "b", "c"]), identities.slice(0, 3), () => "unused");
  assert.deepEqual(augmented.groups[0]?.members.map(({ name }) => name), ["a", "b", "c"]);
  assert.deepEqual(
    (({ id, displayName, source }) => ({ id, displayName, source }))(augmented.groups[0]!),
    { id: "auto-1", displayName: "Custom Machine", source: "automatic" },
  );

  const manual = createManualMergeGroup(empty, "manual-1", "Manual", identities.slice(0, 2));
  const augmentedManual = applyAutomaticRecognition(manual, addressesFor(["a", "b", "c"]), identities.slice(0, 3), () => "unused");
  assert.deepEqual(augmentedManual.groups[0]?.members.map(({ name }) => name), ["a", "b", "c"]);
  assert.equal(augmentedManual.groups[0]?.id, "manual-1");
  assert.equal(augmentedManual.groups[0]?.displayName, "Manual");

  const excluded = { ...first, exclusions: [identities[2]!] };
  const readded = applyAutomaticRecognition(excluded, addressesFor(["a", "b", "c"]), identities.slice(0, 3), () => "unused");
  assert.deepEqual(readded.groups[0]?.members.map(({ name }) => name), ["a", "b", "c"]);
  assert.deepEqual(readded.exclusions, []);

  const ambiguous = {
    ...empty,
    groups: [
      { id: "auto-ab", displayName: "AB", source: "automatic" as const, members: identities.slice(0, 2) },
      { id: "auto-cd", displayName: "CD", source: "automatic" as const, members: identities.slice(2, 4) },
    ],
  };
  assert.deepEqual(
    applyAutomaticRecognition(ambiguous, addressesFor(["a", "b", "c", "d", "e"]), identities, () => "unused"),
    ambiguous,
  );
});

test("continuous merge recognition reuses manual groups after split and preserves exact drag order", () => {
  const identities = ["a", "b", "c", "d"].map((name) => ({ provider: "p", name }));
  const available = identities.map((identity) => ({ ...identity, protocol: "Vmess" }));
  const addresses = {
    countries: {},
    groups: {
      p: [{ suffix: "Machine", members: identities.slice(0, 3).map((identity) => ({ ...identity, address: `${identity.name}.invalid` })) }],
    },
  };
  const manual = {
    schemaVersion: 1 as const,
    version: 1,
    exclusions: [identities[2]!],
    groups: [
      { id: "manual", displayName: "Custom", source: "manual" as const, members: identities.slice(0, 2) },
      { id: "other", displayName: "Other", source: "manual" as const, members: identities.slice(2) },
    ],
  };

  const moved = moveMergeGroupMember(manual, identities[2]!, "manual", 1);
  assert.deepEqual(moved.groups.find((group) => group.id === "manual")?.members.map(({ name }) => name), ["a", "c", "b"]);
  assert.equal(moved.groups.some((group) => group.id === "other"), false);

  const reordered = moveMergeGroupMember(moved, identities[1]!, "manual", 0);
  assert.deepEqual(reordered.groups[0]?.members.map(({ name }) => name), ["b", "a", "c"]);

  const split = splitMergeGroup(reordered, "manual");
  assert.deepEqual(split.exclusions, reordered.exclusions);
  const regrouped = applyAutomaticRecognition(split, addresses, available, () => "auto-new");
  assert.deepEqual(regrouped.groups[0], {
    id: "auto-new",
    displayName: "Machine",
    source: "automatic",
    members: identities.slice(0, 3),
  });

  const augmented = applyAutomaticRecognition({
    ...manual,
    exclusions: [],
    groups: [manual.groups[0]!],
  }, addresses, available, () => "unused");
  assert.deepEqual(augmented.groups[0]?.members, identities.slice(0, 3));
  assert.equal(augmented.groups[0]?.id, "manual");
  assert.equal(augmented.groups[0]?.displayName, "Custom");
  assert.equal(augmented.groups[0]?.source, "manual");
});

test("proxy merge drag session previews source removal, live insertion, cancellation, and commit", () => {
  const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((name) => ({ provider: "p", name }));
  const original = {
    schemaVersion: 1 as const,
    version: 2,
    exclusions: [],
    groups: [
      { id: "left", displayName: "Left", source: "manual" as const, members: [a!, b!, c!] },
      { id: "right", displayName: "Right", source: "manual" as const, members: [d!, e!] },
    ],
  };

  let same = beginProxyMergeDrag(original, b!);
  assert.deepEqual(same.preview.groups[0]?.members.map(({ name }) => name), ["a", "c"]);
  same = previewProxyMergeDrag(same, "left", 0);
  assert.deepEqual(same.preview.groups[0]?.members.map(({ name }) => name), ["b", "a", "c"]);
  same = previewProxyMergeDrag(same, "left", 2);
  assert.deepEqual(same.preview.groups[0]?.members.map(({ name }) => name), ["a", "c", "b"]);
  assert.deepEqual(cancelProxyMergeDrag(same), original);
  assert.deepEqual(endProxyMergeDrag(same).groups[0]?.members.map(({ name }) => name), ["a", "c", "b"]);

  let cross = beginProxyMergeDrag(original, a!);
  cross = previewProxyMergeDrag(cross, "right", 1);
  assert.deepEqual(cross.preview.groups.find((group) => group.id === "left")?.members.map(({ name }) => name), ["b", "c"]);
  assert.deepEqual(cross.preview.groups.find((group) => group.id === "right")?.members.map(({ name }) => name), ["d", "a", "e"]);

  const dissolving = beginProxyMergeDrag({ ...original, groups: [
    { ...original.groups[0]!, members: [a!, b!] },
    original.groups[1]!,
  ] }, a!);
  assert.deepEqual(dissolving.preview.groups.find((group) => group.id === "left")?.members, [b]);
  const reversed = previewProxyMergeDrag(dissolving, "left", 1);
  assert.deepEqual(endProxyMergeDrag(reversed).groups.find((group) => group.id === "left")?.members.map(({ name }) => name), ["b", "a"]);
  const inserted = previewProxyMergeDrag(dissolving, "right", 2);
  assert.deepEqual(inserted.preview.groups.find((group) => group.id === "right")?.members.map(({ name }) => name), ["d", "e", "a"]);
  assert.equal(endProxyMergeDrag(inserted).groups.some((group) => group.id === "left"), false);

  const leftTarget = previewProxyMergeDrag(same, "right", 1);
  assert.equal(leftTarget.valid, true);
  const invalid = previewProxyMergeDrag(leftTarget, null);
  assert.equal(invalid.valid, false);
  assert.deepEqual(endProxyMergeDrag(invalid), original);
});

test("proxy merge drag sessions are idempotent and support member and group returns to unmerged", () => {
  const [a, b, c, d, e, loose] = ["a", "b", "c", "d", "e", "loose"].map((name) => ({ provider: "p", name }));
  const original = {
    schemaVersion: 1 as const,
    version: 3,
    exclusions: [{ provider: "p", name: "excluded" }],
    groups: [
      { id: "left", displayName: "Left", source: "manual" as const, members: [a!, b!, c!] },
      { id: "right", displayName: "Right", source: "automatic" as const, members: [d!, e!] },
    ],
  };

  const started = beginProxyMergeDrag(original, b!);
  const overC = previewProxyMergeDrag(started, "left", 2, c!);
  const sameOverC = previewProxyMergeDrag(overC, "left", 1, c!);
  assert.equal(sameOverC, overC);
  assert.deepEqual(overC.preview.groups[0]?.members.map(({ name }) => name), ["a", "b", "c"]);
  const invalid = previewProxyMergeDrag(overC, null);
  assert.equal(previewProxyMergeDrag(invalid, null), invalid);
  assert.deepEqual(endProxyMergeDrag(invalid), original);
  assert.deepEqual(cancelProxyMergeDrag(overC), original);

  const memberLeft = previewProxyMergeDragToUnmerged(beginProxyMergeDrag(original, b!));
  assert.equal(previewProxyMergeDragToUnmerged(memberLeft), memberLeft);
  const memberResult = endProxyMergeDrag(memberLeft);
  assert.deepEqual(memberResult.groups.find(({ id }) => id === "left")?.members.map(({ name }) => name), ["a", "c"]);
  assert.deepEqual(memberResult.exclusions, original.exclusions);

  const twoMember = { ...original, groups: [{ ...original.groups[0]!, members: [a!, b!] }, original.groups[1]!] };
  const dissolved = endProxyMergeDrag(previewProxyMergeDragToUnmerged(beginProxyMergeDrag(twoMember, a!)));
  assert.equal(dissolved.groups.some(({ id }) => id === "left"), false);
  assert.deepEqual(dissolved.exclusions, original.exclusions);

  const groupStarted = beginProxyMergeGroupDrag(original, "right");
  assert.ok(groupStarted);
  assert.equal(groupStarted.preview.groups.some(({ id }) => id === "right"), false);
  const groupLeft = previewProxyMergeDragToUnmerged(groupStarted);
  assert.equal(endProxyMergeDrag(groupLeft).groups.some(({ id }) => id === "right"), false);
  assert.deepEqual(endProxyMergeDrag(groupLeft).exclusions, original.exclusions);
  assert.deepEqual(cancelProxyMergeDrag(groupLeft), original);

  const looseLeft = previewProxyMergeDragToUnmerged(beginProxyMergeDrag(original, loose!));
  assert.equal(looseLeft.valid, false);
  assert.deepEqual(endProxyMergeDrag(looseLeft), original);
});

test("automatic merge recognition emits valid exact identities and clears assigned exclusions", () => {
  const nodes = ["a", "b", "c", "d"].map((name) => ({ provider: "p", name, protocol: "Vless" }));
  const identity = (name: string) => ({ provider: "p", name });
  const simpleAddresses = {
    inline: {}, providers: {}, countries: {},
    groups: { p: [{ suffix: "Machine", members: ["a", "b", "c"].map((name) => ({
      name, protocol: "Vless", port: "443",
    })) }] },
  };
  const result = applyAutomaticRecognition({
    schemaVersion: 1,
    version: 4,
    groups: [],
    exclusions: [identity("a"), identity("b"), identity("a"), identity("d")],
  }, {
    inline: {}, providers: {}, countries: {},
    groups: { p: [
      { suffix: " Machine ", members: [
        { name: "a", protocol: "Vless", port: "443" },
        { name: "a", protocol: "Vless", port: "443" },
        { name: "b", protocol: "Vmess", port: "8443" },
        { name: "c", protocol: "Trojan", port: "9443" },
      ] },
      { suffix: "Overlap", members: [
        { name: "c", protocol: "Trojan", port: "9443" },
        { name: "d", protocol: "Vless", port: "443" },
      ] },
      { suffix: "   ", members: [
        { name: "a", protocol: "Vless", port: "443" },
        { name: "d", protocol: "Vless", port: "443" },
      ] },
      { suffix: "Invalid", members: [
        { name: " ", protocol: "Vless", port: "443" },
        { name: "d", protocol: "Vless", port: "443" },
      ] },
    ] },
  }, nodes, () => "automatic-machine");

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]?.displayName, "Machine");
  assert.deepEqual(result.groups[0]?.members.map(({ name }) => name), ["a", "b", "c"]);
  const assignedKeys = result.groups.flatMap((group) => group.members.map(proxyIdentityKey));
  assert.equal(new Set(assignedKeys).size, assignedKeys.length);
  assert.equal(result.groups.every((group) => group.displayName.trim() && group.members.length >= 2), true);
  assert.deepEqual(result.exclusions, [identity("d")]);

  const manual = {
    schemaVersion: 1 as const,
    version: 4,
    groups: [{
      id: "manual-machine",
      displayName: "Custom Name",
      source: "manual" as const,
      members: [identity("a"), identity("b")],
    }],
    exclusions: [identity("c"), identity("d")],
  };
  const augmentedManual = applyAutomaticRecognition(manual, simpleAddresses, nodes, () => "unused");
  assert.deepEqual(augmentedManual.groups[0], {
    ...manual.groups[0],
    members: [identity("a"), identity("b"), identity("c")],
  });
  assert.deepEqual(augmentedManual.exclusions, [identity("d")]);

  const unnamedDraft = {
    ...manual,
    groups: [{ ...manual.groups[0]!, displayName: "" }],
    exclusions: [identity("a"), identity("d")],
  };
  let unnamedIdCalls = 0;
  const augmentedUnnamed = applyAutomaticRecognition(unnamedDraft, simpleAddresses, nodes, () => {
    unnamedIdCalls += 1;
    return "must-not-be-created";
  });
  assert.equal(augmentedUnnamed.groups[0]?.id, "manual-machine");
  assert.equal(augmentedUnnamed.groups[0]?.displayName, "");
  assert.deepEqual(augmentedUnnamed.groups[0]?.members, [identity("a"), identity("b"), identity("c")]);
  assert.equal(unnamedIdCalls, 0);
});

test("proxy card selection prefers runtime, saved choice, then first member", () => {
  const card = {
    key: "group:provider:members",
    label: "server-alpha",
    provider: "provider",
    grouped: true,
    members: [
      { name: "node-a", protocol: "VLESS", port: "443" },
      { name: "node-b", protocol: "VMess", port: "8443" },
    ],
  };
  assert.equal(selectedProxyCardNode(card, "node-b", "node-a"), "node-b");
  assert.equal(selectedProxyCardNode(card, "other", "node-b"), "node-b");
  assert.equal(selectedProxyCardNode(card, "other", "missing"), "node-a");
  assert.match(proxyCardPreferenceKey("provider", "group", card.key), /^proxy-card-selection:/);
  const unnamed = { ...card, label: "" };
  assert.equal(proxyCardDisplayLabel(unnamed, "node-a"), "node-a");
  assert.equal(proxyCardDisplayLabel(unnamed, "node-b"), "node-b");
  assert.equal(proxyCardDisplayLabel(card, "node-b"), "server-alpha");
  const emptyNameSettings = createManualMergeGroup(
    { schemaVersion: 1, version: 0, groups: [], exclusions: [] },
    "unnamed",
    "",
    [
      { provider: "provider", name: "node-a" },
      { provider: "provider", name: "node-b" },
    ],
  );
  assert.equal(emptyNameSettings.groups[0]?.displayName, "");
});

test("pending proxy selections overlay runtime reads without mutating the snapshot", () => {
  const runtime = {
    AUTO: { name: "AUTO", type: "Selector", all: ["A", "B", "C"], now: "A" },
    FALLBACK: { name: "FALLBACK", type: "Selector", all: ["X", "Y"], now: "X" },
  };
  const overlaid = applyPendingProxySelections(runtime, { AUTO: "C" });

  assert.equal(runtime.AUTO.now, "A");
  assert.equal(overlaid.AUTO.now, "C");
  assert.equal(overlaid.FALLBACK, runtime.FALLBACK);
});

test("independent probes run concurrently while groups and cards reuse overlapping actual targets", async () => {
  const pending = new Map<string, Promise<number>>();
  let finishA!: (value: number) => void;
  let failB!: (error: Error) => void;
  const calls: string[] = [];
  const request = (name: string) => requestProxyDelay(pending, name, () => {
    calls.push(name);
    return new Promise<number>((resolve, reject) => { if (name === "A") finishA = resolve; else failB = reject; });
  });
  const a = request("A"), duplicate = request("A"), b = request("B");
  const results = Promise.allSettled([a, b]);
  await Promise.resolve();
  assert.equal(a, duplicate);
  assert.deepEqual(calls, ["A", "B"]);
  finishA(23); failB(new Error("failed"));
  assert.deepEqual((await results).map(result => result.status), ["fulfilled", "rejected"]);
  assert.equal(pending.size, 0);
  assert.equal(await requestProxyDelay(pending, "B", async () => 42), 42);
  assert.equal(proxyDelayTarget("Group", { Group: { now: "Nested" }, Nested: { now: "A" }, A: { type: "Socks5" } }), "A");
});

test("automatic regions share concise simplified labels without changing manual regions", () => {
  assert.equal(formatProxyCountry({ countryCode: "HK", country: "Hong Kong", region: "香港特别行政区" }), "HK · 香港 / 中国");
  assert.equal(formatProxyCountry({ countryCode: "TW", country: "Taiwan", region: "臺北市" }), "TW · 台北市 / 中国");
  assert.equal(formatProxyCountry({ countryCode: "JP", country: "Japan", region: "东京" }), "JP · 东京 / 日本");
  assert.equal(proxyRegionDisplayLabel("人工原文"), "人工原文");
});

test("DIRECT uses a domestic delay target while proxy nodes use HTTP gstatic", () => {
  assert.equal(delayTestUrl({ type: "Direct" }), DIRECT_DELAY_TEST_URL);
  assert.equal(delayTestUrl({ type: "DIRECT" }), DIRECT_DELAY_TEST_URL);
  assert.equal(delayTestUrl({ type: "Vless" }), PROXY_DELAY_TEST_URL);
  assert.equal(PROXY_DELAY_TEST_URL.startsWith("http://"), true);
  assert.equal(DIRECT_DELAY_TEST_URL.startsWith("http://"), true);
  assert.equal(DIRECT_DELAY_TEST_URL, "http://connect.rom.miui.com/generate_204");
});

test("proxy delay requests preserve native group, provider, node, and DIRECT endpoints", () => {
  assert.equal(
    proxyGroupDelayRequest("AUTO/group"),
    `/group/AUTO%2Fgroup/delay?url=${encodeURIComponent(PROXY_DELAY_TEST_URL)}&timeout=5000`,
  );
  assert.equal(
    proxyNodeDelayRequest("node/name", "provider/name", { type: "Vless" }),
    `/providers/proxies/provider%2Fname/node%2Fname/healthcheck?url=${encodeURIComponent(PROXY_DELAY_TEST_URL)}&timeout=5000`,
  );
  assert.equal(
    proxyNodeDelayRequest("DIRECT", undefined, { type: "Direct" }),
    proxyDirectDelayRequest("DIRECT"),
  );
  assert.equal(proxyNodeDelayRequest("DIRECT", "default", { type: "Direct" }), proxyDirectDelayRequest("DIRECT"));
  assert.deepEqual(
    directProxyNames(["node", "DIRECT", "direct-lower"], {
      node: { type: "Vless" },
      DIRECT: { type: "Direct" },
      "direct-lower": { type: "direct" },
    }),
    ["DIRECT", "direct-lower"],
  );
});

test("automatic merge feedback distinguishes already merged nodes from unreadable sources", () => {
  const before = { schemaVersion: 1 as const, version: 8, groups: [], exclusions: [] };
  const available = [{ provider: 'fixture', name: 'alpha', protocol: 'VLESS' }, { provider: 'fixture', name: 'beta', protocol: 'VMess' }];
  const addresses = { inline: {}, providers: { fixture: { alpha: 'edge.example.test', beta: 'edge.example.test' } }, countries: {}, groups: {
    fixture: [{ suffix: 'fixture-group', members: available.map((node) => ({ ...node, port: '443' })) }],
  } };
  const merged = applyAutomaticRecognition(before, addresses, available, () => 'new-group');
  assert.equal(merged.groups.length, 1);
  assert.match(automaticRecognitionFeedback(before, merged, addresses, available), /新增 1 组、加入 2 个节点/);
  const repeated = applyAutomaticRecognition(merged, addresses, available, () => 'unused');
  assert.equal(repeated, merged);
  assert.match(automaticRecognitionFeedback(merged, repeated, addresses, available), /已读取 2 个节点地址.*已合并/);
  assert.match(automaticRecognitionFeedback(merged, merged, { ...addresses, groups: {} }, available), /没有符合自动合并条件/);
  assert.match(automaticRecognitionFeedback(merged, merged, { ...addresses, providers: {} }, available), /没有读到/);
});
