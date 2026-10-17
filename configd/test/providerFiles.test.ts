import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, chown, link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ConfigStore } from "../src/config/store.js";
import {
  ProviderFileConflictError,
  ProviderFileExistsError,
  ProviderFileNameError,
  ProviderFileReadOnlyError,
  ProviderFileRecoveryError,
  ProviderFileReferencedError,
  ProviderRuntimeReferenceError,
  ProviderFileValidationError,
  ProviderFilterConflictError,
} from "../src/providerFiles/errors.js";
import {
  ProviderFileService,
} from "../src/providerFiles/service.js";
import type { PublicSubscription } from "../src/subscriptions/types.js";
import { SubscriptionService } from "../src/subscriptions/service.js";
import { SubscriptionValidationError } from "../src/config/errors.js";
import { WriteQueue } from "../src/writeQueue.js";
import { parse, stringify } from "yaml";
import type { ProviderRuntimeDependencies } from "../src/providerFiles/types.js";

function sha256(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

async function fixture(options: {
  readRuntimeDependencies?: () => Promise<ProviderRuntimeDependencies>;
  configs?: Record<string, string>;
  subscriptions?: PublicSubscription[];
  beforeFileRename?: () => Promise<void>;
  beforeStateRename?: () => Promise<void>;
  beforeRenameCleanup?: (phase: "rollback-target" | "commit-source") => Promise<void>;
  afterRenamePhase?: (phase: "prepared" | "linked" | "committed") => Promise<void>;
  beforeOperationCleanup?: (operation: string, phase: string) => Promise<void>;
  afterOperationPhase?: (operation: string, phase: string) => Promise<void>;
  afterProviderFilePublish?: () => Promise<void>;
  beforeConfigSave?: (name: string) => Promise<void>;
  beforeOwnedSourceFileDelete?: () => Promise<void>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "mihomo-provider-files-"));
  const providerDir = join(root, "providers");
  const ruleProviderDir = join(root, "ruleset");
  await mkdir(providerDir);
  const configs = new Map(Object.entries(options.configs ?? {}));
  const store = {
    list: async () => [...configs].map(([name, content]) => ({
      name,
      path: join(root, name),
      sha256: sha256(content),
      size: Buffer.byteLength(content),
      updatedAt: "2026-08-12T00:00:00.000Z",
    })),
    read: async (name: string) => {
      const content = configs.get(name);
      if (content == null) throw new Error("fixture config not found");
      return { name, path: join(root, name), content, sha256: sha256(content) };
    },
    saveFileUnqueued: async (name: string, content: string, expectedSha256: string) => {
      const current = configs.get(name);
      if (current == null || sha256(current) !== expectedSha256) throw new Error("configuration changed");
      await options.beforeConfigSave?.(name);
      configs.set(name, content);
      return { name, path: join(root, name), content, sha256: sha256(content) };
    },
    restoreFileUnqueued: async (name: string, content: string, expectedSha256: string) => {
      const current = configs.get(name);
      if (current == null || sha256(current) !== expectedSha256) throw new Error("configuration changed");
      configs.set(name, content);
      return { name, path: join(root, name), content, sha256: sha256(content) };
    },
  } as unknown as Pick<ConfigStore, "list" | "read" | "saveFileUnqueued" | "restoreFileUnqueued">;
  const writeQueue = new WriteQueue();
  const service = new ProviderFileService({
    providerDir,
    ruleProviderDir,
    statePath: join(root, "state", "provider-files.json"),
    dataDir: root,
    maxContentBytes: 4096,
    writeQueue,
    store,
    subscriptions: () => options.subscriptions ?? [],
    readRuntimeDependencies: options.readRuntimeDependencies ?? (async () => ({ content: "mode: direct\n", uncertain: false })),
    ...(options.beforeFileRename ? { beforeFileRename: options.beforeFileRename } : {}),
    ...(options.beforeStateRename ? { beforeStateRename: options.beforeStateRename } : {}),
    ...(options.beforeRenameCleanup ? { beforeRenameCleanup: options.beforeRenameCleanup } : {}),
    ...(options.afterRenamePhase ? { afterRenamePhase: options.afterRenamePhase } : {}),
    ...(options.beforeOperationCleanup ? { beforeOperationCleanup: options.beforeOperationCleanup } : {}),
    ...(options.afterOperationPhase ? { afterOperationPhase: options.afterOperationPhase } : {}),
    ...(options.afterProviderFilePublish ? { afterProviderFilePublish: options.afterProviderFilePublish } : {}),
    ...(options.beforeOwnedSourceFileDelete ? { beforeOwnedSourceFileDelete: options.beforeOwnedSourceFileDelete } : {}),
  });
  await service.init();
  return { root, providerDir, ruleProviderDir, service, store, writeQueue, configs };
}

test("orphan extraction cleanup checks identity, source, file and references while preserving other owners", async (t) => {
  let runtime = "mode: direct\n";
  const f = await fixture({ configs: { "a.yaml": "proxies: []\n", "b.yaml": "proxies: []\n" },
    readRuntimeDependencies: async () => ({ content: runtime, uncertain: true }) });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const name of ["a", "b"]) await f.service.createLocalExtraction({ configName: `${name}.yaml`,
    sourceSha256: (await f.store.read(`${name}.yaml`)).sha256, fileName: `${name}-out.yaml`, enabled: false });
  const [a, b] = f.service.localExtractions();
  const input = { ...a!, filterVersion: a!.filterSettings.version };
  await assert.rejects(f.service.deleteLocalExtraction(input), ProviderFileConflictError);
  f.configs.delete("a.yaml");
  await assert.rejects(f.service.deleteLocalExtraction({ ...input, fileName: "b-out.yaml" }), ProviderFileConflictError);
  await assert.rejects(f.service.deleteLocalExtraction({ ...input, filterVersion: 99 }), ProviderFileConflictError);
  await writeFile(join(f.providerDir, "a-out.yaml"), "proxies: []\n");
  await assert.rejects(f.service.deleteLocalExtraction(input), ProviderFileConflictError);
  await unlink(join(f.providerDir, "a-out.yaml"));
  f.configs.set("reference.yaml", "proxy-providers: {a: {type: file, path: ./providers/a-out.yaml}}\n");
  await assert.rejects(f.service.deleteLocalExtraction(input), ProviderFileReferencedError);
  f.configs.delete("reference.yaml");
  runtime = "proxy-providers: {a: {type: file, path: ./providers/a-out.yaml}}\n";
  await assert.rejects(f.service.deleteLocalExtraction(input), ProviderRuntimeReferenceError);
  runtime = "mode: direct\n";
  await f.service.deleteLocalExtraction(input);
  assert.deepEqual(f.service.localExtractions(), [b]);
  assert.deepEqual(JSON.parse(await readFile(f.service.options.statePath, "utf8")).local, [b]);
  assert.deepEqual([...f.configs.keys()], ["b.yaml"]);
});

test("orphan extraction cleanup preserves metadata when atomic publication fails", async (t) => {
  let fail = false;
  const f = await fixture({ configs: { "a.yaml": "proxies: []\n" },
    beforeStateRename: async () => { if (fail) throw new Error("fixture publication failure"); } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.service.createLocalExtraction({ configName: "a.yaml", sourceSha256: (await f.store.read("a.yaml")).sha256, fileName: "a-out.yaml", enabled: false });
  const before = f.service.localExtractions();
  f.configs.delete("a.yaml"); fail = true;
  await assert.rejects(f.service.deleteLocalExtraction({ ...before[0]!, filterVersion: before[0]!.filterSettings.version }), /fixture publication failure/);
  assert.deepEqual(f.service.localExtractions(), before);
  assert.deepEqual(JSON.parse(await readFile(f.service.options.statePath, "utf8")).local, before);
});

test("collection settings rename the current reference and retain the file used by another config", async (t) => {
  const declaration = { type: "file", path: "./providers/existing.yaml" };
  const content = stringify({ "proxy-providers": { first: declaration }, "proxy-groups": [{ name: "test", type: "select", use: ["first"] }] });
  const other = stringify({ "proxy-providers": { shared: declaration }, "proxy-groups": [{ name: "other", type: "select", use: ["shared"] }] });
  const { root, providerDir, service, store } = await fixture({ configs: { "first.yaml": content, "other.yaml": other } });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(providerDir, "existing.yaml"), "proxies: []\n");
  const file = await service.read("proxy", "existing.yaml");
  assert.equal(file.writable, true);
  assert.equal(file.source, "external");
  const saved = await service.save("proxy", file.fileName, "proxies:\n  - {name: sample, type: direct}\n", file.sha256);
  await assert.rejects(service.delete("proxy", saved.fileName, saved.sha256), ProviderFileReadOnlyError);
  const result = await service.saveCollectionSettings({ configName: "first.yaml", expectedConfigSha256: sha256(content), category: "proxy", name: "first",
    snippet: stringify({ renamed: { type: "file", path: "./providers/renamed.yaml" } }), loaded: true, selectedGroups: ["test"], expectedFileSha256: saved.sha256 });
  const first = parse(result.config.content);
  assert.equal(first["proxy-providers"].renamed.path, "./providers/renamed.yaml");
  assert.deepEqual(first["proxy-groups"][0].use, ["renamed"]);
  const second = parse((await store.read("other.yaml")).content);
  assert.equal(second["proxy-providers"].shared.path, "./providers/existing.yaml");
  assert.deepEqual(second["proxy-groups"][0].use, ["shared"]);
  assert.equal((await service.read("proxy", "renamed.yaml")).source, "external");
  assert.equal(await readFile(join(providerDir, "existing.yaml"), "utf8"), "proxies:\n  - {name: sample, type: direct}\n");
  assert.equal(await readFile(join(providerDir, "renamed.yaml"), "utf8"), await readFile(join(providerDir, "existing.yaml"), "utf8"));
  assert.equal(result.retainedSource?.reason, "referenced");
  assert.deepEqual(result.retainedSource?.configReferences, [{ configName: "other.yaml", kind: "path", path: "./providers/existing.yaml" }]);
});

test("collection rename removes the old name when only other hard links are referenced", async (t) => {
  for (const dependency of ["source", "runtime"] as const) {
    const content = "proxy-providers:\n  first: {type: file, path: ./providers/original.yaml}\n";
    const alias = content.replace("original.yaml", "alias.yaml");
    const f = await fixture({ configs: { "main.yaml": content, ...(dependency === "source" ? { "other.yaml": alias } : {}) },
      readRuntimeDependencies: async () => ({ content: dependency === "runtime" ? alias : "mode: direct\n", uncertain: false }) });
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const file = await f.service.create("proxy", "original.yaml", "# retained body\nproxies: []\n");
    const sourcePath = join(f.providerDir, file.fileName);
    await chmod(sourcePath, 0o640);
    if (process.platform !== "win32" && process.getuid?.() === 0) await chown(sourcePath, 65534, 65534);
    const before = await stat(sourcePath);
    await link(sourcePath, join(f.providerDir, "alias.yaml"));
    const result = await f.service.saveCollectionSettings({ configName: "main.yaml", expectedConfigSha256: sha256(content),
      category: "proxy", name: "first", snippet: "renamed: {type: file, path: ./providers/next.yaml}\n", loaded: true, selectedGroups: [], expectedFileSha256: file.sha256 });
    assert.equal(result.retainedSource, undefined);
    assert.equal(parse(result.config.content)["proxy-providers"].renamed.path, "./providers/next.yaml");
    await assert.rejects(readFile(sourcePath), { code: "ENOENT" });
    const after = await stat(join(f.providerDir, "next.yaml"));
    for (const key of ["dev", "ino", "mode", "uid", "gid"] as const) assert.equal(after[key], before[key]);
    assert.equal((await f.service.read("proxy", "next.yaml")).sha256, file.sha256);
    assert.equal(await readFile(join(f.providerDir, "alias.yaml"), "utf8"), "# retained body\nproxies: []\n");
    const state = JSON.parse(await readFile(f.service.options.statePath, "utf8"));
    assert.deepEqual(state.manual, [{ category: "proxy", fileName: "next.yaml" }]);
    assert.equal(state.operationJournal, null);
  }
});

test("rename keeps direct references after an inode match and paths through directory aliases", async (t) => {
  const content = "proxy-providers:\n  first: {type: file, path: ./providers/original.yaml}\n";
  const f = await fixture({ configs: { "main.yaml": content } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const file = await f.service.create("proxy", "original.yaml");
  await link(join(f.providerDir, file.fileName), join(f.providerDir, "alias.yaml"));
  f.configs.set("other.yaml", "proxy-providers:\n  alias: {type: file, path: ./providers/alias.yaml}\n  direct: {type: file, path: ./providers/original.yaml}\n");
  const result = await f.service.saveCollectionSettings({ configName: "main.yaml", expectedConfigSha256: sha256(content), category: "proxy",
    name: "first", snippet: "first: {type: file, path: ./providers/next.yaml}\n", loaded: true, selectedGroups: [], expectedFileSha256: file.sha256 });
  assert.equal(result.retainedSource?.reason, "referenced");
  assert.deepEqual(result.retainedSource?.configReferences, [
    { configName: "other.yaml", kind: "identity", path: "./providers/alias.yaml" },
    { configName: "other.yaml", kind: "path", path: "./providers/original.yaml" },
  ]);
  if (process.platform === "win32") return;
  await symlink(f.providerDir, join(f.root, "directory-alias"), "dir");
  f.configs.set("other.yaml", "proxy-providers:\n  directory: {type: file, path: ./directory-alias/next.yaml}\n");
  const next = await f.service.saveCollectionSettings({ configName: "main.yaml", expectedConfigSha256: result.config.sha256, category: "proxy",
    name: "first", snippet: "first: {type: file, path: ./providers/final.yaml}\n", loaded: true, selectedGroups: [], expectedFileSha256: file.sha256 });
  assert.equal(next.retainedSource?.reason, "referenced");
  assert.deepEqual(next.retainedSource?.configReferences, [{ configName: "other.yaml", kind: "path", path: "./directory-alias/next.yaml" }]);
  assert.equal(await readFile(join(f.root, "directory-alias/next.yaml"), "utf8"), file.content);
});

test("committed collection rename resumes source removal after restart with a referenced hard link", async (t) => {
  const content = "proxy-providers:\n  first: {type: file, path: ./providers/original.yaml}\n";
  let interrupt = false;
  const f = await fixture({ configs: { "main.yaml": content, "other.yaml": content.replace("original.yaml", "alias.yaml") },
    beforeRenameCleanup: async (phase) => { if (interrupt && phase === "commit-source") throw new Error("fixture interruption"); } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const file = await f.service.create("proxy", "original.yaml");
  await link(join(f.providerDir, file.fileName), join(f.providerDir, "alias.yaml"));
  interrupt = true;
  await assert.rejects(f.service.saveCollectionSettings({ configName: "main.yaml", expectedConfigSha256: sha256(content), category: "proxy",
    name: "first", snippet: "first: {type: file, path: ./providers/next.yaml}\n", loaded: true, selectedGroups: [], expectedFileSha256: file.sha256 }), ProviderFileRecoveryError);
  assert.equal(JSON.parse(await readFile(f.service.options.statePath, "utf8")).operationJournal.phase, "committed");
  interrupt = false;
  const reloaded = new ProviderFileService(f.service.options);
  await reloaded.init();
  assert.equal((await reloaded.read("proxy", "next.yaml")).sha256, file.sha256);
  await assert.rejects(readFile(join(f.providerDir, "original.yaml")), { code: "ENOENT" });
  assert.equal((await f.store.read("main.yaml")).content.includes("./providers/next.yaml"), true);
  assert.equal(JSON.parse(await readFile(f.service.options.statePath, "utf8")).operationJournal, null);
});

test("collection file rename rolls back the target when the current config fails", async (t) => {
  const content = stringify({ "proxy-providers": { first: { type: "file", path: "./providers/shared.yaml" } }, "proxy-groups": [{ name: "test", type: "select", use: ["first"] }] });
  const { root, providerDir, service, store } = await fixture({ configs: { "first.yaml": content, "other.yaml": content },
    beforeConfigSave: async (name) => { if (name === "first.yaml") throw new Error("fixture save failure"); } });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(providerDir, "shared.yaml"), "proxies: []\n");
  const file = await service.read("proxy", "shared.yaml");
  await assert.rejects(service.saveCollectionSettings({ configName: "first.yaml", expectedConfigSha256: sha256(content), category: "proxy", name: "first",
    snippet: stringify({ renamed: { type: "file", path: "./providers/renamed.yaml" } }), loaded: true, selectedGroups: ["test"], expectedFileSha256: file.sha256 }));
  assert.equal((await store.read("first.yaml")).content, content);
  assert.equal((await store.read("other.yaml")).content, content);
  assert.equal((await service.read("proxy", "shared.yaml")).sha256, file.sha256);
  await assert.rejects(readFile(join(providerDir, "renamed.yaml")));
});

test("collection preferences persist separately and HTTP cache cannot be unlocked by changing type", async (t) => {
  const content = stringify({ "proxy-providers": {
    inline: { type: "inline", payload: [] }, remote: { type: "http", path: "./providers/cache.yaml", url: "https://fixture.invalid/provider" },
  }, "proxy-groups": [{ name: "test", type: "select", use: ["inline", "remote"] }] });
  const { root, providerDir, service, store, configs } = await fixture({ configs: { "main.yaml": content } });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(providerDir, "cache.yaml"), "proxies: []\n");
  await service.list();
  const preferences = await service.setCollectionReadOnly({ configName: "main.yaml", category: "proxy", name: "inline", readOnly: true, expectedVersion: 0 });
  assert.equal(preferences.readOnly.length, 1);
  assert.equal((await store.read("main.yaml")).content, content);
  const reloaded = new ProviderFileService(service.options);
  await reloaded.init();
  assert.deepEqual(reloaded.collectionPreferences(), preferences);
  await writeFile(join(providerDir, "occupied.yaml"), "proxies: []\n");
  await assert.rejects(reloaded.saveCollectionSettings({ configName: "main.yaml", expectedConfigSha256: sha256(content), category: "proxy", name: "remote",
    snippet: stringify({ remote: { type: "http", path: "./providers/occupied.yaml", url: "https://fixture.invalid/provider" } }), loaded: true, selectedGroups: ["test"] }), ProviderFileExistsError);
  assert.equal((await store.read("main.yaml")).content, content);
  const changed = parse(content);
  changed["proxy-providers"].remote = { type: "file", path: "./providers/cache.yaml" };
  configs.set("main.yaml", stringify(changed));
  const file = await reloaded.read("proxy", "cache.yaml");
  assert.equal(file.writable, false);
  await assert.rejects(reloaded.save("proxy", "cache.yaml", "proxies: []\n", file.sha256), ProviderFileReadOnlyError);
  await assert.rejects(reloaded.setCollectionReadOnly({ configName: "main.yaml", category: "proxy", name: "remote", readOnly: false, expectedVersion: preferences.version }), ProviderFileReadOnlyError);
});

test("saved path evidence survives restart and syncs the exact original body without resaving YAML", async (t) => {
  const before = "mode: rule\nproxy-providers:\n  first:\n    type: file\n    path: ./providers/original.yaml\n";
  const after = before.replace("original.yaml", "next.yaml");
  const { root, providerDir, service, store } = await fixture({ configs: { "main.yaml": before } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = "# body retained\nproxies:\n  - {name: sample, type: direct}\n";
  await writeFile(join(providerDir, "original.yaml"), body);
  const saved = await service.saveConfig("main.yaml", after, sha256(before));
  assert.equal((await store.read("main.yaml")).content, after);
  assert.equal(await readFile(join(providerDir, "original.yaml"), "utf8"), body);
  await assert.rejects(readFile(join(providerDir, "next.yaml")));
  const change = saved.collectionPathChanges[0]!;
  assert.deepEqual(change, { category: "proxy", name: "first", fromPath: "./providers/original.yaml", toPath: "./providers/next.yaml", fileSha256: sha256(body) });
  const reloaded = new ProviderFileService(service.options);
  await reloaded.init();
  assert.deepEqual((await reloaded.readConfig("main.yaml")).collectionPathChanges, [change]);
  const later = await reloaded.saveConfig("main.yaml", after.replace("rule", "direct"), saved.sha256);
  assert.deepEqual(later.collectionPathChanges, [change]);
  const input = { configName: "main.yaml", expectedConfigSha256: later.sha256, ...change, expectedFileSha256: change.fileSha256,
    draftContent: later.content + "# unrelated draft\n" };
  const restored = await reloaded.resolveCollectionPath({ ...input, action: "restore" });
  assert.equal(restored.fromPath, change.fromPath);
  assert.equal(restored.content, body);
  assert.equal((await store.read("main.yaml")).content, later.content);
  const result = await reloaded.resolveCollectionPath({ ...input, action: "rename" });
  assert.equal(result.config?.content, later.content);
  assert.equal(result.config?.sha256, later.sha256);
  assert.deepEqual(result.config?.collectionPathChanges, []);
  assert.equal(await readFile(join(providerDir, "next.yaml"), "utf8"), body);
  await assert.rejects(readFile(join(providerDir, "original.yaml")));
});

test("existing targets remain a reference change and rename collisions never replace either body", async (t) => {
  const before = "proxy-providers:\n  first: {type: file, path: ./providers/original.yaml}\nproxy-groups:\n  - {name: select, type: select, use: [first]}\n";
  const { root, providerDir, service, store } = await fixture({ configs: { "main.yaml": before } });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(providerDir, "original.yaml"), "proxies: []\n");
  await writeFile(join(providerDir, "exists.yaml"), "# existing target\nproxies: []\n");
  await assert.rejects(service.saveCollectionSettings({ configName: "main.yaml", expectedConfigSha256: sha256(before), category: "proxy", name: "first",
    snippet: "first: {type: file, path: ./providers/exists.yaml}\n", loaded: true, selectedGroups: ["select"], expectedFileSha256: sha256("proxies: []\n") }), ProviderFileExistsError);
  assert.equal((await store.read("main.yaml")).content, before);
  const saved = await service.saveConfig("main.yaml", before.replace("original.yaml", "exists.yaml"), sha256(before));
  assert.deepEqual(saved.collectionPathChanges, []);
  assert.equal(await readFile(join(providerDir, "original.yaml"), "utf8"), "proxies: []\n");
  assert.equal(await readFile(join(providerDir, "exists.yaml"), "utf8"), "# existing target\nproxies: []\n");
});

test("path recovery rechecks draft, source version, target collision and original inode", async (t) => {
  const before = "rule-providers:\n  first: {type: file, behavior: domain, path: ./ruleset/original.yaml}\n";
  const { root, ruleProviderDir, service } = await fixture({ configs: { "main.yaml": before } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = "payload: [fixture.invalid]\n";
  await writeFile(join(ruleProviderDir, "original.yaml"), body);
  const saved = await service.saveConfig("main.yaml", before.replace("original.yaml", "next.yaml"), sha256(before));
  const change = saved.collectionPathChanges[0]!;
  const input = { configName: "main.yaml", expectedConfigSha256: saved.sha256, ...change, expectedFileSha256: change.fileSha256, draftContent: saved.content, action: "rename" as const };
  await assert.rejects(service.resolveCollectionPath({ ...input, expectedConfigSha256: sha256(before) }));
  await assert.rejects(service.resolveCollectionPath({ ...input, draftContent: before }), ProviderFileConflictError);
  await writeFile(join(ruleProviderDir, "next.yaml"), "payload: [collision.invalid]\n");
  await assert.rejects(service.resolveCollectionPath(input), ProviderFileExistsError);
  await unlink(join(ruleProviderDir, "next.yaml"));
  await rename(join(ruleProviderDir, "original.yaml"), join(ruleProviderDir, "moved.yaml"));
  await writeFile(join(ruleProviderDir, "original.yaml"), body);
  assert.deepEqual((await service.readConfig("main.yaml")).collectionPathChanges, []);
  await assert.rejects(service.resolveCollectionPath(input), ProviderFileConflictError);
  assert.equal(await readFile(join(ruleProviderDir, "original.yaml"), "utf8"), body);
});

test("retained manual files keep both owners for referenced and unknown runtime versions", async (t) => {
  for (const reason of ["runtime_reference", "runtime_unknown"] as const) {
    const content = "proxy-providers:\n  first: {type: file, path: ./providers/original.yaml}\nproxy-groups:\n  - {name: select, type: select, use: [first]}\n";
    const { root, providerDir, service } = await fixture({ configs: { "main.yaml": content },
      readRuntimeDependencies: async () => ({ content: reason === "runtime_reference" ? content : "mode: direct\n", uncertain: reason === "runtime_unknown" }) });
    t.after(() => rm(root, { recursive: true, force: true }));
    const original = await service.create("proxy", "original.yaml", "proxies: []\n");
    const result = await service.saveCollectionSettings({ configName: "main.yaml", expectedConfigSha256: sha256(content), category: "proxy", name: "first",
      snippet: "first: {type: file, path: ./providers/next.yaml}\n", loaded: true, selectedGroups: ["select"], expectedFileSha256: original.sha256 });
    assert.equal(result.retainedSource?.reason, reason);
    const reloaded = new ProviderFileService(service.options);
    await reloaded.init();
    assert.equal((await reloaded.read("proxy", "original.yaml")).source, "manual");
    assert.equal((await reloaded.read("proxy", "next.yaml")).source, "manual");
    await reloaded.save("proxy", "next.yaml", "# new body\nproxies: []\n", original.sha256);
    assert.equal(await readFile(join(providerDir, "original.yaml"), "utf8"), "proxies: []\n");
  }
});

test("path recovery distinguishes prepared, linked and committed transactions with unchanged YAML", async (t) => {
  for (const phase of ["prepared", "linked", "committed"] as const) {
    const before = "proxy-providers:\n  first: {type: file, path: ./providers/original.yaml}\n";
    let fail = false;
    const { root, providerDir, service } = await fixture({ configs: { "main.yaml": before }, afterOperationPhase: async (operation, current) => {
      if (fail && operation === "rename" && current === phase) throw new Error("fixture interrupted");
    } });
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(providerDir, "original.yaml"), "proxies: []\n");
    const saved = await service.saveConfig("main.yaml", before.replace("original.yaml", "next.yaml"), sha256(before));
    const change = saved.collectionPathChanges[0]!;
    fail = true;
    await assert.rejects(service.resolveCollectionPath({ configName: "main.yaml", expectedConfigSha256: saved.sha256, ...change,
      expectedFileSha256: change.fileSha256, draftContent: saved.content, action: "rename" }));
    fail = false;
    const reloaded = new ProviderFileService(service.options);
    await reloaded.init();
    assert.equal((await reloaded.readConfig("main.yaml")).sha256, saved.sha256);
    const keep = phase === "committed" ? "next.yaml" : "original.yaml";
    const removed = phase === "committed" ? "original.yaml" : "next.yaml";
    assert.equal(await readFile(join(providerDir, keep), "utf8"), "proxies: []\n");
    await assert.rejects(readFile(join(providerDir, removed)));
  }
});

test("path evidence does not grant recovery to HTTP caches, generated files or unrecorded history", async (t) => {
  const before = "proxy-providers:\n  first: {type: file, path: ./providers/original.yaml}\n";
  const { root, providerDir, service, configs } = await fixture({ configs: { "main.yaml": before,
    "http.yaml": "proxy-providers:\n  cache: {type: http, path: ./providers/original.yaml, url: 'https://fixture.invalid'}\n" } });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(providerDir, "original.yaml"), "proxies: []\n");
  let saved = await service.saveConfig("main.yaml", before.replace("original.yaml", "next.yaml"), sha256(before));
  assert.deepEqual(saved.collectionPathChanges, []);
  configs.delete("http.yaml");
  saved = await service.saveConfig("main.yaml", before, saved.sha256);
  saved = await service.saveConfig("main.yaml", before.replace("original.yaml", "later.yaml"), saved.sha256);
  assert.deepEqual(saved.collectionPathChanges, []);
  await writeFile(join(providerDir, "unrelated.yaml"), "proxies: []\n");
  assert.deepEqual((await service.readConfig("main.yaml")).collectionPathChanges, []);
  const extractionSource = "proxies: [{name: fixture, type: direct}]\n";
  configs.set("source.yaml", extractionSource);
  await service.createLocalExtraction({ configName: "source.yaml", sourceSha256: sha256(extractionSource), fileName: "derived.yaml" });
  saved = await service.saveConfig("main.yaml", before.replace("original.yaml", "derived.yaml"), saved.sha256);
  saved = await service.saveConfig("main.yaml", before.replace("original.yaml", "derived-next.yaml"), saved.sha256);
  assert.deepEqual(saved.collectionPathChanges, []);
  assert.equal((await service.read("proxy", "derived.yaml")).writable, false);
});

test("managed Provider files enforce manual CRUD ownership and expected SHA", async (t) => {
  const { root, providerDir, ruleProviderDir, service, configs } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const created = await service.create("proxy", "manual.yaml");
  assert.equal(created.content, "proxies:\n");
  assert.equal(created.source, "manual");
  assert.equal(created.writable, true);
  assert.equal(created.referencePath, "./providers/manual.yaml");
  assert.deepEqual(service.templateSettings(), {
    version: 0,
    ruleBehavior: "classical",
    ruleFormat: "yaml",
    interval: null,
    healthCheck: false,
  });
  const templates = await service.saveTemplateSettings({
    ...service.templateSettings(),
    ruleBehavior: "domain",
    ruleFormat: "text",
    interval: 600,
    healthCheck: true,
  });
  assert.equal(templates.version, 1);
  await assert.rejects(
    service.saveTemplateSettings({ ...templates, version: 0 }),
    ProviderFileConflictError,
  );
  const templateReload = new ProviderFileService({ ...service.options });
  await templateReload.init();
  assert.deepEqual(templateReload.templateSettings(), templates);
  const httpConfig = "proxy-providers:\n  remote:\n    type: http\n    url: https://fixture.invalid/provider\n    path: ./providers/remote.yaml\n";
  configs.set("http.yaml", "rules: [MATCH,DIRECT]\n");
  const httpSaved = await service.saveConfigWithManualHttp({
    configName: "http.yaml",
    content: httpConfig,
    expectedSha256: sha256(configs.get("http.yaml")!),
    providers: [{ category: "proxy", name: "remote" }],
  });
  assert.equal(configs.get("http.yaml"), httpConfig);
  assert.deepEqual(service.manualHttpProviders("http.yaml").map(({ declaration: _declaration, ...owner }) => owner), [{ configName: "http.yaml", category: "proxy", name: "remote" }]);
  await assert.rejects(service.saveConfigWithManualHttp({
    configName: "http.yaml", content: httpConfig, expectedSha256: "0".repeat(64), providers: [],
  }), ProviderFileConflictError);
  assert.deepEqual(service.manualHttpProviders("http.yaml").map(({ declaration: _declaration, ...owner }) => owner), [{ configName: "http.yaml", category: "proxy", name: "remote" }]);
  const httpReload = new ProviderFileService({ ...service.options });
  await httpReload.init();
  assert.deepEqual(httpReload.manualHttpProviders("http.yaml").map(({ declaration: _declaration, ...owner }) => owner), [{ configName: "http.yaml", category: "proxy", name: "remote" }]);
  assert.equal(httpSaved.sha256, sha256(httpConfig));
  let stateWrites = 0;
  const cleanupFailureService = new ProviderFileService({
    ...service.options,
    beforeStateRename: async () => {
      stateWrites += 1;
      if (stateWrites === 2) throw new Error("fixture ownership state commit failed");
    },
  });
  await cleanupFailureService.init();
  const renamedHttpConfig = httpConfig.replaceAll("remote", "recovered");
  await assert.rejects(cleanupFailureService.saveConfigWithManualHttp({
    configName: "http.yaml",
    content: renamedHttpConfig,
    expectedSha256: sha256(httpConfig),
    providers: [{ category: "proxy", name: "recovered" }],
  }), /state commit failed/);
  const recoveryState = JSON.parse(await readFile(service.options.statePath, "utf8"));
  assert.equal(recoveryState.httpConfigIntent.afterSha256, sha256(renamedHttpConfig));
  const recoveredHttp = new ProviderFileService({ ...service.options });
  await recoveredHttp.init();
  assert.deepEqual(recoveredHttp.manualHttpProviders("http.yaml").map(({ declaration: _declaration, ...owner }) => owner), [{ configName: "http.yaml", category: "proxy", name: "recovered" }]);
  assert.equal(JSON.parse(await readFile(service.options.statePath, "utf8")).httpConfigIntent, null);
  const unloadedHttpConfig = "rules: [MATCH,DIRECT]\n";
  const unloadedHttp = await recoveredHttp.saveConfigWithManualHttp({
    configName: "http.yaml",
    content: unloadedHttpConfig,
    expectedSha256: sha256(renamedHttpConfig),
    providers: [{ category: "proxy", name: "recovered" }],
  });
  assert.deepEqual(recoveredHttp.manualHttpProviders("http.yaml").map(({ declaration: _declaration, ...owner }) => owner), [{ configName: "http.yaml", category: "proxy", name: "recovered" }]);
  await recoveredHttp.saveConfigWithManualHttp({
    configName: "http.yaml",
    content: unloadedHttpConfig,
    expectedSha256: unloadedHttp.sha256,
    providers: [],
  });
  assert.deepEqual(recoveredHttp.manualHttpProviders("http.yaml"), []);
  configs.delete("http.yaml");

  const customContent = "proxies:\n  - { name: fixture, type: direct }\n";
  const custom = await service.create("proxy", "custom.yaml", customContent);
  assert.equal(custom.content, customContent);
  await service.delete("proxy", custom.fileName, custom.sha256);
  const stateBeforeInvalidCreate = await readFile(service.options.statePath, "utf8");
  await assert.rejects(
    service.create("proxy", "invalid.yaml", "payload: []\n"),
    /invalid top-level structure/,
  );
  assert.equal(await readFile(service.options.statePath, "utf8"), stateBeforeInvalidCreate);
  await assert.rejects(
    readFile(join(providerDir, "invalid.yaml")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

  const saved = await service.save(
    "proxy",
    "manual.yaml",
    "proxies:\n  - { name: sample, type: direct }\n",
    created.sha256,
  );
  assert.notEqual(saved.sha256, created.sha256);
  await assert.rejects(
    service.save("proxy", "manual.yaml", "proxies: []\n", created.sha256),
    ProviderFileConflictError,
  );

  const renamed = await service.rename("proxy", "manual.yaml", "renamed.yaml", saved.sha256);
  assert.equal(renamed.fileName, "renamed.yaml");
  assert.equal(renamed.source, "manual");
  await service.delete("proxy", "renamed.yaml", renamed.sha256);
  assert.deepEqual(await service.list(), []);

  const transactional = await service.create("proxy", "transactional.yaml");
  const beforeConfig = [
    "proxy-providers:",
    "  transactional:",
    "    type: file",
    "    path: ./providers/transactional.yaml",
    "proxy-groups:",
    "  - name: Main",
    "    type: select",
    "    use: [transactional]",
    "",
  ].join("\n");
  configs.set("current.yaml", beforeConfig);
  const renamedConfig = beforeConfig
    .replaceAll("transactional.yaml", "combined.yaml")
    .replaceAll("transactional", "combined");
  const combined = await service.renameWithConfig({
    category: "proxy",
    fileName: "transactional.yaml",
    nextFileName: "combined.yaml",
    expectedSha256: transactional.sha256,
    configName: "current.yaml",
    configContent: renamedConfig,
    expectedConfigSha256: sha256(beforeConfig),
  });
  assert.equal(combined.file.fileName, "combined.yaml");
  assert.equal(configs.get("current.yaml"), renamedConfig);
  assert.equal((await service.read("combined.yaml")).source, "manual");
  const removedConfig = "proxy-groups:\n  - name: Main\n    type: select\n";
  const removed = await service.deleteWithConfig({
    category: "proxy",
    fileName: "combined.yaml",
    expectedSha256: combined.file.sha256,
    configName: "current.yaml",
    configContent: removedConfig,
    expectedConfigSha256: combined.config.sha256,
  });
  assert.equal(removed.config.content, removedConfig);
  assert.equal(configs.get("current.yaml"), removedConfig);
  assert.deepEqual(await service.list(), []);

  const stillReferenced = await service.create("rule", "shared.yaml");
  configs.set("current.yaml", "rules: [MATCH,DIRECT]\n");
  configs.set("other.yaml", "rule-providers:\n  shared:\n    type: file\n    path: ./ruleset/shared.yaml\n");
  await assert.rejects(service.deleteWithConfig({
    category: "rule",
    fileName: "shared.yaml",
    expectedSha256: stillReferenced.sha256,
    configName: "current.yaml",
    configContent: "rules: [MATCH,DIRECT]\n",
    expectedConfigSha256: sha256(configs.get("current.yaml")!),
  }), ProviderFileReferencedError);
  assert.equal((await service.read("shared.yaml")).source, "manual");

  if (process.platform === "win32") {
    const caseCreated = await service.create("proxy", "ManualCase.yaml");
    const caseRenamed = await service.rename(
      "proxy",
      "ManualCase.yaml",
      "manualcase.yaml",
      caseCreated.sha256,
    );
    assert.equal(caseRenamed.fileName, "manualcase.yaml");
    assert.equal(caseRenamed.source, "manual");
    const entries = await readdir(providerDir);
    assert.equal(entries.includes("manualcase.yaml"), true);
    assert.equal(entries.includes("ManualCase.yaml"), false);
    const caseReloaded = new ProviderFileService({ ...service.options });
    await caseReloaded.init();
    const caseAfterRestart = await caseReloaded.read("manualcase.yaml");
    assert.equal(caseAfterRestart.source, "manual");
    assert.equal(caseAfterRestart.sha256, caseCreated.sha256);
    assert.equal(JSON.parse(await readFile(service.options.statePath, "utf8")).operationJournal, null);
    await caseReloaded.delete("proxy", "manualcase.yaml", caseAfterRestart.sha256);
  }

  await writeFile(join(ruleProviderDir, "external.yaml"), "payload:\n  - DOMAIN,example.invalid\n", "utf8");
  const external = await service.read("rule", "external.yaml");
  assert.equal(external.source, "external");
  assert.equal(external.category, "rule");
  await assert.rejects(
    service.save("rule", "external.yaml", "payload: []\n", external.sha256),
    ProviderFileReadOnlyError,
  );
  await assert.rejects(service.create("proxy", "../outside.yaml"), ProviderFileNameError);
  await mkdir(join(providerDir, "directory.yaml"));
  await assert.rejects(service.read("directory.yaml"));

  const outsideProviderDir = `${root}-outside-providers`;
  t.after(() => rm(outsideProviderDir, { recursive: true, force: true }));
  const outsideStatePath = join(root, "outside-provider-state.json");
  const outside = new ProviderFileService({
    ...service.options,
    providerDir: outsideProviderDir,
    statePath: outsideStatePath,
  });
  await assert.rejects(outside.init(), ProviderFileNameError);
  await assert.rejects(
    readdir(outsideProviderDir),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  await assert.rejects(
    readFile(outsideStatePath),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

  const outsideSubscriptionStatePath = join(root, "outside-subscriptions.json");
  const outsideSubscriptions = new SubscriptionService({
    statePath: outsideSubscriptionStatePath,
    providerDir: outsideProviderDir,
    dataDir: root,
    requestTimeoutMs: 1000,
    maxResponseBytes: 4096,
    writeQueue: new WriteQueue(),
  });
  await assert.rejects(outsideSubscriptions.init(), SubscriptionValidationError);
  await assert.rejects(
    readFile(outsideSubscriptionStatePath),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

  const dottedProviderDir = join(root, "..providers");
  const dottedQueue = new WriteQueue();
  let dottedSubscriptions!: SubscriptionService;
  const dottedProviderFiles = new ProviderFileService({
    providerDir: dottedProviderDir,
    statePath: join(root, "dotted-provider-state.json"),
    dataDir: root,
    maxContentBytes: 4096,
    writeQueue: dottedQueue,
    store: service.options.store,
    subscriptions: () => dottedSubscriptions?.list() ?? [],
  });
  await dottedProviderFiles.init();
  const dottedManual = await dottedProviderFiles.create("proxy", "manual.yaml");
  assert.equal(dottedManual.referencePath, "./..providers/manual.yaml");
  assert.equal((await dottedProviderFiles.read("manual.yaml")).sha256, dottedManual.sha256);

  dottedSubscriptions = new SubscriptionService({
    statePath: join(root, "dotted-subscriptions.json"),
    providerDir: dottedProviderDir,
    dataDir: root,
    requestTimeoutMs: 1000,
    maxResponseBytes: 4096,
    writeQueue: dottedQueue,
    fetchImpl: async () => new Response("proxies:\n  - { name: sample, type: direct }\n"),
    publishProvider: (identity, commitState) =>
      dottedProviderFiles.publishSubscriptionProvider(identity, commitState),
    ensureProviderOwnershipReady: () => dottedProviderFiles.ensureProviderOperationRecovered(),
    assertProviderReservationAvailable: (identity) =>
      dottedProviderFiles.assertSubscriptionReservationAvailable(identity),
    assertProviderIdentity: (identity) => dottedProviderFiles.assertSubscriptionPublish(identity),
  });
  await dottedSubscriptions.init();
  const dottedSubscription = await dottedSubscriptions.create({
    name: "Dotted provider",
    url: "https://example.test/dotted-provider",
    extractProvider: true,
    providerName: "subscription",
    mergeIntoConfig: true,
    configName: "profile.yaml",
    groupNames: ["Proxy"],
    autoUpdate: false,
    intervalMinutes: 60,
  });
  const dottedPublished = await dottedSubscriptions.updateNow(dottedSubscription.id);
  assert.equal(dottedPublished.providerPath, "./..providers/subscription.yaml");
  const dottedCommitted = dottedSubscriptions.list().find((item) => item.id === dottedSubscription.id)!;
  const dottedContent = await readFile(join(dottedProviderDir, "subscription.yaml"));
  assert.equal(dottedCommitted.providerSha256, sha256(dottedContent.toString("utf8")));
  assert.equal((await dottedProviderFiles.read("subscription.yaml")).sha256, dottedCommitted.providerSha256);

  const runtimeOriginalDir = join(root, "..providers-original");
  const runtimeLinkedTarget = `${root}-runtime-linked-target`;
  t.after(() => rm(runtimeLinkedTarget, { recursive: true, force: true }));
  await mkdir(runtimeLinkedTarget);
  await writeFile(join(runtimeLinkedTarget, "subscription.yaml"), dottedContent);
  await rename(dottedProviderDir, runtimeOriginalDir);
  let runtimeLinkAvailable = true;
  try {
    await symlink(runtimeLinkedTarget, dottedProviderDir, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    runtimeLinkAvailable = false;
    await rename(runtimeOriginalDir, dottedProviderDir);
  }
  if (runtimeLinkAvailable) {
    await assert.rejects(dottedSubscriptions.beginBinding(dottedSubscription.id), /provider directory is unavailable/);
    assert.equal(dottedSubscriptions.list().find((item) => item.id === dottedSubscription.id)?.binding, null);
    const persistedDotted = JSON.parse(await readFile(join(root, "dotted-subscriptions.json"), "utf8"));
    assert.equal(
      persistedDotted.subscriptions.find((item: { id: string }) => item.id === dottedSubscription.id)?.binding,
      null,
    );
    assert.deepEqual(await readFile(join(runtimeLinkedTarget, "subscription.yaml")), dottedContent);
    await unlink(dottedProviderDir);
    await rename(runtimeOriginalDir, dottedProviderDir);
  }
  dottedSubscriptions.close();

  const linkedProviderDir = join(root, "linked-providers");
  const linkedTargetDir = `${root}-linked-target`;
  t.after(() => rm(linkedTargetDir, { recursive: true, force: true }));
  await mkdir(linkedTargetDir);
  let linkAvailable = true;
  try {
    await symlink(linkedTargetDir, linkedProviderDir, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    linkAvailable = false;
  }
  if (linkAvailable) {
    const linkedProviderState = join(root, "linked-provider-state.json");
    const linkedProviderFiles = new ProviderFileService({
      ...service.options,
      providerDir: linkedProviderDir,
      statePath: linkedProviderState,
    });
    await assert.rejects(linkedProviderFiles.init(), ProviderFileNameError);
    const linkedSubscriptionState = join(root, "linked-subscription-state.json");
    const linkedSubscriptions = new SubscriptionService({
      statePath: linkedSubscriptionState,
      providerDir: linkedProviderDir,
      dataDir: root,
      requestTimeoutMs: 1000,
      maxResponseBytes: 4096,
      writeQueue: new WriteQueue(),
    });
    await assert.rejects(linkedSubscriptions.init(), SubscriptionValidationError);
    assert.deepEqual(await readdir(linkedTargetDir), []);
    for (const statePath of [linkedProviderState, linkedSubscriptionState]) {
      await assert.rejects(
        readFile(statePath),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
    }
  }

  let saveRacePath: string | null = null;
  const saveRaceFixture = await fixture({
    beforeFileRename: async () => {
      if (!saveRacePath) return;
      const path = saveRacePath;
      saveRacePath = null;
      await unlink(path);
      await writeFile(path, "proxies:\n  - { name: third-party, type: direct }\n", "utf8");
    },
  });
  t.after(() => rm(saveRaceFixture.root, { recursive: true, force: true }));
  const saveRaceCreated = await saveRaceFixture.service.create("proxy", "save-race.yaml");
  saveRacePath = join(saveRaceFixture.providerDir, "save-race.yaml");
  await assert.rejects(
    saveRaceFixture.service.save(
      "proxy",
      "save-race.yaml",
      "proxies:\n  - { name: manager, type: direct }\n",
      saveRaceCreated.sha256,
    ),
    ProviderFileConflictError,
  );
  assert.equal(
    await readFile(join(saveRaceFixture.providerDir, "save-race.yaml"), "utf8"),
    "proxies:\n  - { name: third-party, type: direct }\n",
  );
  assert.equal((await saveRaceFixture.service.read("save-race.yaml")).source, "manual");
  assert.equal(
    (await readdir(saveRaceFixture.providerDir)).some((name) => name.includes(".save-")),
    false,
  );

  let candidateAttack: "file" | "symlink" | null = null;
  let symlinkAttackExercised = false;
  let candidateRaceProviderDir = "";
  const candidateRaceFixture = await fixture({
    beforeFileRename: async () => {
      if (!candidateAttack) return;
      const attack = candidateAttack;
      candidateAttack = null;
      const candidateName = (await readdir(candidateRaceProviderDir)).find(
        (name) => name.startsWith(".candidate-race.yaml.save-"),
      );
      assert.ok(candidateName);
      const candidatePath = join(candidateRaceProviderDir, candidateName);
      await unlink(candidatePath);
      if (attack === "symlink") {
        try {
          await symlink(join(candidateRaceProviderDir, "candidate-race.yaml"), candidatePath, "file");
          symlinkAttackExercised = true;
          return;
        } catch (error) {
          if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
      await writeFile(candidatePath, "proxies:\n  - {}\n", "utf8");
    },
  });
  candidateRaceProviderDir = candidateRaceFixture.providerDir;
  t.after(() => rm(candidateRaceFixture.root, { recursive: true, force: true }));
  const candidateRaceCreated = await candidateRaceFixture.service.create("proxy", "candidate-race.yaml");
  const candidateRacePath = join(candidateRaceFixture.providerDir, "candidate-race.yaml");
  for (const attack of ["file", "symlink"] as const) {
    candidateAttack = attack;
    await assert.rejects(
      candidateRaceFixture.service.save(
        "proxy",
        "candidate-race.yaml",
        "proxies:\n  - { name: manager, type: direct }\n",
        candidateRaceCreated.sha256,
      ),
    );
    const afterCandidateAttack = await candidateRaceFixture.service.read("candidate-race.yaml");
    assert.equal(afterCandidateAttack.content, candidateRaceCreated.content);
    assert.equal(afterCandidateAttack.sha256, candidateRaceCreated.sha256);
    assert.equal(
      (await readdir(candidateRaceFixture.providerDir)).some((name) => name.includes(".save-")),
      false,
    );
  }
  if (process.platform !== "win32") assert.equal(symlinkAttackExercised, true);

  let replaceRenameSourceAt: "prepared" | "linked" | null = null;
  let failRenameCleanupPhase: string | null = null;
  let renameRaceSourcePath = "";
  const renameRaceFixture = await fixture({
    afterRenamePhase: async (phase) => {
      if (phase !== replaceRenameSourceAt) return;
      replaceRenameSourceAt = null;
      await unlink(renameRaceSourcePath);
      await writeFile(renameRaceSourcePath, "proxies:\n  - { name: replacement, type: direct }\n", "utf8");
    },
    beforeOperationCleanup: async (operation, phase) => {
      if (operation !== "rename" || phase !== failRenameCleanupPhase) return;
      failRenameCleanupPhase = null;
      throw new Error(`simulated rename ${phase} failure`);
    },
  });
  t.after(() => rm(renameRaceFixture.root, { recursive: true, force: true }));
  let renameRaceService = renameRaceFixture.service;
  const renameRaceCreated = await renameRaceService.create("proxy", "rename-race.yaml");
  renameRaceSourcePath = join(renameRaceFixture.providerDir, "rename-race.yaml");
  replaceRenameSourceAt = "prepared";
  failRenameCleanupPhase = "rollback-target";
  await assert.rejects(
    renameRaceService.rename(
      "proxy",
      "rename-race.yaml",
      "rename-race-next.yaml",
      renameRaceCreated.sha256,
    ),
    ProviderFileRecoveryError,
  );
  assert.equal(
    await readFile(renameRaceSourcePath, "utf8"),
    "proxies:\n  - { name: replacement, type: direct }\n",
  );
  assert.equal(
    await readFile(join(renameRaceFixture.providerDir, "rename-race-next.yaml"), "utf8"),
    "proxies:\n  - { name: replacement, type: direct }\n",
  );
  assert.equal(
    JSON.parse(await readFile(renameRaceFixture.service.options.statePath, "utf8")).operationJournal?.phase,
    "linked",
  );
  renameRaceService = new ProviderFileService({ ...renameRaceFixture.service.options });
  await renameRaceService.init();
  await assert.rejects(
    readFile(join(renameRaceFixture.providerDir, "rename-race-next.yaml")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  assert.equal((await renameRaceService.read("rename-race.yaml")).source, "manual");
  assert.equal(
    JSON.parse(await readFile(renameRaceFixture.service.options.statePath, "utf8")).operationJournal,
    null,
  );

  const clearRaceCreated = await renameRaceService.create("proxy", "rename-clear-race.yaml");
  renameRaceSourcePath = join(renameRaceFixture.providerDir, "rename-clear-race.yaml");
  replaceRenameSourceAt = "prepared";
  failRenameCleanupPhase = "clear-journal";
  await assert.rejects(
    renameRaceService.rename(
      "proxy",
      "rename-clear-race.yaml",
      "rename-clear-race-next.yaml",
      clearRaceCreated.sha256,
    ),
    ProviderFileRecoveryError,
  );
  await assert.rejects(
    readFile(join(renameRaceFixture.providerDir, "rename-clear-race-next.yaml")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  assert.equal(
    JSON.parse(await readFile(renameRaceFixture.service.options.statePath, "utf8")).operationJournal?.phase,
    "linked",
  );
  renameRaceService = new ProviderFileService({ ...renameRaceFixture.service.options });
  await renameRaceService.init();
  assert.equal((await renameRaceService.read("rename-clear-race.yaml")).source, "manual");
  assert.equal(
    JSON.parse(await readFile(renameRaceFixture.service.options.statePath, "utf8")).operationJournal,
    null,
  );

  const separatedRaceCreated = await renameRaceService.create("proxy", "rename-separated.yaml");
  renameRaceSourcePath = join(renameRaceFixture.providerDir, "rename-separated.yaml");
  replaceRenameSourceAt = "linked";
  await assert.rejects(
    renameRaceService.rename(
      "proxy",
      "rename-separated.yaml",
      "rename-separated-next.yaml",
      separatedRaceCreated.sha256,
    ),
    ProviderFileRecoveryError,
  );
  assert.equal(
    await readFile(renameRaceSourcePath, "utf8"),
    "proxies:\n  - { name: replacement, type: direct }\n",
  );
  assert.equal(await readFile(join(renameRaceFixture.providerDir, "rename-separated-next.yaml"), "utf8"), "proxies:\n");
  const separatedReload = new ProviderFileService({ ...renameRaceFixture.service.options });
  await assert.rejects(separatedReload.init(), ProviderFileRecoveryError);
  assert.equal(
    JSON.parse(await readFile(renameRaceFixture.service.options.statePath, "utf8")).operationJournal?.phase,
    "linked",
  );
});

test("proxy and rule files stay in separate controlled directories and unloaded HTTP declarations remain catalogued", async (t) => {
  let failedConfigSave: string | null = null;
  const { root, providerDir, ruleProviderDir, service, configs } = await fixture({
    beforeConfigSave: async (name) => {
      if (name === failedConfigSave) throw new Error("fixture config save failed");
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const proxy = await service.create("proxy", "shared.yaml", "proxies: []\n");
  const rule = await service.create("rule", "shared.yaml", "payload: []\n");
  assert.equal(proxy.referencePath, "./providers/shared.yaml");
  assert.equal(rule.referencePath, "./ruleset/shared.yaml");
  assert.equal(await readFile(join(providerDir, "shared.yaml"), "utf8"), "proxies: []\n");
  assert.equal(await readFile(join(ruleProviderDir, "shared.yaml"), "utf8"), "payload: []\n");
  assert.deepEqual((await service.list()).map(({ category, fileName }) => [category, fileName]), [
    ["proxy", "shared.yaml"],
    ["rule", "shared.yaml"],
  ]);

  const initial = [
    "rule-providers:",
    "  remote-rules:",
    "    type: http",
    "    behavior: classical",
    "    format: yaml",
    "    url: https://fixture.invalid/rules",
    "    path: ./ruleset/remote-rules.yaml",
    "    interval: 3600",
    "    header: { X-Fixture: retained }",
    "rules: []",
    "",
  ].join("\n");
  configs.set("http-rule.yaml", initial);
  const saved = await service.saveConfigWithManualHttp({
    configName: "http-rule.yaml",
    content: initial,
    expectedSha256: sha256(initial),
    providers: [{ category: "rule", name: "remote-rules" }],
  });
  assert.equal(service.manualHttpProviders("http-rule.yaml")[0]?.declaration?.interval, 3600);
  const edited = initial
    .replace("interval: 3600", "interval: 21600")
    .replace("header: { X-Fixture: retained }", "header: { X-Fixture: edited }\n    proxy: DIRECT\n    size-limit: 4096")
  // Simulate a normal config save that reached disk while the catalog still contains D0.
  configs.set("http-rule.yaml", edited)
  const unloaded = "rules: []\n";
  await service.saveConfigWithManualHttp({
    configName: "http-rule.yaml",
    content: unloaded,
    expectedSha256: sha256(edited),
    providers: [{ category: "rule", name: "remote-rules" }],
  });
  const restarted = new ProviderFileService({ ...service.options });
  await restarted.init();
  const catalog = restarted.manualHttpProviders("http-rule.yaml");
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.category, "rule");
  assert.equal(catalog[0]?.declaration?.path, "./ruleset/remote-rules.yaml");
  assert.equal(catalog[0]?.declaration?.interval, 21600);
  assert.deepEqual(catalog[0]?.declaration?.header, { "X-Fixture": "edited" });
  assert.equal(catalog[0]?.declaration?.proxy, "DIRECT");
  assert.equal(catalog[0]?.declaration?.["size-limit"], 4096);

  const restoredDeclaration = catalog[0]!.declaration!;
  const reloaded = [
    "rule-providers:",
    "  remote-rules:",
    ...stringify(restoredDeclaration).trimEnd().split("\n").map((line) => `    ${line}`),
    "rules: []",
    "",
  ].join("\n");
  await restarted.saveConfigWithManualHttp({
    configName: "http-rule.yaml",
    content: reloaded,
    expectedSha256: sha256(unloaded),
    providers: [{ category: "rule", name: "remote-rules" }],
  });
  assert.deepEqual(restarted.manualHttpProviders("http-rule.yaml")[0]?.declaration, restoredDeclaration);
  assert.deepEqual((parse(configs.get("http-rule.yaml")!) as Record<string, any>)["rule-providers"]["remote-rules"], restoredDeclaration);

  const transientName = "transient-http.yaml";
  configs.set(transientName, edited);
  await restarted.saveConfigWithManualHttp({
    configName: transientName,
    content: unloaded,
    expectedSha256: sha256(edited),
    providers: [],
  });
  const transientCatalog = restarted.manualHttpProviders(transientName);
  assert.deepEqual(transientCatalog, []);

  const compatibleHttp = [
    "proxy-providers:",
    "  compatible:",
    "    url: https://fixture.invalid/compatible",
    "    path: ./providers/compatible.yaml",
    "    header: { X-Fixture: compatible }",
    "  explicit-inline:",
    "    type: inline",
    "    url: https://fixture.invalid/ignored",
    "    path: ./providers/ignored.yaml",
    "    proxies: []",
    "",
  ].join("\n");
  configs.set("compatible-http.yaml", compatibleHttp);
  await restarted.saveConfigWithManualHttp({
    configName: "compatible-http.yaml",
    content: compatibleHttp,
    expectedSha256: sha256(compatibleHttp),
    providers: [{ category: "proxy", name: "compatible" }],
  });
  await assert.rejects(restarted.saveConfigWithManualHttp({
    configName: "compatible-http.yaml",
    content: compatibleHttp,
    expectedSha256: sha256(compatibleHttp),
    providers: [{ category: "proxy", name: "explicit-inline" }],
  }), ProviderFileValidationError);
  await restarted.saveConfigWithManualHttp({
    configName: "compatible-http.yaml",
    content: "proxy-providers: {}\n",
    expectedSha256: sha256(compatibleHttp),
    providers: [{ category: "proxy", name: "compatible" }],
  });
  const compatibleCatalog = restarted.manualHttpProviders("compatible-http.yaml");
  assert.deepEqual(compatibleCatalog.map((entry) => entry.name), ["compatible"]);
  assert.deepEqual(compatibleCatalog[0]?.declaration?.header, { "X-Fixture": "compatible" });

  const failedName = "failed-transient-http.yaml";
  configs.set(failedName, edited);
  failedConfigSave = failedName;
  await assert.rejects(restarted.saveConfigWithManualHttp({
    configName: failedName,
    content: unloaded,
    expectedSha256: sha256(edited),
    providers: [],
  }), /fixture config save failed/);
  failedConfigSave = null;
  assert.equal(configs.get(failedName), edited);
  assert.deepEqual(restarted.manualHttpProviders(failedName), []);
  assert.equal(JSON.parse(await readFile(restarted.options.statePath, "utf8")).httpConfigIntent, null);

  const failedRestart = new ProviderFileService({ ...restarted.options });
  await failedRestart.init();
  assert.deepEqual(failedRestart.manualHttpProviders(failedName), []);
});

test("owned local and subscription Provider sources delete transactionally without deleting their sources", async (t) => {
  const source = "proxies:\n  - { name: local-node, type: direct }\n";
  const active = [
    "proxy-providers:",
    "  local-output:",
    "    type: file",
    "    path: ./providers/local-output.yaml",
    "proxy-groups:",
    "  - name: PROXY",
    "    type: select",
    "    use: [local-output]",
    "",
  ].join("\n");
  const candidate = "proxy-groups:\n  - name: PROXY\n    type: select\n";
  const localFixture = await fixture({ configs: { "source.yaml": source, "active.yaml": active } });
  t.after(() => rm(localFixture.root, { recursive: true, force: true }));
  await localFixture.service.createLocalExtraction({
    configName: "source.yaml", sourceSha256: sha256(source), fileName: "local-output.yaml",
  });
  const local = localFixture.service.localExtractions()[0]!;
  const localRecord = (await localFixture.service.list()).find((item) => item.fileName === local.fileName)!;
  assert.deepEqual({ source: localRecord.source, ownerId: localRecord.ownerId }, { source: "local", ownerId: local.id });
  const localResult = await localFixture.service.deleteOwnedSourceWithConfig({
    source: "local", ownerId: local.id, fileName: local.fileName, expectedSha256: local.providerSha256!,
    configName: "active.yaml", configContent: candidate, expectedConfigSha256: sha256(active),
  });
  assert.equal(localResult.config.content, candidate);
  assert.equal(localFixture.service.localExtractions().length, 0);
  assert.equal(localFixture.configs.get("source.yaml"), source);
  await assert.rejects(readFile(join(localFixture.providerDir, local.fileName)), { code: "ENOENT" });

  const crossFixture = await fixture({ configs: { "source.yaml": source, "active.yaml": active, "other.yaml": active } });
  t.after(() => rm(crossFixture.root, { recursive: true, force: true }));
  await crossFixture.service.createLocalExtraction({
    configName: "source.yaml", sourceSha256: sha256(source), fileName: "local-output.yaml",
  });
  const crossLocal = crossFixture.service.localExtractions()[0]!;
  await assert.rejects(crossFixture.service.deleteOwnedSourceWithConfig({
    source: "local", ownerId: crossLocal.id, fileName: crossLocal.fileName, expectedSha256: crossLocal.providerSha256!,
    configName: "active.yaml", configContent: candidate, expectedConfigSha256: sha256(active),
  }), (error: unknown) => error instanceof ProviderFileReferencedError && error.configNames.includes("other.yaml"));
  assert.equal(crossFixture.service.localExtractions().length, 1);
  assert.equal(await readFile(join(crossFixture.providerDir, crossLocal.fileName), "utf8") !== "", true);

  let failConfigSave = false;
  const rollbackFixture = await fixture({
    configs: { "source.yaml": source, "active.yaml": active },
    beforeConfigSave: async () => { if (failConfigSave) throw new Error("injected config failure"); },
  });
  t.after(() => rm(rollbackFixture.root, { recursive: true, force: true }));
  await rollbackFixture.service.createLocalExtraction({
    configName: "source.yaml", sourceSha256: sha256(source), fileName: "local-output.yaml",
  });
  const rollbackLocal = rollbackFixture.service.localExtractions()[0]!;
  failConfigSave = true;
  await assert.rejects(rollbackFixture.service.deleteOwnedSourceWithConfig({
    source: "local", ownerId: rollbackLocal.id, fileName: rollbackLocal.fileName, expectedSha256: rollbackLocal.providerSha256!,
    configName: "active.yaml", configContent: candidate, expectedConfigSha256: sha256(active),
  }), /injected config failure/);
  assert.equal(rollbackFixture.configs.get("active.yaml"), active);
  assert.equal(rollbackFixture.service.localExtractions().length, 1);
  assert.equal(await readFile(join(rollbackFixture.providerDir, rollbackLocal.fileName), "utf8") !== "", true);

  const fileFailureFixture = await fixture({
    configs: { "source.yaml": source, "active.yaml": active },
    beforeOwnedSourceFileDelete: async () => { throw new Error("injected file failure"); },
  });
  t.after(() => rm(fileFailureFixture.root, { recursive: true, force: true }));
  await fileFailureFixture.service.createLocalExtraction({
    configName: "source.yaml", sourceSha256: sha256(source), fileName: "local-output.yaml",
  });
  const fileFailureLocal = fileFailureFixture.service.localExtractions()[0]!;
  await assert.rejects(fileFailureFixture.service.deleteOwnedSourceWithConfig({
    source: "local", ownerId: fileFailureLocal.id, fileName: fileFailureLocal.fileName,
    expectedSha256: fileFailureLocal.providerSha256!, configName: "active.yaml", configContent: candidate,
    expectedConfigSha256: sha256(active),
  }), /injected file failure/);
  assert.equal(fileFailureFixture.configs.get("active.yaml"), active);
  assert.equal(fileFailureFixture.service.localExtractions().length, 1);
  assert.equal(await readFile(join(fileFailureFixture.providerDir, fileFailureLocal.fileName), "utf8") !== "", true);

  let failOwnerState = false;
  const stateFailureFixture = await fixture({
    configs: { "source.yaml": source, "active.yaml": active },
    beforeStateRename: async () => { if (failOwnerState) throw new Error("injected owner state failure"); },
  });
  t.after(() => rm(stateFailureFixture.root, { recursive: true, force: true }));
  await stateFailureFixture.service.createLocalExtraction({
    configName: "source.yaml", sourceSha256: sha256(source), fileName: "local-output.yaml",
  });
  const stateFailureLocal = stateFailureFixture.service.localExtractions()[0]!;
  failOwnerState = true;
  await assert.rejects(stateFailureFixture.service.deleteOwnedSourceWithConfig({
    source: "local", ownerId: stateFailureLocal.id, fileName: stateFailureLocal.fileName,
    expectedSha256: stateFailureLocal.providerSha256!, configName: "active.yaml", configContent: candidate,
    expectedConfigSha256: sha256(active),
  }), /injected owner state failure/);
  assert.equal(stateFailureFixture.configs.get("active.yaml"), active);
  assert.equal(stateFailureFixture.service.localExtractions().length, 1);
  assert.equal(await readFile(join(stateFailureFixture.providerDir, stateFailureLocal.fileName), "utf8") !== "", true);

  const subscriptionContent = "proxies:\n  - { name: subscription-node, type: direct }\n";
  const subscription = {
    id: "subscription-owner", name: "Subscription", url: "https://fixture.invalid/subscription",
    configFileName: null, providerName: "subscription-output", providerNameMode: "custom" as const,
    extractProvider: true, providerSha256: sha256(subscriptionContent), mergeIntoConfig: true,
    configName: "active.yaml", groupNames: ["PROXY"], binding: {
      configName: "active.yaml", providerName: "subscription-output", providerPath: "./providers/subscription-output.yaml",
      groupNames: ["PROXY"], status: "active" as const,
    }, autoUpdate: false, intervalMinutes: 60, status: "success" as const, nodeCount: 1,
    lastAttemptAt: null, lastUpdatedAt: null, nextUpdateAt: null, uploadBytes: null, downloadBytes: null,
    totalBytes: null, expiresAt: null, filterSettings: { version: 0, enabled: false, rules: [] },
  } as unknown as PublicSubscription;
  const subscriptionFixture = await fixture({ configs: { "active.yaml": "proxies: []\n" }, subscriptions: [subscription] });
  t.after(() => rm(subscriptionFixture.root, { recursive: true, force: true }));
  await writeFile(join(subscriptionFixture.providerDir, "subscription-output.yaml"), subscriptionContent, "utf8");
  const subscriptionStatePath = join(subscriptionFixture.root, "subscriptions-success.json");
  await writeFile(subscriptionStatePath, JSON.stringify({ version: 1, subscriptions: [subscription] }), "utf8");
  const actualSubscriptions = new SubscriptionService({
    statePath: subscriptionStatePath, providerDir: subscriptionFixture.providerDir,
    dataDir: subscriptionFixture.root, requestTimeoutMs: 1_000, maxResponseBytes: 4_096,
    writeQueue: subscriptionFixture.writeQueue,
  });
  await actualSubscriptions.init();
  const subscriptionRecord = (await subscriptionFixture.service.list()).find((item) => item.source === "subscription")!;
  assert.equal(subscriptionRecord.ownerId, subscription.id);
  await assert.rejects(subscriptionFixture.service.deleteOwnedSourceWithConfig({
    source: "subscription", ownerId: "wrong-owner", fileName: subscriptionRecord.fileName,
    expectedSha256: subscriptionRecord.sha256, configName: "active.yaml", configContent: "proxies: []\n",
    expectedConfigSha256: sha256("proxies: []\n"),
  }), ProviderFileReadOnlyError);
  await subscriptionFixture.service.deleteOwnedSourceWithConfig({
    source: "subscription", ownerId: subscription.id, fileName: subscriptionRecord.fileName,
    expectedSha256: subscriptionRecord.sha256, configName: "active.yaml", configContent: "proxies: []\n",
    expectedConfigSha256: sha256("proxies: []\n"),
  }, () => actualSubscriptions.disableProviderExtractionUnqueued(subscription.id, subscriptionRecord.sha256));
  const retainedSubscription = actualSubscriptions.list()[0]!;
  assert.equal(actualSubscriptions.list().length, 1);
  assert.equal(retainedSubscription.extractProvider, false);
  assert.equal(retainedSubscription.providerSha256, null);
  assert.equal(retainedSubscription.mergeIntoConfig, false);
  assert.equal(retainedSubscription.binding, null);
  await assert.rejects(readFile(join(subscriptionFixture.providerDir, subscriptionRecord.fileName)), { code: "ENOENT" });

  const rollbackSubscription = { ...subscription, id: "subscription-rollback", binding: { ...subscription.binding! } };
  const subscriptionRollbackFixture = await fixture({
    configs: { "active.yaml": "proxies: []\n" }, subscriptions: [rollbackSubscription],
    beforeOwnedSourceFileDelete: async () => { throw new Error("injected subscription file failure"); },
  });
  t.after(() => rm(subscriptionRollbackFixture.root, { recursive: true, force: true }));
  await writeFile(join(subscriptionRollbackFixture.providerDir, "subscription-output.yaml"), subscriptionContent, "utf8");
  const rollbackStatePath = join(subscriptionRollbackFixture.root, "subscriptions-rollback.json");
  await writeFile(rollbackStatePath, JSON.stringify({ version: 1, subscriptions: [rollbackSubscription] }), "utf8");
  const rollbackSubscriptions = new SubscriptionService({
    statePath: rollbackStatePath, providerDir: subscriptionRollbackFixture.providerDir,
    dataDir: subscriptionRollbackFixture.root, requestTimeoutMs: 1_000, maxResponseBytes: 4_096,
    writeQueue: subscriptionRollbackFixture.writeQueue,
  });
  await rollbackSubscriptions.init();
  const rollbackRecord = (await subscriptionRollbackFixture.service.list()).find((item) => item.source === "subscription")!;
  await assert.rejects(subscriptionRollbackFixture.service.deleteOwnedSourceWithConfig({
    source: "subscription", ownerId: rollbackSubscription.id, fileName: rollbackRecord.fileName,
    expectedSha256: rollbackRecord.sha256, configName: "active.yaml", configContent: "proxies: []\n",
    expectedConfigSha256: sha256("proxies: []\n"),
  }, () => rollbackSubscriptions.disableProviderExtractionUnqueued(rollbackSubscription.id, rollbackRecord.sha256)),
  /injected subscription file failure/);
  const restoredSubscription = rollbackSubscriptions.list()[0]!;
  assert.equal(rollbackSubscriptions.list().length, 1);
  assert.equal(restoredSubscription.extractProvider, true);
  assert.equal(restoredSubscription.providerSha256, rollbackRecord.sha256);
  assert.equal(restoredSubscription.mergeIntoConfig, true);
  assert.deepEqual(restoredSubscription.binding, rollbackSubscription.binding);
  assert.equal(subscriptionRollbackFixture.configs.get("active.yaml"), "proxies: []\n");
  assert.equal(await readFile(join(subscriptionRollbackFixture.providerDir, rollbackRecord.fileName), "utf8"), subscriptionContent);

});

test("local extraction resolves inline, file, and HTTP cache sources without consuming generated outputs", async (t) => {
  const mixed = [
    "proxies:",
    "  - { name: root, type: direct }",
    "proxy-providers:",
    "  inline:",
    "    type: inline",
    "    payload:",
    "      - { name: inline, type: direct }",
    "  file:",
    "    type: file",
    "    path: ./providers/file-cache.yaml",
    "  remote:",
    "    type: http",
    "    url: https://fixture.invalid/provider",
    "    path: ./providers/http-cache.yaml",
    "",
  ].join("\n");
  const { root, providerDir, service, configs } = await fixture({ configs: { "mixed.yaml": mixed } });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(providerDir, "file-cache.yaml"), "proxies:\n  - { name: file, type: direct }\n", "utf8");
  await writeFile(join(providerDir, "http-cache.yaml"), "proxies:\n  - { name: http, type: direct }\n", "utf8");
  const merged = await service.createLocalExtraction({
    configName: "mixed.yaml", sourceSha256: sha256(mixed), fileName: "mixed-output.yaml",
  });
  assert.equal(merged.nodeCount, 4);

  const before = await readFile(join(providerDir, "mixed-output.yaml"));
  const selfReferencing = "proxy-providers:\n  output:\n    type: file\n    path: ./providers/../providers/mixed-output.yaml\n";
  configs.set("mixed.yaml", selfReferencing);
  await assert.rejects(
    service.regenerateLocalExtractionsForConfig("mixed.yaml", sha256(selfReferencing)),
    ProviderFileValidationError,
  );
  assert.deepEqual(await readFile(join(providerDir, "mixed-output.yaml")), before);

  const stateBeforeAliases = await readFile(service.options.statePath);
  const rootAlias = join(providerDir, "root-alias");
  await symlink(providerDir, rootAlias, process.platform === "win32" ? "junction" : "dir");
  const canonicalAlias = "proxy-providers:\n  output:\n    type: file\n    path: ./providers/root-alias/mixed-output.yaml\n";
  configs.set("mixed.yaml", canonicalAlias);
  await assert.rejects(
    service.regenerateLocalExtractionsForConfig("mixed.yaml", sha256(canonicalAlias)),
    ProviderFileValidationError,
  );
  assert.deepEqual(await readFile(join(providerDir, "mixed-output.yaml")), before);
  assert.deepEqual(await readFile(service.options.statePath), stateBeforeAliases);

  const outsideDir = join(root, "outside-providers");
  await mkdir(outsideDir);
  await writeFile(join(outsideDir, "external.yaml"), "proxies:\n  - { name: external, type: direct }\n", "utf8");
  await symlink(outsideDir, join(providerDir, "outside-alias"), process.platform === "win32" ? "junction" : "dir");
  const outsideAlias = "proxy-providers:\n  external:\n    type: file\n    path: ./providers/outside-alias/external.yaml\n";
  configs.set("mixed.yaml", outsideAlias);
  await assert.rejects(
    service.regenerateLocalExtractionsForConfig("mixed.yaml", sha256(outsideAlias)),
    ProviderFileValidationError,
  );
  assert.deepEqual(await readFile(join(providerDir, "mixed-output.yaml")), before);
  assert.deepEqual(await readFile(service.options.statePath), stateBeforeAliases);

  await link(join(providerDir, "mixed-output.yaml"), join(providerDir, "output-hardlink.yaml"));
  const hardlinkAlias = "proxy-providers:\n  output:\n    type: http\n    url: https://fixture.invalid/provider\n    path: ./providers/output-hardlink.yaml\n";
  configs.set("mixed.yaml", hardlinkAlias);
  await assert.rejects(
    service.regenerateLocalExtractionsForConfig("mixed.yaml", sha256(hardlinkAlias)),
    ProviderFileValidationError,
  );
  assert.deepEqual(await readFile(join(providerDir, "mixed-output.yaml")), before);
  assert.deepEqual(await readFile(service.options.statePath), stateBeforeAliases);

  await writeFile(join(providerDir, "cycle-a.yaml"), "proxy-providers:\n  b:\n    type: file\n    path: ./providers/cycle-b.yaml\n", "utf8");
  await writeFile(join(providerDir, "cycle-b.yaml"), "proxy-providers:\n  a:\n    type: file\n    path: ./providers/./cycle-a.yaml\n", "utf8");
  const cyclic = "proxy-providers:\n  a:\n    type: file\n    path: ./providers/cycle-a.yaml\n";
  configs.set("cycle.yaml", cyclic);
  await assert.rejects(service.createLocalExtraction({
    configName: "cycle.yaml", sourceSha256: sha256(cyclic), fileName: "cycle-output.yaml",
  }), ProviderFileValidationError);
  await assert.rejects(readFile(join(providerDir, "cycle-output.yaml")), { code: "ENOENT" });

  const escaped = "proxy-providers:\n  bad:\n    type: file\n    path: ./outside.yaml\n";
  configs.set("escaped.yaml", escaped);
  await assert.rejects(service.createLocalExtraction({
    configName: "escaped.yaml", sourceSha256: sha256(escaped), fileName: "escaped-output.yaml",
  }), ProviderFileValidationError);
});

test("managed Provider validation preserves content and protects subscription publish ownership", async (t) => {
  let failPublish = false;
  let failLocalSourceCleanup = false;
  const externalContent = "proxies:\n  - { name: external, type: direct }\n";
  const subscriptions = [{
    id: "external-subscription",
    name: "External subscription",
    providerName: "external",
    extractProvider: true,
    providerSha256: sha256(externalContent),
  }, {
    id: "new-subscription",
    name: "New subscription",
    providerName: "new-subscription",
    extractProvider: true,
    providerSha256: null,
  }] as unknown as PublicSubscription[];
  const localSource = "proxies:\n  - { name: keep, type: direct }\n  - { name: Notice Expired, type: direct }\n";
  const { root, providerDir, ruleProviderDir, service, configs } = await fixture({
    configs: { "local.yaml": localSource },
    subscriptions,
    beforeFileRename: async () => { if (failPublish) throw new Error("injected publish failure"); },
    beforeOperationCleanup: async (operation, phase) => {
      if (failLocalSourceCleanup && operation === "publish" && phase === "cleanup-local-source") {
        throw new Error("injected local source cleanup failure");
      }
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const created = await service.create("rule", "manual-rule.yaml");
  const unfinished = await service.save("rule", "manual-rule.yaml", "proxies: []\n", created.sha256);
  assert.equal(unfinished.content, "proxies: []\n");
  assert.throws(() => service.validate("rule", unfinished.content), ProviderFileValidationError);
  assert.throws(
    () => service.validate("proxy", "proxies: [invalid]\n"),
    ProviderFileValidationError,
  );
  assert.throws(
    () => service.validate("rule", "payload: [1]\n"),
    ProviderFileValidationError,
  );
  assert.equal(await readFile(join(ruleProviderDir, "manual-rule.yaml"), "utf8"), "proxies: []\n");
  const oversizedPath = join(providerDir, "oversized.yaml");
  await writeFile(oversizedPath, `payload:\n  - ${"x".repeat(4096)}\n`, "utf8");
  await assert.rejects(service.read("oversized.yaml"), ProviderFileValidationError);
  await assert.rejects(service.list(), ProviderFileValidationError);
  await unlink(oversizedPath);
  assert.equal((await service.list()).some((item) => item.fileName === "manual-rule.yaml"), true);
  failPublish = true;
  await assert.rejects(
    service.save("rule", "manual-rule.yaml", "payload:\n  - DOMAIN,example.invalid\n", unfinished.sha256),
    /injected publish failure/,
  );
  assert.equal(await readFile(join(ruleProviderDir, "manual-rule.yaml"), "utf8"), "proxies: []\n");
  failPublish = false;

  subscriptions.push({
    ...subscriptions[0]!,
    id: "manual-conflict",
    providerName: "manual-rule",
    providerSha256: created.sha256,
  });
  await assert.rejects(
    service.assertSubscriptionPublish({
      subscriptionId: "manual-conflict",
      fileName: "manual-rule.yaml",
      expectedSha256: created.sha256,
    }),
    ProviderFileReadOnlyError,
  );
  await writeFile(join(providerDir, "external.yaml"), externalContent, "utf8");
  await service.assertSubscriptionPublish({
    subscriptionId: "external-subscription",
    fileName: "external.yaml",
    expectedSha256: sha256(externalContent),
  });
  await assert.rejects(
    service.assertSubscriptionPublish({
      subscriptionId: "external-subscription",
      fileName: "external.yaml",
      expectedSha256: "0".repeat(64),
    }),
    ProviderFileConflictError,
  );
  await service.assertSubscriptionPublish({
    subscriptionId: "new-subscription",
    fileName: "new-subscription.yaml",
    expectedSha256: null,
  });

  const localPublished = await service.createLocalExtraction({
    configName: "local.yaml",
    sourceSha256: sha256(localSource),
    fileName: "local-extracted.yaml",
  });
  assert.equal(localPublished.nodeCount, 2);
  const localStateBeforeDuplicate = await readFile(service.options.statePath, "utf8");
  await assert.rejects(service.createLocalExtraction({
    configName: "local.yaml",
    sourceSha256: sha256(localSource),
    fileName: "local-duplicate.yaml",
  }), ProviderFileConflictError);
  assert.equal(await readFile(service.options.statePath, "utf8"), localStateBeforeDuplicate);
  await assert.rejects(readFile(join(providerDir, "local-duplicate.yaml"), "utf8"), { code: "ENOENT" });
  configs.set("dormant.yaml", localSource);
  const dormantCreated = await service.createLocalExtraction({
    configName: "dormant.yaml",
    sourceSha256: sha256(localSource),
    fileName: "local-dormant.yaml",
    enabled: false,
    filterSettings: { enabled: true, rules: ["notice"] },
  });
  assert.equal(dormantCreated.nodeCount, 0);
  const dormantRelation = service.localExtractions().find((entry) => entry.fileName === "local-dormant.yaml")!;
  assert.equal(dormantRelation.enabled, false);
  assert.deepEqual(dormantRelation.filterSettings, { version: 0, enabled: false, rules: [] });
  assert.equal(dormantRelation.providerSha256, null);
  await assert.rejects(readFile(join(providerDir, "local-dormant.yaml"), "utf8"), { code: "ENOENT" });
  const relation = service.localExtractions()[0]!;
  assert.equal((await service.read("local-extracted.yaml")).source, "local");
  assert.equal((await service.read("local-extracted.yaml")).writable, false);
  assert.equal((await service.read("local-extracted.yaml")).extractionId, relation.id);
  assert.deepEqual(await service.previewLocalExtraction(relation.id, ["notice & expired"]), {
    totalCount: 2,
    remainingCount: 1,
    matchedNames: ["Notice Expired"],
  });
  await service.saveLocalExtractionSettings(relation.id, {
    expectedVersion: 0,
    enabled: true,
    rules: ["notice & expired"],
  });
  assert.match(await readFile(join(providerDir, "local-extracted.yaml"), "utf8"), /name: keep/);
  assert.match(await readFile(join(providerDir, "local-extracted.yaml"), "utf8"), /Notice Expired/);
  assert.equal(service.localExtractions()[0]?.nodeCount, 2);

  await service.saveLocalExtractionSettings(relation.id, {
    expectedVersion: 1,
    enabled: false,
    rules: [],
  });
  assert.equal(service.localExtractions()[0]?.filterSettings.version, 2);
  assert.equal(service.localExtractions()[0]?.filterSettings.enabled, false);
  assert.match(await readFile(join(providerDir, "local-extracted.yaml"), "utf8"), /Notice Expired/);
  await service.saveLocalExtractionSettings(relation.id, {
    expectedVersion: 2,
    enabled: true,
    rules: ["notice & expired"],
  });

  const changedSource = "proxies:\n  - { name: new-node, type: direct }\n  - { name: Notice Expired, type: direct }\n";
  configs.set("local.yaml", changedSource);
  assert.deepEqual(await service.regenerateLocalExtractionsForConfig("local.yaml", sha256(changedSource)), [{
    category: "proxy",
    name: "local-extracted",
    nodeCount: 2,
  }]);
  const restarted = new ProviderFileService({ ...service.options });
  await restarted.init();
  assert.equal(restarted.localExtractions()[0]?.sourceSha256, sha256(changedSource));
  assert.equal((await restarted.read("local-extracted.yaml")).source, "local");
  const localBeforeRename = await readFile(join(providerDir, "local-extracted.yaml"), "utf8");
  const consumerConfig = [
    "proxy-providers:",
    "  Local:",
    "    type: file",
    "    path: ./providers/local-extracted.yaml",
    "",
  ].join("\n");
  configs.set("consumer.yaml", consumerConfig);
  await assert.rejects(
    restarted.renameLocalExtraction(relation.id, "local-renamed.yaml"),
    (error: ProviderFileReferencedError) => error.configNames.join(",") === "consumer.yaml",
  );
  assert.equal(await readFile(join(providerDir, "local-extracted.yaml"), "utf8"), localBeforeRename);
  await assert.rejects(
    readFile(join(providerDir, "local-renamed.yaml"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  assert.equal(restarted.localExtractions()[0]?.fileName, "local-extracted.yaml");
  assert.equal(configs.get("consumer.yaml"), consumerConfig);
  assert.equal(
    JSON.parse(await readFile(restarted.options.statePath, "utf8")).operationJournal,
    null,
  );
  configs.delete("consumer.yaml");
  const renamedLocal = await restarted.renameLocalExtraction(relation.id, "local-renamed.yaml");
  assert.equal(renamedLocal.fileName, "local-renamed.yaml");
  assert.equal((await restarted.read("local-renamed.yaml")).source, "local");
  const disabledLocal = await restarted.setLocalExtractionEnabled(relation.id, false);
  assert.equal(disabledLocal.enabled, false);
  configs.set("local.yaml", "proxies:\n  - { name: disabled-source-change, type: direct }\n  - { name: new-node, type: direct }\n");
  assert.deepEqual(await restarted.regenerateLocalExtractionsForConfig("local.yaml", sha256(configs.get("local.yaml")!)), []);
  await restarted.saveLocalExtractionSettings(relation.id, {
    expectedVersion: disabledLocal.filterSettings.version,
    enabled: false,
    rules: [],
  });
  const dormantContent = await readFile(join(providerDir, "local-renamed.yaml"), "utf8");
  assert.doesNotMatch(dormantContent, /disabled-source-change/);
  const enabledLocal = await restarted.setLocalExtractionEnabled(relation.id, true);
  assert.equal(enabledLocal.enabled, true);
  assert.match(await readFile(join(providerDir, "local-renamed.yaml"), "utf8"), /disabled-source-change/);
  assert.match(await readFile(join(providerDir, "local-renamed.yaml"), "utf8"), /new-node/);
  const renamedRestart = new ProviderFileService({ ...service.options });
  await renamedRestart.init();
  assert.equal(renamedRestart.localExtractions()[0]?.fileName, "local-renamed.yaml");
  assert.equal(renamedRestart.localExtractions()[0]?.enabled, true);
  const combinedBefore = renamedRestart.localExtractions()[0]!;
  const combinedRequest = {
    id: combinedBefore.id,
    currentFileName: combinedBefore.fileName,
    fileName: "local-combined.yaml",
    providerSha256: combinedBefore.providerSha256,
    currentEnabled: combinedBefore.enabled,
    enabled: true,
    filterSettings: { ...combinedBefore.filterSettings, enabled: true, rules: ["new-node"] },
  };
  const combinedSource = configs.get("local.yaml")!;
  configs.set("local.yaml", "proxies:\n  - { name: superseded, type: direct }\n");
  await assert.rejects(renamedRestart.updateLocalExtraction(combinedRequest), ProviderFileConflictError);
  configs.set("local.yaml", combinedSource);
  assert.deepEqual(renamedRestart.localExtractions()[0], combinedBefore);
  const combinedRollbackState = JSON.parse(await readFile(renamedRestart.options.statePath, "utf8"));
  assert.deepEqual(combinedRollbackState.local[0], combinedBefore);
  assert.equal(combinedRollbackState.operationJournal, null);
  assert.equal((await renamedRestart.read(combinedBefore.fileName)).sha256, combinedBefore.providerSha256);
  await assert.rejects(readFile(join(providerDir, "local-combined.yaml"), "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  failLocalSourceCleanup = true;
  await assert.rejects(
    renamedRestart.updateLocalExtraction(combinedRequest),
    (error: Error) => error.message.includes("recovery is incomplete") &&
      error.cause instanceof Error && error.cause.message.includes("injected local source cleanup failure"),
  );
  failLocalSourceCleanup = false;
  const combinedCommitted = renamedRestart.localExtractions()[0]!;
  assert.equal(combinedCommitted.enabled, true);
  assert.equal(combinedCommitted.fileName, "local-combined.yaml");
  assert.equal(combinedCommitted.filterSettings.version, combinedBefore.filterSettings.version + 1);
  assert.deepEqual(combinedCommitted.filterSettings.rules, ["new-node"]);
  assert.equal(combinedCommitted.nodeCount, 2);
  assert.equal(combinedCommitted.sourceSha256, sha256(configs.get("local.yaml")!));
  const combinedCleanupState = JSON.parse(await readFile(renamedRestart.options.statePath, "utf8"));
  assert.deepEqual(combinedCleanupState.local[0], combinedCommitted);
  assert.equal(combinedCleanupState.operationJournal?.operation, "publish");
  assert.equal(combinedCleanupState.operationJournal?.phase, "cleanup-only");
  assert.equal(combinedCleanupState.operationJournal?.localSourceFileName, combinedBefore.fileName);
  assert.equal(combinedCleanupState.operationJournal?.localSourceSha256, combinedBefore.providerSha256);
  assert.match(combinedCleanupState.operationJournal?.localSourceDevice, /^\d+$/);
  assert.match(combinedCleanupState.operationJournal?.localSourceInode, /^[1-9]\d*$/);
  assert.equal(await readFile(join(providerDir, "local-combined.yaml"), "utf8").then(sha256), combinedCommitted.providerSha256);
  assert.match(await readFile(join(providerDir, "local-combined.yaml"), "utf8"), /new-node/);
  assert.equal(await readFile(join(providerDir, combinedBefore.fileName), "utf8").then(sha256), combinedBefore.providerSha256);
  const combinedRecovered = new ProviderFileService({
    ...renamedRestart.options,
    beforeOperationCleanup: undefined,
  });
  await combinedRecovered.init();
  await assert.rejects(readFile(join(providerDir, combinedBefore.fileName), "utf8"), { code: "ENOENT" });
  assert.deepEqual(combinedRecovered.localExtractions()[0], combinedCommitted);
  assert.equal((await combinedRecovered.read("local-combined.yaml")).sha256, combinedCommitted.providerSha256);
  assert.equal(JSON.parse(await readFile(combinedRecovered.options.statePath, "utf8")).operationJournal, null);

  let reachedCreatePrepared!: () => void;
  const createPrepared = new Promise<void>((resolve) => { reachedCreatePrepared = resolve; });
  const holdCreateCrash = new Promise<void>(() => undefined);
  const createCrash = await fixture({
    configs: { "source.yaml": localSource },
    afterOperationPhase: async (operation, phase) => {
      if (operation === "publish" && phase === "prepared") {
        reachedCreatePrepared();
        await holdCreateCrash;
      }
    },
  });
  t.after(() => rm(createCrash.root, { recursive: true, force: true }));
  void createCrash.service.createLocalExtraction({
    configName: "source.yaml",
    sourceSha256: sha256(localSource),
    fileName: "crash-create.yaml",
  }).catch(() => undefined);
  await createPrepared;
  const createCrashDiskState = JSON.parse(await readFile(createCrash.service.options.statePath, "utf8"));
  assert.deepEqual(createCrashDiskState.local, []);
  assert.equal(createCrashDiskState.operationJournal?.localBefore, null);
  const recoveredCreate = new ProviderFileService({ ...createCrash.service.options, afterOperationPhase: undefined });
  await recoveredCreate.init();
  assert.deepEqual(recoveredCreate.localExtractions(), []);
  await assert.rejects(readFile(join(createCrash.providerDir, "crash-create.yaml")), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(createCrash.service.options.statePath, "utf8")).operationJournal, null);

});

const publishFor = (
  targetFixture: Awaited<ReturnType<typeof fixture>>,
  owners: PublicSubscription[],
  content: string,
  commitState?: (sha256: string) => Promise<void>,
) => targetFixture.writeQueue.enqueue(() => targetFixture.service.publishSubscriptionProvider({
  subscriptionId: owners[0]!.id,
  fileName: `${owners[0]!.providerName}.yaml`,
  expectedSha256: owners[0]!.providerSha256,
  content,
}, async (committedSha256) => {
  if (commitState) {
    await commitState(committedSha256);
    return;
  }
  owners[0] = { ...owners[0]!, providerSha256: committedSha256 } as PublicSubscription;
}));
const initialPublishContent = "proxies:\n  - { name: initial, type: direct }\n";
const nextPublishContent = "proxies:\n  - { name: next, type: direct }\n";

test("managed Provider references follow source paths, directory aliases, and platform names", async (t) => {
  const { root, providerDir, service, configs } = await fixture({
    configs: {
      "a.yaml": [
        "proxy-providers:",
        "  manual:",
        "    type: file",
        "    path: ./providers/manual.yaml",
        "proxy-groups:",
        "  - name: Proxy",
        "    type: select",
        "    use: [manual]",
        "",
      ].join("\n"),
      "b.yaml": "mode: rule\n",
    }
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const manual = await service.create("proxy", "manual.yaml");
  await assert.rejects(
    service.rename("proxy", "manual.yaml", "moved.yaml", manual.sha256),
    (error: ProviderFileReferencedError) =>
      error.configNames.length === 1 && error.configNames[0] === "a.yaml",
  );
  await assert.rejects(
    service.delete("proxy", "manual.yaml", manual.sha256),
    ProviderFileReferencedError,
  );

  const aliasManual = await service.create("proxy", "aliased.yaml");
  const aliasDirectory = join(root, "provider-alias");
  let aliasAvailable = true;
  try {
    await symlink(providerDir, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    aliasAvailable = false;
  }
  if (aliasAvailable) {
    configs.set("alias-reference.yaml", [
      "proxy-providers:",
      "  aliased:",
      "    type: file",
      "    path: ./provider-alias/aliased.yaml",
      "",
    ].join("\n"));
    await assert.rejects(
      service.rename("proxy", "aliased.yaml", "aliased-next.yaml", aliasManual.sha256),
      (error: ProviderFileReferencedError) => error.configNames.join(",") === "alias-reference.yaml",
    );
    await assert.rejects(
      service.delete("proxy", "aliased.yaml", aliasManual.sha256),
      (error: ProviderFileReferencedError) => error.configNames.join(",") === "alias-reference.yaml",
    );
    configs.delete("alias-reference.yaml");
  }

  if (process.platform === "win32") {
    const wideManual = await service.create("proxy", "Ａ.yaml");
    await writeFile(join(providerDir, "A.yaml"), "proxies:\n", "utf8");
    const wideRecord = await service.read("Ａ.yaml");
    const narrowRecord = await service.read("A.yaml");
    assert.equal(wideRecord.source, "manual");
    assert.equal(wideRecord.writable, true);
    assert.equal(narrowRecord.source, "external");
    assert.equal(narrowRecord.writable, false);
    await assert.rejects(
      service.save("proxy", "A.yaml", "proxies: []\n", narrowRecord.sha256),
      ProviderFileReadOnlyError,
    );
    await assert.rejects(
      service.rename("proxy", "A.yaml", "A-next.yaml", narrowRecord.sha256),
      ProviderFileReadOnlyError,
    );
    await assert.rejects(
      service.delete("proxy", "A.yaml", narrowRecord.sha256),
      ProviderFileReadOnlyError,
    );
    assert.equal((await service.read("Ａ.yaml")).sha256, wideManual.sha256);

    const caseManual = await service.create("proxy", "CaseAlias.yaml");
    await assert.rejects(service.create("proxy", "casealias.yaml"), ProviderFileExistsError);
    configs.set("case-reference.yaml", [
      "proxy-providers:",
      "  case_alias:",
      "    type: file",
      "    path: ./providers/CASEALIAS.yaml",
      "",
    ].join("\n"));
    await assert.rejects(
      service.rename("proxy", "CaseAlias.yaml", "case-next.yaml", caseManual.sha256),
      (error: ProviderFileReferencedError) => error.configNames.join(",") === "case-reference.yaml",
    );
    await assert.rejects(
      service.delete("proxy", "CaseAlias.yaml", caseManual.sha256),
      (error: ProviderFileReferencedError) => error.configNames.join(",") === "case-reference.yaml",
    );
    configs.delete("case-reference.yaml");
  }
});

test("managed Provider ownership and filter versions survive rename, create, and delete recovery", async (t) => {
  let failStateWrite = false;
  let failRenameRecovery = false;
  let crashPhase: "linked" | "committed" | null = null;
  let crashOperationPhase: string | null = null;
  let failOperationCleanup: string | null = null;
  const automaticContent = "proxies:\n  - { name: automatic, type: direct }\n";
  const subscriptions = [{
    id: "subscription-id",
    name: "Subscription",
    providerName: "automatic",
    extractProvider: true,
    providerSha256: sha256(automaticContent),
  }, {
    id: "reserved-id",
    name: "Reserved",
    providerName: "reserved",
    extractProvider: true,
    providerSha256: null,
  }] as unknown as PublicSubscription[];
  const { root, providerDir, service, store } = await fixture({
    subscriptions,
    beforeStateRename: async () => { if (failStateWrite) throw new Error("injected state failure"); },
    beforeRenameCleanup: async (phase) => {
      if (failRenameRecovery && phase === "rollback-target") throw new Error("injected cleanup failure");
    },
    afterRenamePhase: async (phase) => {
      if (phase === crashPhase) throw new Error(`simulated ${phase} interruption`);
    },
    afterOperationPhase: async (operation, phase) => {
      if (`${operation}:${phase}` === crashOperationPhase) throw new Error("simulated operation interruption");
    },
    beforeOperationCleanup: async (operation, phase) => {
      if (`${operation}:${phase}` === failOperationCleanup) throw new Error("injected operation cleanup failure");
    }
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(providerDir, "automatic.yaml"), automaticContent, "utf8");
  const automatic = await service.read("automatic.yaml");
  assert.equal(automatic.source, "subscription");
  assert.deepEqual(automatic.filterSettings, { version: 0, enabled: false, rules: [] });
  const settings = await service.saveFilterSettings("automatic.yaml", {
    expectedVersion: 0,
    enabled: true,
    rules: ["剩余 & 流量", "官网", "  "],
  });
  assert.deepEqual(settings, { version: 1, enabled: true, rules: ["剩余 & 流量", "官网"] });
  await assert.rejects(
    service.saveFilterSettings("automatic.yaml", { expectedVersion: 0, enabled: false, rules: [] }),
    ProviderFilterConflictError,
  );

  subscriptions[0] = { ...subscriptions[0]!, providerSha256: "a".repeat(64) } as PublicSubscription;
  const drifted = await service.read("automatic.yaml");
  assert.equal(drifted.source, "external");
  assert.equal(drifted.writable, false);
  await assert.rejects(
    service.saveFilterSettings("automatic.yaml", { expectedVersion: 1, enabled: false, rules: [] }),
    ProviderFileReadOnlyError,
  );
  subscriptions[0] = { ...subscriptions[0]!, providerSha256: sha256(automaticContent) } as PublicSubscription;
  await assert.rejects(service.create("proxy", "reserved.yaml"), ProviderFileExistsError);

  const ambiguous = await service.create("proxy", "ambiguous.yaml");
  subscriptions.push({
    ...subscriptions[0]!,
    id: "ambiguous-subscription",
    providerName: "ambiguous",
    providerSha256: ambiguous.sha256,
  });
  const ambiguousRecord = await service.read("ambiguous.yaml");
  assert.equal(ambiguousRecord.source, "external");
  assert.equal(ambiguousRecord.writable, false);
  await assert.rejects(
    service.save("proxy", "ambiguous.yaml", "proxies: []\n", ambiguous.sha256),
    ProviderFileReadOnlyError,
  );

  const recovery = await service.create("proxy", "recovery.yaml");
  const recoveryContent = (await service.read("recovery.yaml")).content;
  failStateWrite = true;
  failRenameRecovery = true;
  await assert.rejects(
    service.rename("proxy", "recovery.yaml", "recovery-next.yaml", recovery.sha256),
    (error: ProviderFileRecoveryError) => error.message === "provider rename failed; recovery is incomplete",
  );
  assert.equal(await readFile(join(providerDir, "recovery.yaml"), "utf8"), recoveryContent);
  assert.equal(await readFile(join(providerDir, "recovery-next.yaml"), "utf8"), recoveryContent);
  await assert.rejects(service.read("recovery.yaml"), ProviderFileRecoveryError);
  const journalAfterFailedCleanup = JSON.parse(await readFile(service.options.statePath, "utf8"));
  assert.equal(journalAfterFailedCleanup.operationJournal?.phase, "linked");
  failStateWrite = false;
  failRenameRecovery = false;

  let recovered = new ProviderFileService({ ...service.options });
  await recovered.init();
  assert.equal((await recovered.read("recovery.yaml")).content, recoveryContent);
  await assert.rejects(
    readFile(join(providerDir, "recovery-next.yaml"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  assert.equal(JSON.parse(await readFile(service.options.statePath, "utf8")).operationJournal, null);

  const linked = await recovered.create("proxy", "linked.yaml");
  crashPhase = "linked";
  await assert.rejects(
    recovered.rename("proxy", "linked.yaml", "linked-next.yaml", linked.sha256),
    /simulated linked interruption/,
  );
  assert.equal(await readFile(join(providerDir, "linked.yaml"), "utf8"), "proxies:\n");
  assert.equal(await readFile(join(providerDir, "linked-next.yaml"), "utf8"), "proxies:\n");
  crashPhase = null;
  recovered = new ProviderFileService({ ...service.options });
  await recovered.init();
  assert.equal((await recovered.read("linked.yaml")).source, "manual");
  await assert.rejects(
    readFile(join(providerDir, "linked-next.yaml"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

  const committed = await recovered.create("proxy", "committed.yaml");
  crashPhase = "committed";
  await assert.rejects(
    recovered.rename("proxy", "committed.yaml", "committed-next.yaml", committed.sha256),
    ProviderFileRecoveryError,
  );
  assert.equal(await readFile(join(providerDir, "committed.yaml"), "utf8"), "proxies:\n");
  assert.equal(await readFile(join(providerDir, "committed-next.yaml"), "utf8"), "proxies:\n");
  crashPhase = null;
  recovered = new ProviderFileService({ ...service.options });
  await recovered.init();
  assert.equal((await recovered.read("committed-next.yaml")).source, "manual");
  await assert.rejects(
    readFile(join(providerDir, "committed.yaml"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

  crashOperationPhase = "create:published";
  await assert.rejects(recovered.create("proxy", "create-interrupted.yaml"), /simulated operation interruption/);
  const interruptedCreateState = JSON.parse(await readFile(service.options.statePath, "utf8"));
  assert.equal(interruptedCreateState.operationJournal?.operation, "create");
  assert.equal(await readFile(join(providerDir, "create-interrupted.yaml"), "utf8"), "proxies:\n");
  crashOperationPhase = null;
  recovered = new ProviderFileService({ ...service.options });
  await recovered.init();
  await assert.rejects(
    readFile(join(providerDir, "create-interrupted.yaml"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  const retriedCreate = await recovered.create("proxy", "create-interrupted.yaml");
  assert.equal(retriedCreate.source, "manual");

  failOperationCleanup = "create:clear-journal";
  await assert.rejects(recovered.create("proxy", "create-cleanup.yaml"), ProviderFileRecoveryError);
  const failedCreateState = JSON.parse(await readFile(service.options.statePath, "utf8"));
  assert.equal(failedCreateState.operationJournal?.operation, "create");
  assert.equal(await readFile(join(providerDir, "create-cleanup.yaml"), "utf8"), "proxies:\n");
  assert.equal(
    await readFile(join(providerDir, failedCreateState.operationJournal.stageFileName), "utf8"),
    "proxies:\n",
  );
  failOperationCleanup = null;
  recovered = new ProviderFileService({ ...service.options });
  await recovered.init();
  assert.equal((await recovered.read("create-cleanup.yaml")).source, "manual");

  const interruptedDelete = await recovered.create("proxy", "delete-interrupted.yaml");
  crashOperationPhase = "delete:backed-up";
  await assert.rejects(
    recovered.delete("proxy", "delete-interrupted.yaml", interruptedDelete.sha256),
    /simulated operation interruption/,
  );
  const interruptedDeleteState = JSON.parse(await readFile(service.options.statePath, "utf8"));
  assert.equal(interruptedDeleteState.operationJournal?.operation, "delete");
  assert.equal(await readFile(join(providerDir, "delete-interrupted.yaml"), "utf8"), "proxies:\n");
  assert.equal(
    await readFile(join(providerDir, interruptedDeleteState.operationJournal.backupFileName), "utf8"),
    "proxies:\n",
  );
  crashOperationPhase = null;
  recovered = new ProviderFileService({ ...service.options });
  await recovered.init();
  assert.equal((await recovered.read("delete-interrupted.yaml")).source, "manual");

  const cleanupDelete = await recovered.create("proxy", "delete-cleanup.yaml");
  failOperationCleanup = "delete:commit-source";
  await assert.rejects(
    recovered.delete("proxy", "delete-cleanup.yaml", cleanupDelete.sha256),
    ProviderFileRecoveryError,
  );
  const failedDeleteState = JSON.parse(await readFile(service.options.statePath, "utf8"));
  assert.equal(failedDeleteState.operationJournal?.operation, "delete");
  assert.equal(await readFile(join(providerDir, "delete-cleanup.yaml"), "utf8"), "proxies:\n");
  assert.equal(
    await readFile(join(providerDir, failedDeleteState.operationJournal.backupFileName), "utf8"),
    "proxies:\n",
  );
  failOperationCleanup = null;
  recovered = new ProviderFileService({ ...service.options });
  await recovered.init();
  await assert.rejects(
    readFile(join(providerDir, "delete-cleanup.yaml"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  assert.equal(
    (await readdir(providerDir)).some((name) => name.startsWith(".provider-op-")),
    false,
  );
  assert.equal(JSON.parse(await readFile(service.options.statePath, "utf8")).operationJournal, null);

  const reloaded = new ProviderFileService({
    ...service.options,
    store,
    subscriptions: () => subscriptions,
  });
  await reloaded.init();
  assert.deepEqual((await reloaded.read("automatic.yaml")).filterSettings, settings);
});

test("Provider drafts remain saveable while explicit validation checks their content", async (t) => {
  const { root, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  let guarded = await service.create("proxy", "guarded.yaml");
  for (const invalid of [
    "proxies: [1]\n",
    "proxies:\n  - { name: missing-type }\n",
    "proxies:\n  - { type: direct }\n",
  ]) {
    guarded = await service.save("proxy", "guarded.yaml", invalid, guarded.sha256);
    assert.equal(guarded.content, invalid);
    assert.throws(() => service.validate("proxy", invalid), ProviderFileValidationError);
  }
  let guardedRule = await service.create("rule", "guarded-rule.yaml");
  for (const invalid of ["payload: [{}]\n", "payload: ['']\n"]) {
    guardedRule = await service.save("rule", "guarded-rule.yaml", invalid, guardedRule.sha256);
    assert.equal(guardedRule.content, invalid);
    assert.throws(() => service.validate("rule", invalid), ProviderFileValidationError);
  }
});

test("create stage identity changes roll back publication", async (t) => {
  let replaceCreateStage = false;
  let createStageFixture!: Awaited<ReturnType<typeof fixture>>;
  createStageFixture = await fixture({
    afterOperationPhase: async (operation, phase) => {
      if (operation !== "create" || phase !== "staged" || !replaceCreateStage) return;
      replaceCreateStage = false;
      const journal = JSON.parse(
        await readFile(createStageFixture.service.options.statePath, "utf8"),
      ).operationJournal;
      const stagePath = join(createStageFixture.providerDir, journal.stageFileName);
      await unlink(stagePath);
      await writeFile(stagePath, "proxies:\n  - {}\n", "utf8");
    },
  });
  t.after(() => rm(createStageFixture.root, { recursive: true, force: true }));
  replaceCreateStage = true;
  await assert.rejects(
    createStageFixture.service.create("proxy", "create-stage-race.yaml"),
    ProviderFileConflictError,
  );
  await assert.rejects(
    readFile(join(createStageFixture.providerDir, "create-stage-race.yaml")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  const createStageState = JSON.parse(await readFile(createStageFixture.service.options.statePath, "utf8"));
  assert.deepEqual(createStageState.manual, []);
  assert.equal(createStageState.operationJournal, null);
  assert.equal((await createStageFixture.service.create("proxy", "create-after-stage-race.yaml")).source, "manual");
});

test("create commit preserves journal evidence when published file identities change", async (t) => {
  let replaceCreatedTarget = false;
  let createdTargetPath = "";
  let createCommitIdentityFixture!: Awaited<ReturnType<typeof fixture>>;
  createCommitIdentityFixture = await fixture({
    afterOperationPhase: async (operation, phase) => {
      if (operation !== "create" || phase !== "published" || !replaceCreatedTarget) return;
      replaceCreatedTarget = false;
      const journal = JSON.parse(
        await readFile(createCommitIdentityFixture.service.options.statePath, "utf8"),
      ).operationJournal;
      const stagePath = join(createCommitIdentityFixture.providerDir, journal.stageFileName);
      // Hold the original inode while constructing the replacement. Otherwise
      // ext4 can immediately recycle it and the fixture no longer changes identity.
      const original = await open(createdTargetPath, "r");
      t.after(() => original.close());
      await unlink(createdTargetPath);
      await unlink(stagePath);
      await writeFile(createdTargetPath, "proxies:\n", "utf8");
      await link(createdTargetPath, stagePath);
    },
  });
  t.after(() => rm(createCommitIdentityFixture.root, { recursive: true, force: true }));
  createdTargetPath = join(createCommitIdentityFixture.providerDir, "create-commit-identity.yaml");
  replaceCreatedTarget = true;
  await assert.rejects(
    createCommitIdentityFixture.service.create("proxy", "create-commit-identity.yaml"),
    ProviderFileRecoveryError,
  );
  assert.equal(await readFile(createdTargetPath, "utf8"), "proxies:\n");
  const createCommitIdentityState = JSON.parse(
    await readFile(createCommitIdentityFixture.service.options.statePath, "utf8"),
  );
  assert.deepEqual(createCommitIdentityState.manual, []);
  assert.equal(createCommitIdentityState.operationJournal?.phase, "published");
  assert.equal(
    await readFile(
      join(createCommitIdentityFixture.providerDir, createCommitIdentityState.operationJournal.stageFileName),
      "utf8",
    ),
    "proxies:\n",
  );
});

test("create rollback preserves files when target and proof identities change", async (t) => {
  let failCreateCommit = false;
  let replaceCreateRollbackTarget = false;
  let createRollbackTargetPath = "";
  let createRollbackIdentityFixture!: Awaited<ReturnType<typeof fixture>>;
  createRollbackIdentityFixture = await fixture({
    beforeStateRename: async () => {
      if (failCreateCommit) throw new Error("injected create state failure");
    },
    beforeOperationCleanup: async (operation, phase) => {
      if (operation !== "create" || phase !== "rollback-target" || !replaceCreateRollbackTarget) return;
      replaceCreateRollbackTarget = false;
      const journal = JSON.parse(
        await readFile(createRollbackIdentityFixture.service.options.statePath, "utf8"),
      ).operationJournal;
      const stagePath = join(createRollbackIdentityFixture.providerDir, journal.stageFileName);
      const original = await open(createRollbackTargetPath, "r");
      t.after(() => original.close());
      await unlink(createRollbackTargetPath);
      await unlink(stagePath);
      await writeFile(createRollbackTargetPath, "proxies:\n", "utf8");
      await link(createRollbackTargetPath, stagePath);
    },
  });
  t.after(() => rm(createRollbackIdentityFixture.root, { recursive: true, force: true }));
  createRollbackTargetPath = join(createRollbackIdentityFixture.providerDir, "create-rollback-identity.yaml");
  failCreateCommit = true;
  replaceCreateRollbackTarget = true;
  await assert.rejects(
    createRollbackIdentityFixture.service.create("proxy", "create-rollback-identity.yaml"),
    ProviderFileRecoveryError,
  );
  assert.equal(await readFile(createRollbackTargetPath, "utf8"), "proxies:\n");
  const createRollbackIdentityState = JSON.parse(
    await readFile(createRollbackIdentityFixture.service.options.statePath, "utf8"),
  );
  assert.deepEqual(createRollbackIdentityState.manual, []);
  assert.equal(createRollbackIdentityState.operationJournal?.phase, "published");
  assert.equal(
    await readFile(
      join(createRollbackIdentityFixture.providerDir, createRollbackIdentityState.operationJournal.stageFileName),
      "utf8",
    ),
    "proxies:\n",
  );
});

test("delete commit preserves files when source and backup identities change", async (t) => {
  let replaceBackedUpSource = false;
  let backedUpSourcePath = "";
  let deleteCommitIdentityFixture!: Awaited<ReturnType<typeof fixture>>;
  deleteCommitIdentityFixture = await fixture({
    afterOperationPhase: async (operation, phase) => {
      if (operation !== "delete" || phase !== "backed-up" || !replaceBackedUpSource) return;
      replaceBackedUpSource = false;
      const journal = JSON.parse(
        await readFile(deleteCommitIdentityFixture.service.options.statePath, "utf8"),
      ).operationJournal;
      const backupPath = join(deleteCommitIdentityFixture.providerDir, journal.backupFileName);
      const original = await open(backedUpSourcePath, "r");
      t.after(() => original.close());
      await unlink(backedUpSourcePath);
      await unlink(backupPath);
      await writeFile(backedUpSourcePath, "proxies:\n", "utf8");
      await link(backedUpSourcePath, backupPath);
    },
  });
  t.after(() => rm(deleteCommitIdentityFixture.root, { recursive: true, force: true }));
  const deleteCommitIdentityCreated = await deleteCommitIdentityFixture.service.create(
    "proxy",
    "delete-commit-identity.yaml",
  );
  backedUpSourcePath = join(deleteCommitIdentityFixture.providerDir, "delete-commit-identity.yaml");
  replaceBackedUpSource = true;
  await assert.rejects(
    deleteCommitIdentityFixture.service.delete(
      "proxy",
      "delete-commit-identity.yaml",
      deleteCommitIdentityCreated.sha256,
    ),
    ProviderFileRecoveryError,
  );
  assert.equal(await readFile(backedUpSourcePath, "utf8"), "proxies:\n");
  const deleteCommitIdentityState = JSON.parse(
    await readFile(deleteCommitIdentityFixture.service.options.statePath, "utf8"),
  );
  assert.equal(deleteCommitIdentityState.manual[0]?.fileName, "delete-commit-identity.yaml");
  assert.equal(deleteCommitIdentityState.operationJournal?.phase, "backed-up");
  assert.equal(
    await readFile(
      join(deleteCommitIdentityFixture.providerDir, deleteCommitIdentityState.operationJournal.backupFileName),
      "utf8",
    ),
    "proxies:\n",
  );
});

test("delete cleanup preserves committed journal evidence after identity changes", async (t) => {
  let replaceCommittedDeleteSource = false;
  let committedDeleteSourcePath = "";
  let deleteCleanupIdentityFixture!: Awaited<ReturnType<typeof fixture>>;
  deleteCleanupIdentityFixture = await fixture({
    beforeOperationCleanup: async (operation, phase) => {
      if (operation !== "delete" || phase !== "commit-source" || !replaceCommittedDeleteSource) return;
      replaceCommittedDeleteSource = false;
      const journal = JSON.parse(
        await readFile(deleteCleanupIdentityFixture.service.options.statePath, "utf8"),
      ).operationJournal;
      const backupPath = join(deleteCleanupIdentityFixture.providerDir, journal.backupFileName);
      const original = await open(committedDeleteSourcePath, "r");
      t.after(() => original.close());
      await unlink(committedDeleteSourcePath);
      await unlink(backupPath);
      await writeFile(committedDeleteSourcePath, "proxies:\n", "utf8");
      await link(committedDeleteSourcePath, backupPath);
    },
  });
  t.after(() => rm(deleteCleanupIdentityFixture.root, { recursive: true, force: true }));
  const deleteCleanupIdentityCreated = await deleteCleanupIdentityFixture.service.create(
    "proxy",
    "delete-cleanup-identity.yaml",
  );
  committedDeleteSourcePath = join(deleteCleanupIdentityFixture.providerDir, "delete-cleanup-identity.yaml");
  replaceCommittedDeleteSource = true;
  await assert.rejects(
    deleteCleanupIdentityFixture.service.delete(
      "proxy",
      "delete-cleanup-identity.yaml",
      deleteCleanupIdentityCreated.sha256,
    ),
    ProviderFileRecoveryError,
  );
  assert.equal(await readFile(committedDeleteSourcePath, "utf8"), "proxies:\n");
  const deleteCleanupIdentityState = JSON.parse(
    await readFile(deleteCleanupIdentityFixture.service.options.statePath, "utf8"),
  );
  assert.deepEqual(deleteCleanupIdentityState.manual, []);
  assert.equal(deleteCleanupIdentityState.operationJournal?.phase, "committed");
  assert.equal(
    await readFile(
      join(deleteCleanupIdentityFixture.providerDir, deleteCleanupIdentityState.operationJournal.backupFileName),
      "utf8",
    ),
    "proxies:\n",
  );
});

test("prepared create recovery preserves third-party files without recorded proof", async (t) => {
  let stopPreparedCreate = true;
  const createIdentityFixture = await fixture({
    afterOperationPhase: async (operation, phase) => {
      if (stopPreparedCreate && operation === "create" && phase === "prepared") {
        throw new Error("stop before create stage");
      }
    },
  });
  t.after(() => rm(createIdentityFixture.root, { recursive: true, force: true }));
  await assert.rejects(
    createIdentityFixture.service.create("proxy", "third-party.yaml"),
    /stop before create stage/,
  );
  const legacyCreateState = JSON.parse(await readFile(createIdentityFixture.service.options.statePath, "utf8"));
  const legacyCreateTarget = join(createIdentityFixture.providerDir, "third-party.yaml");
  const legacyCreateStage = join(
    createIdentityFixture.providerDir,
    legacyCreateState.operationJournal.stageFileName,
  );
  await writeFile(legacyCreateTarget, "proxies:\n", "utf8");
  await link(legacyCreateTarget, legacyCreateStage);
  stopPreparedCreate = false;
  const createIdentityReload = new ProviderFileService({ ...createIdentityFixture.service.options });
  await assert.rejects(createIdentityReload.init(), ProviderFileRecoveryError);
  assert.equal(await readFile(legacyCreateTarget, "utf8"), "proxies:\n");
  assert.equal(await readFile(legacyCreateStage, "utf8"), "proxies:\n");
  assert.equal(
    JSON.parse(await readFile(createIdentityFixture.service.options.statePath, "utf8")).operationJournal?.operation,
    "create",
  );
});

test("prepared delete recovery preserves third-party files without recorded proof", async (t) => {
  let stopPreparedDelete = false;
  const deleteIdentityFixture = await fixture({
    afterOperationPhase: async (operation, phase) => {
      if (stopPreparedDelete && operation === "delete" && phase === "prepared") {
        throw new Error("stop before delete backup");
      }
    },
  });
  t.after(() => rm(deleteIdentityFixture.root, { recursive: true, force: true }));
  const legacyDeleteCreated = await deleteIdentityFixture.service.create("proxy", "third-party-delete.yaml");
  stopPreparedDelete = true;
  await assert.rejects(
    deleteIdentityFixture.service.delete(
      "proxy",
      "third-party-delete.yaml",
      legacyDeleteCreated.sha256,
    ),
    /stop before delete backup/,
  );
  const legacyDeleteState = JSON.parse(await readFile(deleteIdentityFixture.service.options.statePath, "utf8"));
  const legacyDeleteSource = join(deleteIdentityFixture.providerDir, "third-party-delete.yaml");
  const legacyDeleteBackup = join(
    deleteIdentityFixture.providerDir,
    legacyDeleteState.operationJournal.backupFileName,
  );
  await unlink(legacyDeleteSource);
  await writeFile(legacyDeleteSource, "proxies:\n", "utf8");
  await link(legacyDeleteSource, legacyDeleteBackup);
  stopPreparedDelete = false;
  const deleteIdentityReload = new ProviderFileService({ ...deleteIdentityFixture.service.options });
  await assert.rejects(deleteIdentityReload.init(), ProviderFileRecoveryError);
  assert.equal(await readFile(legacyDeleteSource, "utf8"), "proxies:\n");
  assert.equal(await readFile(legacyDeleteBackup, "utf8"), "proxies:\n");
  assert.equal(
    JSON.parse(await readFile(deleteIdentityFixture.service.options.statePath, "utf8")).operationJournal?.phase,
    "prepared",
  );
});

test("staged create recovery resumes after journal clearing fails", async (t) => {
  let stopStagedCreate = true;
  let failStagedCreateClear = true;
  const stagedCreateFixture = await fixture({
    afterOperationPhase: async (operation, phase) => {
      if (stopStagedCreate && operation === "create" && phase === "staged") {
        throw new Error("stop after create proof");
      }
    },
    beforeOperationCleanup: async (operation, phase) => {
      if (failStagedCreateClear && operation === "create" && phase === "clear-journal") {
        throw new Error("stop create recovery clear");
      }
    },
  });
  t.after(() => rm(stagedCreateFixture.root, { recursive: true, force: true }));
  await assert.rejects(
    stagedCreateFixture.service.create("proxy", "staged-create.yaml"),
    ProviderFileRecoveryError,
  );
  assert.equal(
    JSON.parse(await readFile(stagedCreateFixture.service.options.statePath, "utf8")).operationJournal?.phase,
    "staged",
  );
  stopStagedCreate = false;
  failStagedCreateClear = false;
  const stagedCreateReload = new ProviderFileService({ ...stagedCreateFixture.service.options });
  await stagedCreateReload.init();
  assert.equal(
    JSON.parse(await readFile(stagedCreateFixture.service.options.statePath, "utf8")).operationJournal,
    null,
  );
});

test("staged delete recovery resumes after journal clearing fails", async (t) => {
  let stopStagedDelete = false;
  let failStagedDeleteClear = false;
  const stagedDeleteFixture = await fixture({
    afterOperationPhase: async (operation, phase) => {
      if (stopStagedDelete && operation === "delete" && phase === "staged") {
        throw new Error("stop after delete proof");
      }
    },
    beforeOperationCleanup: async (operation, phase) => {
      if (failStagedDeleteClear && operation === "delete" && phase === "clear-journal") {
        throw new Error("stop delete recovery clear");
      }
    },
  });
  t.after(() => rm(stagedDeleteFixture.root, { recursive: true, force: true }));
  const stagedDeleteCreated = await stagedDeleteFixture.service.create("proxy", "staged-delete.yaml");
  stopStagedDelete = true;
  failStagedDeleteClear = true;
  await assert.rejects(
    stagedDeleteFixture.service.delete("proxy", "staged-delete.yaml", stagedDeleteCreated.sha256),
    ProviderFileRecoveryError,
  );
  assert.equal(
    JSON.parse(await readFile(stagedDeleteFixture.service.options.statePath, "utf8")).operationJournal?.phase,
    "staged",
  );
  stopStagedDelete = false;
  failStagedDeleteClear = false;
  const stagedDeleteReload = new ProviderFileService({ ...stagedDeleteFixture.service.options });
  await stagedDeleteReload.init();
  assert.equal((await stagedDeleteReload.read("staged-delete.yaml")).source, "manual");
  assert.equal(
    JSON.parse(await readFile(stagedDeleteFixture.service.options.statePath, "utf8")).operationJournal,
    null,
  );
});

test("linked rename recovery preserves a target with changed identity", async (t) => {
  let stopLinkedRename = true;
  const renameIdentityFixture = await fixture({
    afterRenamePhase: async (phase) => {
      if (stopLinkedRename && phase === "linked") throw new Error("stop after rename link");
    },
  });
  t.after(() => rm(renameIdentityFixture.root, { recursive: true, force: true }));
  const renameIdentitySource = await renameIdentityFixture.service.create("proxy", "identity-source.yaml");
  await assert.rejects(renameIdentityFixture.service.rename(
    "proxy",
    "identity-source.yaml",
    "identity-target.yaml",
    renameIdentitySource.sha256,
  ), /stop after rename link/);
  await unlink(join(renameIdentityFixture.providerDir, "identity-target.yaml"));
  await writeFile(join(renameIdentityFixture.providerDir, "identity-target.yaml"), "proxies:\n", "utf8");
  stopLinkedRename = false;
  const renameIdentityReload = new ProviderFileService({ ...renameIdentityFixture.service.options });
  await assert.rejects(renameIdentityReload.init(), ProviderFileRecoveryError);
  assert.equal(await readFile(join(renameIdentityFixture.providerDir, "identity-source.yaml"), "utf8"), "proxies:\n");
  assert.equal(await readFile(join(renameIdentityFixture.providerDir, "identity-target.yaml"), "utf8"), "proxies:\n");
  assert.equal(
    JSON.parse(await readFile(renameIdentityFixture.service.options.statePath, "utf8")).operationJournal?.operation,
    "rename",
  );
});

test("create collisions retain the target and recover interrupted cleanup", async (t) => {
  let failCreateCollisionCleanup = false;
  let createCollisionPath: string | null = null;
  const createCollisionFixture = await fixture({
    afterOperationPhase: async (operation, phase) => {
      if (operation === "create" && phase === "prepared" && createCollisionPath) {
        await writeFile(createCollisionPath, "proxies:\n", "utf8");
      }
    },
    beforeOperationCleanup: async (operation, phase) => {
      if (failCreateCollisionCleanup && operation === "create" && phase === "cleanup-stage") {
        throw new Error("collision cleanup failed");
      }
    },
  });
  t.after(() => rm(createCollisionFixture.root, { recursive: true, force: true }));
  const collisionPath = join(createCollisionFixture.providerDir, "collision.yaml");
  createCollisionPath = collisionPath;
  await assert.rejects(createCollisionFixture.service.create("proxy", "collision.yaml"), ProviderFileExistsError);
  assert.equal(await readFile(collisionPath, "utf8"), "proxies:\n");
  assert.equal(
    JSON.parse(await readFile(createCollisionFixture.service.options.statePath, "utf8")).operationJournal,
    null,
  );
  createCollisionPath = null;
  assert.equal((await createCollisionFixture.service.create("proxy", "unrelated.yaml")).source, "manual");

  createCollisionPath = join(createCollisionFixture.providerDir, "cleanup-collision.yaml");
  failCreateCollisionCleanup = true;
  await assert.rejects(
    createCollisionFixture.service.create("proxy", "cleanup-collision.yaml"),
    ProviderFileRecoveryError,
  );
  const collisionJournal = JSON.parse(await readFile(createCollisionFixture.service.options.statePath, "utf8"));
  assert.equal(collisionJournal.operationJournal?.phase, "aborting");
  assert.equal(
    await readFile(join(createCollisionFixture.providerDir, "cleanup-collision.yaml"), "utf8"),
    "proxies:\n",
  );
  failCreateCollisionCleanup = false;
  createCollisionPath = null;
  const createCollisionReload = new ProviderFileService({ ...createCollisionFixture.service.options });
  await createCollisionReload.init();
  assert.equal(
    await readFile(join(createCollisionFixture.providerDir, "cleanup-collision.yaml"), "utf8"),
    "proxies:\n",
  );
  assert.equal(
    JSON.parse(await readFile(createCollisionFixture.service.options.statePath, "utf8")).operationJournal,
    null,
  );
});

test("rename collisions retain the target and clear completed recovery", async (t) => {
  let renameCollisionPath: string | null = null;
  const renameCollisionFixture = await fixture({
    afterRenamePhase: async (phase) => {
      if (phase === "prepared" && renameCollisionPath) {
        await writeFile(renameCollisionPath, "proxies:\n", "utf8");
      }
    },
  });
  t.after(() => rm(renameCollisionFixture.root, { recursive: true, force: true }));
  const renameCollisionSource = await renameCollisionFixture.service.create("proxy", "rename-collision-source.yaml");
  renameCollisionPath = join(renameCollisionFixture.providerDir, "rename-collision-target.yaml");
  await assert.rejects(renameCollisionFixture.service.rename(
    "proxy",
    "rename-collision-source.yaml",
    "rename-collision-target.yaml",
    renameCollisionSource.sha256,
  ), ProviderFileExistsError);
  assert.equal(await readFile(renameCollisionPath, "utf8"), "proxies:\n");
  assert.equal((await renameCollisionFixture.service.read("rename-collision-source.yaml")).source, "manual");
  assert.equal(
    JSON.parse(await readFile(renameCollisionFixture.service.options.statePath, "utf8")).operationJournal,
    null,
  );
  renameCollisionPath = null;
  assert.equal((await renameCollisionFixture.service.create("proxy", "rename-unrelated.yaml")).source, "manual");
});

test("subscription publication checks source identity before replacing the file", async (t) => {
  let replaceBeforePublish = false;
  let prePublishTarget = "";
  const prePublishOwners = [{
    id: "pre-publish-owner",
    name: "Pre-publish owner",
    providerName: "pre-publish",
    extractProvider: true,
    providerSha256: null,
  }] as unknown as PublicSubscription[];
  const prePublishFixture = await fixture({
    subscriptions: prePublishOwners,
    beforeFileRename: async () => {
      if (!replaceBeforePublish) return;
      replaceBeforePublish = false;
      await unlink(prePublishTarget);
      await writeFile(prePublishTarget, initialPublishContent, "utf8");
    },
  });
  t.after(() => rm(prePublishFixture.root, { recursive: true, force: true }));
  prePublishTarget = join(prePublishFixture.providerDir, "pre-publish.yaml");
  await publishFor(prePublishFixture, prePublishOwners, initialPublishContent);
  const prePublishCommittedSha = prePublishOwners[0]!.providerSha256;
  replaceBeforePublish = true;
  await assert.rejects(
    publishFor(prePublishFixture, prePublishOwners, nextPublishContent),
    ProviderFileConflictError,
  );
  assert.equal(prePublishOwners[0]!.providerSha256, prePublishCommittedSha);
  assert.equal(await readFile(prePublishTarget, "utf8"), initialPublishContent);
  const prePublishJournal = JSON.parse(await readFile(prePublishFixture.service.options.statePath, "utf8"))
    .operationJournal;
  assert.equal(prePublishJournal.phase, "staged");
  assert.equal(await readFile(join(prePublishFixture.providerDir, prePublishJournal.backupFileName), "utf8"), initialPublishContent);
  assert.equal(await readFile(join(prePublishFixture.providerDir, prePublishJournal.anchorFileName), "utf8"), nextPublishContent);
});

test("subscription publication checks target identity before committing ownership", async (t) => {
  let replaceAfterPublish = false;
  let postPublishTarget = "";
  let postPublishCommitCount = 0;
  const postPublishOwners = [{
    id: "post-publish-owner",
    name: "Post-publish owner",
    providerName: "post-publish",
    extractProvider: true,
    providerSha256: null,
  }] as unknown as PublicSubscription[];
  const postPublishFixture = await fixture({
    subscriptions: postPublishOwners,
    afterProviderFilePublish: async () => {
      if (!replaceAfterPublish) return;
      replaceAfterPublish = false;
      await unlink(postPublishTarget);
      await writeFile(postPublishTarget, nextPublishContent, "utf8");
    },
  });
  t.after(() => rm(postPublishFixture.root, { recursive: true, force: true }));
  postPublishTarget = join(postPublishFixture.providerDir, "post-publish.yaml");
  await publishFor(postPublishFixture, postPublishOwners, initialPublishContent);
  const postPublishCommittedSha = postPublishOwners[0]!.providerSha256;
  replaceAfterPublish = true;
  await assert.rejects(
    publishFor(postPublishFixture, postPublishOwners, nextPublishContent, async (committedSha256) => {
      postPublishCommitCount += 1;
      postPublishOwners[0] = {
        ...postPublishOwners[0]!,
        providerSha256: committedSha256,
      } as PublicSubscription;
    }),
    ProviderFileConflictError,
  );
  assert.equal(postPublishCommitCount, 0);
  assert.equal(postPublishOwners[0]!.providerSha256, postPublishCommittedSha);
  assert.equal(await readFile(postPublishTarget, "utf8"), nextPublishContent);
  const postPublishJournal = JSON.parse(await readFile(postPublishFixture.service.options.statePath, "utf8"))
    .operationJournal;
  assert.equal(postPublishJournal.phase, "published");
  assert.equal(await readFile(join(postPublishFixture.providerDir, postPublishJournal.backupFileName), "utf8"), initialPublishContent);
  assert.equal(await readFile(join(postPublishFixture.providerDir, postPublishJournal.anchorFileName), "utf8"), nextPublishContent);
});

test("subscription rollback retains journal evidence when target identity changes", async (t) => {
  let replaceRollbackTarget = false;
  let rollbackTarget = "";
  const rollbackOwners = [{
    id: "rollback-owner",
    name: "Rollback owner",
    providerName: "rollback",
    extractProvider: true,
    providerSha256: null,
  }] as unknown as PublicSubscription[];
  const rollbackFixture = await fixture({
    subscriptions: rollbackOwners,
    beforeOperationCleanup: async (operation, phase) => {
      if (operation !== "publish" || phase !== "rollback-target" || !replaceRollbackTarget) return;
      replaceRollbackTarget = false;
      await unlink(rollbackTarget);
      await writeFile(rollbackTarget, nextPublishContent, "utf8");
    },
  });
  t.after(() => rm(rollbackFixture.root, { recursive: true, force: true }));
  rollbackTarget = join(rollbackFixture.providerDir, "rollback.yaml");
  await publishFor(rollbackFixture, rollbackOwners, initialPublishContent);
  const rollbackCommittedSha = rollbackOwners[0]!.providerSha256;
  replaceRollbackTarget = true;
  await assert.rejects(
    publishFor(rollbackFixture, rollbackOwners, nextPublishContent, async () => {
      throw new Error("injected publish state failure");
    }),
    ProviderFileRecoveryError,
  );
  assert.equal(rollbackOwners[0]!.providerSha256, rollbackCommittedSha);
  assert.equal(await readFile(rollbackTarget, "utf8"), nextPublishContent);
  const rollbackJournal = JSON.parse(await readFile(rollbackFixture.service.options.statePath, "utf8"))
    .operationJournal;
  assert.equal(rollbackJournal.phase, "published");
  assert.equal(await readFile(join(rollbackFixture.providerDir, rollbackJournal.backupFileName), "utf8"), initialPublishContent);
  assert.equal(await readFile(join(rollbackFixture.providerDir, rollbackJournal.anchorFileName), "utf8"), nextPublishContent);
});

test("subscription cleanup retains journal evidence when publication proof changes", async (t) => {
  let replaceCleaningProof = false;
  let cleaningTarget = "";
  const cleaningOwners = [{
    id: "cleaning-owner",
    name: "Cleaning owner",
    providerName: "cleaning",
    extractProvider: true,
    providerSha256: null,
  }] as unknown as PublicSubscription[];
  let cleaningFixture!: Awaited<ReturnType<typeof fixture>>;
  cleaningFixture = await fixture({
    subscriptions: cleaningOwners,
    afterOperationPhase: async (operation, phase) => {
      if (operation !== "publish" || phase !== "cleaning" || !replaceCleaningProof) return;
      replaceCleaningProof = false;
      const journal = JSON.parse(await readFile(cleaningFixture.service.options.statePath, "utf8")).operationJournal;
      await unlink(join(cleaningFixture.providerDir, journal.anchorFileName));
      await unlink(cleaningTarget);
      await writeFile(cleaningTarget, nextPublishContent, "utf8");
    },
  });
  t.after(() => rm(cleaningFixture.root, { recursive: true, force: true }));
  cleaningTarget = join(cleaningFixture.providerDir, "cleaning.yaml");
  await publishFor(cleaningFixture, cleaningOwners, initialPublishContent);
  replaceCleaningProof = true;
  await assert.rejects(
    publishFor(cleaningFixture, cleaningOwners, nextPublishContent),
    ProviderFileRecoveryError,
  );
  assert.equal(await readFile(cleaningTarget, "utf8"), nextPublishContent);
  const cleaningJournal = JSON.parse(await readFile(cleaningFixture.service.options.statePath, "utf8"))
    .operationJournal;
  assert.equal(cleaningJournal.phase, "cleaning");
  const cleaningReload = new ProviderFileService({ ...cleaningFixture.service.options });
  await assert.rejects(cleaningReload.init(), ProviderFileRecoveryError);
  assert.equal(await readFile(cleaningTarget, "utf8"), nextPublishContent);
  assert.equal(
    JSON.parse(await readFile(cleaningFixture.service.options.statePath, "utf8")).operationJournal?.phase,
    "cleaning",
  );
});

test("cleanup-only recovery preserves files after proof identity changes", async (t) => {
  let replaceCleanupOnlyProof = false;
  let cleanupOnlyAttackTarget = "";
  const cleanupOnlyAttackOwners = [{
    id: "cleanup-only-attack-owner",
    name: "Cleanup-only attack owner",
    providerName: "cleanup-only-attack",
    extractProvider: true,
    providerSha256: null,
  }] as unknown as PublicSubscription[];
  let cleanupOnlyAttackFixture!: Awaited<ReturnType<typeof fixture>>;
  cleanupOnlyAttackFixture = await fixture({
    subscriptions: cleanupOnlyAttackOwners,
    afterOperationPhase: async (operation, phase) => {
      if (operation !== "publish" || phase !== "cleanup-only" || !replaceCleanupOnlyProof) return;
      replaceCleanupOnlyProof = false;
      const journal = JSON.parse(
        await readFile(cleanupOnlyAttackFixture.service.options.statePath, "utf8"),
      ).operationJournal;
      await unlink(join(cleanupOnlyAttackFixture.providerDir, journal.anchorFileName));
      await unlink(cleanupOnlyAttackTarget);
      await writeFile(cleanupOnlyAttackTarget, nextPublishContent, "utf8");
    },
  });
  t.after(() => rm(cleanupOnlyAttackFixture.root, { recursive: true, force: true }));
  cleanupOnlyAttackTarget = join(cleanupOnlyAttackFixture.providerDir, "cleanup-only-attack.yaml");
  await publishFor(cleanupOnlyAttackFixture, cleanupOnlyAttackOwners, initialPublishContent);
  replaceCleanupOnlyProof = true;
  await assert.rejects(
    publishFor(cleanupOnlyAttackFixture, cleanupOnlyAttackOwners, nextPublishContent),
    ProviderFileRecoveryError,
  );
  assert.equal(await readFile(cleanupOnlyAttackTarget, "utf8"), nextPublishContent);
  assert.equal(
    JSON.parse(await readFile(cleanupOnlyAttackFixture.service.options.statePath, "utf8")).operationJournal?.phase,
    "cleanup-only",
  );
  const cleanupOnlyAttackReload = new ProviderFileService({ ...cleanupOnlyAttackFixture.service.options });
  await assert.rejects(cleanupOnlyAttackReload.init(), ProviderFileRecoveryError);
  assert.equal(await readFile(cleanupOnlyAttackTarget, "utf8"), nextPublishContent);
  assert.equal(
    JSON.parse(await readFile(cleanupOnlyAttackFixture.service.options.statePath, "utf8")).operationJournal?.phase,
    "cleanup-only",
  );
});

test("cleanup-only recovery resumes after journal clearing is interrupted", async (t) => {
  let interruptAfterProofRemoval = false;
  const cleanupOnlyOwners = [{
    id: "cleanup-only-owner",
    name: "Cleanup-only owner",
    providerName: "cleanup-only",
    extractProvider: true,
    providerSha256: null,
  }] as unknown as PublicSubscription[];
  let cleanupOnlyFixture!: Awaited<ReturnType<typeof fixture>>;
  cleanupOnlyFixture = await fixture({
    subscriptions: cleanupOnlyOwners,
    beforeOperationCleanup: async (operation, phase) => {
      if (operation !== "publish" || phase !== "clear-journal" || !interruptAfterProofRemoval) return;
      interruptAfterProofRemoval = false;
      const journal = JSON.parse(await readFile(cleanupOnlyFixture.service.options.statePath, "utf8")).operationJournal;
      assert.equal(journal.phase, "cleanup-only");
      assert.equal(
        await readFile(join(cleanupOnlyFixture.providerDir, journal.anchorFileName), "utf8"),
        nextPublishContent,
      );
      throw new Error("simulated journal clear failure");
    },
  });
  t.after(() => rm(cleanupOnlyFixture.root, { recursive: true, force: true }));
  await publishFor(cleanupOnlyFixture, cleanupOnlyOwners, initialPublishContent);
  interruptAfterProofRemoval = true;
  await assert.rejects(
    publishFor(cleanupOnlyFixture, cleanupOnlyOwners, nextPublishContent),
    ProviderFileRecoveryError,
  );
  assert.equal(
    JSON.parse(await readFile(cleanupOnlyFixture.service.options.statePath, "utf8")).operationJournal?.phase,
    "cleanup-only",
  );
  const cleanupOnlyReload = new ProviderFileService({ ...cleanupOnlyFixture.service.options });
  await cleanupOnlyReload.init();
  assert.equal(await readFile(join(cleanupOnlyFixture.providerDir, "cleanup-only.yaml"), "utf8"), nextPublishContent);
  assert.equal(
    JSON.parse(await readFile(cleanupOnlyFixture.service.options.statePath, "utf8")).operationJournal,
    null,
  );
});

test("Provider reads and lists wait for subscription publication to commit", async (t) => {
  let releasePublishedTarget: (() => void) | null = null;
  let publishedTargetReached: (() => void) | null = null;
  const publishedTargetGate = () => new Promise<void>((resolve) => { releasePublishedTarget = resolve; });
  const publishedTargetSignal = () => new Promise<void>((resolve) => { publishedTargetReached = resolve; });
  let waitForPublishedTarget: Promise<void> | null = null;
  const serializedSubscriptions = [{
    id: "serialized-subscription",
    name: "Serialized subscription",
    providerName: "serialized",
    extractProvider: true,
    providerSha256: null,
  }] as unknown as PublicSubscription[];
  const serializedFixture = await fixture({
    subscriptions: serializedSubscriptions,
    afterProviderFilePublish: async () => {
      publishedTargetReached?.();
      if (waitForPublishedTarget) await waitForPublishedTarget;
    },
  });
  t.after(() => rm(serializedFixture.root, { recursive: true, force: true }));

  const assertSerializedPublish = async (content: string) => {
    waitForPublishedTarget = publishedTargetGate();
    const targetReached = publishedTargetSignal();
    const expectedSha256 = serializedSubscriptions[0]!.providerSha256;
    const publish = serializedFixture.writeQueue.enqueue(() =>
      serializedFixture.service.publishSubscriptionProvider({
        subscriptionId: "serialized-subscription",
        fileName: "serialized.yaml",
        expectedSha256,
        content,
      }, async (committedSha256) => {
        serializedSubscriptions[0] = {
          ...serializedSubscriptions[0]!,
          providerSha256: committedSha256,
        } as PublicSubscription;
      }),
    );
    await targetReached;
    let readSettled = false;
    let listSettled = false;
    const pendingRead = serializedFixture.service.read("serialized.yaml").finally(() => { readSettled = true; });
    const pendingList = serializedFixture.service.list().finally(() => { listSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(readSettled, false);
    assert.equal(listSettled, false);
    releasePublishedTarget?.();
    await publish;
    const snapshot = await pendingRead;
    const listed = (await pendingList).find((item) => item.fileName === "serialized.yaml");
    assert.equal(snapshot.content, content);
    assert.equal(sha256(snapshot.content), snapshot.sha256);
    assert.equal(listed?.sha256, snapshot.sha256);
    assert.equal(
      JSON.parse(await readFile(serializedFixture.service.options.statePath, "utf8")).operationJournal,
      null,
    );
    waitForPublishedTarget = null;
    releasePublishedTarget = null;
    publishedTargetReached = null;
  };

  await assertSerializedPublish("proxies:\n  - { name: first, type: direct }\n");
  await assertSerializedPublish("proxies:\n  - { name: second, type: direct }\n");
});

test("Provider reads wait for manual save before subsequent rename", async (t) => {
  let releaseSave: (() => void) | null = null;
  let saveReached: (() => void) | null = null;
  let waitForSave: Promise<void> | null = null;
  const saveFixture = await fixture({
    beforeFileRename: async () => {
      saveReached?.();
      if (waitForSave) await waitForSave;
    },
  });
  t.after(() => rm(saveFixture.root, { recursive: true, force: true }));
  const saveCreated = await saveFixture.service.create("proxy", "serialized-save.yaml");
  waitForSave = new Promise<void>((resolve) => { releaseSave = resolve; });
  const saveSignal = new Promise<void>((resolve) => { saveReached = resolve; });
  const saving = saveFixture.service.save(
    "proxy",
    "serialized-save.yaml",
    "proxies:\n  - { name: saved, type: direct }\n",
    saveCreated.sha256,
  );
  await saveSignal;
  let saveReadSettled = false;
  const pendingSaveRead = saveFixture.service.read("serialized-save.yaml")
    .finally(() => { saveReadSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(saveReadSettled, false);
  releaseSave?.();
  const saved = await saving;
  const savedSnapshot = await pendingSaveRead;
  assert.equal(savedSnapshot.content, saved.content);
  assert.equal(sha256(savedSnapshot.content), savedSnapshot.sha256);
  const renamedAfterSerializedRead = await saveFixture.service.rename(
    "proxy",
    "serialized-save.yaml",
    "serialized-save-next.yaml",
    saved.sha256,
  );
  assert.equal(renamedAfterSerializedRead.fileName, "serialized-save-next.yaml");
});

test("cleanup previews reuse one config scan and distinguish path, inode and unreadable evidence", async (t) => {
  const reference = (path: string) => stringify({ "proxy-providers": { fixture: { type: "file", path } } });
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const name of ["shared", "independent", "other"]) await f.service.create("proxy", `${name}.yaml`);
  await link(join(f.providerDir, "shared.yaml"), join(f.root, "linked.yaml"));
  const originalBody = await readFile(join(f.providerDir, "shared.yaml"), "utf8");
  f.configs.set("path.yaml", reference("./providers/shared.yaml"));
  f.configs.set("identity.yaml", reference("./linked.yaml"));
  f.configs.set("invalid.yaml", "[invalid");
  f.configs.set("unreadable.yaml", "mode: direct\n");
  const originalList = f.store.list.bind(f.store);
  const originalRead = f.store.read.bind(f.store);
  const calls = { list: 0, read: 0 };
  f.store.list = async () => { calls.list++; return originalList(); };
  f.store.read = async (name: string) => {
    calls.read++;
    if (name === "unreadable.yaml") throw new Error("fixture read failed");
    return originalRead(name);
  };
  await f.service.list();
  assert.deepEqual(calls, { list: 1, read: 4 });
  calls.list = calls.read = 0;
  const plan = await f.service.previewCleanup({ category: "proxy" });
  assert.deepEqual(calls, { list: 1, read: 4 });
  const shared = plan.files.find((item) => item.fileName === "shared.yaml")!;
  assert.equal(shared.reason, "referenced");
  assert.deepEqual(shared.configNames, ["identity.yaml", "invalid.yaml", "path.yaml", "unreadable.yaml"]);
  assert.deepEqual(shared.configReferences, [
    { configName: "identity.yaml", kind: "identity", path: "./linked.yaml" }, { configName: "invalid.yaml", kind: "unreadable" },
    { configName: "path.yaml", kind: "path", path: "./providers/shared.yaml" }, { configName: "unreadable.yaml", kind: "unreadable" },
  ]);
  calls.list = calls.read = 0;
  const scoped = await f.service.previewCleanup({ configName: "path.yaml", expectedConfigSha256: sha256(f.configs.get("path.yaml")!) });
  assert.deepEqual(calls, { list: 1, read: 4 });
  assert.equal(scoped.files[0]?.configNames?.includes("path.yaml"), false);
  await assert.rejects(f.service.delete("proxy", shared.fileName, shared.sha256), ProviderFileReferencedError);
  assert.equal((await f.service.cleanup([shared])).files[0]?.action, "keep");
  assert.equal((await f.service.cleanup([shared], true)).files[0]?.action, "deleted");
  assert.equal(await readFile(join(f.root, "linked.yaml"), "utf8"), originalBody);
  assert.equal((await f.service.read("proxy", "independent.yaml")).fileName, "independent.yaml");
});

test("partial reference scans preserve known dependencies on both sides of an unreadable declaration", async (t) => {
  for (const badFirst of [false, true]) {
    const direct = { direct: { type: "file", path: "./providers/old.yaml" } };
    const unreadable = { unreadable: { type: "file", path: "./unreadable.yaml" } };
    let content = stringify({ "proxy-providers": badFirst ? { ...unreadable, ...direct } : { ...direct, ...unreadable },
      "rule-providers": { linked: { type: "file", path: "./linked.yaml" } } });
    const f = await fixture({ configs: { "main.yaml": content },
      readRuntimeDependencies: async () => ({ content, uncertain: false, hasSuccessfulRecord: true }) });
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const original = await f.service.create("proxy", "old.yaml");
    await f.service.create("proxy", "other.yaml");
    await symlink(join(f.providerDir, "other.yaml"), join(f.root, "unreadable.yaml"));
    await link(join(f.providerDir, "old.yaml"), join(f.root, "linked.yaml"));
    let item = (await f.service.previewCleanup()).files.find((entry) => entry.fileName === "old.yaml")!;
    assert.deepEqual(item.configReferences, [
      { configName: "main.yaml", kind: "identity", path: "./linked.yaml" },
      { configName: "main.yaml", kind: "path", path: "./providers/old.yaml" },
      { configName: "main.yaml", kind: "unreadable" },
    ]);
    assert.deepEqual(item.runtime, { references: [
      { kind: "path", path: "./providers/old.yaml" }, { kind: "identity", path: "./linked.yaml" },
    ], uncertain: true, scanComplete: false, hasSuccessfulRecord: true, unknownReason: "record_unreadable" });
    await assert.rejects(f.service.delete("proxy", "old.yaml", original.sha256), ProviderFileReferencedError);
    f.configs.clear();
    await assert.rejects(f.service.delete("proxy", "old.yaml", original.sha256), ProviderRuntimeReferenceError);
    content = stringify({ "proxy-providers": unreadable });
    item = (await f.service.previewCleanup()).files.find((entry) => entry.fileName === "old.yaml")!;
    assert.equal(item.reason, "runtime_unknown");
    assert.equal(item.runtime?.scanComplete, false);
    assert.equal((await f.service.cleanup([item])).files[0]?.action, "keep");
    assert.equal((await f.service.read("proxy", "old.yaml")).sha256, original.sha256);
  }
});

test("selected cleanup deletes only chosen controlled files and keeps automatic cleanup protections", async (t) => {
  const f = await fixture({ configs: { "source.yaml": "proxies: [{name: fixture, type: direct}]\n" },
    readRuntimeDependencies: async () => ({ content: null, uncertain: true }) });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.service.create("proxy", "selected.yaml");
  await f.service.create("proxy", "unselected.yaml");
  await f.service.createLocalExtraction({ configName: "source.yaml", sourceSha256: (await f.store.read("source.yaml")).sha256, fileName: "derived.yaml" });
  f.configs.set("reference.yaml", "proxy-providers:\n  p: {type: file, path: ./providers/selected.yaml}\n");
  const preview = await f.service.previewCleanup({ category: "proxy" });
  const selected = preview.files.filter((file) => file.fileName !== "unselected.yaml");
  assert.equal((await f.service.cleanup(selected)).files.every((file) => file.action === "keep"), true);
  assert.equal((await f.service.cleanup(selected, true)).files.every((file) => file.action === "deleted"), true);
  assert.equal((await f.service.read("unselected.yaml")).fileName, "unselected.yaml");
  assert.ok(f.configs.get("reference.yaml")?.includes("selected.yaml"));
  assert.ok((f.service.localExtractions()).some((entry) => entry.fileName === "derived.yaml"));
  const baseline = await f.service.previewCleanup({ category: "proxy" });
  await rename(join(f.providerDir, "unselected.yaml"), join(f.providerDir, "held"));
  await writeFile(join(f.providerDir, "unselected.yaml"), "proxies:\n");
  assert.equal((await f.service.cleanup(baseline.files, true)).files[0]?.reason, "changed");
});

test("selected cleanup rechecks content and identity inside the delete transaction", async (t) => {
  for (const change of ["content", "identity"] as const) {
    const original = "proxies: []\n";
    const replacement = change === "content" ? "proxies:\n" : original;
    const f = await fixture({ afterOperationPhase: async (operation, phase) => {
      if (operation !== "delete" || phase !== "prepared") return;
      const path = join(f.providerDir, "selected.yaml");
      if (change === "identity") await rename(path, join(f.providerDir, "held"));
      await writeFile(path, replacement);
    } });
    t.after(() => rm(f.root, { recursive: true, force: true }));
    await writeFile(join(f.providerDir, "selected.yaml"), original);
    const preview = await f.service.previewCleanup({ category: "proxy" });
    const result = await f.service.cleanup(preview.files, true);
    assert.equal(result.files[0]?.action, "keep");
    assert.equal(result.files[0]?.reason, "changed");
    assert.equal(await readFile(join(f.providerDir, "selected.yaml"), "utf8"), replacement);
    assert.equal(JSON.parse(await readFile(f.service.options.statePath, "utf8")).operationJournal, null);
  }
});

test("selected external deletion recovers by explicit commit phase", async (t) => {
  for (const phase of ["prepared", "backed-up", "committed"]) {
    let fail = true;
    const f = await fixture({ afterOperationPhase: async (operation, current) => {
      if (fail && operation === "delete" && current === phase) throw new Error("injected stop");
    } });
    t.after(() => rm(f.root, { recursive: true, force: true }));
    await writeFile(join(f.providerDir, "external.yaml"), "proxies: []\n");
    const preview = await f.service.previewCleanup({ category: "proxy" });
    await f.service.cleanup(preview.files, true).catch(() => undefined);
    fail = false;
    const recovered = new ProviderFileService(f.service.options); await recovered.init();
    if (phase === "committed") await assert.rejects(readFile(join(f.providerDir, "external.yaml")), { code: "ENOENT" });
    else assert.equal(await readFile(join(f.providerDir, "external.yaml"), "utf8"), "proxies: []\n");
    assert.equal(JSON.parse(await readFile(f.service.options.statePath, "utf8")).operationJournal, null);
  }
});

async function maintainedCleanupFixture(t: { after: (callback: () => Promise<unknown>) => void }) {
  const source = "mode: direct\nproxies: [{name: fixture, type: direct}]\n";
  const f = await fixture({ configs: { "local-source.yaml": source } });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  let service = f.service;
  let subscriptions = new SubscriptionService({
    statePath: join(f.root, "subscriptions.json"), providerDir: f.providerDir, dataDir: f.root,
    requestTimeoutMs: 1000, maxResponseBytes: 4096, writeQueue: f.writeQueue,
    fetchImpl: async () => new Response(source),
    publishProvider: (identity, commit) => service.publishSubscriptionProvider(identity, commit),
    assertProviderReservationAvailable: (identity) => service.assertSubscriptionReservationAvailable(identity),
    ensureProviderOwnershipReady: () => service.ensureProviderOperationRecovered(),
    assertProviderIdentity: (identity) => service.assertSubscriptionPublish(identity),
    readConfigFile: (name) => f.store.read(name),
    syncConfigFile: async (name, content) => { f.configs.set(name, content); return f.store.read(name); },
  });
  await subscriptions.init();
  service.options.subscriptions = () => subscriptions.list();
  service.options.clearSubscriptionProviderUnqueued = (identity) => subscriptions.clearProviderFileUnqueued(identity);
  const subscription = await subscriptions.create({ name: "subscription-source", url: "https://fixture.invalid/source",
    extractProvider: true, providerName: "subscription-body", autoUpdate: false, intervalMinutes: 60 });
  await subscriptions.updateNow(subscription.id);
  assert.equal(subscriptions.list()[0]?.status, "success");
  await service.createLocalExtraction({ configName: "local-source.yaml",
    sourceSha256: (await f.store.read("local-source.yaml")).sha256, fileName: "local-body.yaml" });
  const local = service.localExtractions()[0]!;
  const restart = async () => {
    subscriptions = new SubscriptionService(subscriptions.options); await subscriptions.init();
    service = new ProviderFileService(service.options); await service.init(); return service;
  };
  const regenerate = async (kind: "local" | "subscription") => {
    if (kind === "local") return service.regenerateLocalExtractionsForConfig(local.configName, (await f.store.read(local.configName)).sha256);
    const owner = subscriptions.list()[0]!;
    return subscriptions.regenerateProvidersForConfig(owner.configFileName!, (await f.store.read(owner.configFileName!)).sha256);
  };
  return { ...f, get subscriptions() { return subscriptions; }, local, restart, regenerate };
}

test("selected maintained bodies rebuild through their original flows and refuse unexpected files", async (t) => {
  const f = await maintainedCleanupFixture(t);
  const kept = await f.service.create("proxy", "unselected.yaml");
  const preview = await f.service.previewCleanup({ category: "proxy" });
  const selected = preview.files.filter((item) => item.fileName !== kept.fileName);
  const originalBodies = new Map(await Promise.all(selected.map(async (item) =>
    [item.fileName, await readFile(join(f.providerDir, item.fileName), "utf8")] as const)));
  const result = await f.service.cleanup(selected, true);
  assert.equal(result.files.every((item) => item.action === "deleted"), true);
  assert.equal(f.service.localExtractions()[0]?.providerSha256, null);
  assert.equal(f.subscriptions.list()[0]?.providerSha256, null);
  assert.equal(f.subscriptions.list()[0]?.extractProvider, true);
  assert.equal(f.service.localExtractions()[0]?.enabled, true);
  assert.equal((await f.service.read(kept.fileName)).sha256, kept.sha256);
  for (const kind of ["local", "subscription"] as const) {
    const fileName = kind === "local" ? "local-body.yaml" : "subscription-body.yaml";
    const path = join(f.providerDir, fileName);
    await assert.rejects(readFile(path), { code: "ENOENT" });
    // A file appearing after the confirmed deletion is not ours to overwrite.
    await writeFile(path, originalBodies.get(fileName)!);
    await assert.rejects(f.regenerate(kind), (error) => error instanceof ProviderFileConflictError || error instanceof ProviderFileReadOnlyError);
    assert.equal(await readFile(path, "utf8"), originalBodies.get(fileName));
    await unlink(path);
    await f.regenerate(kind);
    const regenerated = await f.service.read(fileName);
    assert.equal(regenerated.source, kind);
    await rename(path, path + ".held");
    await assert.rejects(f.regenerate(kind), ProviderFileConflictError); // Unconfirmed removal must remain a conflict.
    await rename(path + ".held", path);
    await writeFile(path, "proxies: [{name: replaced, type: direct}]\n");
    await assert.rejects(f.regenerate(kind), ProviderFileConflictError);
    assert.match(await readFile(path, "utf8"), /name: replaced/);
  }
});

test("maintained cleanup recovery changes absence metadata only after commit", async (t) => {
  for (const phase of ["backed-up", "committed", "subscription-state-written"]) {
    const f = await maintainedCleanupFixture(t);
    let fail = true;
    f.service.options.afterOperationPhase = async (operation, current) => {
      if (fail && operation === "delete" && current === phase) throw new Error("injected stop");
    };
    f.service.options.clearSubscriptionProviderUnqueued = async (identity) => {
      await f.subscriptions.clearProviderFileUnqueued(identity);
      if (fail && phase === "subscription-state-written") throw new Error("injected state stop");
    };
    for (const kind of ["local", "subscription"] as const) {
      if (phase === "subscription-state-written" && kind === "local") continue;
      const service = await f.restart();
      const fileName = kind === "local" ? "local-body.yaml" : "subscription-body.yaml";
      const preview = await service.previewCleanup({ category: "proxy" });
      fail = true;
      await service.cleanup(preview.files.filter((item) => item.fileName === fileName), true).catch(() => undefined);
      fail = false;
      const recovered = await f.restart();
      const digest = kind === "local" ? recovered.localExtractions()[0]?.providerSha256 : f.subscriptions.list()[0]?.providerSha256;
      if (phase === "backed-up") {
        assert.equal(digest, (await recovered.read(fileName)).sha256);
      } else {
        assert.equal(digest, null);
        await assert.rejects(readFile(join(f.providerDir, fileName)), { code: "ENOENT" });
        await f.regenerate(kind);
        assert.equal((await recovered.read(fileName)).source, kind);
      }
      assert.equal(JSON.parse(await readFile(service.options.statePath, "utf8")).operationJournal, null);
    }
  }
});

test("cleanup retains shared, maintained, external and recorded runtime dependencies and rechecks identity", async (t) => {
  let runtime = { content: 'proxy-providers:\n  running: {type: file, path: ./providers/running.yaml}\n', uncertain: false };
  const f = await fixture({ readRuntimeDependencies: async () => runtime });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const name of ['unused', 'shared', 'running', 'changed', 'later']) await f.service.create('proxy', `${name}.yaml`);
  await writeFile(join(f.providerDir, 'external.yaml'), 'proxies: []\n');
  const reference = (name: string) => `proxy-providers:\n  source: {type: file, path: ./providers/${name}.yaml}\n`;
  f.configs.set('shared.yaml', reference('shared'));
  const plan = await f.service.previewCleanup({ category: 'proxy' });
  const byName = (name: string) => plan.files.find((item) => item.fileName === `${name}.yaml`)!;
  assert.equal(byName('unused').action, 'delete');
  assert.equal(byName('external').reason, 'ownership_unknown');
  assert.equal(byName('shared').reason, 'referenced');
  assert.equal(byName('running').reason, 'runtime_reference');
  await assert.rejects(f.service.delete('proxy', 'running.yaml', byName('running').sha256), ProviderRuntimeReferenceError);
  // Same bytes in a new inode must not inherit the preview's approval.
  await rename(join(f.providerDir, 'changed.yaml'), join(f.providerDir, 'changed-held'));
  await writeFile(join(f.providerDir, 'changed.yaml'), 'proxies:\n');
  f.configs.set('later.yaml', reference('later'));
  const result = await f.service.cleanup(plan.files.filter((item) => item.action === 'delete'));
  assert.equal(result.files.find((item) => item.fileName === 'unused.yaml')?.action, 'deleted');
  assert.equal(result.files.find((item) => item.fileName === 'changed.yaml')?.reason, 'changed');
  assert.equal(result.files.find((item) => item.fileName === 'later.yaml')?.reason, 'referenced');
  runtime = { content: 'mode: direct\n', uncertain: true };
  assert.equal((await f.service.previewCleanup()).files.find((item) => item.fileName === 'changed.yaml')?.reason, 'runtime_unknown');
  runtime = { content: '[invalid', uncertain: false };
  assert.equal((await f.service.previewCleanup()).files.find((item) => item.fileName === 'changed.yaml')?.reason, 'runtime_unknown');
});

test("config deletion preview scopes dependencies, retains maintenance, and safely cleans controlled HTTP caches", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.service.create('proxy', 'exclusive.yaml');
  await f.service.create('proxy', 'orphan.yaml');
  await writeFile(join(f.ruleProviderDir, 'cache.yaml'), 'payload: []\n');
  f.configs.set('main.yaml', 'proxy-providers:\n  exclusive: {type: file, path: ./providers/exclusive.yaml}\nrule-providers:\n  cache: {type: http, path: ./ruleset/cache.yaml, url: https://example.invalid/rules}\n');
  const source = await f.store.read('main.yaml');
  const plan = await f.service.previewCleanup({ configName: source.name, expectedConfigSha256: source.sha256 });
  assert.deepEqual(plan.files.map((item) => item.fileName).sort(), ['cache.yaml', 'exclusive.yaml']);
  assert.equal(plan.files.every((item) => item.action === 'delete'), true);
  await assert.rejects(f.service.previewCleanup({ configName: source.name, expectedConfigSha256: '0'.repeat(64) }), ProviderFileConflictError);
  f.configs.delete('main.yaml');
  const result = await f.service.cleanup(plan.files);
  assert.equal(result.files.every((item) => item.action === 'deleted'), true);
  assert.deepEqual((await f.service.list()).map((item) => item.fileName), ['orphan.yaml']);
  const reload = new ProviderFileService(f.service.options); await reload.init();
  assert.equal((await reload.list()).length, 1);
});

test("dependency preview explains missing and external files and never treats absent runtime evidence as unused", async (t) => {
  const f = await fixture({ readRuntimeDependencies: async () => ({ content: null, uncertain: true }) });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const manual = await f.service.create('proxy', 'retained.yaml');
  f.configs.set('main.yaml', 'proxy-providers:\n  missing: {type: file, path: ./providers/missing.yaml}\n  external: {type: file, path: ./external.yaml}\n');
  const snapshot = await f.store.read('main.yaml');
  const preview = await f.service.previewCleanup({ configName: snapshot.name, expectedConfigSha256: snapshot.sha256 });
  assert.deepEqual(preview.files.map((item) => [item.fileName, item.reason]), [['missing.yaml', 'unreadable'], ['external.yaml', 'ownership_unknown']]);
  const cleanup = await f.service.previewCleanup({ category: 'proxy' });
  assert.equal(cleanup.files.find((item) => item.fileName === manual.fileName)?.reason, 'runtime_unknown');
  await assert.rejects(f.service.delete('proxy', manual.fileName, manual.sha256), ProviderRuntimeReferenceError);
});

test("unknown current runtime protects ordinary and configuration-coupled deletion in both categories", async (t) => {
  const f = await fixture({ readRuntimeDependencies: async () => ({ content: "mode: direct\n", uncertain: true }) });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const category of ["proxy", "rule"] as const) {
    const file = await f.service.create(category, "retained.yaml");
    const configName = `${category}.yaml`;
    f.configs.set(configName, stringify({ [`${category}-providers`]: { retained: { type: "file", path: file.referencePath } } }));
    const source = await f.store.read(configName);
    const expectedError = (error: unknown) => error instanceof ProviderRuntimeReferenceError && error.reason === "runtime_unknown";
    await assert.rejects(f.service.deleteWithConfig({ category, fileName: file.fileName, expectedSha256: file.sha256,
      configName, expectedConfigSha256: source.sha256, configContent: "mode: direct\n" }), expectedError);
    assert.equal((await f.store.read(configName)).sha256, source.sha256);
    const preview = await f.service.previewCleanup({ configName, expectedConfigSha256: source.sha256 });
    assert.equal(preview.files[0]?.reason, "runtime_unknown");
    f.configs.delete(configName);
    await assert.rejects(f.service.delete(category, file.fileName, file.sha256), expectedError);
    assert.equal((await f.service.cleanup(preview.files)).files[0]?.reason, "runtime_unknown");
    assert.equal((await f.service.read(category, file.fileName)).sha256, file.sha256);
  }
});
