import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, stringify } from "yaml";
import { ConfigStore } from "../src/config/store.js";
import { ConfigConflictError, ConfigProviderFilesError, ConfigValidationError } from "../src/config/errors.js";
import {
  ProviderFileService,
  type ProxyCollectionCreateInput,
} from "../src/providerFiles/service.js";
import {
  ProviderFileConflictError,
  ProviderFileExistsError,
  ProviderFileNameError,
  ProviderFileReadOnlyError,
  ProviderFileReferencedError,
  ProviderFileValidationError,
} from "../src/providerFiles/errors.js";
import { WriteQueue } from "../src/writeQueue.js";

const nodes = "proxies:\n  - {name: fixture-direct, type: direct}\n";
const main = "# keep this comment\nmode: rule\nproxy-groups:\n  - {name: Route, type: select, proxies: [DIRECT]}\nrules: [MATCH,Route]\n";
const missing = main + "proxy-providers:\n  legacy:\n    type: file\n    path: ./legacy.yaml\n    health-check: {enable: true, url: https://example.invalid/check, interval: 600}\n";

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "mihomo-collection-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new WriteQueue();
  await mkdir(join(root, "configs"));
  await writeFile(join(root, "configs/default.yaml"), main);
  let validations = 0;
  const store = new ConfigStore({ configPath: join(root, "configs/default.yaml"), dataDir: root,
    mihomoBinary: process.execPath, validatorArgsPrefix: [join(dirname(fileURLToPath(import.meta.url)), "fixtures/validator.mjs"), "-"],
    validationTimeoutMs: 2000, maxContentBytes: 16384, writeQueue: queue, onChild: () => { validations++; } });
  const service = new ProviderFileService({ providerDir: join(root, "providers"), dataDir: root,
    statePath: join(root, "state/providers.json"), maxContentBytes: 16384, store, writeQueue: queue,
    readRuntimeDependencies: async () => ({ content: "mode: direct\n", uncertain: false }) });
  await service.init();
  return { root, store, service, validations: () => validations };
}

test("repair rejects an old declaration with a fresh SHA and fills the latest proxy or rule path", async (t) => {
  const { root, store, service } = await fixture(t);
  for (const category of ["proxy", "rule"] as const) {
    const directory = category === "proxy" ? "providers" : "ruleset";
    const oldDeclaration = { type: "file", path: "./" + directory + "/old.yaml", ...(category === "rule" ? { behavior: "domain", format: "yaml" } : {}) };
    const old = await store.create(category + "-path.yaml", stringify({ [category + "-providers"]: { target: oldDeclaration } }));
    const latest = await store.saveFile(old.name, old.content.replace("old.yaml", "new.yaml"), old.sha256);
    const input = { category, configName: latest.name, expectedConfigSha256: latest.sha256, name: "target",
      operationId: randomUUID(), repair: true, groupNames: [], snippet: stringify({ target: oldDeclaration }),
      content: category === "proxy" ? nodes : "payload: [example.invalid]\n" };
    await assert.rejects(service.createCollection(input), ProviderFileConflictError);
    assert.equal((await store.read(latest.name)).content, latest.content);
    await assert.rejects(readFile(join(root, directory, "old.yaml")), { code: "ENOENT" });
    await assert.rejects(service.createCollection({ ...input, expectedConfigSha256: old.sha256 }), ConfigConflictError);
    const result = await service.createCollection({ ...input, snippet: stringify({ target: { ...oldDeclaration, path: "./" + directory + "/new.yaml" } }) });
    assert.equal(result.config.content, latest.content);
    assert.equal(result.file.fileName, "new.yaml");
    assert.equal(result.file.content, input.content);
    assert.equal(await readFile(join(root, directory, "new.yaml"), "utf8"), input.content);
    await assert.rejects(readFile(join(root, directory, "old.yaml")), { code: "ENOENT" });
  }
});

test("upload and save retain missing File configs, while validation and runtime publication block them", async (t) => {
  const { store, validations } = await fixture(t);
  const created = await store.create("migration.yaml", missing);
  assert.deepEqual(created.providerIssues, [{ category: "proxy", name: "legacy", status: "missing" }]);
  assert.equal(validations(), 0);
  const saved = await store.saveFile(created.name, missing.replace("mode: rule", "mode: global"), created.sha256);
  assert.equal(saved.providerIssues?.length, 1);
  await assert.rejects(store.validate(saved.content), ConfigProviderFilesError);
  await assert.rejects(store.publishGeneratedUnqueued(saved.content), ConfigProviderFilesError);
  const unfinished = await store.create("invalid.yaml", missing + "broken: [INVALID\n");
  await assert.rejects(store.validate(unfinished.content), ConfigValidationError);
  const caches = main + "proxy-providers:\n  cache: {type: http, path: ./missing-cache.yaml, url: https://example.invalid/provider}\n  embedded: {type: inline, payload: []}\n";
  assert.equal((await store.create("http.yaml", caches)).providerIssues, undefined);
  assert.ok(validations() > 0);
});

test("File dependency errors distinguish missing, scope and unreadable, including missing leaves below symlinks", async (t) => {
  const { root, store } = await fixture(t);
  await mkdir(join(root, "directory"));
  const source = "proxy-providers:\n  missing: {type: file, path: ./absent.yaml}\n  outside: {type: file, path: ../outside.yaml}\n  directory: {type: file, path: ./directory}\n";
  assert.deepEqual((await store.providerIssues(source)).map((issue) => issue.status), ["missing", "outside_scope", "unreadable"]);
  assert.equal((await store.create("unreadable.yaml", source)).providerIssues?.length, 3);
  await assert.rejects(store.validate(source), ConfigProviderFilesError);
  if (process.platform !== "win32") {
    await symlink(tmpdir(), join(root, "linked"), "dir");
    assert.equal((await store.providerIssues("proxy-providers:\n  a: {type: file, path: ./linked/absent-fixture.yaml}\n"))[0]?.status, "outside_scope");
  }
});

test("repair without an edited declaration fills its original file and preserves source bytes and health checks", async (t) => {
  const { store, service } = await fixture(t);
  const source = await store.create("migration.yaml", missing.replace("./legacy.yaml", "./providers/legacy.yaml").replace("proxies: [DIRECT]", "proxies: [DIRECT], use: [legacy]"));
  const input: ProxyCollectionCreateInput = { configName: source.name, expectedConfigSha256: source.sha256,
    name: "legacy", content: nodes, operationId: randomUUID(), groupNames: ["Route"], repair: true };
  const result = await service.createProxyCollection(input);
  assert.equal(result.file.source, "manual");
  assert.equal(result.config.providerIssues, undefined);
  const config = parse(result.config.content);
  assert.deepEqual(config["proxy-providers"].legacy["health-check"], parse(source.content)["proxy-providers"].legacy["health-check"]);
  assert.match(result.config.content, /# keep this comment/);
  assert.deepEqual(config.rules, parse(source.content).rules);
  assert.equal(config["proxy-providers"].legacy.path, result.file.referencePath);
  assert.equal(result.file.fileName, "legacy.yaml");
  assert.equal(result.config.content, source.content);
  assert.equal(result.config.sha256, source.sha256);
  assert.equal(await store.readProviderPayload("proxy", "legacy", source.name), nodes);
  await assert.rejects(service.createProxyCollection(input), ProviderFileConflictError);
  assert.equal((await service.list()).length, 1);
});

test("proxy and rule repairs without snippets retain declared paths and controlled-directory restrictions", async (t) => {
  const { store, service, validations } = await fixture(t);
  const source = await store.create("restore-original.yaml", '# preserve source\nmode: INVALID\nproxy-providers:\n  proxy: {type: file, path: ./providers/original.yml}\nrule-providers:\n  rule: {type: file, behavior: domain, path: ./ruleset/original.yml}\n');
  for (const category of ["proxy", "rule"] as const) {
    const result = await service.createCollection({ category, configName: source.name, expectedConfigSha256: source.sha256,
      operationId: randomUUID(), name: category, repair: true, groupNames: [],
      content: category === "proxy" ? nodes : 'payload: ["example.invalid"]\n' });
    assert.equal(result.file.fileName, "original.yml");
    assert.equal(result.config.content, source.content);
    assert.equal(result.config.sha256, source.sha256);
  }
  assert.equal(validations(), 0);
  const outside = await store.create("outside-repair.yaml", missing);
  await assert.rejects(service.createProxyCollection({ configName: outside.name, expectedConfigSha256: outside.sha256,
    operationId: randomUUID(), name: "legacy", repair: true, groupNames: ["Route"], content: nodes }), ProviderFileNameError);
  assert.equal((await store.read(outside.name)).content, outside.content);
});

test("new collections bind groups, reject conflicts and main configs, and isolate names between configs", async (t) => {
  const { store, service } = await fixture(t);
  const source = await store.read();
  const input = { configName: source.name, expectedConfigSha256: source.sha256, name: "same-name", content: nodes,
    operationId: randomUUID(), groupNames: ["Route"] };
  await assert.rejects(service.createProxyCollection({ ...input, content: nodes + main }), ProviderFileValidationError);
  await assert.rejects(service.createProxyCollection({ ...input, groupNames: [] }), ProviderFileValidationError);
  await assert.rejects(service.createProxyCollection({ ...input, name: "Route" }), ProviderFileExistsError);
  const first = await service.createProxyCollection(input);
  assert.deepEqual(parse(first.config.content)["proxy-groups"][0].use, ["same-name"]);
  const secondSource = await store.create("another.yaml", main);
  const second = await service.createProxyCollection({ ...input, configName: secondSource.name, expectedConfigSha256: secondSource.sha256,
    groupNames: [], newGroupName: "New selection", operationId: randomUUID() });
  assert.notEqual(first.file.fileName, second.file.fileName);
  assert.deepEqual(parse(second.config.content)["proxy-groups"][1], { name: "New selection", type: "select", use: ["same-name"] });
  await assert.rejects(service.createProxyCollection({ ...input, expectedConfigSha256: first.config.sha256, operationId: randomUUID() }), ProviderFileExistsError);
  await assert.rejects(service.createProxyCollection({ ...input, name: "different" }), ConfigConflictError);
  const all = await store.create("all.yaml", main.replace("proxies: [DIRECT]", "include-all-providers: true"));
  const auto = await service.createProxyCollection({ ...input, configName: all.name, expectedConfigSha256: all.sha256, groupNames: [] });
  assert.equal(parse(auto.config.content)["proxy-groups"][0].use, undefined);
});

test("restoring unchanged proxy and rule declarations preserves source bytes and leaves Core errors for explicit validation", async (t) => {
  const { store, service, validations } = await fixture(t);
  // The fixture validator rejects INVALID, while both missing declarations are valid YAML.
  const source = await store.create("restore.yaml", '# preserve formatting\nmode: INVALID\nproxy-providers:\n  proxy: {type: file, path: ./providers/restore.yaml}\nrule-providers:\n  rule: {type: file, behavior: domain, path: ./ruleset/restore.yaml}\n');
  for (const category of ["proxy", "rule"] as const) {
    const declaration = parse(source.content)[`${category}-providers`][category];
    const result = await service.createCollection({ category, configName: source.name, expectedConfigSha256: source.sha256,
      operationId: randomUUID(), name: category, repair: true, groupNames: [],
      snippet: stringify({ [category]: declaration }), content: category === "proxy" ? nodes : 'payload: ["example.invalid"]\n' });
    assert.equal(result.config.content, source.content);
    assert.equal(result.config.sha256, source.sha256);
  }
  assert.equal(validations(), 0);
  assert.equal((await store.read(source.name)).providerIssues, undefined);
  await assert.rejects(store.validate(source.content), ConfigValidationError);
  assert.equal((await service.list()).length, 2);
});

test("missing proxy and rule bodies reuse their original manual owner without changing source bytes", async (t) => {
  const { root, store, service, validations } = await fixture(t);
  for (const category of ["proxy", "rule"] as const) {
    const body = category === "proxy" ? nodes : 'payload: ["example.invalid"]\n';
    const file = await service.create(category, "restore-owned.yaml", body);
    await unlink(join(root, file.referencePath));
  }
  const source = await store.create("restore-owned.yaml", '# keep original bytes\nmode: INVALID\nproxy-providers:\n  proxy: {type: file, path: ./providers/restore-owned.yaml}\nrule-providers:\n  rule: {type: file, behavior: domain, path: ./ruleset/restore-owned.yaml}\n');
  const state = () => readFile(service.options.statePath, "utf8").then(JSON.parse);
  const originalOwners = (await state()).manual;
  for (const category of ["proxy", "rule"] as const) {
    const input = { category, configName: source.name, expectedConfigSha256: source.sha256,
      operationId: randomUUID(), name: category, repair: true, groupNames: [],
      snippet: stringify({ [category]: parse(source.content)[`${category}-providers`][category] }),
      content: category === "proxy" ? nodes : 'payload: ["example.invalid"]\n' };
    await assert.rejects(service.create(category, "restore-owned.yaml", input.content), ProviderFileExistsError);
    await assert.rejects(service.createCollection({ ...input, expectedConfigSha256: "0".repeat(64) }), ConfigConflictError);
    const restored = await service.createCollection(input);
    assert.equal(restored.file.content, input.content);
    assert.equal(restored.file.source, "manual");
    assert.equal(restored.config.content, source.content);
    assert.equal(restored.config.sha256, source.sha256);
    await assert.rejects(service.createCollection({ ...input, content: input.content + "# replacement\n" }), ProviderFileConflictError);
    assert.equal(await readFile(join(root, restored.file.referencePath), "utf8"), input.content);
    assert.deepEqual((await state()).manual, originalOwners);
    const preference = await service.setCollectionReadOnly({ category, configName: source.name, name: category,
      readOnly: true, expectedVersion: service.collectionPreferences().version });
    await unlink(join(root, restored.file.referencePath));
    await assert.rejects(service.createCollection(input), ProviderFileReadOnlyError);
    await writeFile(join(root, restored.file.referencePath), input.content, { flag: "wx" });
    await service.setCollectionReadOnly({ category, configName: source.name, name: category,
      readOnly: false, expectedVersion: preference.version });
  }
  assert.equal(validations(), 0);
  assert.equal((await store.read(source.name)).providerIssues, undefined);
  assert.equal(await readFile(join(root, "configs", source.name), "utf8"), source.content);
});

test("manual missing-body repair recovers each publication phase without losing or duplicating ownership", async (t) => {
  for (const category of ["proxy", "rule"] as const) {
    for (const phase of ["prepared", "staged", "published", "committed"]) {
      await t.test(`${category}/${phase}`, async (t) => {
        const { root, store, service } = await fixture(t);
        const body = category === "proxy" ? nodes : 'payload: ["example.invalid"]\n';
        const file = await service.create(category, "recover-owned.yaml", body);
        const path = join(root, file.referencePath);
        await unlink(path);
        const declaration = { type: "file", path: file.referencePath, ...(category === "rule" ? { behavior: "domain" } : {}) };
        const source = await store.create("recover.yaml", stringify({ [`${category}-providers`]: { restored: declaration } }));
        const owners = JSON.parse(await readFile(service.options.statePath, "utf8")).manual;
        const input = { category, configName: source.name, expectedConfigSha256: source.sha256, name: "restored",
          operationId: randomUUID(), repair: true, groupNames: [], snippet: stringify({ restored: declaration }), content: body };
        let interrupted = false;
        service.options.afterOperationPhase = async (operation, current) => {
          if (!interrupted && operation === "create" && current === phase) {
            interrupted = true;
            throw new Error("fixture interruption");
          }
        };
        await assert.rejects(service.createCollection(input), /fixture interruption/);
        const reloaded = new ProviderFileService({ ...service.options });
        await reloaded.init();
        const state = JSON.parse(await readFile(service.options.statePath, "utf8"));
        assert.deepEqual(state.manual, owners);
        assert.equal(state.operationJournal, null);
        if (phase === "committed") assert.equal(await readFile(path, "utf8"), body);
        else {
          await assert.rejects(readFile(path), { code: "ENOENT" });
          await reloaded.createCollection(input);
        }
        assert.equal((await store.read(source.name)).sha256, source.sha256);
        assert.deepEqual(JSON.parse(await readFile(service.options.statePath, "utf8")).manual, owners);
        assert.deepEqual(await readdir(dirname(path)), [file.fileName]);
      });
    }
  }
});

test("missing manual restoration rejects changed ownership, HTTP cache paths and publication collisions", async (t) => {
  for (const category of ["proxy", "rule"] as const) {
    await t.test(category, async (t) => {
      const { root, store, service } = await fixture(t);
      const content = category === "proxy" ? nodes : 'payload: ["example.invalid"]\n';
      const file = await service.create(category, "guarded.yaml", content);
      const path = join(root, file.referencePath);
      await unlink(path);
      const declaration = { type: "file", path: file.referencePath, ...(category === "rule" ? { behavior: "domain" } : {}) };
      const source = await store.create("guarded.yaml", stringify({ [`${category}-providers`]: { guarded: declaration } }));
      const input = { category, configName: source.name, expectedConfigSha256: source.sha256, name: "guarded",
        operationId: randomUUID(), repair: true, groupNames: [], snippet: stringify({ guarded: declaration }), content };
      const savedState = JSON.parse(await readFile(service.options.statePath, "utf8"));
      await writeFile(service.options.statePath, JSON.stringify({ ...savedState,
        manual: [...savedState.manual, { category, fileName: file.fileName }] }));
      const ambiguous = new ProviderFileService({ ...service.options });
      await ambiguous.init();
      await assert.rejects(ambiguous.createCollection(input), ProviderFileExistsError);
      if (category === "proxy") {
        await writeFile(service.options.statePath, JSON.stringify({ ...savedState, local: [{ id: "fixture-extraction",
          configName: source.name, sourceSha256: source.sha256, fileName: file.fileName, providerSha256: file.sha256,
          enabled: true, nodeCount: 1, filterSettings: { version: 0, enabled: false, rules: [] } }] }));
        const maintained = new ProviderFileService({ ...service.options });
        await maintained.init();
        await assert.rejects(maintained.createCollection(input), ProviderFileReadOnlyError);
      }
      await writeFile(service.options.statePath, JSON.stringify(savedState));
      const restored = new ProviderFileService({ ...service.options });
      await restored.init();
      restored.options.beforeFileRename = () => writeFile(path, content + "# appeared concurrently\n", { flag: "wx" });
      await assert.rejects(restored.createCollection(input), ProviderFileExistsError);
      assert.equal(await readFile(path, "utf8"), content + "# appeared concurrently\n");
      assert.deepEqual(JSON.parse(await readFile(service.options.statePath, "utf8")).manual, savedState.manual);
      await unlink(path);
      // The surviving manual owner cannot turn an HTTP cache back into an editable File.
      await writeFile(join(root, "configs/cache.yaml"), stringify({ [`${category}-providers`]: {
        cache: { ...declaration, type: "http", url: "https://example.invalid/provider" },
      } }));
      await assert.rejects(restored.createCollection(input), ProviderFileReadOnlyError);
      assert.equal((await store.read(source.name)).sha256, source.sha256);
    });
  }
});

test("a missing generated body can be repaired using its original import operation and manual owner", async (t) => {
  const { root, store, service } = await fixture(t);
  const source = await store.read();
  const identity = { category: "proxy" as const, configName: source.name, name: "generated", operationId: randomUUID() };
  const snippet = service.collectionUploadDeclaration(identity);
  const created = await service.createCollection({ ...identity, snippet, expectedConfigSha256: source.sha256, groupNames: ["Route"], content: nodes });
  await unlink(join(root, created.file.referencePath));
  const restored = await service.createCollection({ ...identity, snippet, expectedConfigSha256: created.config.sha256,
    groupNames: [], repair: true, content: nodes });
  assert.equal(restored.file.fileName, created.file.fileName);
  assert.equal(restored.config.sha256, created.config.sha256);
  assert.equal((await service.list()).length, 1);
});

test("failed configuration publication rolls the file back, and retry succeeds once", async (t) => {
  const { root, store, service } = await fixture(t);
  const snapshot = await store.read();
  const input = { configName: snapshot.name, expectedConfigSha256: snapshot.sha256, operationId: randomUUID(), name: "test", content: nodes, groupNames: ["Route"] };
  const save = store.saveFileUnqueued.bind(store);
  store.saveFileUnqueued = async () => { throw new Error("fixture write failure"); };
  await assert.rejects(service.createProxyCollection(input));
  assert.equal((await store.read()).sha256, snapshot.sha256);
  assert.deepEqual(await readdir(join(root, "providers")), []);
  store.saveFileUnqueued = save;
  await service.createProxyCollection(input);
  assert.equal((await service.list()).length, 1);
});

test("recovery after config commit restores manual ownership and repeated import returns the same file", async (t) => {
  const { store, service } = await fixture(t);
  const source = await store.read();
  let fail = true;
  service.options.beforeStateRename = async () => {
    if (fail && (await store.read()).sha256 !== source.sha256) { fail = false; throw new Error("fixture catalog failure"); }
  };
  const input = { configName: source.name, expectedConfigSha256: source.sha256, operationId: randomUUID(), name: "test", content: nodes, groupNames: ["Route"] };
  await assert.rejects(service.createProxyCollection(input));
  const reloaded = new ProviderFileService({ ...service.options });
  await reloaded.init();
  const saved = await reloaded.createProxyCollection(input);
  assert.equal(saved.file.source, "manual");
  assert.equal((await reloaded.list()).length, 1);
});

test("a missing dependency in another config does not claim unrelated manual files", async (t) => {
  const { store, service } = await fixture(t);
  await store.create("incomplete.yaml", missing);
  const unrelated = await service.create("proxy", "unrelated.yaml", nodes);
  await service.delete("proxy", unrelated.fileName, unrelated.sha256);
  const referenced = await service.create("proxy", "referenced.yaml", nodes);
  await store.create("references.yaml", main + `proxy-providers:\n  used: {type: file, path: ${referenced.referencePath}}\n`);
  await assert.rejects(service.delete("proxy", referenced.fileName, referenced.sha256), ProviderFileReferencedError);
});

test("rule imports publish payload and RULE-SET atomically and preserve ordering on retry", async (t) => {
  const { store, service } = await fixture(t);
  const source = await store.create("rules.yaml", main.replace("rules: [MATCH,Route]", 'rules: ["MATCH,Route"]'));
  const input = { category: "rule" as const, configName: source.name, expectedConfigSha256: source.sha256, operationId: randomUUID(), name: "rules", content: 'payload: ["example.invalid"]\n', groupNames: [], behavior: "domain", ruleSetRules: ["RULE-SET,rules,Route"] };
  const saved = await service.createCollection(input);
  assert.deepEqual(parse(saved.config.content).rules, ["RULE-SET,rules,Route", "MATCH,Route"]);
  assert.equal(parse(saved.config.content)["rule-providers"].rules.format, "yaml");
  assert.equal(saved.file.category, "rule");
  assert.equal((await service.createCollection(input)).file.fileName, saved.file.fileName);
  await assert.rejects(service.createCollection({ ...input, operationId: randomUUID(), name: "unused", expectedConfigSha256: saved.config.sha256, ruleSetRules: [] }), ProviderFileValidationError);
});

test("upload replacement checks source and file versions plus ordinary File and display read-only permissions", async (t) => {
  const { store, service } = await fixture(t);
  const file = await service.create("proxy", "replace.yaml", nodes);
  const source = await store.create("replace.yaml", main + `proxy-providers:\n  replace: {type: file, path: ${file.referencePath}}\n`);
  const content = nodes + "# replacement\n";
  const input = { category: "proxy" as const, configName: source.name, expectedConfigSha256: source.sha256, operationId: randomUUID(), name: "replace", content, groupNames: [], replace: true, targetFileName: file.fileName, expectedFileSha256: file.sha256 };
  await assert.rejects(service.createCollection({ ...input, expectedConfigSha256: "stale" }));
  await assert.rejects(service.createCollection({ ...input, expectedFileSha256: "stale" }));
  const pref = await service.setCollectionReadOnly({ configName: source.name, category: "proxy", name: "replace", readOnly: true, expectedVersion: 0 });
  await assert.rejects(service.createCollection(input));
  await service.setCollectionReadOnly({ configName: source.name, category: "proxy", name: "replace", readOnly: false, expectedVersion: pref.version });
  const replaced = await service.createCollection(input);
  assert.equal(replaced.config.sha256, source.sha256);
  assert.equal(replaced.file.content, content);
  await assert.rejects(service.createCollection(input));
  await store.create("cache.yaml", main + `proxy-providers:\n  cache: {type: http, path: ${file.referencePath}, url: https://example.invalid}\n`);
  await assert.rejects(service.createCollection({ ...input, expectedFileSha256: replaced.file.sha256 }));
  assert.equal((await service.read("proxy", file.fileName)).content, content);
});

test("uploaded declarations persist names, settings, paths and references together with the selected body", async (t) => {
  const { store, service } = await fixture(t);
  const source = await store.read();
  const identity = { category: "proxy" as const, configName: source.name, name: "upload", operationId: randomUUID() };
  const generated = parse(service.collectionUploadDeclaration(identity));
  const declaration = { ...generated.upload, "health-check": { enable: false, interval: 600 }, filter: "fixture" };
  const input = { ...identity, expectedConfigSha256: source.sha256, content: nodes, groupNames: ["Route"], snippet: stringify({ renamed: declaration }) };
  const saved = await service.createCollection(input);
  assert.equal(saved.name, "renamed");
  assert.deepEqual(parse(saved.config.content)["proxy-providers"].renamed, declaration);
  assert.deepEqual(parse(saved.config.content)["proxy-groups"][0].use, ["renamed"]);
  assert.equal(saved.file.content, nodes);
  assert.equal((await service.createCollection(input)).file.fileName, saved.file.fileName);
  const replace = { ...input, name: "renamed", operationId: randomUUID(), expectedConfigSha256: saved.config.sha256,
    replace: true, targetFileName: saved.file.fileName, expectedFileSha256: saved.file.sha256, content: nodes + "# uploaded replacement\n",
    snippet: stringify({ final: { ...declaration, path: "./providers/final.yaml", filter: "changed" } }) };
  const replaced = await service.createCollection(replace);
  assert.equal(replaced.file.fileName, "final.yaml");
  assert.equal(replaced.file.content, replace.content);
  assert.deepEqual(parse(replaced.config.content)["proxy-groups"][0].use, ["final"]);
  assert.equal(parse(replaced.config.content)["proxy-providers"].final.filter, "changed");
  const bad = { ...replace, name: "final", targetFileName: replaced.file.fileName, expectedFileSha256: replaced.file.sha256,
    expectedConfigSha256: replaced.config.sha256, content: nodes + "# must rollback\n", groupNames: ["missing"],
    snippet: stringify({ final: { ...declaration, path: replaced.file.referencePath } }) };
  await assert.rejects(service.createCollection(bad));
  assert.equal((await service.read("proxy", replaced.file.fileName)).content, replaced.file.content);
  assert.equal((await store.read()).sha256, replaced.config.sha256);
  await assert.rejects(service.createCollection({ ...bad, snippet: stringify({ final: { type: "file", path: "../escape.yaml" } }) }));
});

test("rule upload declaration controls behavior and supports repairing a missing controlled file", async (t) => {
  const { store, service } = await fixture(t);
  const source = await store.create("missing-rule.yaml", 'rules: ["RULE-SET,old,DIRECT", "MATCH,DIRECT"]\nrule-providers:\n  old: {type: file, behavior: domain, format: yaml, path: ./ruleset/missing.yaml}\n');
  const saved = await service.createCollection({ category: "rule", configName: source.name, expectedConfigSha256: source.sha256,
    operationId: randomUUID(), name: "old", repair: true, content: 'payload: ["example.invalid"]\n', groupNames: [],
    snippet: 'fixed: {type: file, behavior: domain, format: yaml, path: ./ruleset/missing.yaml, size-limit: 5000}\n' });
  assert.equal(saved.file.fileName, "missing.yaml");
  assert.deepEqual(parse(saved.config.content).rules, ["RULE-SET,fixed,DIRECT", "MATCH,DIRECT"]);
  assert.equal(parse(saved.config.content)["rule-providers"].fixed["size-limit"], 5000);
  assert.equal(saved.config.providerIssues, undefined);
});
