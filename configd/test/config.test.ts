import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { coreDiagnostics } from "../src/config/diagnostics.js";

test("Core diagnostics allowlist never returns raw names, paths, credentials or body excerpts", () => {
  const sensitive = "https://example.invalid/private?token=credential-fixture";
  for (const output of [
    `proxy group[0]: ${sensitive}: \`use\` or \`proxies\` missing`,
    `rules[1] [${sensitive}] error: proxy [credential-fixture] not found`,
    `parse proxy provider ${sensitive} error: yaml: line 42: credential-fixture`,
    `unknown ${sensitive}`,
  ]) {
    const diagnostics = coreDiagnostics(output);
    assert.ok(diagnostics.length);
    assert.doesNotMatch(JSON.stringify(diagnostics), /credential-fixture|example.invalid|line 42/);
    assert.equal(diagnostics[0]!.path, undefined);
  }
  assert.equal(coreDiagnostics("proxy group[0]: sample: `use` or `proxies` missing")[0]!.code, "empty_proxy_group");
});

test("Core circular diagnostics require structural errors, not loop words in types, names or paths", () => {
  const logged = (message: string) => `time="2026-09-26T00:00:00Z" level=error msg="${message}"\nconfiguration file /tmp/cycle-loop.yaml test failed\n`;
  for (const [output, code] of [
    ["proxy 0: unsupport proxy type: loop", "invalid_proxy"],
    ["proxy 0: unsupport proxy type: cycle", "invalid_proxy"],
    ["proxy group[0]: loop: unsupported type", "group_type"],
    ["proxy group[0]: circular: proxy [cycle] not found", "group_reference_missing"],
    ["parse proxy provider loop error: invalid body", "invalid_provider"],
    ["open /tmp/loop-cycle-circular.yaml: permission denied", "core_validation_failed"],
    ["unknown cycle or loop", "core_validation_failed"],
    ["proxy 0: loop is detected in ProxyGroup, please check following ProxyGroups: [A B]", "invalid_proxy"],
  ]) {
    assert.equal(coreDiagnostics(logged(output!))[0]!.code, code);
  }
  for (const message of [
    "loop is detected in ProxyGroup, please check following ProxyGroups: [A B]",
    "sub-rule error: circular references [A->B->A]",
  ]) {
    assert.equal(coreDiagnostics(message)[0]!.code, "circular_reference");
    assert.equal(coreDiagnostics(logged(message))[0]!.code, "circular_reference");
    assert.doesNotMatch(JSON.stringify(coreDiagnostics(logged(message))), /A->B|A B|\/tmp/);
  }
});

test("missing rule declaration diagnostics locate only a rule matched against the validated body", () => {
  const rule = 'RULE-SET,示例规则,DIRECT';
  const content = `rules:\n  - MATCH,DIRECT\n  - ${rule}\n`;
  const message = `rules[1] [${rule}] error: rule set [示例规则] not found`;
  const logged = `time="2026-09-27T00:00:00Z" level=error msg=${JSON.stringify(message)}`;
  for (const output of [message, logged]) {
    const result = coreDiagnostics(output, content);
    assert.deepEqual(result[0]!.path, ["rules", 1]);
    assert.doesNotMatch(JSON.stringify(result), /示例规则|DIRECT/);
    assert.equal(coreDiagnostics(output)[0]!.path, undefined);
    assert.equal(coreDiagnostics(output, content.replace(rule, "MATCH,REJECT"))[0]!.path, undefined);
    assert.equal(coreDiagnostics(output, content + 'rule-providers: {示例规则: {type: inline}}\n')[0]!.path, undefined);
    assert.equal(coreDiagnostics(output, "rules: [*unknown]\n")[0]!.path, undefined);
    assert.equal(coreDiagnostics(output, "rules: []\n")[0]!.path, undefined);
  }
  assert.equal(coreDiagnostics(`parse rule provider fixture error: ${message}`, content)[0]!.path, undefined);
});
import { createServer, type Server } from "node:http";
import {
  ConfigConflictError,
  ConfigFileExistsError,
  ConfigTooLargeError,
  ConfigValidationError,
  ConfigValidationTimeoutError,
  ConfigProviderFilesError,
  SubscriptionDownloadError,
} from "../src/config/errors.ts";
import { ConfigStore } from "../src/config/store.ts";
import { createConfigdServer } from "../src/server.ts";
import { ProviderFileService } from "../src/providerFiles/service.ts";
import { SubscriptionService, type SubscriptionServiceOptions } from "../src/subscriptions/service.ts";
import type { PublicSubscription } from "../src/subscriptions/types.ts";
import { WriteQueue } from "../src/writeQueue.ts";
import { ManagerSettingsService } from "../src/managerSettings/service.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function within<T>(operation: Promise<T>, timeoutMs = 1500) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function listenSafe(server: Server, startPort: number) {
  for (let port = startPort; port < startPort + 20; port += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", onError);
          resolve();
        });
      });
      return port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("no test port available");
}

async function fixtureStore(options: { timeout?: number; maxBytes?: number; onChild?: (pid: number | undefined) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mihomo-configd-test-"));
  const configPath = join(root, "config.yaml");
  const marker = join(root, "child-terminated");
  const writeQueue = new WriteQueue();
  await cp(join(fixtureDir, "config.yaml"), configPath);
  const store = new ConfigStore({
    configPath,
    mihomoBinary: process.execPath,
    dataDir: root,
    validationTimeoutMs: options.timeout ?? 1000,
    maxContentBytes: options.maxBytes ?? 4096,
    writeQueue,
    validatorArgsPrefix: [join(fixtureDir, "validator.mjs"), marker],
    ...(options.onChild ? { onChild: (child) => options.onChild?.(child.pid) } : {}),
  });
  return { root, configPath, marker, store, writeQueue };
}

async function providerOwnershipOptions(
  root: string,
  store: ConfigStore,
  writeQueue: WriteQueue,
  subscriptions: () => PublicSubscription[],
  beforeFileRename?: () => Promise<void>,
): Promise<Pick<SubscriptionServiceOptions,
  "publishProvider" | "ensureProviderOwnershipReady" | "assertProviderReservationAvailable"
>> {
  const providerFiles = new ProviderFileService({
    providerDir: join(root, "providers"),
    statePath: join(root, "provider-files.json"),
    dataDir: root,
    maxContentBytes: 4096,
    writeQueue,
    store,
    subscriptions,
    ...(beforeFileRename ? { beforeFileRename } : {}),
  });
  await providerFiles.init();
  return {
    publishProvider: (identity, commitState) =>
      providerFiles.publishSubscriptionProvider(identity, commitState),
    ensureProviderOwnershipReady: () => providerFiles.ensureProviderOperationRecovered(),
    assertProviderReservationAvailable: (identity) =>
      providerFiles.assertSubscriptionReservationAvailable(identity),
  };
}

test("production configd wiring never authorizes collection cleanup from a successful historical load", { timeout: 15_000 }, async (t) => {
  const { root, configPath, store, writeQueue } = await fixtureStore();
  let child: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(configPath, "mode: direct\n");
  const manager = new ManagerSettingsService({ statePath: join(root, "manager-settings.json"),
    runtimeDir: join(root, "generated-runtime"), store, writeQueue });
  const source = await store.read();
  const generated = await manager.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: 0 });
  const pending = await manager.beginLoad({ generatedVersion: generated.version, expectedVersion: 0 });
  // Only the isolated fixture records a historical success; no Core is loaded.
  await manager.finishLoad({ attemptId: pending.lastAttempt!.id, expectedVersion: pending.version, result: "succeeded" });
  const applied = await manager.readApplied();
  assert.equal(applied.state.lastAttempt?.status, "succeeded");
  assert.equal(applied.state.lastSuccessful?.generated.version, generated.version);
  assert.equal(applied.content, "mode: direct\n");

  const reservation = createServer();
  const port = await listenSafe(reservation, 27681);
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CONFIGD_|MIHOMO_)/.test(key)) delete env[key];
  Object.assign(env, { MIHOMO_CONFIG_PATH: configPath, MIHOMO_DATA_DIR: root,
    MIHOMO_BINARY_PATH: process.execPath, MIHOMO_PROVIDER_DIR: join(root, "providers"),
    MIHOMO_RULE_PROVIDER_DIR: join(root, "ruleset"), CONFIGD_HOST: "127.0.0.1", CONFIGD_PORT: String(port) });
  child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/index.ts", import.meta.url))], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.resume();
  await within(new Promise<void>((resolve, reject) => {
    child!.once("error", reject);
    child!.once("exit", () => reject(new Error("isolated configd exited before readiness")));
    child!.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("configd listening on")) resolve(); });
  }), 5000);
  const request = (path: string, method = "GET", body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  for (const category of ["proxy", "rule"] as const) {
    const created = await request("/managed-providers", "POST", { category, fileName: "retained.yaml",
      content: category === "proxy" ? "proxies: []\n" : "payload: []\n" });
    assert.equal(created.status, 201);
    await created.arrayBuffer();
  }
  await writeFile(join(root, "selected.yaml"), "proxy-providers:\n  p: {type: file, path: ./providers/retained.yaml}\nrule-providers:\n  r: {type: file, behavior: domain, path: ./ruleset/retained.yaml}\n");
  const selected = await (await request("/files/selected.yaml")).json() as { sha256: string };
  const preview = await (await request("/files/selected.yaml/delete-preview", "POST", { expectedSha256: selected.sha256 })).json() as {
    files: Array<{ category: string; fileName: string; sha256: string; identity: string; action: string; reason: string }>;
  };
  assert.equal(preview.files.length, 2);
  assert.ok(preview.files.every((file) => file.action === "keep" && file.reason === "runtime_unknown"));
  const removed = await request("/files/selected.yaml", "DELETE", { expectedSha256: selected.sha256, cleanupFiles: preview.files });
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json() as { cleanup: unknown }).cleanup, preview);
  assert.equal((await request("/files/selected.yaml")).status, 404);
  for (const file of preview.files) {
    const direct = await request(`/managed-providers/${file.category}/${file.fileName}`, "DELETE", { expectedSha256: file.sha256 });
    assert.equal(direct.status, 409);
    assert.deepEqual(await direct.json(), { error: "runtime_unknown" });
    const cleanupPreview = await (await request("/provider-cleanup/preview", "POST", { category: file.category })).json() as typeof preview;
    assert.equal(cleanupPreview.files[0]?.reason, "runtime_unknown");
    assert.equal(await readFile(join(root, file.category === "proxy" ? "providers" : "ruleset", file.fileName), "utf8"),
      file.category === "proxy" ? "proxies: []\n" : "payload: []\n");
  }
  assert.deepEqual(await (await request("/provider-cleanup", "POST", { files: preview.files })).json(), preview);
});

test("reads configuration content and sha256", async () => {
  const { root, configPath, store } = await fixtureStore();
  const content = await readFile(configPath, "utf8");
  assert.deepEqual(await store.read(), {
    name: "config.yaml",
    path: configPath,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  const metadata = await stat(configPath);
  const listed = (await store.list()).find((entry) => entry.name === "config.yaml")!;
  assert.equal(listed.size, metadata.size);
  assert.equal(listed.updatedAt, metadata.mtime.toISOString());

  const oversized = await fixtureStore({ maxBytes: 8 });
  await assert.rejects(oversized.store.read(), ConfigTooLargeError);
  await assert.rejects(oversized.store.list(), ConfigTooLargeError);

  const siblingConfigDir = join(root, "configs");
  const siblingDataDir = join(root, "mihomo-data");
  const siblingConfigPath = join(siblingConfigDir, "sibling.yaml");
  const siblingContent = "mode: direct\n";
  await mkdir(siblingConfigDir);
  await mkdir(siblingDataDir);
  await writeFile(siblingConfigPath, siblingContent);
  const siblingStore = new ConfigStore({
    ...store.options,
    configPath: siblingConfigPath,
    dataDir: siblingDataDir,
  });
  const siblingSnapshot = await siblingStore.read();
  assert.equal(siblingSnapshot.content, siblingContent);
  assert.equal(siblingSnapshot.sha256, createHash("sha256").update(siblingContent).digest("hex"));
  const siblingMetadata = await stat(siblingConfigPath);
  assert.deepEqual(await siblingStore.list(), [{
    name: "sibling.yaml",
    path: siblingConfigPath,
    sha256: siblingSnapshot.sha256,
    size: siblingMetadata.size,
    updatedAt: siblingMetadata.mtime.toISOString(),
  }]);
});

test("configd emits lightweight changes only after configuration commits", async () => {
  const { root, store, writeQueue } = await fixtureStore();
  let failSubscriptionUpdate = false;
  const subscriptions = new SubscriptionService({
    statePath: join(root, "subscriptions.json"),
    providerDir: join(root, "providers"),
    requestTimeoutMs: 1000,
    maxResponseBytes: 4096,
    writeQueue,
    fetchImpl: async () => {
      if (failSubscriptionUpdate) throw new Error("fixture update failure");
      return new Response("mode: rule\n");
    },
    syncConfigFile: async (name, content, existing) => existing
      ? store.saveFileUnqueued(name, content, (await store.read(name)).sha256)
      : store.createUnqueued(name, content),
  });
  await subscriptions.init();
  const providerFiles = new ProviderFileService({
    providerDir: join(root, "providers"),
    statePath: join(root, "provider-files.json"),
    dataDir: root,
    maxContentBytes: 4096,
    writeQueue,
    store,
    subscriptions: () => subscriptions.list(),
    readRuntimeDependencies: async () => ({ content: "mode: direct\n", uncertain: false }),
  });
  await providerFiles.init();
  const subscription = await subscriptions.create({
    name: "Event Subscription",
    url: "https://example.invalid/redacted",
    extractProvider: false,
    mergeIntoConfig: false,
    autoUpdate: false,
    intervalMinutes: 60,
  });
  const httpConfig = await store.create("http-event.yaml", "rules: [MATCH,DIRECT]\n");
  const server = createConfigdServer({ store, subscriptions, providerFiles, maxBodyBytes: 4096 });
  const port = await listenSafe(server, 19080);
  const base = `http://127.0.0.1:${port}`;
  try {
    const changes = await fetch(`${base}/changes`);
    const reader = changes.body!.getReader();
    const decoder = new TextDecoder();
    assert.match(decoder.decode((await within(reader.read())).value), /"operation":"ready"/);
    const created = await fetch(`${base}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "event.yaml", content: "" }),
    });
    assert.equal(created.status, 201);
    const event = decoder.decode((await within(reader.read())).value);
    assert.match(event, /"operation":"create"/);
    assert.match(event, /"name":"event.yaml"/);
    assert.doesNotMatch(event, /content|url|token/i);

    await subscriptions.updateNow(subscription.id);
    const directEvent = decoder.decode((await within(reader.read())).value);
    assert.match(directEvent, /"operation":"subscription-update"/);
    assert.match(directEvent, /"name":"Event Subscription.yaml"/);
    assert.doesNotMatch(directEvent, /content|url|token|provider/i);

    failSubscriptionUpdate = true;
    await assert.rejects(subscriptions.updateNow(subscription.id));
    const pendingManualEvent = reader.read();
    const failedWindow = await Promise.race([
      pendingManualEvent.then(() => "event" as const),
      new Promise<"none">((resolve) => setTimeout(() => resolve("none"), 50)),
    ]);
    assert.equal(failedWindow, "none");
    failSubscriptionUpdate = false;
    const manual = await fetch(`${base}/subscriptions/${encodeURIComponent(subscription.id)}/update`, {
      method: "POST",
    });
    assert.equal(manual.status, 200);
    const manualEvent = decoder.decode((await within(pendingManualEvent)).value);
    assert.equal((manualEvent.match(/"operation":"subscription-update"/g) ?? []).length, 1);
    const pendingHttpEvent = reader.read();
    const duplicate = await Promise.race([
      pendingHttpEvent.then(({ done }) => !done),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(duplicate, false);

    const nextHttpConfig = [
      "proxy-providers:",
      "  fixture-http:",
      "    type: http",
      "    url: https://fixture.invalid/provider",
      "    path: ./providers/fixture-http.yaml",
      "",
    ].join("\n");
    const conflictedApply = await fetch(`${base}/managed-http-providers/apply`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        configName: httpConfig.name,
        content: nextHttpConfig,
        expectedSha256: "0".repeat(64),
        providers: [{ category: "proxy", name: "fixture-http" }],
      }),
    });
    assert.equal(conflictedApply.status, 409);
    assert.equal(await Promise.race([
      pendingHttpEvent.then(() => "event" as const),
      new Promise<"none">((resolve) => setTimeout(() => resolve("none"), 50)),
    ]), "none");
    const applied = await fetch(`${base}/managed-http-providers/apply`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        configName: httpConfig.name,
        content: nextHttpConfig,
        expectedSha256: httpConfig.sha256,
        providers: [{ category: "proxy", name: "fixture-http" }],
      }),
    });
    assert.equal(applied.status, 200);
    const httpEvent = decoder.decode((await within(pendingHttpEvent)).value);
    assert.equal((httpEvent.match(/"operation":"save"/g) ?? []).length, 1);
    assert.match(httpEvent, /"name":"http-event.yaml"/);
    assert.doesNotMatch(httpEvent, /content|url|ownership|fixture-http/i);

    const manualProvider = await providerFiles.create("proxy", "event-manual.yaml");
    const renamedConfigContent = nextHttpConfig.replaceAll("fixture-http", "event-renamed");
    const renameResponse = await fetch(`${base}/managed-providers/proxy/${manualProvider.fileName}/rename-with-config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fileName: "event-renamed.yaml",
        expectedSha256: manualProvider.sha256,
        configName: httpConfig.name,
        configContent: renamedConfigContent,
        expectedConfigSha256: createHash("sha256").update(nextHttpConfig).digest("hex"),
      }),
    });
    assert.equal(renameResponse.status, 200);
    const renameEvent = decoder.decode((await within(reader.read())).value);
    assert.equal((renameEvent.match(/"operation":"save"/g) ?? []).length, 1);
    assert.match(renameEvent, /"name":"http-event.yaml"/);

    const renamedFile = await providerFiles.read("event-renamed.yaml");
    const deleteResponse = await fetch(`${base}/managed-providers/proxy/${renamedFile.fileName}/delete-with-config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedSha256: renamedFile.sha256,
        configName: httpConfig.name,
        configContent: "rules: [MATCH,DIRECT]\n",
        expectedConfigSha256: createHash("sha256").update(renamedConfigContent).digest("hex"),
      }),
    });
    assert.equal(deleteResponse.status, 200);
    const deleteEvent = decoder.decode((await within(reader.read())).value);
    assert.equal((deleteEvent.match(/"operation":"save"/g) ?? []).length, 1);
    assert.match(deleteEvent, /"name":"http-event.yaml"/);
    await reader.cancel();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    subscriptions.close();
  }
});

test("named configuration CRUD is isolated, conflict-safe, and rejects path traversal", async () => {
  let validationChildren = 0;
  const { root, store } = await fixtureStore({ onChild: () => { validationChildren += 1; } });
  const empty = await store.create("empty.yaml", "");
  assert.equal(empty.content, "");
  assert.equal(await readFile(join(root, "empty.yaml"), "utf8"), "");
  assert.equal(validationChildren, 0);
  const created = await store.create("profile one.yaml", "mode: rule\n");
  assert.equal(validationChildren, 0);
  assert.equal(created.name, "profile one.yaml");
  assert.equal(created.path, join(root, "profile one.yaml"));
  const localized = await store.create("订阅示例.yaml", "mode: rule\n");
  assert.equal(localized.name, "订阅示例.yaml");
  await assert.rejects(store.create("profile one.yaml", "mode: global\n"), /already exists/);
  await assert.rejects(store.create("../outside.yaml", ""), /invalid configuration file name/);
  await assert.rejects(store.create("nested/profile.yaml", ""), /invalid configuration file name/);
  assert.equal((await store.create("invalid.yaml", "INVALID")).content, "INVALID");
  await assert.rejects(store.validate("INVALID"), ConfigValidationError);

  const renamed = await store.rename("profile one.yaml", "renamed.yml", created.sha256);
  assert.equal(renamed.name, "renamed.yml");
  assert.equal(renamed.content, "mode: rule\n");
  await assert.rejects(store.read("profile one.yaml"), /not found/);
  await assert.rejects(store.rename("renamed.yml", "订阅示例.yaml", renamed.sha256), /already exists/);
  await assert.rejects(store.rename("renamed.yml", "../outside.yaml", renamed.sha256), /invalid configuration file name/);

  const listed = await store.list();
  assert.deepEqual(listed.map(({ name }) => name), ["config.yaml", "empty.yaml", "invalid.yaml", "renamed.yml", "订阅示例.yaml"]);
  await assert.rejects(store.saveFile("renamed.yml", "mode: direct\n", "0".repeat(64)), ConfigConflictError);
  const saved = await store.saveFile("renamed.yml", "mode: direct\n", renamed.sha256);
  assert.equal((await store.read("config.yaml")).content, await readFile(join(root, "config.yaml"), "utf8"));
  assert.equal((await store.read("renamed.yml")).content, "mode: direct\n");
  await store.delete("renamed.yml", saved.sha256);
  await assert.rejects(store.read("renamed.yml"), /not found/);
});

test("reads exact provider declaration and file payload", async () => {
  const { root, configPath, store } = await fixtureStore();
  const providerDir = join(root, "providers");
  const source = "# preserved comment\nproxies:\n  - name: node-a\n    type: direct\n";
  await mkdir(providerDir);
  await writeFile(join(providerDir, "source.yaml"), source);
  await writeFile(configPath, [
    "proxy-providers:",
    "  local source:",
    "    type: file",
    "    path: ./providers/source.yaml",
    "",
  ].join("\n"));

  assert.match(await store.readProviderDeclaration("proxy", "local source"), /local source:\n    type: file/);
  assert.equal(await store.readProviderPayload("proxy", "local source"), source);
  store.options.maxProviderSourceBytes = Buffer.byteLength(source) - 1;
  await assert.rejects(store.readProviderPayload("proxy", "local source"), ConfigTooLargeError);
  store.options.maxProviderSourceBytes = Buffer.byteLength(source);
  assert.equal(await store.readProviderPayload("proxy", "local source"), source);

  const dottedProviderDir = join(root, "..providers");
  await mkdir(dottedProviderDir);
  await writeFile(join(dottedProviderDir, "source.yaml"), source);
  await writeFile(configPath, [
    "proxy-providers:",
    "  dotted source:",
    "    type: file",
    "    path: ./..providers/source.yaml",
    "",
  ].join("\n"));
  assert.equal(await store.readProviderPayload("proxy", "dotted source"), source);
});

test("provider HTTP reads use the selected configuration and reject a stale source", async () => {
  const { root, store } = await fixtureStore();
  await mkdir(join(root, "providers"));
  await mkdir(join(root, "ruleset"));
  await writeFile(join(root, "providers", "selected.yaml"), "proxies: [{ name: fixture-node }]\n");
  await writeFile(join(root, "ruleset", "selected.yaml"), "payload: [example.test]\n");
  await writeFile(join(root, "selected.yaml"), "proxy-providers:\n  same: { type: file, path: ./providers/selected.yaml }\nrule-providers:\n  same: { type: http, path: ./ruleset/selected.yaml }\n");
  const source = await store.read("selected.yaml");
  const server = createConfigdServer({ store, maxBodyBytes: 4096 });
  const port = await listenSafe(server, 19350);
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const category of ["proxy", "rule"]) {
      const route = `${base}/provider-files/${category}/same`;
      const result = await fetch(`${route}?configName=selected.yaml&sha256=${source.sha256}`);
      assert.equal(result.status, 200);
      assert.match(await result.text(), category === "proxy" ? /fixture-node/ : /example.test/);
      assert.equal((await fetch(route)).status, 400);
      assert.equal((await fetch(`${route}?configName=config.yaml`)).status, 404);
      assert.equal((await fetch(`${route}?configName=selected.yaml&sha256=${"0".repeat(64)}`)).status, 409);
      assert.equal((await fetch(`${route}?configName=../selected.yaml`)).status, 400);
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("reads the original declaration and payload node for an inline provider", async () => {
  const { configPath, store } = await fixtureStore();
  await writeFile(configPath, [
    "proxy-providers:",
    "  inline source:",
    "    # preserved inline comment",
    "    type: inline",
    "    payload:",
    "      - name: node-a",
    "        type: direct",
    "",
  ].join("\n"));

  const declaration = await store.readProviderDeclaration("proxy", "inline source");
  const payload = await store.readProviderPayload("proxy", "inline source");
  assert.match(declaration, /# preserved inline comment/);
  assert.match(declaration, /type: inline/);
  assert.match(payload, /^payload:/);
  assert.match(payload, /name: node-a/);
});

test("provider source cannot escape the Mihomo data directory", async () => {
  const { root, configPath, store } = await fixtureStore();
  await writeFile(configPath, [
    "rule-providers:",
    "  outside:",
    "    type: file",
    "    path: ../outside.yaml",
    "",
  ].join("\n"));

  await assert.rejects(
    store.readProviderPayload("rule", "outside"),
    ConfigProviderFilesError,
  );

  const regularSource = join(root, "regular-provider.yaml");
  const linkedSource = join(root, "linked-provider.yaml");
  await writeFile(regularSource, "payload: []\n");
  let symlinkAvailable = true;
  try {
    await symlink(regularSource, linkedSource, "file");
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    symlinkAvailable = false;
  }
  if (symlinkAvailable) {
    await writeFile(configPath, [
      "rule-providers:",
      "  linked:",
      "    type: file",
      "    path: ./linked-provider.yaml",
      "",
    ].join("\n"));
    await assert.rejects(store.readProviderPayload("rule", "linked"), ConfigProviderFilesError);
  }

  await mkdir(join(root, "provider-directory"));
  await writeFile(configPath, [
    "rule-providers:",
    "  directory:",
    "    type: file",
    "    path: ./provider-directory",
    "",
  ].join("\n"));
  await assert.rejects(store.readProviderPayload("rule", "directory"), ConfigProviderFilesError);
});

test("validates a candidate and cleans its temporary file", async () => {
  const { root, store } = await fixtureStore();
  await store.validate("mode: rule\ntun:\n  enable: false\n");
  assert.equal((await readdir(root)).some((name) => name.includes("candidate")), false);
});

test("failed validation leaves the official configuration unchanged", async () => {
  const { configPath, root, store } = await fixtureStore();
  const before = await readFile(configPath, "utf8");
  await assert.rejects(store.validate("INVALID"), ConfigValidationError);
  assert.equal(await readFile(configPath, "utf8"), before);
  assert.equal((await readdir(root)).some((name) => name.includes("candidate")), false);
});

test("validation timeout terminates the child and cleans its candidate", async () => {
  let childPid: number | undefined;
  const { root, store } = await fixtureStore({ timeout: 100, onChild: (pid) => (childPid = pid) });
  await assert.rejects(store.validate("TIMEOUT"), ConfigValidationTimeoutError);
  assert.ok(childPid);
  assert.throws(() => process.kill(childPid!, 0));
  assert.equal((await readdir(root)).some((name) => name.includes("candidate")), false);
});

test("rejects request bodies above the configured limit", async () => {
  const { store } = await fixtureStore({ maxBytes: 32 });
  const server = createConfigdServer({ store, maxBodyBytes: 32 });
  const port = await listenSafe(server, 19100);
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${port}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x".repeat(100) }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "content_too_large" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("expectedSha256 conflict refuses overwrite", async () => {
  const { configPath, store } = await fixtureStore();
  const before = await readFile(configPath, "utf8");
  await assert.rejects(store.save("mode: direct\n", "0".repeat(64)), ConfigConflictError);
  assert.equal(await readFile(configPath, "utf8"), before);
});

test("successful save preserves mode and atomically publishes validated content", async () => {
  const { configPath, store } = await fixtureStore();
  const before = await store.read();
  const beforeMode = (await stat(configPath)).mode;
  const content = "mode: direct\ntun:\n  enable: false\n";
  const saved = await store.save(content, before.sha256);
  assert.equal(saved.sha256, createHash("sha256").update(content).digest("hex"));
  assert.equal(await readFile(configPath, "utf8"), content);
  assert.equal((await stat(configPath)).mode, beforeMode);
});

test("concurrent writes are serialized and stale second write conflicts", async () => {
  const { configPath, store } = await fixtureStore();
  const before = await store.read();
  const first = store.save("mode: direct\n", before.sha256);
  const second = store.save("mode: global\n", before.sha256);
  await first;
  await assert.rejects(second, ConfigConflictError);
  assert.equal(await readFile(configPath, "utf8"), "mode: direct\n");
});

test("server distinguishes bad JSON and validation failure without leaking content", async () => {
  const { root, configPath, store } = await fixtureStore();
  await mkdir(join(root, "providers"));
  await writeFile(join(root, "providers", "source.yaml"), "proxies:\n  - name: node-a\n");
  await writeFile(configPath, [
    "proxy-providers:",
    "  local source:",
    "    type: file",
    "    path: ./providers/source.yaml",
    "",
  ].join("\n"));
  const server = createConfigdServer({ store, maxBodyBytes: 4096 });
  const port = await listenSafe(server, 19120);
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${port}`;
    const read = await fetch(`${base}/file`);
    assert.equal(read.status, 200);
    const provider = await fetch(`${base}/provider-files/proxy/local%20source?configName=${store.defaultName}`);
    assert.equal(provider.status, 200);
    assert.match(provider.headers.get("content-type") || "", /application\/yaml/);
    assert.equal(await provider.text(), "proxies:\n  - name: node-a\n");
    const declaration = await fetch(`${base}/provider-configs/proxy/local%20source?configName=${store.defaultName}`);
    assert.equal(declaration.status, 200);
    assert.match(await declaration.text(), /local source:\n    type: file/);
    const bad = await fetch(`${base}/file`, { method: "PUT", body: "{" });
    assert.equal(bad.status, 400);
    const invalid = await fetch(`${base}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "INVALID secret-value" }),
    });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.text()).includes("secret-value"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("named configuration API returns stable CRUD errors", async () => {
  const { store } = await fixtureStore();
  const server = createConfigdServer({ store, maxBodyBytes: 4096 });
  const port = await listenSafe(server, 19140);
  try {
    const base = `http://127.0.0.1:${port}`;
    const create = () => fetch(`${base}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "profile.yaml", content: "mode: rule\n" }),
    });
    const created = await create();
    assert.equal(created.status, 201);
    const createdSnapshot = await created.json() as { sha256: string };

    const duplicate = await create();
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: "config_exists" });

    const badName = await fetch(`${base}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "../outside.yaml", content: "mode: rule\n" }),
    });
    assert.equal(badName.status, 400);
    assert.deepEqual(await badName.json(), { error: "invalid_config_name" });

    const missing = await fetch(`${base}/files/missing.yaml`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "config_not_found" });

    const rename = (name: string) => fetch(`${base}/files/profile.yaml/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, expectedSha256: createdSnapshot.sha256 }),
    });
    const invalidRename = await rename("../outside.yaml");
    assert.equal(invalidRename.status, 400);
    assert.deepEqual(await invalidRename.json(), { error: "invalid_config_name" });
    await store.create("occupied.yaml", "mode: rule\n");
    const occupiedRename = await rename("occupied.yaml");
    assert.equal(occupiedRename.status, 409);
    assert.deepEqual(await occupiedRename.json(), { error: "config_exists" });
    const renamed = await rename("renamed.yml");
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { name: string }).name, "renamed.yml");

    const staleDelete = await fetch(`${base}/files/renamed.yml`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedSha256: "0".repeat(64) }),
    });
    assert.equal(staleDelete.status, 409);
    assert.deepEqual(await staleDelete.json(), { error: "config_conflict" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("subscription-managed files are marked and keep their owner through the rename API", async () => {
  const { root, store, writeQueue } = await fixtureStore();
  let downloaded = "mode: rule\n";
  const subscriptions = new SubscriptionService({
    statePath: join(root, "subscriptions.json"),
    providerDir: join(root, "providers"),
    requestTimeoutMs: 1000,
    maxResponseBytes: 4096,
    writeQueue,
    fetchImpl: async () => new Response(downloaded),
    syncConfigFile: async (name, content, existing) => existing
      ? store.saveFileUnqueued(name, content, (await store.read(name)).sha256)
      : store.createUnqueued(name, content),
    deleteConfigFile: (name, expectedSha256) => store.deleteUnqueued(name, expectedSha256),
  });
  await subscriptions.init();
  const subscription = await subscriptions.create({
    name: "Managed",
    url: "https://example.test/subscription",
    extractProvider: false,
    mergeIntoConfig: false,
    autoUpdate: false,
    intervalMinutes: 60,
  });
  const firstUpdate = await subscriptions.updateNow(subscription.id);
  assert.equal(firstUpdate.nodeCount, 0);
  assert.equal(firstUpdate.providerName, null);
  assert.equal(firstUpdate.config?.content, downloaded);
  const before = await store.read("Managed.yaml");
  const server = createConfigdServer({ store, subscriptions, maxBodyBytes: 4096 });
  const port = await listenSafe(server, 19160);
  try {
    const base = `http://127.0.0.1:${port}`;
    const listed = await fetch(`${base}/files`).then((response) => response.json()) as {
      files: Array<{ name: string; subscriptionManaged: boolean; subscriptionId: string | null }>;
    };
    const managed = listed.files.find((file) => file.name === "Managed.yaml");
    assert.deepEqual(managed && {
      name: managed.name,
      subscriptionManaged: managed.subscriptionManaged,
      subscriptionId: managed.subscriptionId,
    }, {
      name: "Managed.yaml",
      subscriptionManaged: true,
      subscriptionId: subscription.id,
    });
    const paddedRename = await fetch(`${base}/files/Managed.yaml/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: " Managed renamed.yml ", expectedSha256: before.sha256 }),
    });
    assert.equal(paddedRename.status, 400);
    assert.deepEqual(await paddedRename.json(), { error: "invalid_config_name" });
    const renamed = await fetch(`${base}/files/Managed.yaml/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Managed renamed.yml", expectedSha256: before.sha256 }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(subscriptions.configOwner("Managed.yaml"), null);
    assert.deepEqual(subscriptions.configOwner("Managed renamed.yml"), {
      id: subscription.id,
      name: "Managed",
    });
    downloaded = "mode: direct\n";
    await subscriptions.updateNow(subscription.id);
    assert.equal((await store.read("Managed renamed.yml")).content, downloaded);
    await assert.rejects(store.read("Managed.yaml"), /not found/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    subscriptions.close();
  }
});

test("subscription config sync counts optional proxies and only extracts Providers when enabled", async () => {
  const { root, store, writeQueue } = await fixtureStore();
  let downloaded = [
    "mode: rule",
    "proxies:",
    "  - name: local-node",
    "    type: direct",
    "",
  ].join("\n");
  const subscriptions = new SubscriptionService({
    statePath: join(root, "subscriptions.json"),
    providerDir: join(root, "providers"),
    dataDir: root,
    requestTimeoutMs: 1000,
    maxResponseBytes: 4096,
    writeQueue,
    fetchImpl: async () => new Response(downloaded),
    syncConfigFile: async (name, content, existing) => existing
      ? store.saveFileUnqueued(name, content, (await store.read(name)).sha256)
      : store.createUnqueued(name, content),
    deleteConfigFile: (name, expectedSha256) => store.deleteUnqueued(name, expectedSha256),
    assertProviderReservationAvailable: async () => undefined,
  });
  await subscriptions.init();
  const plain = await subscriptions.create({
    name: "Plain config",
    url: "https://example.test/plain",
    extractProvider: false,
    mergeIntoConfig: false,
    autoUpdate: false,
    intervalMinutes: 60,
  });
  const plainResult = await within(subscriptions.updateNow(plain.id));
  assert.equal(plainResult.nodeCount, 1);
  assert.equal(plainResult.providerName, null);
  assert.equal((await store.read("Plain config.yaml")).content, downloaded);
  await assert.rejects(readFile(join(root, "providers", ".yaml"), "utf8"), { code: "ENOENT" });

  downloaded = "mode: rule\n";
  const extracted = await subscriptions.create({
    name: "Extracted",
    url: "https://example.test/extracted",
    extractProvider: true,
    providerName: "extracted",
    mergeIntoConfig: false,
    autoUpdate: false,
    intervalMinutes: 60,
  });
  await assert.rejects(within(subscriptions.updateNow(extracted.id)), SubscriptionDownloadError);
  await assert.rejects(store.read("Extracted.yaml"), /not found/);
  await assert.rejects(readFile(join(root, "providers", "extracted.yaml"), "utf8"), { code: "ENOENT" });
  subscriptions.close();
});

test("subscription sync rejects empty downloads without publishing or changing managed files", async () => {
  const { root, store, writeQueue } = await fixtureStore();
  let downloaded = "";
  const providerPath = join(root, "providers", "empty-guard.yaml");
  let subscriptions!: SubscriptionService;
  const providerOwnership = await providerOwnershipOptions(
    root,
    store,
    writeQueue,
    () => subscriptions.list(),
  );
  subscriptions = new SubscriptionService({
    statePath: join(root, "subscriptions.json"),
    providerDir: join(root, "providers"),
    dataDir: root,
    requestTimeoutMs: 1000,
    maxResponseBytes: 4096,
    writeQueue,
    fetchImpl: async () => new Response(downloaded),
    syncConfigFile: async (name, content, existing) => existing
      ? store.saveFileUnqueued(name, content, (await store.read(name)).sha256)
      : store.createUnqueued(name, content),
    deleteConfigFile: (name, expectedSha256) => store.deleteUnqueued(name, expectedSha256),
    ...providerOwnership,
  });
  await subscriptions.init();
  const subscription = await subscriptions.create({
    name: "Empty guard",
    url: "https://example.test/empty-guard",
    extractProvider: true,
    providerName: "empty-guard",
    mergeIntoConfig: false,
    autoUpdate: false,
    intervalMinutes: 60,
  });

  for (const blank of ["", " \r\n\t"]) {
    downloaded = blank;
    await assert.rejects(within(subscriptions.updateNow(subscription.id)), SubscriptionDownloadError);
    await assert.rejects(store.read("Empty guard.yaml"), /not found/);
    await assert.rejects(readFile(providerPath), { code: "ENOENT" });
    const failed = subscriptions.list().find((item) => item.id === subscription.id)!;
    assert.equal(failed.status, "error");
    assert.equal(failed.configFileName, null);
    assert.equal(subscriptions.configOwner("Empty guard.yaml"), null);
  }

  downloaded = [
    "mode: rule",
    "proxies:",
    "  - name: first",
    "    type: direct",
    "",
  ].join("\n");
  const firstResult = await within(subscriptions.updateNow(subscription.id));
  const firstConfig = await store.read("Empty guard.yaml");
  const firstProviderHash = createHash("sha256").update(await readFile(providerPath)).digest("hex");
  assert.equal(firstResult.config?.sha256, firstConfig.sha256);
  assert.equal(firstConfig.sha256, createHash("sha256").update(downloaded).digest("hex"));
  assert.equal(subscriptions.configOwner(firstConfig.name)?.id, subscription.id);
  assert.equal(subscriptions.list().find((item) => item.id === subscription.id)?.status, "success");

  for (const blank of ["", " \n "]) {
    downloaded = blank;
    await assert.rejects(within(subscriptions.updateNow(subscription.id)), SubscriptionDownloadError);
    const preserved = await store.read(firstConfig.name);
    assert.equal(preserved.sha256, firstConfig.sha256);
    assert.equal(createHash("sha256").update(await readFile(providerPath)).digest("hex"), firstProviderHash);
    assert.equal(subscriptions.configOwner(firstConfig.name)?.id, subscription.id);
    const failed = subscriptions.list().find((item) => item.id === subscription.id)!;
    assert.equal(failed.status, "error");
    assert.equal(failed.configFileName, firstConfig.name);
  }

  downloaded = [
    "mode: direct",
    "proxies:",
    "  - name: second",
    "    type: direct",
    "",
  ].join("\n");
  const secondResult = await within(subscriptions.updateNow(subscription.id));
  const secondConfig = await store.read(firstConfig.name);
  assert.equal(secondResult.config?.sha256, secondConfig.sha256);
  assert.notEqual(secondConfig.sha256, firstConfig.sha256);
  assert.notEqual(createHash("sha256").update(await readFile(providerPath)).digest("hex"), firstProviderHash);
  assert.equal(subscriptions.configOwner(secondConfig.name)?.id, subscription.id);
  assert.equal(subscriptions.list().find((item) => item.id === subscription.id)?.status, "success");

  const manualDraft = await store.createUnqueued("Manual draft.yaml", "");
  assert.equal(manualDraft.content.length, 0);
  assert.equal((await stat(manualDraft.path)).size, 0);
  subscriptions.close();
});

test("subscription HTTP sync uses a compatible agent and bypasses validation only for managed files", async () => {
  let validationChildren = 0;
  const { root, store, writeQueue } = await fixtureStore({
    onChild: () => { validationChildren += 1; },
  });
  const firstBody = ["mode: rule", "fixture-marker: INVALID", ""].join("\n");
  const secondBody = ["mode: direct", "fixture-marker: INVALID", ""].join("\n");
  let servedBody = firstBody;
  let compatibleRequests = 0;
  const httpServer = createServer((request, response) => {
    const userAgent = request.headers["user-agent"];
    const compatible = typeof userAgent === "string" && userAgent.startsWith("clash.meta/");
    if (compatible) compatibleRequests += 1;
    response.writeHead(200, { "content-type": "application/yaml" });
    response.end(compatible ? servedBody : "");
  });
  const port = await listenSafe(httpServer, 19200);
  const endpoint = `http://127.0.0.1:${port}/fixture`;
  let unexpectedRequests = 0;
  const subscriptions = new SubscriptionService({
    statePath: join(root, "subscriptions.json"),
    providerDir: join(root, "providers"),
    dataDir: root,
    requestTimeoutMs: 1000,
    maxResponseBytes: 4096,
    writeQueue,
    fetchImpl: async (input, init) => {
      if (String(input) !== endpoint) unexpectedRequests += 1;
      return fetch(input, init);
    },
    syncConfigFile: async (name, content, existing) => existing
      ? store.saveSubscriptionFileUnqueued(name, content, (await store.read(name)).sha256)
      : store.createSubscriptionFileUnqueued(name, content),
    deleteConfigFile: (name, expectedSha256) => store.deleteUnqueued(name, expectedSha256),
  });
  await subscriptions.init();
  try {
    const subscription = await subscriptions.create({
      name: "HTTP fixture",
      url: endpoint,
      extractProvider: false,
      mergeIntoConfig: false,
      autoUpdate: false,
      intervalMinutes: 60,
    });
    const firstResult = await within(subscriptions.updateNow(subscription.id));
    const firstSnapshot = await store.read("HTTP fixture.yaml");
    const firstMetadata = await stat(firstSnapshot.path);
    assert.equal(firstResult.config?.sha256, firstSnapshot.sha256);
    assert.equal(firstSnapshot.sha256, createHash("sha256").update(firstBody).digest("hex"));
    assert.equal(firstMetadata.size, Buffer.byteLength(firstBody));
    assert.equal((await store.list()).some((file) => file.name === firstSnapshot.name), true);
    assert.equal(subscriptions.configOwner(firstSnapshot.name)?.id, subscription.id);
    assert.equal(validationChildren, 0);
    assert.equal(unexpectedRequests, 0);
    assert.equal(compatibleRequests, 1);

    await assert.rejects(store.createUnqueued("Ordinary create.yaml", firstBody), ConfigValidationError);
    const ordinaryDraft = await store.createUnqueued("Ordinary save.yaml", "");
    await assert.rejects(
      store.saveFileUnqueued(ordinaryDraft.name, firstBody, ordinaryDraft.sha256),
      ConfigValidationError,
    );
    assert.equal(validationChildren, 2);
    assert.equal((await store.read(ordinaryDraft.name)).sha256, ordinaryDraft.sha256);

    const occupied = await store.createUnqueued("Occupied.yaml", "");
    const conflict = await subscriptions.create({
      name: "Occupied",
      url: endpoint,
      extractProvider: false,
      mergeIntoConfig: false,
      autoUpdate: false,
      intervalMinutes: 60,
    });
    await assert.rejects(within(subscriptions.updateNow(conflict.id)), ConfigFileExistsError);
    assert.equal((await store.read(occupied.name)).sha256, occupied.sha256);
    assert.equal(subscriptions.configOwner(occupied.name), null);

    const blank = await subscriptions.create({
      name: "Blank HTTP fixture",
      url: endpoint,
      extractProvider: false,
      mergeIntoConfig: false,
      autoUpdate: false,
      intervalMinutes: 60,
    });
    for (const content of ["", " \r\n\t"]) {
      servedBody = content;
      await assert.rejects(within(subscriptions.updateNow(blank.id)), SubscriptionDownloadError);
      await assert.rejects(store.read("Blank HTTP fixture.yaml"), /not found/);
      assert.equal(subscriptions.configOwner("Blank HTTP fixture.yaml"), null);
    }

    servedBody = " \n";
    await assert.rejects(within(subscriptions.updateNow(subscription.id)), SubscriptionDownloadError);
    const preserved = await store.read(firstSnapshot.name);
    assert.equal(preserved.sha256, firstSnapshot.sha256);
    assert.equal(subscriptions.configOwner(preserved.name)?.id, subscription.id);

    servedBody = secondBody;
    const secondResult = await within(subscriptions.updateNow(subscription.id));
    const secondSnapshot = await store.read(firstSnapshot.name);
    const secondMetadata = await stat(secondSnapshot.path);
    assert.equal(secondResult.config?.sha256, secondSnapshot.sha256);
    assert.equal(secondSnapshot.sha256, createHash("sha256").update(secondBody).digest("hex"));
    assert.notEqual(secondSnapshot.sha256, firstSnapshot.sha256);
    assert.equal(secondMetadata.mode, firstMetadata.mode);
    assert.equal(validationChildren, 2);
    assert.equal(subscriptions.configOwner(secondSnapshot.name)?.id, subscription.id);
  } finally {
    subscriptions.close();
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("subscription publish transaction restores config and Provider after downstream failures", async () => {
  let validationChildren = 0;
  const { root, store, writeQueue } = await fixtureStore({
    onChild: () => { validationChildren += 1; },
  });
  const bodies = ["first", "second", "third"].map((name) => [
    "mode: rule",
    "fixture-marker: INVALID",
    "proxies:",
    `  - name: ${name}`,
    "    type: direct",
    "",
  ].join("\n"));
  let downloaded = bodies[0]!;
  let failStateWrites = 0;
  let failProviderWrites = 0;
  let subscriptions!: SubscriptionService;
  const providerOwnership = await providerOwnershipOptions(
    root,
    store,
    writeQueue,
    () => subscriptions.list(),
    async () => {
      if (failProviderWrites > 0) {
        failProviderWrites -= 1;
        throw new Error("provider publish failed");
      }
    },
  );
  subscriptions = new SubscriptionService({
    statePath: join(root, "subscriptions.json"),
    providerDir: join(root, "providers"),
    dataDir: root,
    requestTimeoutMs: 1000,
    maxResponseBytes: 4096,
    writeQueue,
    fetchImpl: async () => new Response(downloaded),
    beforeStateRename: async () => {
      if (failStateWrites > 0) {
        failStateWrites -= 1;
        throw new Error("state publish failed");
      }
    },
    syncConfigFile: async (name, content, existing) => {
      if (!existing) {
        const snapshot = await store.createSubscriptionFileUnqueued(name, content);
        return {
          snapshot,
          rollback: async () => { await store.deleteUnqueued(snapshot.name, snapshot.sha256); },
        };
      }
      const previous = await store.read(name);
      const snapshot = await store.saveSubscriptionFileUnqueued(name, content, previous.sha256);
      return {
        snapshot,
        rollback: async () => {
          await store.restoreSubscriptionFileUnqueued(name, previous.content, snapshot.sha256);
        },
      };
    },
    deleteConfigFile: (name, expectedSha256) => store.deleteUnqueued(name, expectedSha256),
    ...providerOwnership,
  });
  await subscriptions.init();
  const providerHash = async (name: string) => createHash("sha256")
    .update(await readFile(join(root, "providers", `${name}.yaml`)))
    .digest("hex");
  try {
    const subscription = await subscriptions.create({
      name: "Transactional",
      url: "https://example.test/transactional",
      extractProvider: true,
      providerName: "transactional",
      mergeIntoConfig: false,
      autoUpdate: false,
      intervalMinutes: 60,
    });
    await within(subscriptions.updateNow(subscription.id));
    const originalConfig = await store.read("Transactional.yaml");
    const originalConfigMode = (await stat(originalConfig.path)).mode;
    const originalProviderHash = await providerHash("transactional");
    const originalProviderMode = (await stat(join(root, "providers", "transactional.yaml"))).mode;
    assert.equal(validationChildren, 0);

    downloaded = bodies[1]!;
    failStateWrites = 1;
    await assert.rejects(within(subscriptions.updateNow(subscription.id)), /state publish failed/);
    const afterStateFailure = await store.read(originalConfig.name);
    assert.equal(afterStateFailure.sha256, originalConfig.sha256);
    assert.equal((await stat(afterStateFailure.path)).mode, originalConfigMode);
    assert.equal(await providerHash("transactional"), originalProviderHash);
    assert.equal((await stat(join(root, "providers", "transactional.yaml"))).mode, originalProviderMode);
    assert.equal(subscriptions.configOwner(originalConfig.name)?.id, subscription.id);
    assert.equal(subscriptions.list().find((item) => item.id === subscription.id)?.configFileName, originalConfig.name);

    const retried = await within(subscriptions.updateNow(subscription.id));
    const retriedConfig = await store.read(originalConfig.name);
    const retriedProviderHash = await providerHash("transactional");
    assert.equal(retried.config?.sha256, retriedConfig.sha256);
    assert.notEqual(retriedConfig.sha256, originalConfig.sha256);
    assert.notEqual(retriedProviderHash, originalProviderHash);
    assert.equal((await stat(retriedConfig.path)).mode, originalConfigMode);
    assert.equal(subscriptions.configOwner(retriedConfig.name)?.id, subscription.id);

    downloaded = bodies[2]!;
    failProviderWrites = 1;
    await assert.rejects(within(subscriptions.updateNow(subscription.id)), /provider publish failed/);
    const afterProviderFailure = await store.read(retriedConfig.name);
    assert.equal(afterProviderFailure.sha256, retriedConfig.sha256);
    assert.equal(await providerHash("transactional"), retriedProviderHash);
    assert.equal(subscriptions.configOwner(retriedConfig.name)?.id, subscription.id);

    downloaded = bodies[0]!;
    const firstCreation = await subscriptions.create({
      name: "First transaction",
      url: "https://example.test/first-transaction",
      extractProvider: true,
      providerName: "first-transaction",
      mergeIntoConfig: false,
      autoUpdate: false,
      intervalMinutes: 60,
    });
    failStateWrites = 1;
    await assert.rejects(within(subscriptions.updateNow(firstCreation.id)), /state publish failed/);
    await assert.rejects(store.read("First transaction.yaml"), /not found/);
    await assert.rejects(readFile(join(root, "providers", "first-transaction.yaml")), { code: "ENOENT" });
    assert.equal(subscriptions.configOwner("First transaction.yaml"), null);
    const failedCreation = subscriptions.list().find((item) => item.id === firstCreation.id)!;
    assert.equal(failedCreation.configFileName, null);
    assert.equal(failedCreation.status, "error");

    await assert.rejects(store.createUnqueued("Ordinary transaction.yaml", bodies[0]!), ConfigValidationError);
    const ordinaryDraft = await store.createUnqueued("Ordinary transaction save.yaml", "");
    await assert.rejects(
      store.saveFileUnqueued(ordinaryDraft.name, bodies[0]!, ordinaryDraft.sha256),
      ConfigValidationError,
    );
    assert.equal(validationChildren, 2);
    assert.equal((await store.read(ordinaryDraft.name)).sha256, ordinaryDraft.sha256);
  } finally {
    subscriptions.close();
  }
});

test("subscription update API distinguishes Mihomo validation from Provider extraction failures", async () => {
  const { root, store, writeQueue } = await fixtureStore();
  const subscriptions = new SubscriptionService({
    statePath: join(root, "subscriptions.json"),
    providerDir: join(root, "providers"),
    dataDir: root,
    requestTimeoutMs: 1000,
    maxResponseBytes: 4096,
    writeQueue,
    fetchImpl: async (input) => new Response(String(input).includes("mihomo-invalid")
      ? "INVALID"
      : "mode: rule\n"),
    syncConfigFile: async (name, content, existing) => existing
      ? store.saveFileUnqueued(name, content, (await store.read(name)).sha256)
      : store.createUnqueued(name, content),
    deleteConfigFile: (name, expectedSha256) => store.deleteUnqueued(name, expectedSha256),
    assertProviderReservationAvailable: async () => undefined,
  });
  await subscriptions.init();
  const validation = await subscriptions.create({
    name: "Validation",
    url: "https://example.test/mihomo-invalid",
    extractProvider: false,
    mergeIntoConfig: false,
    autoUpdate: false,
    intervalMinutes: 60,
  });
  const extraction = await subscriptions.create({
    name: "Extraction",
    url: "https://example.test/provider-invalid",
    extractProvider: true,
    providerName: "extraction",
    mergeIntoConfig: false,
    autoUpdate: false,
    intervalMinutes: 60,
  });
  const server = createConfigdServer({ store, subscriptions, maxBodyBytes: 4096 });
  const port = await listenSafe(server, 19180);
  try {
    const base = `http://127.0.0.1:${port}`;
    const validationResponse = await fetch(`${base}/subscriptions/${validation.id}/update`, { method: "POST" });
    assert.equal(validationResponse.status, 422);
    assert.deepEqual(await validationResponse.json(), { error: "validation_failed", diagnostics: coreDiagnostics("") });
    const extractionResponse = await fetch(`${base}/subscriptions/${extraction.id}/update`, { method: "POST" });
    assert.equal(extractionResponse.status, 422);
    assert.deepEqual(await extractionResponse.json(), { error: "subscription_update_failed" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    subscriptions.close();
  }
});

test("subscription config ownership compensates state and delete failures without queue re-entry", async () => {
  const { root, store, writeQueue } = await fixtureStore();
  let failStateWrites = 0;
  const subscriptionContent = [
    "mode: rule",
    "proxies:",
    "  - name: fixture-node",
    "    type: direct",
    "",
  ].join("\n");
  const subscriptions = new SubscriptionService({
    statePath: join(root, "subscriptions.json"),
    providerDir: join(root, "providers"),
    requestTimeoutMs: 1000,
    maxResponseBytes: 4096,
    writeQueue,
    fetchImpl: async () => new Response(subscriptionContent),
    beforeStateRename: async () => {
      if (failStateWrites > 0) {
        failStateWrites -= 1;
        throw new Error("state write failed");
      }
    },
    syncConfigFile: async (name, content, existing) => existing
      ? store.saveFileUnqueued(name, content, (await store.read(name)).sha256)
      : store.createUnqueued(name, content),
    deleteConfigFile: (name, expectedSha256) => store.deleteUnqueued(name, expectedSha256),
  });
  await subscriptions.init();
  const subscription = await subscriptions.create({
    name: "Recoverable",
    url: "https://example.test/recoverable",
    extractProvider: false,
    mergeIntoConfig: false,
    autoUpdate: false,
    intervalMinutes: 60,
  });

  failStateWrites = 1;
  await assert.rejects(within(subscriptions.updateNow(subscription.id)), /state write failed/);
  await assert.rejects(store.read("Recoverable.yaml"), /not found/);
  const retried = await within(subscriptions.updateNow(subscription.id));
  assert.equal(retried.config?.name, "Recoverable.yaml");
  const managed = await store.read("Recoverable.yaml");

  failStateWrites = 1;
  await assert.rejects(within(subscriptions.deleteManagedConfigFile(
    managed.name,
    () => store.deleteUnqueued(managed.name, managed.sha256),
    (snapshot) => store.createUnqueued(snapshot.name, snapshot.content),
  )), /state write failed/);
  assert.ok(await store.read(managed.name));
  assert.ok(subscriptions.configOwner(managed.name));

  await assert.rejects(within(subscriptions.deleteManagedConfigFile(
    managed.name,
    () => store.deleteUnqueued(managed.name, "0".repeat(64)),
    (snapshot) => store.createUnqueued(snapshot.name, snapshot.content),
  )), ConfigConflictError);
  assert.ok(await store.read(managed.name));
  assert.ok(subscriptions.configOwner(managed.name));

  await within(subscriptions.deleteManagedConfigFile(
    managed.name,
    () => store.deleteUnqueued(managed.name, managed.sha256),
    (snapshot) => store.createUnqueued(snapshot.name, snapshot.content),
  ));
  assert.equal(subscriptions.configOwner(managed.name), null);
  await store.create(managed.name, "mode: direct\n");
  await assert.rejects(within(subscriptions.updateNow(subscription.id)), /already exists/);
  assert.equal((await store.read(managed.name)).content, "mode: direct\n");
  subscriptions.close();
});
