import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigStore } from "../src/config/store.js";
import { ConfigConflictError, ConfigSourceInUseError, ConfigSourceUsageUnknownError } from "../src/config/errors.js";
import { ManagerSettingsService } from "../src/managerSettings/service.js";
import { ProviderFileService } from "../src/providerFiles/service.js";
import { createConfigdServer } from "../src/server.js";
import { WriteQueue } from "../src/writeQueue.js";
import { SubscriptionService } from "../src/subscriptions/service.js";
import { confirmedRuntimePath } from "../../deploy/debian/startup-config.mjs";

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "mihomo-save-collections-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "configs"));
  const configPath = join(root, "configs/source.yaml");
  await writeFile(configPath, "mode: direct\nproxies: [{name: fixture, type: direct}]\n");
  const queue = new WriteQueue();
  const store = new ConfigStore({ configPath, dataDir: root, mihomoBinary: process.execPath,
    validatorArgsPrefix: [join(dirname(fileURLToPath(import.meta.url)), "fixtures/validator.mjs"), "-"],
    validationTimeoutMs: 2000, maxContentBytes: 16384, writeQueue: queue });
  const manager = new ManagerSettingsService({ statePath: join(root, "settings.json"), runtimeDir: join(root, "runtime"), store, writeQueue: queue });
  const providers = new ProviderFileService({ providerDir: join(root, "providers"), statePath: join(root, "providers.json"),
    dataDir: root, store, writeQueue: queue, maxContentBytes: 16384,
    readRuntimeDependencies: async () => {
      const { content, state } = await manager.readAppliedUnqueued();
      return { content, uncertain: true, hasSuccessfulRecord: state.lastSuccessful !== null };
    } });
  await providers.init();
  const apply = async (name: string, result: "succeeded" | "failed" | "unknown" = "succeeded") => {
    const source = await store.read(name);
    const generated = await manager.generate({ sourceName: name, expectedSourceSha256: source.sha256, expectedSettingsVersion: 0 });
    const pending = await manager.beginLoad({ generatedVersion: generated.version, expectedVersion: (await manager.readLoadState()).version });
    return manager.finishLoad({ attemptId: pending.lastAttempt!.id, expectedVersion: pending.version, result });
  };
  return { root, store, manager, providers, apply, queue };
}

test("config deletion cleans its dormant extraction and the API cleans legacy orphan relations", async (t) => {
  const f = await fixture(t);
  const original = await f.store.read();
  const kept = await f.store.create("kept.yaml", original.content);
  for (const source of [original, kept]) await f.providers.createLocalExtraction({ configName: source.name,
    sourceSha256: source.sha256, fileName: source.name, enabled: false });
  await f.apply(kept.name);
  const server = createConfigdServer({ store: f.store, managerSettings: f.manager, providerFiles: f.providers, maxBodyBytes: 16384 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const remove = (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const deleted = await remove(`/files/${original.name}`, { expectedSha256: original.sha256 });
  assert.equal(deleted.status, 204);
  assert.deepEqual(f.providers.localExtractions().map((entry) => entry.configName), [kept.name]);
  const old = await f.store.create("old.yaml", original.content);
  await f.providers.createLocalExtraction({ configName: old.name, sourceSha256: old.sha256, fileName: "old-out.yaml", enabled: false });
  await f.store.delete(old.name, old.sha256);
  const relation = f.providers.localExtractions().find((entry) => entry.configName === old.name)!;
  const response = await remove(`/local-provider-extractions/${relation.id}`, { ...relation, filterVersion: relation.filterSettings.version });
  assert.equal(response.status, 204);
  assert.deepEqual(f.providers.localExtractions().map((entry) => entry.configName), [kept.name]);
  assert.equal((await f.store.read(kept.name)).sha256, kept.sha256);
});

test("renamed files remain protected through failed application and explicit cleanup uses the latest successful paths", async (t) => {
  const f = await fixture(t);
  const file = await f.providers.create("proxy", "original.yaml", "proxies: []\n");
  const original = await f.store.read();
  const source = await f.store.saveFile(original.name, original.content + "proxy-providers:\n  first: {type: file, path: ./providers/original.yaml}\n", original.sha256);
  await f.apply(source.name);
  const result = await f.providers.saveCollectionSettings({ configName: source.name, expectedConfigSha256: source.sha256, category: "proxy",
    name: "first", snippet: "first: {type: file, path: ./providers/next.yaml}\n", loaded: true, selectedGroups: [], expectedFileSha256: file.sha256 });
  assert.equal(result.retainedSource?.reason, "runtime_reference");
  await f.apply(source.name, "failed");
  const failedPreview = (await f.providers.previewCleanup()).files.find((entry) => entry.fileName === file.fileName)!;
  assert.equal(failedPreview.reason, "runtime_reference");
  assert.deepEqual(failedPreview.runtime?.references, [{ kind: "path", path: "./providers/original.yaml" }]);
  assert.equal((await f.providers.cleanup([failedPreview])).files[0]?.action, "keep");
  await f.apply(source.name);
  const restarted = new ProviderFileService(f.providers.options);
  await restarted.init();
  const preview = (await restarted.previewCleanup()).files.find((entry) => entry.fileName === file.fileName)!;
  assert.equal(preview.reason, "runtime_unknown");
  assert.deepEqual(preview.configReferences, [{ configName: source.name, kind: "identity", path: "./providers/next.yaml" }]);
  assert.deepEqual(preview.runtime, { uncertain: true, unknownReason: "core_unverified", hasSuccessfulRecord: true, scanComplete: true,
    references: [{ kind: "identity", path: "./providers/next.yaml" }] });
  assert.equal((await restarted.cleanup([preview])).files[0]?.action, "keep");
  const record = await f.manager.readLoadState();
  assert.equal((await restarted.cleanup([preview], true)).files[0]?.action, "deleted");
  await assert.rejects(readFile(join(f.root, "providers/original.yaml")), { code: "ENOENT" });
  assert.equal((await restarted.read("proxy", "next.yaml")).sha256, file.sha256);
  assert.deepEqual(JSON.parse(await readFile(f.providers.options.statePath, "utf8")).manual, [{ category: "proxy", fileName: "next.yaml" }]);
  assert.deepEqual(await f.manager.readLoadState(), record);
});

test("source drafts preserve extraction and successful startup; explicit generation prepares and validates", async (t) => {
  const f = await fixture(t);
  const source = await f.store.read();
  await f.providers.createLocalExtraction({ configName: source.name, sourceSha256: source.sha256, fileName: "derived.yaml" });
  const originalBody = await readFile(join(f.root, "providers/derived.yaml"), "utf8");
  const success = await f.apply(source.name);
  const server = createConfigdServer({ store: f.store, managerSettings: f.manager, providerFiles: f.providers, maxBodyBytes: 16384 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, method: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const draft = "mode: [INVALID\n";
  let response = await request(`/files/${source.name}`, "PUT", { content: draft, expectedSha256: source.sha256 });
  assert.equal(response.status, 200);
  let saved = await response.json() as { sha256: string };
  assert.equal((await f.store.read()).content, draft);
  assert.equal(await readFile(join(f.root, "providers/derived.yaml"), "utf8"), originalBody);
  response = await request("/runtime-config/generate", "POST", { sourceName: source.name, expectedSourceSha256: saved.sha256, expectedSettingsVersion: 0 });
  assert.equal(response.status, 422); await response.arrayBuffer();
  assert.deepEqual(await f.manager.readLoadState(), success);
  assert.equal(confirmedRuntimePath("unused", f.manager.options.runtimeDir), success.lastSuccessful!.generated.path);
  const next = "mode: direct\nproxies: [{name: replacement, type: direct}]\n";
  response = await request(`/files/${source.name}`, "PUT", { content: next, expectedSha256: saved.sha256 });
  saved = await response.json() as { sha256: string };
  assert.equal(await readFile(join(f.root, "providers/derived.yaml"), "utf8"), originalBody);
  response = await request("/runtime-config/generate", "POST", { sourceName: source.name, expectedSourceSha256: saved.sha256, expectedSettingsVersion: 0 });
  assert.equal(response.status, 200); await response.arrayBuffer();
  assert.notEqual(await readFile(join(f.root, "providers/derived.yaml"), "utf8"), originalBody);
  assert.deepEqual(await f.manager.readLoadState(), success);
});

test("source deletion requires a successful switch and rechecks pending, stale and unreadable records", async (t) => {
  const f = await fixture(t);
  const original = await f.store.read();
  await f.apply(original.name);
  const changed = await f.store.saveFile(original.name, "mode: rule\n", original.sha256);
  await assert.rejects(f.store.delete(changed.name, changed.sha256), ConfigSourceInUseError);
  const guardedState = await f.manager.readLoadState();
  await assert.rejects(f.store.rename(changed.name, "renamed.yaml", changed.sha256), ConfigSourceInUseError);
  assert.equal((await f.store.read(changed.name)).content, changed.content);
  assert.deepEqual(await f.manager.readLoadState(), guardedState);
  const other = await f.store.create("other.yaml", "mode: direct\n");
  await f.apply(other.name, "failed");
  await assert.rejects(f.store.delete(changed.name, changed.sha256), ConfigSourceInUseError);
  await assert.rejects(f.store.rename(changed.name, "renamed.yaml", changed.sha256), ConfigSourceInUseError);
  const candidate = await f.manager.generate({ sourceName: other.name, expectedSourceSha256: other.sha256, expectedSettingsVersion: 0 });
  await f.manager.beginLoad({ generatedVersion: candidate.version, expectedVersion: (await f.manager.readLoadState()).version });
  await assert.rejects(f.store.rename(other.name, "pending.yaml", other.sha256), ConfigSourceUsageUnknownError);
  await f.apply(other.name, "unknown");
  await assert.rejects(f.store.delete(other.name, other.sha256), ConfigSourceUsageUnknownError);
  await assert.rejects(f.store.rename(other.name, "renamed.yaml", other.sha256), ConfigSourceUsageUnknownError);
  await f.apply(other.name);
  await assert.rejects(f.store.delete(changed.name, original.sha256), ConfigConflictError);
  const renamed = await f.store.rename(changed.name, "renamed.yaml", changed.sha256);
  await f.store.delete(renamed.name, renamed.sha256);
  const draft = await f.store.create("draft.yaml", "[");
  await writeFile(join(f.manager.options.runtimeDir, "load-state.json"), "{");
  await assert.rejects(f.store.delete(draft.name, draft.sha256), ConfigSourceUsageUnknownError);
  await assert.rejects(f.store.rename(draft.name, "draft-renamed.yaml", draft.sha256), ConfigSourceUsageUnknownError);
});

test("unresolved alias drafts save and read exactly; application rejects them until repaired", async (t) => {
  const f = await fixture(t);
  const before = await f.store.read();
  const success = await f.apply(before.name);
  const server = createConfigdServer({ store: f.store, managerSettings: f.manager, providerFiles: f.providers, maxBodyBytes: 16384 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, method = "GET", body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const content = before.content + "review_alias: *missing\n";
  let response = await request(`/files/${before.name}`, "PUT", { content, expectedSha256: before.sha256 });
  assert.equal(response.status, 200);
  const saved = await response.json() as { content: string; sha256: string };
  assert.equal(saved.content, content);
  response = await request(`/files/${before.name}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { content: string }).content, content);
  response = await request("/runtime-config/generate", "POST", { sourceName: before.name, expectedSourceSha256: saved.sha256, expectedSettingsVersion: 0 });
  assert.equal(response.status, 422);
  assert.equal((await response.json() as { diagnostics: Array<{ code: string }> }).diagnostics[0]?.code, "yaml_reference");
  assert.deepEqual(await f.manager.readLoadState(), success);
  const repaired = await f.store.saveFile(before.name, "anchor: &missing ready\n" + content, saved.sha256);
  response = await request("/runtime-config/generate", "POST", { sourceName: before.name, expectedSourceSha256: repaired.sha256, expectedSettingsVersion: 0 });
  assert.equal(response.status, 200); await response.arrayBuffer();
  assert.deepEqual(await f.manager.readLoadState(), success);
});

test("subscription managed source rename uses the same queued protection", async (t) => {
  const f = await fixture(t);
  const options = { statePath: join(f.root, "subscriptions.json"), providerDir: join(f.root, "providers"), dataDir: f.root,
    requestTimeoutMs: 1000, maxResponseBytes: 16384, writeQueue: f.queue };
  let subscriptions = new SubscriptionService(options); await subscriptions.init();
  const owner = await subscriptions.create({ name: "owned", url: "https://fixture.invalid/source", autoUpdate: false, intervalMinutes: 60 });
  const source = await f.store.read();
  await writeFile(options.statePath, JSON.stringify({ version: 1, subscriptions: [{ ...owner, configFileName: source.name }] }));
  subscriptions = new SubscriptionService(options); await subscriptions.init();
  const rename = () => subscriptions.renameConfigFile(source.name, "renamed.yaml",
    () => f.store.renameUnqueued(source.name, "renamed.yaml", source.sha256),
    (snapshot) => f.store.renameUnqueued(snapshot.name, source.name, snapshot.sha256).then(() => undefined));
  const success = await f.apply(source.name);
  await assert.rejects(rename(), ConfigSourceInUseError);
  assert.equal(subscriptions.list()[0]?.configFileName, source.name);
  assert.deepEqual(await f.manager.readLoadState(), success);
  await f.store.create("other.yaml", "mode: direct\n"); await f.apply("other.yaml");
  await rename();
  assert.equal(subscriptions.list()[0]?.configFileName, "renamed.yaml");
});

test("generation rejects malformed saved File bodies before beginning a load", async (t) => {
  const f = await fixture(t);
  const body = await f.providers.create("proxy", "body.yaml", "proxies: []\n");
  const source = await f.store.read();
  const saved = await f.store.saveFile(source.name, source.content + "proxy-providers:\n  sample: {type: file, path: ./providers/body.yaml}\n", source.sha256);
  const success = await f.apply(saved.name);
  await f.providers.save("proxy", body.fileName, "proxies: [}{", body.sha256);
  await assert.rejects(f.manager.generate({ sourceName: saved.name, expectedSourceSha256: saved.sha256, expectedSettingsVersion: 0 },
    (name, sha) => f.providers.validateSourceCollectionsUnqueued(name, sha)));
  assert.deepEqual(await f.manager.readLoadState(), success);
});

test("collection validation shares source references within one queued operation and rechecks the next", async (t) => {
  const f = await fixture(t);
  const original = await f.store.read();
  await f.store.create("empty.yaml", "");
  const files = await Promise.all(["first.yaml", "second.yaml", "third.yaml"].map((name) => f.providers.create("proxy", name, "proxies: []\n")));
  const content = original.content + "proxy-providers:\n" + files.map((file, index) => "  group" + index + ": {type: file, path: ./providers/" + file.fileName + "}\n").join("");
  const source = await f.store.saveFile(original.name, content, original.sha256);
  const read = f.store.read.bind(f.store);
  const list = f.store.list.bind(f.store);
  let reads = 0, lists = 0;
  f.store.read = (...args) => { reads++; return read(...args); };
  f.store.list = (...args) => { lists++; return list(...args); };
  await f.queue.enqueue(() => f.providers.validateSourceCollectionsUnqueued(source.name, source.sha256));
  assert.deepEqual({ reads, lists }, { reads: 2, lists: 1 });
  await assert.rejects(f.queue.enqueue(() => f.providers.validateSourceCollectionsUnqueued(source.name, original.sha256)), ConfigConflictError);
  await f.store.saveFile("empty.yaml", "proxy-providers:\n  cache: {type: http, url: http://127.0.0.1/unused, path: ./providers/first.yaml}\n", (await read("empty.yaml")).sha256);
  reads = 0; lists = 0;
  await f.queue.enqueue(() => f.providers.validateSourceCollectionsUnqueued(source.name, source.sha256));
  assert.deepEqual({ reads, lists }, { reads: 2, lists: 1 });
  assert.equal((await f.providers.read("proxy", "first.yaml")).writable, false);
  assert.equal((await f.providers.read("proxy", "second.yaml")).writable, true);
  await assert.rejects(f.providers.save("proxy", "first.yaml", "proxies: []\n", files[0]!.sha256), /read-only/);
});
