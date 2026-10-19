import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, stringify } from "yaml";
import { ConfigStore } from "../src/config/store.js";
import { ConfigProviderFilesError, ConfigValidationError } from "../src/config/errors.js";
import { ManagerSettingsService } from "../src/managerSettings/service.js";
import { ProviderFileService } from "../src/providerFiles/service.js";
import { ProviderFileConflictError, ProviderFileReadOnlyError } from "../src/providerFiles/errors.js";
import { WriteQueue } from "../src/writeQueue.js";
import { createConfigdServer } from "../src/server.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";

const proxyBody = "proxies:\n  - {name: fixture, type: socks5, server: 127.0.0.1, port: 9}\n";
const ruleBody = "payload: [DOMAIN,example.invalid]\n";
const source = (prefix = "./") => stringify({
  mode: "rule", "mixed-port": 0,
  "proxy-providers": { local: { type: "file", path: prefix + "local.yaml" } },
  "rule-providers": { rules: { type: "file", behavior: "classical", path: "./rules.yaml" } },
  "proxy-groups": [{ name: "fixture-group", type: "select", use: ["local"], proxies: ["DIRECT"] }],
  rules: ["RULE-SET,rules,DIRECT", "MATCH,DIRECT"],
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }, legacy = false) {
  const root = await mkdtemp(join(tmpdir(), "mihomo-collection-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "configs")); await mkdir(join(root, "providers"));
  const configPath = join(root, "configs", "first.yaml");
  if (legacy) {
    await writeFile(configPath, source("./providers/"));
    await writeFile(join(root, "providers", "local.yaml"), proxyBody);
  }
  const writeQueue = new WriteQueue();
  const binary = process.env.MIHOMO_TEST_BINARY;
  const store = new ConfigStore({ configPath, dataDir: root, mihomoBinary: binary ?? process.execPath,
    ...(binary ? {} : { validatorArgsPrefix: [join(dirname(fileURLToPath(import.meta.url)), "fixtures/validator.mjs"), "-"] }),
    maxContentBytes: 65536, validationTimeoutMs: 10000, writeQueue });
  const options = { store, writeQueue, dataDir: root, providerDir: join(root, "providers"), ruleProviderDir: join(root, "ruleset"),
    statePath: join(root, "provider-files.json"), maxContentBytes: 65536,
    readRuntimeDependencies: async () => ({ content: "mode: direct\n", uncertain: true }) };
  const files = new ProviderFileService(options); await files.init();
  if (!legacy) await store.create("first.yaml", source());
  const manager = new ManagerSettingsService({ store, writeQueue, statePath: join(root, "settings.json"), runtimeDir: join(root, "runtime") });
  return { root, store, files, manager, options, writeQueue };
}

async function fill(f: Awaited<ReturnType<typeof fixture>>, name = "first.yaml") {
  const before = await f.store.read(name);
  return f.files.saveCollectionWorkspace({ configName: name, expectedSha256: before.sha256, content: before.content, removals: [], bodies: [
    { category: "proxy", name: "local", content: proxyBody, expectedSha256: null },
    { category: "rule", name: "rules", content: "payload:\n  - DOMAIN,example.invalid\n", expectedSha256: null },
  ] });
}

test("first-use workspace creates both categories together and maps only generated YAML", async (t) => {
  const f = await fixture(t);
  const original = await f.store.read();
  assert.deepEqual(original.providerIssues?.map((entry) => entry.status), ["missing", "missing"]);
  const saved = await fill(f);
  assert.equal(saved.content, original.content); assert.equal(saved.providerIssues, undefined);
  assert.ok(saved.collectionPaths?.every((entry) => /^config-[a-f0-9]{24}\//.test(entry.fileName!)));
  assert.equal(saved.collectionPaths![0]!.fileName!.split("/")[0], saved.collectionPaths![1]!.fileName!.split("/")[0]);
  const generated = await f.manager.generate({ sourceName: saved.name, expectedSourceSha256: saved.sha256, expectedSettingsVersion: 0 },
    (name, sha) => f.files.validateSourceCollectionsUnqueued(name, sha));
  const runtime = parse(await readFile(generated.path, "utf8"));
  assert.equal(runtime["proxy-providers"].local.path, saved.collectionPaths![0]!.referencePath);
  assert.equal((await f.store.read()).content, original.content);
  assert.equal((await f.manager.readLoadState()).lastSuccessful, null);
  await f.store.validate(saved.content, saved.name);
});

test("a second source has isolated files across equivalent relative path expressions", async (t) => {
  const f = await fixture(t); const first = await fill(f);
  await f.store.create("second.yaml", source("./providers/"));
  const second = await fill(f, "second.yaml");
  assert.notEqual(first.collectionPaths![0]!.referencePath, second.collectionPaths![0]!.referencePath);
  const firstFile = await f.files.read("proxy", first.collectionPaths![0]!.fileName!);
  const secondFile = await f.files.read("proxy", second.collectionPaths![0]!.fileName!);
  const changed = proxyBody.replace("port: 9", "port: 10");
  await f.files.saveCollectionWorkspace({ configName: second.name, expectedSha256: second.sha256, content: second.content, removals: [],
    bodies: [{ category: "proxy", name: "local", content: changed, expectedSha256: secondFile.sha256 }] });
  assert.equal((await f.files.read("proxy", firstFile.fileName)).sha256, firstFile.sha256);
  const alias = second.content.replace("./providers/local.yaml", "./local.yaml");
  assert.equal((await f.store.resolveProviderPaths!(second.name, alias))[0]!.fileName, secondFile.fileName);
});

test("workspace syntax validation reports path collisions and rejects unsafe mapping", async (t) => {
  const f = await fixture(t); const before = await f.store.read();
  const config = parse(before.content);
  config["proxy-providers"].duplicate = { type: "file", path: "./providers/local.yaml" };
  await assert.rejects(f.files.validateCollectionWorkspace(before.name, stringify(config), []), (error: unknown) =>
    error instanceof ConfigProviderFilesError && error.issues.length === 2 && error.issues.every((entry) => entry.status === "conflict"));
  for (const path of ["../escape.yaml", "/etc/secret.yaml", "./providers/../escape.yaml"]) {
    config["proxy-providers"] = { local: { type: "file", path } };
    const paths = await f.store.resolveProviderPaths!(before.name, stringify(config));
    assert.equal(paths[0]!.status, "outside_scope");
  }
  await writeFile(join(f.root, "local.yaml"), proxyBody);
  assert.equal((await f.store.read()).collectionPaths![0]!.status, "ownership_unknown");
  if (process.platform !== "win32") {
    const scope = before.collectionPaths![1]!.fileName!.split("/")[0]!;
    await symlink(join(f.root, "configs"), join(f.root, "ruleset", scope));
    assert.equal((await f.store.read()).collectionPaths![1]!.status, "outside_scope");
  }
});

test("workspace preserves incomplete bodies and rolls back the whole save on source failure", async (t) => {
  const f = await fixture(t); const saved = await fill(f);
  const files = await f.files.list();
  const proxy = files.find((entry) => entry.category === "proxy")!;
  const rule = files.find((entry) => entry.category === "rule")!;
  await chmod(join(f.root, proxy.referencePath), 0o640);
  const beforeMode = (await stat(join(f.root, proxy.referencePath))).mode & 0o777;
  const drafts = [{ category: "proxy" as const, name: "local", content: "proxies: [\n", expectedSha256: proxy.sha256 },
    { category: "rule" as const, name: "rules", content: ruleBody, expectedSha256: rule.sha256 }];
  const originalSave = f.store.saveFileUnqueued.bind(f.store);
  f.store.saveFileUnqueued = async () => { throw new Error("fixture source failure"); };
  await assert.rejects(f.files.saveCollectionWorkspace({ configName: saved.name, expectedSha256: saved.sha256, content: saved.content + "# changed\n", bodies: drafts, removals: [] }));
  f.store.saveFileUnqueued = originalSave;
  assert.equal((await f.files.read("proxy", proxy.fileName)).sha256, proxy.sha256);
  assert.equal((await f.files.read("rule", rule.fileName)).sha256, rule.sha256);
  await f.files.saveCollectionWorkspace({ configName: saved.name, expectedSha256: saved.sha256, content: saved.content, bodies: drafts, removals: [] });
  assert.equal((await f.files.read("proxy", proxy.fileName)).content, "proxies: [\n");
  assert.equal((await stat(join(f.root, proxy.referencePath))).mode & 0o777, beforeMode);
  await assert.rejects(f.files.validateCollectionWorkspace(saved.name, saved.content, drafts), ConfigValidationError);
  await assert.rejects(f.files.saveCollectionWorkspace({ configName: saved.name, expectedSha256: saved.sha256, content: saved.content, bodies: drafts, removals: [] }), ProviderFileConflictError);
  assert.equal((await f.store.read()).content, saved.content);
  const current = await f.files.read("proxy", proxy.fileName);
  const unfinished = await f.files.saveCollectionWorkspace({ configName: saved.name, expectedSha256: saved.sha256, content: "rules: [*unfinished]\n",
    bodies: [{ category: "proxy", name: "local", content: proxyBody, expectedSha256: current.sha256 }], removals: [] });
  assert.equal(unfinished.content, "rules: [*unfinished]\n");
});

test("configuration rename retains its scoped files across service restart", async (t) => {
  const f = await fixture(t); const saved = await fill(f);
  const renamed = await f.writeQueue.enqueue(() => f.files.renameConfigSourceUnqueued(saved.name, "renamed.yaml", () => f.store.renameUnqueued(saved.name, "renamed.yaml", saved.sha256)));
  assert.equal((await f.store.read(renamed.name)).collectionPaths![0]!.referencePath, saved.collectionPaths![0]!.referencePath);
  const restarted = new ProviderFileService(f.options); await restarted.init();
  assert.equal((await f.store.read(renamed.name)).providerIssues, undefined);
  await f.store.create("first.yaml", source());
  assert.notEqual((await f.store.read()).collectionPaths![0]!.referencePath, saved.collectionPaths![0]!.referencePath);
});

test("legacy controlled references remain editable and new configurations use their own directory", async (t) => {
  const f = await fixture(t, true); const original = await f.store.read();
  assert.equal(original.collectionPaths![0]!.fileName, "local.yaml");
  await f.store.create("second.yaml", source("./providers/"));
  const second = await f.store.read("second.yaml");
  assert.notEqual(second.collectionPaths![0]!.fileName, "local.yaml");
  assert.equal(second.collectionPaths![0]!.status, "missing");
});

test("removal saves declarations first and retains other-source and uncertain runtime dependencies", async (t) => {
  const f = await fixture(t); const saved = await fill(f);
  const local = saved.collectionPaths![0]!;
  const config = parse(saved.content); delete config["proxy-providers"].local; config["proxy-groups"][0].use = [];
  const removed = await f.files.saveCollectionWorkspace({ configName: saved.name, expectedSha256: saved.sha256, content: stringify(config), bodies: [], removals: [{ category: "proxy", name: "local" }] });
  assert.ok(await f.files.read("proxy", local.fileName!));
  const currentRuntime = await f.store.mapProviderContent(removed.name, removed.content);
  const unknown = await f.files.cleanupAppliedCollections(removed.name, removed.sha256, async () => ({ content: currentRuntime, uncertain: true }));
  assert.equal(unknown[0]!.reason, "runtime_unknown");
  await f.store.create("dependent.yaml", stringify({ "proxy-providers": { dependency: { type: "file", path: local.referencePath } } }));
  const retained = await f.files.cleanupAppliedCollections(removed.name, removed.sha256, async () => ({ content: currentRuntime, uncertain: false }));
  assert.equal(retained[0]!.reason, "referenced");
  const dependent = await f.store.read("dependent.yaml"); await f.store.saveFile("dependent.yaml", "mode: direct\n", dependent.sha256);
  const cleaned = await f.files.cleanupAppliedCollections(removed.name, removed.sha256, async () => ({ content: currentRuntime, uncertain: false }));
  assert.equal(cleaned[0]!.action, "deleted");
  await assert.rejects(f.files.read("proxy", local.fileName!));
});

test("remembered HTTP caches remain read-only through file declarations", async (t) => {
  const f = await fixture(t);
  const previous = await f.store.read();
  const cachePath = "./providers/cache.yaml";
  let snapshot = await f.store.saveFile(previous.name, stringify({ "proxy-providers": { cache: { type: "http", path: cachePath, url: "https://example.invalid/fixture" } } }), previous.sha256);
  await f.files.list();
  snapshot = await f.store.saveFile(snapshot.name, stringify({ "proxy-providers": { cache: { type: "file", path: cachePath } } }), snapshot.sha256);
  await assert.rejects(f.files.saveCollectionWorkspace({ configName: snapshot.name, expectedSha256: snapshot.sha256, content: snapshot.content, bodies: [{ category: "proxy", name: "cache", content: proxyBody, expectedSha256: null }], removals: [] }), ProviderFileReadOnlyError);
});

test("the load-result route cleans removed files only after the matching successful application", async (t) => {
  const f = await fixture(t); const saved = await fill(f);
  const local = saved.collectionPaths![0]!;
  const config = parse(saved.content); delete config["proxy-providers"].local; config["proxy-groups"][0].use = [];
  const removed = await f.files.saveCollectionWorkspace({ configName: saved.name, content: stringify(config), expectedSha256: saved.sha256, bodies: [], removals: [{ category: "proxy", name: "local" }] });
  const server = createConfigdServer({ store: f.store, providerFiles: f.files, managerSettings: f.manager, maxBodyBytes: 65536 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}`;
  for (const key of [local.fileName!, encodeURIComponent(local.fileName!)]) {
    const file = await fetch(endpoint + "/managed-providers/proxy/" + key);
    assert.equal(file.status, 200); await file.json();
  }
  const post = (path: string, body: unknown, method = "POST") => fetch(endpoint + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const generated = await f.manager.generate({ sourceName: removed.name, expectedSourceSha256: removed.sha256, expectedSettingsVersion: 0 }, (name, sha) => f.files.validateSourceCollectionsUnqueued(name, sha));
  const first = await f.manager.beginLoad({ generatedVersion: generated.version, expectedVersion: 0 });
  let response = await post("/runtime-config/load-result", { attemptId: first.lastAttempt!.id, expectedVersion: first.version, result: "failed" }, "PUT");
  assert.equal(response.status, 200); await response.json();
  assert.ok(await f.files.read("proxy", local.fileName!));
  const second = await f.manager.beginLoad({ generatedVersion: generated.version, expectedVersion: (await f.manager.readLoadState()).version });
  response = await post("/runtime-config/load-result", { attemptId: second.lastAttempt!.id, expectedVersion: second.version, result: "succeeded" }, "PUT");
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { collectionCleanup: Array<{ action: string }> }).collectionCleanup[0]!.action, "deleted");
  await assert.rejects(f.files.read("proxy", local.fileName!));
});

test("real Core keeps source A while B is edited and loads all B collections on explicit application", { skip: !process.env.MIHOMO_TEST_BINARY, timeout: 20000 }, async (t) => {
  let stopCore = async () => {};
  t.after(() => stopCore());
  const f = await fixture(t);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const controller = `127.0.0.1:${address.port}`;
  const bootstrap = join(f.root, "bootstrap.yaml");
  await writeFile(bootstrap, stringify({ mode: "direct", "mixed-port": 0, "external-controller": controller }));
  const core = spawn(process.env.MIHOMO_TEST_BINARY!, ["-d", f.root, "-f", bootstrap], { stdio: "ignore" });
  stopCore = async () => {
    if (core.exitCode === null && core.signalCode === null) { const ended = once(core, "exit"); core.kill(); await ended; }
  };
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://${controller}/version`).then((response) => response.ok, () => false)) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true);
  const original = await f.store.read();
  const firstConfig = parse(original.content); firstConfig["external-controller"] = controller;
  await f.store.saveFile(original.name, stringify(firstConfig), original.sha256);
  const first = await fill(f);
  const apply = async (snapshot: { name: string; sha256: string }) => {
    const generated = await f.manager.generate({ sourceName: snapshot.name, expectedSourceSha256: snapshot.sha256, expectedSettingsVersion: 0 },
      (name, sha) => f.files.validateSourceCollectionsUnqueued(name, sha));
    const state = await f.manager.readLoadState();
    const attempt = await f.manager.beginLoad({ generatedVersion: generated.version, expectedVersion: state.version });
    const loaded = await fetch(`http://${controller}/configs?force=true`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: generated.path }) });
    assert.equal(loaded.ok, true); await loaded.arrayBuffer();
    await f.manager.finishLoad({ attemptId: attempt.lastAttempt!.id, expectedVersion: attempt.version, result: "succeeded" });
  };
  await apply(first);
  const providerNames = async () => {
    const response = await fetch(`http://${controller}/providers/proxies/local`); assert.equal(response.ok, true);
    return (await response.json() as { proxies: Array<{ name: string }> }).proxies.map((entry) => entry.name);
  };
  assert.deepEqual(await providerNames(), ["fixture"]);
  await f.store.create("second.yaml", first.content);
  let second = await fill(f, "second.yaml");
  const local = second.collectionPaths![0]!;
  const body = await f.files.read("proxy", local.fileName!);
  second = await f.files.saveCollectionWorkspace({ configName: second.name, expectedSha256: second.sha256, content: second.content, removals: [],
    bodies: [{ category: "proxy", name: "local", content: proxyBody.replace("name: fixture", "name: fixture-b"), expectedSha256: body.sha256 }] });
  assert.deepEqual(await providerNames(), ["fixture"]);
  assert.equal((await f.manager.readLoadState()).lastSuccessful!.generated.sourceName, first.name);
  await apply(second);
  assert.deepEqual(await providerNames(), ["fixture-b"]);
  assert.equal((await f.manager.readLoadState()).lastSuccessful!.generated.sourceName, second.name);
  const rules = await fetch(`http://${controller}/providers/rules`); assert.equal(rules.ok, true);
  assert.equal((await rules.json() as { providers: Record<string, { ruleCount: number }> }).providers.rules!.ruleCount, 1);
  assert.equal((await f.files.read("proxy", first.collectionPaths![0]!.fileName!)).content, proxyBody);
});
