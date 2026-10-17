import { resolveSettingsValues } from "../src/features/system/managerSettingsValues.ts";
import { managerSettingsForm } from "../src/features/system/managerSettingsForm.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError } from "../src/api/configClient.ts";
import { cleanCollectionLocation, collectionEditLocation, configEditLocation, configRenameLocation, readCollectionTarget } from "../src/shared/collectionTarget.ts";

import {
  compatibilityRedirects,
  navigationItemFromPath,
  navigationItems,
  redirectTargetForPath,
  routeIdFromPath,
} from "../src/app/navigation.ts";
import {
  navigationBlockReason,
  shouldBlockNavigation,
} from "../src/app/state/dirtyGuard.ts";
import {
  calculateConnectionRates,
  connectionAgeSeconds,
  connectionColumnValue,
  connectionSource,
  connectionTarget,
  formatDuration,
} from "../src/features/connections/connectionViewModel.ts";
import {
  configRuleItems,
  configProxyGroupNames,
  configRuleProviderNames,
  filterRuleItems,
  reorderConfigRules,
  updateConfigRules,
  ruleItems,
  rulePolicyEditable,
  ruleTone,
} from "../src/features/rules/ruleViewModel.ts";
import {
  commitRuleEditorRefresh,
  commitRuleEditorSave,
  createRuleEditorValue,
  addRuleSetEditorValue,
  addRuleEditorValues,
  parseWebsiteRules,
  discardRuleEditorValue,
  moveRuleEditorValue,
  moveRuleInFullOrder,
  removeRuleEditorValue,
  ruleOrderDirty,
  saveRuleConfiguration,
  selectRuleConfigTarget,
  setRuleEditorPolicy,
} from "../src/features/rules/ruleEditorState.ts";

test("website rules normalize exact hosts, report invalid lines and preserve batch insertion order", () => {
  const parsed = parseWebsiteRules('example.com\nhttps://www.example.com/path?q=1\n\nhttps://example.com/other\nhttps://sub.example.com:8443/x\nftp://bad.example\nnot a domain');
  assert.deepEqual(parsed.hosts, ["example.com", "www.example.com", "sub.example.com"]);
  assert.deepEqual(parsed.errors.map((error) => error.line), [6, 7]);
  const source = 'mode: rule\nrules:\n  - DOMAIN,keep.example,DIRECT\n  - MATCH,DIRECT\n';
  const initial = createRuleEditorValue(configRuleItems(source));
  const values = parsed.hosts.map((payload) => ({ type: "DOMAIN", payload, policy: "DIRECT" }));
  for (const position of ["first", "before-match", "last"] as const) {
    const added = addRuleEditorValues(initial, values, position);
    const saved = configRuleItems(updateConfigRules(source, added.draft));
    const start = position === "first" ? 0 : position === "last" ? 2 : 1;
    assert.deepEqual(saved.slice(start, start + 3).map((rule) => rule.payload), parsed.hosts);
    assert.deepEqual(saved.map(({ type, payload, policy }) => [type, payload, policy]), added.draft.map(({ type, payload, policy }) => [type, payload, policy]));
  }
  const suffix = addRuleEditorValues(createRuleEditorValue([]), [{ type: "DOMAIN-SUFFIX", payload: "www.example.com", policy: "REJECT" }], "first");
  assert.deepEqual(configRuleItems(updateConfigRules('mode: rule\n', suffix.draft)).map(({ type, payload }) => [type, payload]), [["DOMAIN-SUFFIX", "www.example.com"]]);
  const finalSource = 'rules: ["FINAL,DIRECT"]\n';
  assert.deepEqual(configRuleItems(updateConfigRules(finalSource, addRuleEditorValues(createRuleEditorValue(configRuleItems(finalSource)), values, "before-match").draft)).map((rule) => rule.type), ["DOMAIN", "DOMAIN", "DOMAIN", "FINAL"]);
  assert.throws(() => updateConfigRules(source, [{ id: "draft-rule:invalid", type: "OTHER", payload: "x", policy: "DIRECT" }]));
});
import {
  readRuleSnapshotFrame,
  RuleDisplaySnapshotCache,
  ruleTargetLoading,
} from "../src/features/rules/ruleSnapshot.ts";
import { configFileState, setSelectedConfigFile } from "../src/shared/configFileState.ts";
import { RuntimeApplyError } from "../src/shared/runtimeApplication.ts";

test("editing source query changes use the draft navigation guard and keep runtime return identity", () => {
  const dirty = { dirty: true, pendingWrite: false };
  const source = "/collections?source=A.yaml&sha256=old&collection=first";
  assert.equal(shouldBlockNavigation(dirty, source, "/collections"), true);
  assert.equal(shouldBlockNavigation(dirty, source, "/collections?source=B.yaml&sha256=other"), true);
  assert.equal(shouldBlockNavigation(dirty, source, "/collections?source=A.yaml&sha256=new&collection=second"), false);
  assert.equal(shouldBlockNavigation({ dirty: false, pendingWrite: false }, source, "/collections"), false);
  assert.equal(shouldBlockNavigation({ dirty: false, pendingWrite: true }, source, "/collections"), true);
  assert.equal(shouldBlockNavigation(dirty, source, "/runtime-config"), false);
  assert.equal(shouldBlockNavigation(dirty, "/runtime-config", source, source), false);
  assert.equal(shouldBlockNavigation(dirty, "/runtime-config", "/collections", source), true);
});

test("history targets guard source changes while version, selection and runtime return preserve their owner", () => {
  const source = { name: "A.yaml", sha256: "a".repeat(64) };
  const current = collectionEditLocation(source, { category: "proxy", name: "first" });
  const updated = collectionEditLocation({ ...source, sha256: "b".repeat(64) }, { category: "rule", name: "second" });
  const other = collectionEditLocation({ ...source, name: "B.yaml" });
  const dirty = { dirty: true, pendingWrite: false };
  const pending = { dirty: true, pendingWrite: true };
  assert.equal(shouldBlockNavigation(dirty, current, updated), false);
  assert.equal(shouldBlockNavigation(pending, current, updated), false);
  assert.equal(shouldBlockNavigation(dirty, current, other), true);
  assert.equal(shouldBlockNavigation(pending, current, other), true);
  assert.equal(shouldBlockNavigation(dirty, current, { pathname: "/collections" }), true);
  assert.equal(shouldBlockNavigation(dirty, configEditLocation(source), configEditLocation({ ...source, name: "B.yaml" })), true);
  assert.equal(shouldBlockNavigation(dirty, current, "/runtime-config"), false);
  assert.equal(shouldBlockNavigation(pending, current, "/runtime-config"), true);
  assert.equal(shouldBlockNavigation(dirty, "/runtime-config", structuredClone(current), current), false);
  assert.equal(shouldBlockNavigation(dirty, "/runtime-config", other, current), true);
  assert.equal(shouldBlockNavigation(pending, "/runtime-config", current, current), true);
  const legacy = { pathname: "/collections", search: "?source=A.yaml&sha256=bad" };
  assert.equal(shouldBlockNavigation(dirty, legacy, cleanCollectionLocation(legacy)), false);
  assert.equal(shouldBlockNavigation(dirty, legacy, other), true);
});

test("confirmed config rename replaces only its current history identity while preserving draft navigation protection", () => {
  const from = { name: "old.yaml", sha256: "a".repeat(64) };
  const to = { name: "new.yaml", sha256: from.sha256 };
  const current = { ...configEditLocation(from), key: "rename-entry" };
  const destination = configRenameLocation(current, from, to);
  const dirty = { dirty: true, pendingWrite: false };
  const pending = { dirty: true, pendingWrite: true };
  for (const guard of [dirty, pending]) {
    assert.equal(shouldBlockNavigation(guard, current, destination, null, "REPLACE"), false);
    for (const action of ["PUSH", "POP"]) assert.equal(shouldBlockNavigation(guard, current, destination, null, action), true);
    assert.equal(shouldBlockNavigation(guard, current, configEditLocation(to), null, "REPLACE"), true);
    assert.equal(shouldBlockNavigation(guard, { ...current, key: "other-entry" }, destination, null, "REPLACE"), true);
    assert.equal(shouldBlockNavigation(guard, current, { ...destination, pathname: "/collections" }, null, "REPLACE"), true);
    assert.equal(shouldBlockNavigation(guard, current, { ...destination, search: "?source=new.yaml&sha256=bad" }, null, "REPLACE"), true);
    const stale = configRenameLocation(current, { ...from, sha256: "b".repeat(64) }, to);
    assert.equal(shouldBlockNavigation(guard, current, stale, null, "REPLACE"), true);
    const wrongTarget = { ...destination, state: { ...destination.state, collectionTarget: { source: "other.yaml", sha256: to.sha256 } } };
    assert.equal(shouldBlockNavigation(guard, current, wrongTarget, null, "REPLACE"), true);
  }
  const renamed = { ...structuredClone(destination), key: "renamed-entry" };
  assert.deepEqual(readCollectionTarget(renamed).source, to);
  assert.equal(shouldBlockNavigation(dirty, renamed, "/runtime-config"), false);
  assert.equal(shouldBlockNavigation(dirty, "/runtime-config", renamed, renamed), false);
  assert.equal(shouldBlockNavigation(dirty, renamed, current, null, "POP"), true);
  assert.equal(shouldBlockNavigation(dirty, "/runtime-config", current, renamed), true);
  assert.equal(shouldBlockNavigation(pending, renamed, "/runtime-config"), true);
  assert.equal(shouldBlockNavigation(pending, renamed, configEditLocation(from), null, "REPLACE"), true);
});

test("primary navigation exposes the production routes and the stable runtime viewer", () => {
  assert.deepEqual(navigationItems.map((item) => item.path), [
    "/overview",
    "/proxies",
    "/rules",
    "/connections",
    "/config-center",
    "/collections",
    "/runtime-config",
    "/logs",
    "/settings",
  ]);
  assert.deepEqual(
    navigationItems.filter((item) => item.mobile === "primary").map((item) => item.path),
    ["/overview", "/proxies", "/rules", "/config-center"],
  );
  assert.deepEqual(
    navigationItems.filter((item) => item.mobile === "more").map((item) => item.path),
    ["/connections", "/collections", "/runtime-config", "/logs", "/settings"],
  );
  assert.equal(navigationItemFromPath("/settings")?.label, "设置");
  assert.equal(navigationItemFromPath("/config-center")?.label, "编辑配置");
  assert.equal(routeIdFromPath("/runtime-config"), "runtime-config");
  assert.equal(navigationItemFromPath("/runtime-config")?.label, "运行配置");
  assert.equal(routeIdFromPath("/config-center"), "config-center");
  assert.equal(routeIdFromPath("/system"), null);
});

test("root, legacy, and unknown paths resolve to canonical routes", () => {
  assert.deepEqual(compatibilityRedirects, [
    { path: "system", to: "/settings" },
    { path: "config/*", to: "/config-center" },
  ]);
  assert.equal(redirectTargetForPath("/"), "/overview");
  assert.equal(redirectTargetForPath("/system"), "/settings");
  assert.equal(redirectTargetForPath("/config/profiles"), "/config-center");
  assert.equal(redirectTargetForPath("/config/subscriptions/example/edit"), "/config-center");
  assert.equal(redirectTargetForPath("/missing"), "/overview");
  assert.equal(redirectTargetForPath("/logs"), null);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("pending writes take priority over dirty navigation", () => {
  assert.equal(
    navigationBlockReason({ dirty: true, pendingWrite: true }),
    "pending-write",
  );
  assert.equal(
    navigationBlockReason({ dirty: true, pendingWrite: false }),
    "dirty",
  );
  assert.equal(
    shouldBlockNavigation(
      { dirty: true, pendingWrite: true },
      "/config-center",
      "/config-center",
    ),
    false,
  );
});

test("a deferred config write cannot proceed and settles to the current dirty result", async () => {
  const write = deferred<void>();
  let pendingWrite = true;
  const saveConfig = async () => {
    await write.promise;
    pendingWrite = false;
  };
  const saving = saveConfig();

  assert.equal(
    navigationBlockReason({ dirty: true, pendingWrite }),
    "pending-write",
  );
  assert.equal(
    shouldBlockNavigation(
      { dirty: true, pendingWrite },
      "/config-center",
      "/overview",
    ),
    true,
  );

  write.resolve();
  await saving;

  assert.equal(navigationBlockReason({ dirty: true, pendingWrite }), "dirty");
  assert.equal(navigationBlockReason({ dirty: false, pendingWrite }), null);
});

test("runtime viewing preserves the originating draft and keeps write and departure guards", () => {
  const dirty = { dirty: true, pendingWrite: false };
  assert.equal(shouldBlockNavigation(dirty, "/config-center", "/runtime-config"), false);
  assert.equal(shouldBlockNavigation(dirty, "/runtime-config", "/config-center", "/config-center"), false);
  assert.equal(shouldBlockNavigation(dirty, "/runtime-config", "/collections", "/config-center"), true);
  assert.equal(shouldBlockNavigation({ dirty: true, pendingWrite: true }, "/config-center", "/runtime-config"), true);
  assert.equal(shouldBlockNavigation({ dirty: true, pendingWrite: true }, "/runtime-config", "/config-center", "/config-center"), true);
});

test("connection view model maps native fields and derives real snapshot rates", () => {
  const previous = [{ id: "one", download: 1_000, upload: 200 }];
  const current = [{
    id: "one",
    download: 2_500,
    upload: 500,
    start: "2026-08-07T00:00:00.000Z",
    metadata: {
      host: "example.test",
      destinationPort: 443,
      sourceIP: "192.0.2.2",
      sourcePort: 51000,
    },
  }];
  assert.deepEqual(calculateConnectionRates(previous, current, 1_500), {
    one: { downloadRate: 1_000, uploadRate: 200 },
  });
  assert.equal(connectionTarget(current[0]!), "example.test:443");
  assert.equal(connectionSource(current[0]!), "192.0.2.2:51000");
  assert.equal(connectionAgeSeconds(current[0]!, Date.parse("2026-08-07T01:01:01.000Z")), 3661);
  assert.equal(formatDuration(3661), "1h 1m");
});

test("connection rates require adjacent real snapshots and never go negative", () => {
  const firstSnapshot = [{ id: "one", download: 5_000, upload: 700 }];
  assert.deepEqual(calculateConnectionRates(undefined, firstSnapshot, 2_500), {});
  assert.deepEqual(calculateConnectionRates(firstSnapshot, firstSnapshot, 0), {});
  assert.deepEqual(
    calculateConnectionRates(
      firstSnapshot,
      [
        { id: "one", download: 4_000, upload: 900 },
        { id: "new", download: 20_000, upload: 10_000 },
      ],
      2_000,
    ),
    {
      one: { downloadRate: 0, uploadRate: 100 },
      new: { downloadRate: 0, uploadRate: 0 },
    },
  );
});

test("connection columns preserve native metadata for desktop and narrow views", () => {
  const connection = {
    id: "native",
    upload: 2_048,
    download: 4_096,
    start: "2026-08-07T00:00:00.000Z",
    rule: "DOMAIN-SUFFIX",
    rulePayload: "example.test",
    chains: ["Proxy", "Node A"],
    metadata: {
      network: "tcp",
      host: "example.test",
      sniffHost: "sniff.example.test",
      destinationPort: 443,
      sourceIP: "192.0.2.8",
      sourcePort: 51000,
      process: "browser",
    },
  };
  const rates = { native: { downloadRate: 1_024, uploadRate: 512 } };

  assert.deepEqual(
    [
      "target",
      "type",
      "process",
      "sni",
      "rule",
      "policy",
      "source",
      "sourcePort",
      "downloadRate",
      "uploadRate",
      "download",
      "upload",
      "age",
    ].map((column) =>
      connectionColumnValue(
        connection,
        column as Parameters<typeof connectionColumnValue>[1],
        rates,
        Date.parse("2026-08-07T00:01:01.000Z"),
      ),
    ),
    [
      "example.test:443",
      "TCP",
      "browser",
      "sniff.example.test",
      "DOMAIN-SUFFIX / example.test",
      "Proxy / Node A",
      "192.0.2.8",
      "51000",
      "1.0 KB/s",
      "512 B/s",
      "4.0 KB",
      "2.0 KB",
      "1m 1s",
    ],
  );
});

test("rule type view model keeps semantic categories distinct", () => {
  assert.equal(ruleTone("RULE-SET"), "provider");
  assert.equal(ruleTone("RuleSet"), "provider");
  assert.equal(ruleTone("DOMAIN-SUFFIX"), "domain");
  assert.equal(ruleTone("Domain"), "domain");
  assert.equal(ruleTone("IP-CIDR"), "network");
  assert.equal(ruleTone("IPCIDR"), "network");
  assert.equal(ruleTone("GEOIP"), "geo");
  assert.equal(ruleTone("PROCESS-NAME"), "process");
  assert.equal(ruleTone("RULE-PROVIDER"), "provider");
  assert.equal(ruleTone("AND"), "logic");
  assert.equal(ruleTone("Match"), "muted");
});

test("rule view model preserves native fields and gives duplicate rules stable identities", () => {
  const rules = ruleItems([
    { type: "DOMAIN-SUFFIX", payload: "example.test", proxy: "DIRECT" },
    { type: "DOMAIN-SUFFIX", payload: "example.test", proxy: "DIRECT" },
    { type: "MATCH" },
  ]);

  assert.deepEqual(
    rules.map(({ type, payload, policy }) => ({ type, payload, policy })),
    [
      { type: "DOMAIN-SUFFIX", payload: "example.test", policy: "DIRECT" },
      { type: "DOMAIN-SUFFIX", payload: "example.test", policy: "DIRECT" },
      { type: "MATCH", payload: "", policy: "-" },
    ],
  );
  assert.notEqual(rules[0]?.id, rules[1]?.id);
  assert.deepEqual(ruleItems([
    { type: "DOMAIN-SUFFIX", payload: "example.test", proxy: "DIRECT" },
    { type: "DOMAIN-SUFFIX", payload: "example.test", proxy: "DIRECT" },
  ]).map((rule) => rule.id), rules.slice(0, 2).map((rule) => rule.id));
});

test("config-keyed rule snapshots render immediately without storing YAML or unrelated fields", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const firstCache = new RuleDisplaySnapshotCache();
  const cached = firstCache.write("loaded.yaml", "a".repeat(64), [
    { type: "DOMAIN-SUFFIX", payload: "cached.example", proxy: "DIRECT", ignored: "not persisted" },
  ], new Date("2026-08-10T08:00:00.000Z"), storage);
  const restored = new RuleDisplaySnapshotCache().read("loaded.yaml", storage);
  assert.deepEqual(restored, cached);
  assert.equal(restored?.configName, "loaded.yaml");
  assert.equal(restored?.sha256, "a".repeat(64));
  assert.equal(restored?.rules[0]?.payload, "cached.example");
  const persisted = [...values.values()].join("");
  assert.doesNotMatch(persisted, /proxies:|secret-key|完整正文/);

  const firstFrame = readRuleSnapshotFrame("loaded.yaml", new RuleDisplaySnapshotCache(), storage);
  assert.equal(firstFrame.cacheHit, true);
  assert.equal(firstFrame.rules[0]?.payload, "cached.example");
  assert.equal(ruleTargetLoading(firstFrame.cacheHit, false), false);

  const fresh = firstCache.write("loaded.yaml", "b".repeat(64), [
    { type: "RULE-SET", payload: "fresh", proxy: "Proxy" },
  ], new Date("2026-08-10T08:01:00.000Z"), storage);
  const freshFrame = readRuleSnapshotFrame("loaded.yaml", firstCache, storage);
  assert.equal(freshFrame.sha256, fresh.sha256);
  assert.equal(freshFrame.updatedAt, fresh.updatedAt);
  assert.deepEqual(freshFrame.rules.map(({ type, payload, policy }) => ({ type, payload, policy })), [
    { type: "RULE-SET", payload: "fresh", policy: "Proxy" },
  ]);
});

test("empty rule snapshot is a cache hit and does not show initial loading", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const cache = new RuleDisplaySnapshotCache();
  cache.write("empty.yaml", "a".repeat(64), [], new Date("2026-08-10T08:00:00.000Z"), storage);

  const frame = readRuleSnapshotFrame("empty.yaml", new RuleDisplaySnapshotCache(), storage);
  assert.equal(frame.cacheHit, true);
  assert.deepEqual(frame.rules, []);
  assert.equal(ruleTargetLoading(frame.cacheHit, false), false);
});

test("no rule config is a resolved non-loading state while a real cache miss loads", () => {
  const missing = readRuleSnapshotFrame("missing.yaml", new RuleDisplaySnapshotCache(), null);
  assert.equal(missing.cacheHit, false);
  assert.equal(ruleTargetLoading(missing.cacheHit, false), true);
  assert.equal(ruleTargetLoading(false, true), false);
  assert.equal(selectRuleConfigTarget([], null), null);
});

test("pending rule refresh preserves a synchronously moved draft", () => {
  const content = "mode: rule\nrule-providers:\n  fixture:\n    type: file\n    path: ./providers/fixture.yaml\nrules:\n  - DOMAIN,a.example,DIRECT\n  - MATCH,Proxy\n  - DOMAIN,b.example,REJECT\n";
  const original = configRuleItems(content);
  const clean = createRuleEditorValue(original);

  const moved = moveRuleEditorValue(clean, original[2]!.id, original[0]!.id);
  const committed = commitRuleEditorRefresh(moved, original);
  assert.equal(committed.compatible, true);
  assert.deepEqual(committed.editor.draft.map((rule) => rule.payload), ["b.example", "a.example", ""]);
  assert.deepEqual(committed.editor.saved, original);
  assert.equal(ruleOrderDirty(committed.editor.draft, committed.editor.saved), true);

  const incompatible = commitRuleEditorRefresh(moved, original.slice(0, 2));
  assert.equal(incompatible.compatible, false);
  assert.deepEqual(incompatible.editor.draft, moved.draft);
  assert.deepEqual(incompatible.editor.saved, moved.saved);

  assert.deepEqual(configRuleProviderNames(content), ["fixture"]);
  const added = addRuleSetEditorValue(clean, "fixture", "REJECT", "before-match");
  assert.deepEqual(added.draft.map((rule) => [rule.type, rule.payload, rule.policy]), [
    ["DOMAIN", "a.example", "DIRECT"],
    ["RULE-SET", "fixture", "REJECT"],
    ["MATCH", "", "Proxy"],
    ["DOMAIN", "b.example", "REJECT"],
  ]);
  const addedContent = updateConfigRules(content, added.draft);
  assert.deepEqual(configRuleItems(addedContent).map((rule) => [rule.type, rule.payload, rule.policy]),
    added.draft.map((rule) => [rule.type, rule.payload, rule.policy]));
  const removed = removeRuleEditorValue(added, added.draft[1]!.id);
  assert.deepEqual(removed.draft, original);
});

test("pending rule save commits only the submitted draft", async () => {
  const content = "mode: rule\nrules:\n  - DOMAIN,a.example,DIRECT\n  - MATCH,Proxy\n  - DOMAIN,b.example,REJECT\n";
  const original = configRuleItems(content);
  const move1 = moveRuleEditorValue(createRuleEditorValue(original), original[1]!.id, original[0]!.id);
  const submittedDraft = move1.draft;
  let releaseDisk!: () => void;
  const diskPending = new Promise<void>((resolve) => { releaseDisk = resolve; });
  let writtenOrder: string[] = [];
  const saving = saveRuleConfiguration(
    { name: "target.yaml", content, sha256: "a".repeat(64), rules: submittedDraft },
    async (name, next) => {
      writtenOrder = configRuleItems(next).map((rule) => rule.payload);
      await diskPending;
      return { name, path: "/managed/target.yaml", content: next, sha256: "b".repeat(64) };
    },
    async () => {},
  );

  const move2 = moveRuleEditorValue(move1, original[2]!.id, original[1]!.id);
  releaseDisk();
  const firstSave = await saving;
  const savedRules = configRuleItems(firstSave.disk.content);
  const committed = commitRuleEditorSave(move2, submittedDraft, savedRules);

  assert.deepEqual(writtenOrder, ["", "a.example", "b.example"]);
  assert.deepEqual(committed.saved, savedRules);
  assert.deepEqual(committed.draft.map((rule) => rule.payload), ["b.example", "", "a.example"]);
  assert.equal(ruleOrderDirty(committed.draft, committed.saved), true);

  const unchanged = commitRuleEditorSave(move1, submittedDraft, savedRules);
  assert.equal(ruleOrderDirty(unchanged.draft, unchanged.saved), false);
});

test("rule saves rebase identities for consecutive and pending edits without crossing duplicates", async () => {
  const content = [
    "rules:",
    "  - DOMAIN,duplicate.example,DIRECT # first",
    "  - DOMAIN,duplicate.example,DIRECT # second",
    "  - MATCH,DIRECT",
    "",
  ].join("\n");
  const original = configRuleItems(content);
  assert.equal(new Set(original.map((rule) => rule.id)).size, 3);

  let submittedEditor = moveRuleEditorValue(createRuleEditorValue(original), original[1]!.id, original[0]!.id);
  submittedEditor = setRuleEditorPolicy(submittedEditor, original[1]!.id, "GroupA");
  const submittedDraft = submittedEditor.draft;
  const first = await saveRuleConfiguration(
    { name: "loaded.yaml", content, sha256: "a".repeat(64), rules: submittedDraft },
    async (name, next) => ({ name, path: "/managed/loaded.yaml", content: next, sha256: "b".repeat(64) }),
    async () => {},
  );
  assert.match(
    first.disk.content,
    /DOMAIN,duplicate\.example,GroupA # second[\s\S]*DOMAIN,duplicate\.example,DIRECT # first/,
  );
  const savedRules1 = configRuleItems(first.disk.content);
  assert.notEqual(savedRules1[0]!.id, submittedDraft[0]!.id);

  let completionEditor = moveRuleEditorValue(submittedEditor, original[2]!.id, original[1]!.id);
  completionEditor = setRuleEditorPolicy(completionEditor, original[0]!.id, "REJECT");
  const rebased = commitRuleEditorSave(completionEditor, submittedDraft, savedRules1);
  assert.deepEqual(rebased.saved.map((rule) => rule.policy), ["GroupA", "DIRECT", "DIRECT"]);
  assert.deepEqual(rebased.draft.map((rule) => rule.policy), ["DIRECT", "GroupA", "REJECT"]);
  assert.equal(ruleOrderDirty(rebased.draft, rebased.saved), true);
  assert.equal(new Set(rebased.draft.map((rule) => rule.id)).size, 3);

  const second = await saveRuleConfiguration(
    { name: "loaded.yaml", content: first.disk.content, sha256: first.disk.sha256, rules: rebased.draft },
    async (name, next) => ({ name, path: "/managed/loaded.yaml", content: next, sha256: "c".repeat(64) }),
    async () => {},
  );
  assert.match(
    second.disk.content,
    /MATCH,DIRECT[\s\S]*DOMAIN,duplicate\.example,GroupA # second[\s\S]*DOMAIN,duplicate\.example,REJECT # first/,
  );
  const savedRules2 = configRuleItems(second.disk.content);
  const clean = commitRuleEditorSave(rebased, rebased.draft, savedRules2);
  assert.equal(ruleOrderDirty(clean.draft, clean.saved), false);
  assert.deepEqual(clean.saved.map((rule) => rule.policy), ["DIRECT", "GroupA", "REJECT"]);
  assert.equal(new Set(clean.saved.map((rule) => rule.id)).size, 3);
});

test("selected config identity persists in local browser storage", () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
  try {
    setSelectedConfigFile("selected.yaml");
    assert.deepEqual(configFileState(), { selectedName: "selected.yaml" });
    assert.equal(values.size, 1);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test("rule editor target priority, filtered reordering, discard, and late refresh stay config-safe", () => {
  const files = ["first.yaml", "selected.yaml", "loaded.yaml"].map((name) => ({ name, path: name, sha256: "a".repeat(64), size: 1, updatedAt: "2026-08-10T00:00:00Z" }));
  assert.equal(selectRuleConfigTarget(files, "loaded.yaml"), "loaded.yaml");
  assert.equal(selectRuleConfigTarget(files.slice(0, 2), "missing.yaml"), null);
  assert.equal(selectRuleConfigTarget(files.slice(0, 1), null), null);

  const content = "mode: rule\nrules:\n  - DOMAIN,a.example,DIRECT\n  - MATCH,Proxy\n  - DOMAIN,b.example,REJECT\n";
  const original = configRuleItems(content);
  const filtered = filterRuleItems(original, "domain", "DOMAIN");
  const moved = moveRuleInFullOrder(original, filtered[1]!.id, filtered[0]!.id);
  assert.deepEqual(moved.map((rule) => rule.payload), ["b.example", "a.example", ""]);
  assert.equal(ruleOrderDirty(moved, original), true);
  const rewritten = reorderConfigRules(content, moved.map((rule) => rule.id));
  assert.deepEqual(configRuleItems(rewritten).map((rule) => rule.payload), ["b.example", "a.example", ""]);

  const late = commitRuleEditorRefresh(
    moveRuleEditorValue(createRuleEditorValue(original), filtered[1]!.id, filtered[0]!.id),
    original,
  );
  assert.deepEqual(late.editor.draft, moved);
  assert.equal(late.compatible, true);
  const incompatible = commitRuleEditorRefresh(late.editor, original.slice(0, 2));
  assert.deepEqual(incompatible.editor.draft, moved);
  assert.equal(incompatible.compatible, false);
  assert.deepEqual(original, configRuleItems(content));
});

test("rule policy edits preserve syntax, join ordering dirty state, and keep SUB-RULE read-only", async () => {
  const content = [
    "proxy-groups:",
    "  - { name: Main, type: select, proxies: [DIRECT] }",
    "  - { name: Backup, type: fallback, proxies: [DIRECT] }",
    "rules:",
    "  - DOMAIN,example.test, OldPolicy ,no-resolve",
    "  - AND,((DOMAIN,a.example),(NETWORK,TCP)),OldPolicy,no-resolve",
    "  - MATCH,OldPolicy",
    "  - SUB-RULE,child,OldPolicy",
    "",
  ].join("\n");
  const original = configRuleItems(content);
  assert.deepEqual(configProxyGroupNames(content), ["Main", "Backup"]);
  assert.equal(rulePolicyEditable(original[3]!), false);
  let editor = createRuleEditorValue(original);
  editor = setRuleEditorPolicy(editor, original[0]!.id, "Main");
  editor = setRuleEditorPolicy(editor, original[1]!.id, "REJECT-DROP");
  editor = setRuleEditorPolicy(editor, original[2]!.id, "DIRECT");
  assert.equal(ruleOrderDirty(editor.draft, editor.saved), true);
  assert.deepEqual(discardRuleEditorValue(editor), createRuleEditorValue(original));

  const saved = await saveRuleConfiguration(
    { name: "loaded.yaml", content, sha256: "a".repeat(64), rules: editor.draft },
    async (name, next) => ({ name, path: "/managed/loaded.yaml", content: next, sha256: "b".repeat(64) }),
    async () => {},
  );
  assert.deepEqual(configRuleItems(saved.disk.content).map((rule) => rule.policy), [
    "Main", "REJECT-DROP", "DIRECT", "OldPolicy",
  ]);
  assert.match(saved.disk.content, /DOMAIN,example\.test, Main ,no-resolve/);
  assert.match(saved.disk.content, /AND,\(\(DOMAIN,a\.example\),\(NETWORK,TCP\)\),REJECT-DROP,no-resolve/);
});

test("rule save writes one named config and applies it once while preserving disk-only failure", async () => {
  const content = "mode: rule\nrules:\n  - MATCH,DIRECT\n  - DOMAIN,example.test,Proxy\n";
  const rules = configRuleItems(content).reverse();
  const calls: string[] = [];
  const saved = await saveRuleConfiguration(
    { name: "target.yaml", content, sha256: "a".repeat(64), rules },
    async (name, next, sha) => {
      calls.push(`disk:${name}:${sha}`);
      return { name, path: "/managed/target.yaml", content: next, sha256: "b".repeat(64) };
    },
    async (source) => { calls.push(`apply:${source.name}:${source.sha256}`); return undefined!; },
  );
  assert.equal(saved.runtimeError, null);
  assert.deepEqual(calls, [`disk:target.yaml:${"a".repeat(64)}`, `apply:target.yaml:${"b".repeat(64)}`]);
  assert.deepEqual(configRuleItems(saved.disk.content).map((rule) => rule.type), ["DOMAIN", "MATCH"]);

  const diskOnly = await saveRuleConfiguration(
    { name: "target.yaml", content, sha256: "a".repeat(64), rules },
    async (name, next) => ({ name, path: "/managed/target.yaml", content: next, sha256: "b".repeat(64) }),
    async () => { throw new RuntimeApplyError("fixture apply failed", "load", false); },
  );
  assert.equal(diskOnly.runtimeError?.message, "fixture apply failed");
  await assert.rejects(
    saveRuleConfiguration(
      { name: "target.yaml", content, sha256: "a".repeat(64), rules },
      async () => { throw new ConfigError("conflict", 409, "config_conflict"); },
      async () => { throw new Error("must not load"); },
    ),
    (error: unknown) => error instanceof ConfigError && error.code === "config_conflict",
  );
});

test("runtime rule filtering keeps Controller order and does not mutate cached data", () => {
  const rules = ruleItems([
    { type: "DOMAIN-SUFFIX", payload: "alpha.example", proxy: "DIRECT" },
    { type: "RULE-SET", payload: "beta", proxy: "Proxy" },
    { type: "DOMAIN-SUFFIX", payload: "gamma.example", proxy: "Proxy" },
  ]);
  const originalIds = rules.map((rule) => rule.id);

  assert.deepEqual(
    filterRuleItems(rules, "gamma", "DOMAIN-SUFFIX").map((rule) => rule.payload),
    ["gamma.example"],
  );
  assert.deepEqual(
    filterRuleItems(rules, "proxy", "all").map((rule) => rule.payload),
    ["beta", "gamma.example"],
  );
  assert.deepEqual(rules.map((rule) => rule.id), originalIds);
});


test("settings values retain native source keys and explicit precedence", () => {
  const values = resolveSettingsValues(managerSettingsForm({ mode: "direct" }), {
    mode: "global", "log-level": "warning", ipv6: true, "allow-lan": true,
    "tcp-concurrent": true, tun: { enable: true }, sniffer: { enable: true },
  }, null);
  assert.deepEqual([values.form.mode, values.form.logLevel, values.form.ipv6, values.form.allowLan,
    values.form.tcpConcurrent, values.form.tunEnable, values.form.snifferEnable],
  ["direct", "warning", "enabled", "enabled", "enabled", "enabled", "enabled"]);
  assert.deepEqual([...values.explicit], ["mode"]);
});

test("settings values keep unavailable source and default fields unknown", () => {
  const values = resolveSettingsValues(managerSettingsForm({}), {}, null);
  assert.equal(values.known.size, 0);
  assert.equal(values.explicit.size, 0);
});
