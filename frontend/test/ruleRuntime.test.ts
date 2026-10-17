import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeLoadState } from "../src/api/configClient.ts";
import { matchingRuntimeRules, readRuleEditSnapshot, readRuleSource } from "../src/features/rules/ruleRuntime.ts";
import { applyRuleEditorAction, createRuleEditorValue, ruleOrderDirty } from "../src/features/rules/ruleEditorState.ts";
import { configRuleItems, ruleItems } from "../src/features/rules/ruleViewModel.ts";

const generated = { schemaVersion: 1 as const, version: "a-v1", sourceName: "a.yaml", sourceSha256: "a-sha", settingsVersion: 1, contentSha256: "body-a", generatedAt: "now", path: "/runtime/a.yaml" };
const succeeded: RuntimeLoadState = { schemaVersion: 1, version: 2, lastAttempt: { id: "a1", generated, status: "succeeded", startedAt: "now", finishedAt: "now" }, lastSuccessful: { generated, loadedAt: "now" } };
const contentA = "rules:\n  - DOMAIN-SUFFIX,a.example,DIRECT\n  - MATCH,REJECT\n";
const runtimeA = ruleItems([{ type: "DomainSuffix", payload: "a.example", proxy: "DIRECT" }, { type: "Match", payload: "", proxy: "REJECT" }]);

const editSource = { name: "a.yaml", generatedVersion: "a-v1" };
const directContent = "rules:\n  - DOMAIN,duplicate.example,DIRECT\n  - DOMAIN-SUFFIX,hidden.example,DIRECT\n  - DOMAIN,duplicate.example,DIRECT\n  - DOMAIN,last.example,REJECT\n  - MATCH,DIRECT\n";
const directRows = [
  { type: "Domain", payload: "duplicate.example", proxy: "DIRECT" },
  { type: "DomainSuffix", payload: "hidden.example", proxy: "DIRECT" },
  { type: "Domain", payload: "duplicate.example", proxy: "DIRECT" },
  { type: "Domain", payload: "last.example", proxy: "REJECT" },
  { type: "Match", payload: "", proxy: "DIRECT" },
];
const directRuntime = ruleItems(directRows);
const directReaders = () => ({
  rules: async () => ({ rules: directRows }),
  state: async () => succeeded,
  applied: async () => ({ state: succeeded, content: directContent }),
  disk: async () => ({ name: "a.yaml", path: "/configs/a.yaml", content: directContent, sha256: "a-sha" }),
});

test("first direct actions retain the chosen duplicate and preserve hidden rule positions", async () => {
  const prepared = await readRuleEditSnapshot(directRuntime, editSource, new AbortController().signal, null, directReaders());
  const clean = createRuleEditorValue(prepared.rules);
  const secondDuplicate = directRuntime[2]!.id;
  const removed = applyRuleEditorAction(clean, { type: "remove", id: secondDuplicate }, directRuntime);
  assert.deepEqual(removed.draft.map(r => r.id), clean.draft.filter((_, i) => i !== 2).map(r => r.id));
  const changed = applyRuleEditorAction(clean, { type: "policy", id: secondDuplicate, policy: "REJECT" }, directRuntime);
  assert.equal(changed.draft[0]!.policy, "DIRECT");
  assert.equal(changed.draft[2]!.policy, "REJECT");
  const visibleIds = directRuntime.filter(r => r.type === "Domain").map(r => r.id);
  const moved = applyRuleEditorAction(clean, { type: "move", id: secondDuplicate, overId: directRuntime[0]!.id, visibleIds }, directRuntime);
  assert.deepEqual(moved.draft.map(r => r.id), [clean.draft[2], clean.draft[1], clean.draft[0], clean.draft[3], clean.draft[4]].map(r => r!.id));
  assert.equal(moved.draft[1], clean.draft[1]);
  assert.equal(moved.draft[4], clean.draft[4]);
  assert.equal(moved.draft.filter(r => r.type === "Domain").length, 3);
  const secondMove = applyRuleEditorAction(moved, { type: "move", id: moved.draft[3]!.id, overId: moved.draft[0]!.id, visibleIds: moved.draft.filter(r => r.type === "Domain").map(r => r.id) });
  assert.equal(secondMove.draft[1], clean.draft[1]);
  assert.equal(secondMove.draft[4], clean.draft[4]);
  assert.equal(ruleOrderDirty(clean.draft, clean.saved), false);
});

test("first creation uses source identities and matching the existing policy stays clean", async () => {
  const prepared = await readRuleEditSnapshot(directRuntime, editSource, new AbortController().signal, null, directReaders());
  const clean = createRuleEditorValue(prepared.rules);
  const same = applyRuleEditorAction(clean, { type: "policy", id: directRuntime[0]!.id, policy: "DIRECT" }, directRuntime);
  assert.equal(same, clean);
  const added = applyRuleEditorAction(clean, { type: "add", values: [{ type: "DOMAIN", payload: "new.example", policy: "DIRECT" }], position: "before-match" }, directRuntime);
  assert.equal(added.draft.at(-2)?.payload, "new.example");
  assert.equal(added.draft.at(-1)?.type, "Match");
  assert.deepEqual(added.draft.slice(0, 4), prepared.rules.slice(0, 4));
});

test("unapplied source content blocks direct edits even when the rule list is unchanged", async () => {
  const readers = directReaders();
  await assert.rejects(readRuleEditSnapshot(directRuntime, editSource, new AbortController().signal, null, {
    ...readers, disk: async () => ({ ...await readers.disk(), content: directContent + "mode: global\n", sha256: "unapplied-sha" }),
  }), /已保存待应用/);
});

test("changed runtime rows or source versions cannot redirect the first action", async () => {
  const readers = directReaders();
  let diskReads = 0;
  await assert.rejects(readRuleEditSnapshot(directRuntime, editSource, new AbortController().signal, null, {
    ...readers, rules: async () => ({ rules: [...directRows].reverse() }),
    disk: async () => { diskReads++; return readers.disk(); },
  }), /运行规则已变化/);
  assert.equal(diskReads, 0);
  let stateReads = 0;
  const next = { ...generated, version: "a-v2" };
  await assert.rejects(readRuleEditSnapshot(directRuntime, editSource, new AbortController().signal, null, {
    ...readers, state: async () => ++stateReads === 1 ? succeeded : { ...succeeded, lastAttempt: { ...succeeded.lastAttempt!, generated: next }, lastSuccessful: { generated: next, loadedAt: "later" } },
  }), /运行来源已变化/);
  await assert.rejects(readRuleEditSnapshot(directRuntime, null, new AbortController().signal, null, readers), /运行来源/);
});

test("cancelled preparation leaves the displayed runtime and source unchanged", async () => {
  const controller = new AbortController();
  const readers = directReaders();
  await assert.rejects(readRuleEditSnapshot(directRuntime, editSource, controller.signal, null, {
    ...readers, disk: async () => { controller.abort(); return readers.disk(); },
  }), { name: "AbortError" });
  assert.equal(directRuntime.length, 5);
  assert.equal(directRuntime[2]!.policy, "DIRECT");
});

test("rule association uses the successful generated rules and preserves Core order", async () => {
  let reads = 0;
  const readers = { state: async () => succeeded, applied: async () => { reads++; return { state: succeeded, content: contentA }; } };
  const signal = new AbortController().signal;
  const first = await readRuleSource(runtimeA, signal, null, readers);
  assert.deepEqual(first.source, { name: "a.yaml", generatedVersion: "a-v1" });
  assert.equal(reads, 1);
  assert.deepEqual((await readRuleSource(runtimeA, signal, first.cache, readers)).source, first.source);
  assert.equal(reads, 1);
  assert.equal(matchingRuntimeRules(runtimeA, configRuleItems(contentA)), true);
  assert.equal(matchingRuntimeRules([...runtimeA].reverse(), configRuleItems(contentA)), false);
  assert.equal((await readRuleSource([...runtimeA].reverse(), signal, first.cache, readers)).source, null);
  assert.equal(runtimeA[0]?.payload, "a.example");
});

test("IPv6 source rules match Core IPCIDR while payload, policy and order stay exact", async () => {
  const content = "rules:\n  - IP-CIDR6,fc00::/7,DIRECT,no-resolve\n  - IP-CIDR6,::1/128,REJECT\n";
  const runtime = ruleItems([{ type: "IPCIDR", payload: "fc00::/7", proxy: "DIRECT" }, { type: "IPCIDR", payload: "::1/128", proxy: "REJECT" }]);
  const expected = configRuleItems(content);
  assert.equal(matchingRuntimeRules(runtime, expected), true);
  assert.equal(matchingRuntimeRules([{ ...runtime[0]!, payload: "fe80::/10" }, runtime[1]!], expected), false);
  assert.equal(matchingRuntimeRules([{ ...runtime[0]!, policy: "REJECT" }, runtime[1]!], expected), false);
  assert.equal(matchingRuntimeRules([...runtime].reverse(), expected), false);
  const result = await readRuleSource(runtime, new AbortController().signal, null, { state: async () => succeeded, applied: async () => ({ state: succeeded, content }) });
  assert.deepEqual(result.source, { name: "a.yaml", generatedVersion: "a-v1" });
});

test("pending and unknown loads restrict editing while rejected candidates retain the old source", async () => {
  const candidate = { ...generated, version: "b-v1", sourceName: "b.yaml", contentSha256: "body-b" };
  const signal = new AbortController().signal;
  for (const status of ["pending", "unknown", "failed"] as const) {
    const state: RuntimeLoadState = { ...succeeded, version: 3, lastAttempt: { ...succeeded.lastAttempt!, generated: candidate, status } };
    const result = await readRuleSource(runtimeA, signal, null, { state: async () => state, applied: async () => ({ state, content: contentA }) });
    assert.equal(result.source?.name ?? null, status === "failed" ? "a.yaml" : null);
  }
});

test("new successful versions refresh the association and failures never replace runtime data", async () => {
  const next = { ...generated, version: "b-v1", sourceName: "b.yaml", contentSha256: "body-b" };
  const state: RuntimeLoadState = { ...succeeded, version: 4, lastAttempt: { ...succeeded.lastAttempt!, generated: next }, lastSuccessful: { generated: next, loadedAt: "later" } };
  const content = contentA.replace("a.example", "b.example");
  const runtimeB = ruleItems([{ type: "DomainSuffix", payload: "b.example", proxy: "DIRECT" }, { type: "Match", payload: "", proxy: "REJECT" }]);
  const cache = { version: generated.version, sha256: generated.contentSha256, rules: configRuleItems(contentA), proxyGroups: [], ruleProviders: [] };
  const result = await readRuleSource(runtimeB, new AbortController().signal, cache, { state: async () => state, applied: async () => ({ state, content }) });
  assert.equal(result.source?.name, "b.yaml");
  assert.equal(result.cache?.version, "b-v1");
  assert.equal((await readRuleSource(runtimeA, new AbortController().signal, cache, { state: async () => state, applied: async () => ({ state, content }) })).source, null);
  assert.equal((await readRuleSource(runtimeA, new AbortController().signal, cache, { state: async () => { throw new Error("offline"); }, applied: async () => ({ state, content }) })).source, null);
  assert.equal(runtimeA[0]?.payload, "a.example");
});

test("cancelled or changing generated versions cannot establish an editing source", async () => {
  const controller = new AbortController();
  controller.abort();
  const readers = { state: async () => succeeded, applied: async () => ({ state: succeeded, content: contentA }) };
  assert.equal((await readRuleSource(runtimeA, controller.signal, null, readers)).source, null);
  const changed = { ...succeeded, lastSuccessful: { generated: { ...generated, version: "later" }, loadedAt: "later" } };
  assert.equal((await readRuleSource(runtimeA, new AbortController().signal, null, { ...readers, applied: async () => ({ state: changed, content: contentA }) })).source, null);
});
