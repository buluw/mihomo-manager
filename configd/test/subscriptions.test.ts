import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Server } from "node:http";
import { parse } from "yaml";
import type { ConfigStore } from "../src/config/store.ts";
import { createConfigdServer } from "../src/server.ts";
import {
  ConfigFileExistsError,
  SubscriptionDownloadError,
  SubscriptionTimeoutError,
  SubscriptionTooLargeError,
  SubscriptionValidationError,
} from "../src/config/errors.ts";
import { SubscriptionService } from "../src/subscriptions/service.ts";
import type { Subscription } from "../src/subscriptions/types.ts";
import {
  ProviderFileConflictError,
  ProviderFileRecoveryError,
  ProviderFileReferencedError,
} from "../src/providerFiles/errors.ts";
import {
  ProviderFileService,
} from "../src/providerFiles/service.ts";
import { WriteQueue } from "../src/writeQueue.ts";

const validYaml = "proxies:\n  - name: node-a\n    type: socks5\n    server: 127.0.0.1\n    port: 1080\n";

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

async function fixtureService(fetchImpl: typeof fetch, options: {
  timeout?: number;
  maxBytes?: number;
  beforeProviderRename?: () => Promise<void>;
  beforeStateRename?: () => Promise<void>;
  beforeProviderRenameCleanup?: (phase: "rollback-target" | "commit-source") => Promise<void>;
  beforeProviderOperationCleanup?: (operation: string, phase: string) => Promise<void>;
  afterProviderOperationPhase?: (operation: string, phase: string) => Promise<void>;
  afterCaseAliasRemoval?: () => Promise<void>;
  configs?: Record<string, string>;
  setTimer?: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  syncConfigFile?: (
    name: string,
    content: string,
    existing: boolean,
  ) => Promise<{ name: string; path: string; content: string; sha256: string }>;
  deleteConfigFile?: (name: string, expectedSha256: string) => Promise<{ name: string; path: string; content: string; sha256: string }>;
  readConfigFile?: (name: string) => Promise<{ name: string; path: string; content: string; sha256: string }>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "configd-subscriptions-"));
  const writeQueue = new WriteQueue();
  const configs = new Map(Object.entries(options.configs ?? {}));
  let service!: SubscriptionService;
  const providerFiles = new ProviderFileService({
    providerDir: join(root, "providers"),
    statePath: join(root, "state", "provider-files.json"),
    dataDir: root,
    maxContentBytes: options.maxBytes ?? 4096,
    writeQueue,
    store: {
      list: async () => [...configs].map(([name, content]) => ({
        name,
        path: join(root, name),
        sha256: createHash("sha256").update(content).digest("hex"),
        size: Buffer.byteLength(content),
        updatedAt: "2026-08-12T00:00:00.000Z",
      })),
      read: async (name: string) => {
        const content = configs.get(name);
        if (content == null) throw new Error("fixture config not found");
        return {
          name,
          path: join(root, name),
          content,
          sha256: createHash("sha256").update(content).digest("hex"),
        };
      },
    } as unknown as Pick<ConfigStore, "list" | "read">,
    subscriptions: () => service?.list() ?? [],
    readRuntimeDependencies: async () => ({ content: "mode: direct\n", uncertain: false }),
    ...(options.beforeProviderRename ? { beforeFileRename: options.beforeProviderRename } : {}),
    ...(options.beforeProviderRenameCleanup
      ? { beforeRenameCleanup: options.beforeProviderRenameCleanup }
      : {}),
    ...(options.beforeProviderOperationCleanup
      ? { beforeOperationCleanup: options.beforeProviderOperationCleanup }
      : {}),
    ...(options.afterProviderOperationPhase
      ? { afterOperationPhase: options.afterProviderOperationPhase }
      : {}),
    ...(options.afterCaseAliasRemoval ? { afterCaseAliasRemoval: options.afterCaseAliasRemoval } : {}),
  });
  service = new SubscriptionService({
    statePath: join(root, "state", "subscriptions.json"),
    providerDir: join(root, "providers"),
    requestTimeoutMs: options.timeout ?? 1000,
    maxResponseBytes: options.maxBytes ?? 4096,
    writeQueue,
    fetchImpl,
    publishProvider: (identity, commitState) => providerFiles.publishSubscriptionProvider(identity, commitState),
    renameProvider: (identity, commitState) => providerFiles.renameSubscriptionProvider(identity, commitState),
    ensureProviderOwnershipReady: () => providerFiles.ensureProviderOperationRecovered(),
    assertProviderReservationAvailable: (identity) =>
      providerFiles.assertSubscriptionReservationAvailable(identity),
    assertProviderIdentity: (identity) => providerFiles.assertSubscriptionPublish(identity),
    providerFilterSettings: (subscriptionId) => providerFiles.filterSettingsForSubscription(subscriptionId),
    ...(options.beforeStateRename ? { beforeStateRename: options.beforeStateRename } : {}),
    ...(options.setTimer ? { setTimer: options.setTimer } : {}),
    ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
    ...(options.syncConfigFile ? { syncConfigFile: options.syncConfigFile } : {}),
    ...(options.deleteConfigFile ? { deleteConfigFile: options.deleteConfigFile } : {}),
    ...(options.readConfigFile ? { readConfigFile: options.readConfigFile } : {}),
  });
  await service.init();
  await providerFiles.init();
  await service.migrateLegacyFilterSettings();
  service.startScheduling();
  return { root, service, providerFiles, configs, writeQueue };
}

const input = {
  name: "Example",
  url: "https://example.test/subscription",
  extractProvider: true,
  providerName: "example_provider",
  mergeIntoConfig: false,
  configName: "",
  autoUpdate: false,
  intervalMinutes: 60,
};

test("subscription filtering updates the complete source and group references without extraction", async () => {
  const downloaded = [
    "mode: rule",
    "proxies:",
    "  - name: keep-node",
    "    type: direct",
    "  - name: 套餐到期",
    "    type: direct",
    "proxy-groups:",
    "  - name: AUTO",
    "    type: select",
    "    proxies: [keep-node, 套餐到期, FALLBACK, DIRECT]",
    "    use: [remote-provider]",
    "  - name: FALLBACK",
    "    type: fallback",
    "    proxies: [套餐到期, keep-node, AUTO, REJECT]",
    "    url: http://www.gstatic.com/generate_204",
    "rule-providers:",
    "  fixture-rules:",
    "    type: http",
    "    url: https://fixture.invalid/rules",
    "rules:",
    "  - MATCH,AUTO",
    "",
  ].join("\n");
  let published = "";
  let failPublish = false;
  const { service } = await fixtureService(async () => new Response(downloaded), {
    syncConfigFile: async (name, content) => {
      if (failPublish) throw new Error("fixture publish failure");
      published = content;
      return { name, path: name, content, sha256: createHash("sha256").update(content).digest("hex") };
    },
  });
  const created = await service.create({ ...input, extractProvider: false, providerName: "", providerNameMode: "custom" });
  const settings = await service.saveFilterSettings(created.id, { version: 0, enabled: true, rules: ["套餐 & 到期"] });
  assert.equal(settings.version, 1);
  const preview = await service.previewFilter(created.id, settings.rules);
  assert.deepEqual(preview, { totalCount: 2, matchedNames: ["套餐到期"], remainingCount: 1 });
  await service.updateNow(created.id);
  const parsed = parse(published) as Record<string, unknown>;
  assert.equal(parsed.mode, "rule");
  assert.notEqual(published, downloaded);
  assert.deepEqual(parsed.proxies, [{ name: "keep-node", type: "direct" }]);
  assert.deepEqual(parsed["proxy-groups"], [
    {
      name: "AUTO",
      type: "select",
      proxies: ["keep-node", "FALLBACK", "DIRECT"],
      use: ["remote-provider"],
    },
    {
      name: "FALLBACK",
      type: "fallback",
      proxies: ["keep-node", "AUTO", "REJECT"],
      url: "http://www.gstatic.com/generate_204",
    },
  ]);
  assert.deepEqual(parsed["rule-providers"], {
    "fixture-rules": { type: "http", url: "https://fixture.invalid/rules" },
  });
  assert.deepEqual(parsed.rules, ["MATCH,AUTO"]);
  assert.deepEqual(service.list()[0]!.filterSettings, settings);
  const committedContent = published;
  failPublish = true;
  await assert.rejects(service.updateNow(created.id), /fixture publish failure/);
  assert.equal(published, committedContent);
});

test("subscription filtering resolves aliased proxies and group members before removing anchors", async () => {
  const fixtures = [
    [
      "metadata:",
      "  template: &blocked-proxy { name: &blocked-name filtered-node, type: direct }",
      "  unchanged: *blocked-proxy",
      "proxies:",
      "  - *blocked-proxy",
      "  - { name: keep-node, type: direct }",
    ],
    [
      "metadata: { unchanged: kept-value }",
      "proxies:",
      "  - { name: &blocked-name filtered-node, type: direct }",
      "  - { name: keep-node, type: direct }",
    ],
  ];
  for (const fixture of fixtures) {
    const downloaded = [...fixture,
      "proxy-groups:",
      "  - name: MAIN",
      "    type: select",
      "    proxies: [*blocked-name, keep-node, DIRECT]",
      'rules: ["MATCH,MAIN"]',
      "ipv6: false",
      "",
    ].join("\n");
    let published = "";
    const { root, service } = await fixtureService(async () => new Response(downloaded), {
      syncConfigFile: async (name, content) => {
        published = content;
        return { name, path: name, content, sha256: createHash("sha256").update(content).digest("hex") };
      },
    });
    const created = await service.create(input);
    await service.saveFilterSettings(created.id, { version: 0, enabled: true, rules: ["filtered-node"] });
    const preview = await service.previewFilter(created.id, ["filtered-node"]);
    assert.equal(preview.remainingCount, 1);
    await service.updateNow(created.id);
    const filtered = parse(published);
    const provider = parse(await readFile(join(root, "providers", "example_provider.yaml"), "utf8"));
    assert.deepEqual(filtered.proxies, [{ name: "keep-node", type: "direct" }]);
    assert.deepEqual(provider.proxies, filtered.proxies);
    assert.deepEqual(filtered["proxy-groups"][0].proxies, ["keep-node", "DIRECT"]);
    const original = parse(downloaded);
    assert.deepEqual(filtered.metadata, original.metadata);
    assert.deepEqual(filtered.rules, original.rules);
    assert.equal(filtered.ipv6, false);
    service.close();
  }
});

test("subscription filtering retains shared field values when their defining proxy is removed", async () => {
  const downloaded = [
    "proxies:",
    "  - name: filtered-node",
    "    type: socks5",
    "    server: &shared-server 192.0.2.17",
    "    port: &shared-port 1080",
    "    ws-opts: &shared-options { path: /fixture, headers: { Host: *shared-server } }",
    "  - name: keep-node",
    "    type: socks5",
    "    server: *shared-server",
    "    port: *shared-port",
    "    ws-opts: *shared-options",
    "metadata:",
    "  server: *shared-server",
    "  options: *shared-options",
    "  unchanged: &unchanged { label: preserved }",
    "  reference: *unchanged",
    "proxy-groups:",
    "  - { name: MAIN, type: select, proxies: [filtered-node, keep-node, DIRECT] }",
    'rules: ["MATCH,MAIN"]',
    "ipv6: false",
    "",
  ].join("\n");
  let published = "";
  const { root, service } = await fixtureService(async () => new Response(downloaded), {
    syncConfigFile: async (name, content) => {
      published = content;
      return { name, path: name, content, sha256: createHash("sha256").update(content).digest("hex") };
    },
  });
  try {
    const created = await service.create(input);
    await service.saveFilterSettings(created.id, { version: 0, enabled: true, rules: ["filtered-node"] });
    const updated = await service.updateNow(created.id);
    assert.equal(service.list().find((subscription) => subscription.id === created.id)?.status, "success");
    assert.equal(updated.nodeCount, 1);
    const filtered = parse(published);
    const original = parse(downloaded);
    const provider = parse(await readFile(join(root, "providers", "example_provider.yaml"), "utf8"));
    assert.deepEqual(filtered.proxies, [original.proxies[1]]);
    assert.deepEqual(provider.proxies, filtered.proxies);
    assert.equal(filtered.proxies[0].server, "192.0.2.17");
    assert.equal(filtered.proxies[0].port, 1080);
    assert.deepEqual(filtered.proxies[0]["ws-opts"], { path: "/fixture", headers: { Host: "192.0.2.17" } });
    assert.deepEqual(filtered.metadata, original.metadata);
    assert.deepEqual(filtered["proxy-groups"][0].proxies, ["keep-node", "DIRECT"]);
    assert.deepEqual(filtered.rules, original.rules);
    assert.equal(filtered.ipv6, false);
  } finally { service.close(); }
});

test("legacy Provider filters migrate after Provider recovery and remain stable on restart", async () => {
  let downloaded = validYaml;
  const fixture = await fixtureService(async () => new Response(downloaded));
  const enabled = await fixture.service.create({ ...input, name: "Enabled", providerName: "enabled" });
  const disabled = await fixture.service.create({ ...input, name: "Disabled", providerName: "disabled" });
  await fixture.service.updateNow(enabled.id);
  await fixture.service.updateNow(disabled.id);
  await fixture.providerFiles.saveFilterSettings("enabled.yaml", { expectedVersion: 0, enabled: true, rules: ["legacy-enabled"] });
  await fixture.providerFiles.saveFilterSettings("disabled.yaml", { expectedVersion: 0, enabled: false, rules: ["legacy-disabled"] });
  fixture.service.close();
  const legacyState = JSON.parse(await readFile(fixture.service.options.statePath, "utf8"));
  for (const subscription of legacyState.subscriptions) delete subscription.filterSettings;
  await writeFile(fixture.service.options.statePath, JSON.stringify(legacyState), "utf8");

  const queue = new WriteQueue();
  let reloaded!: SubscriptionService;
  const files = new ProviderFileService({ ...fixture.providerFiles.options, writeQueue: queue, subscriptions: () => reloaded?.list() ?? [] });
  reloaded = new SubscriptionService({
    ...fixture.service.options,
    writeQueue: queue,
    providerFilterSettings: (id) => files.filterSettingsForSubscription(id),
    publishProvider: (identity, commit) => files.publishSubscriptionProvider(identity, commit),
  });
  await reloaded.init();
  await files.init();
  assert.equal(await reloaded.migrateLegacyFilterSettings(), true);
  const migrated = reloaded.list();
  assert.deepEqual(migrated.find((item) => item.id === enabled.id)!.filterSettings, { version: 1, enabled: true, rules: ["legacy-enabled"] });
  assert.deepEqual(migrated.find((item) => item.id === disabled.id)!.filterSettings, { version: 1, enabled: false, rules: ["legacy-disabled"] });
  const persisted = JSON.parse(await readFile(reloaded.options.statePath, "utf8"));
  assert.deepEqual(persisted.subscriptions.map((item: Subscription) => item.filterSettings), migrated.map((item) => item.filterSettings));

  downloaded = [validYaml.trimEnd(), "  - name: legacy-enabled", "    type: direct", ""].join("\n");
  await reloaded.updateNow(enabled.id);
  await reloaded.updateNow(disabled.id);
  assert.equal(reloaded.list().find((item) => item.id === enabled.id)!.nodeCount, 1);
  assert.equal(reloaded.list().find((item) => item.id === disabled.id)!.nodeCount, 2);

  const restarted = new SubscriptionService({ ...reloaded.options });
  await restarted.init();
  assert.equal(await restarted.migrateLegacyFilterSettings(), false);
  assert.deepEqual(restarted.list().map((item) => item.filterSettings), reloaded.list().map((item) => item.filterSettings));
});

test("subscription Provider publish and rename enforce ownership and preserve identity on failure", async () => {
  let failStateWrite = false;
  let failCommitCleanup = false;
  let crashProviderOperation: string | null = null;
  let replacePublishStage = false;
  let publishStageProviderDir = "";
  let publishStageStatePath = "";
  let downloadContent = validYaml;
  let scheduled = 0;
  const { root, service, providerFiles, configs } = await fixtureService(async () => new Response(downloadContent), {
    beforeStateRename: async () => { if (failStateWrite) throw new Error("state publish failed"); },
    beforeProviderRenameCleanup: async (phase) => {
      if (failCommitCleanup && phase === "commit-source") throw new Error("source cleanup failed");
    },
    afterProviderOperationPhase: async (operation, phase) => {
      if (operation === "publish" && phase === "staged" && replacePublishStage) {
        replacePublishStage = false;
        const journal = JSON.parse(await readFile(publishStageStatePath, "utf8")).operationJournal;
        const stagePath = join(publishStageProviderDir, journal.stageFileName);
        await unlink(stagePath);
        await writeFile(stagePath, "proxies:\n  - {}\n", "utf8");
      }
      if (`${operation}:${phase}` === crashProviderOperation) throw new Error("simulated provider interruption");
    },
    setTimer: (() => {
      scheduled += 1;
      return { unref() {} } as NodeJS.Timeout;
    }),
    clearTimer: () => undefined,
  });
  publishStageProviderDir = providerFiles.options.providerDir;
  publishStageStatePath = providerFiles.options.statePath;

  let releaseStaleResponse!: (response: Response) => void;
  let markStaleRequestStarted!: () => void;
  const staleResponse = new Promise<Response>((resolve) => { releaseStaleResponse = resolve; });
  const staleRequestStarted = new Promise<void>((resolve) => { markStaleRequestStarted = resolve; });
  let currentResponse = "proxies:\n  - { name: node-b, type: direct }\n";
  const staleFixture = await fixtureService(async (request) => {
    if (String(request).includes("source-a")) {
      markStaleRequestStarted();
      return staleResponse;
    }
    return new Response(currentResponse);
  });
  const staleCreated = await staleFixture.service.create({
    ...input,
    name: "Stale source",
    url: "https://example.test/source-a",
    providerName: "stale_provider",
  });
  const staleUpdate = staleFixture.service.updateNow(staleCreated.id);
  await staleRequestStarted;
  await staleFixture.service.update(staleCreated.id, {
    ...input,
    name: "Current source",
    url: "https://example.test/source-b",
    providerName: "stale_provider",
    autoUpdate: true,
    intervalMinutes: 30,
  });
  const currentStateBeforeStaleResponse = await readFile(
    join(staleFixture.root, "state", "subscriptions.json"),
  );
  releaseStaleResponse(new Response("proxies:\n  - { name: node-a, type: direct }\n"));
  await assert.rejects(staleUpdate, /superseded/);
  assert.deepEqual(
    await readFile(join(staleFixture.root, "state", "subscriptions.json")),
    currentStateBeforeStaleResponse,
  );
  assert.equal(staleFixture.configs.size, 0);
  await assert.rejects(
    readFile(join(staleFixture.root, "providers", "stale_provider.yaml")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  const currentAfterStale = staleFixture.service.list().find((item) => item.id === staleCreated.id)!;
  assert.equal(currentAfterStale.status, "idle");
  assert.equal(currentAfterStale.lastAttemptAt, null);
  assert.equal(currentAfterStale.intervalMinutes, 30);

  await staleFixture.service.updateNow(staleCreated.id);
  const currentProviderPath = join(staleFixture.root, "providers", "stale_provider.yaml");
  const currentProviderContent = await readFile(currentProviderPath, "utf8");
  assert.match(currentProviderContent, /node-b/);
  assert.doesNotMatch(currentProviderContent, /node-a/);
  const currentProviderSha = staleFixture.service.list().find(
    (item) => item.id === staleCreated.id,
  )!.providerSha256;
  currentResponse = "proxies:\n  - {}\n";
  await assert.rejects(staleFixture.service.updateNow(staleCreated.id), SubscriptionDownloadError);
  assert.equal(await readFile(currentProviderPath, "utf8"), currentProviderContent);
  assert.equal(
    staleFixture.service.list().find((item) => item.id === staleCreated.id)?.providerSha256,
    currentProviderSha,
  );
  staleFixture.service.close();

  let failDormantRenameCleanup = false;
  const dormantFixture = await fixtureService(async () => new Response(validYaml), {
    beforeProviderRenameCleanup: async (phase) => {
      if (failDormantRenameCleanup && phase === "commit-source") {
        throw new Error("dormant rename cleanup failed");
      }
    },
  });
  const dormantOwned = await dormantFixture.service.create({
    ...input,
    name: "Dormant owned",
    providerName: "dormant_owned",
  });
  await dormantFixture.service.updateNow(dormantOwned.id);
  const dormantPublished = dormantFixture.service.list().find((item) => item.id === dormantOwned.id)!;
  const dormantPath = join(dormantFixture.root, "providers", "dormant_owned.yaml");
  const dormantContent = await readFile(dormantPath, "utf8");
  const dormantFilter = await dormantFixture.providerFiles.saveFilterSettings("dormant_owned.yaml", {
    expectedVersion: 0,
    enabled: true,
    rules: ["notice"],
  });
  const disabledDormant = await dormantFixture.service.update(dormantOwned.id, {
    ...input,
    name: "Dormant owned",
    extractProvider: false,
    providerName: "dormant_owned",
    url: "",
  });
  assert.equal(disabledDormant.extractProvider, false);
  assert.equal(disabledDormant.providerSha256, dormantPublished.providerSha256);
  await dormantFixture.service.updateNow(dormantOwned.id);
  assert.equal(
    dormantFixture.service.list().find((item) => item.id === dormantOwned.id)?.providerSha256,
    dormantPublished.providerSha256,
  );
  const dormantRecord = await dormantFixture.providerFiles.read("dormant_owned.yaml");
  assert.equal(dormantRecord.source, "subscription");
  assert.deepEqual(dormantRecord.filterSettings, dormantFilter);

  const dormantRenamedPath = join(dormantFixture.root, "providers", "dormant_renamed.yaml");
  failDormantRenameCleanup = true;
  await assert.rejects(dormantFixture.service.update(dormantOwned.id, {
    ...input,
    name: "Dormant owned",
    extractProvider: false,
    providerName: "dormant_renamed",
    url: "",
  }), /recovery is incomplete/);
  const dormantAfterRenameCommit = dormantFixture.service.list().find((item) => item.id === dormantOwned.id)!;
  assert.equal(dormantAfterRenameCommit.extractProvider, false);
  assert.equal(dormantAfterRenameCommit.providerName, "dormant_renamed");
  assert.equal(dormantAfterRenameCommit.providerSha256, dormantPublished.providerSha256);
  assert.equal(await readFile(dormantPath, "utf8"), dormantContent);
  assert.equal(await readFile(dormantRenamedPath, "utf8"), dormantContent);
  assert.equal(
    JSON.parse(await readFile(dormantFixture.providerFiles.options.statePath, "utf8")).operationJournal?.phase,
    "committed",
  );
  failDormantRenameCleanup = false;

  dormantFixture.service.close();
  const dormantRestartQueue = new WriteQueue();
  let dormantRestartedService!: SubscriptionService;
  const dormantRestartedFiles = new ProviderFileService({
    ...dormantFixture.providerFiles.options,
    writeQueue: dormantRestartQueue,
    subscriptions: () => dormantRestartedService?.list() ?? [],
  });
  dormantRestartedService = new SubscriptionService({
    ...dormantFixture.service.options,
    writeQueue: dormantRestartQueue,
    publishProvider: (identity, commitState) => dormantRestartedFiles.publishSubscriptionProvider(identity, commitState),
    renameProvider: (identity, commitState) => dormantRestartedFiles.renameSubscriptionProvider(identity, commitState),
    ensureProviderOwnershipReady: () => dormantRestartedFiles.ensureProviderOperationRecovered(),
    assertProviderReservationAvailable: (identity) =>
      dormantRestartedFiles.assertSubscriptionReservationAvailable(identity),
    assertProviderIdentity: (identity) => dormantRestartedFiles.assertSubscriptionPublish(identity),
  });
  await dormantRestartedService.init();
  await dormantRestartedFiles.init();
  const dormantAfterRestart = dormantRestartedService.list().find((item) => item.id === dormantOwned.id)!;
  assert.equal(dormantAfterRestart.extractProvider, false);
  assert.equal(dormantAfterRestart.providerName, "dormant_renamed");
  assert.equal(dormantAfterRestart.providerSha256, dormantPublished.providerSha256);
  assert.equal((await dormantRestartedFiles.read("dormant_renamed.yaml")).source, "subscription");
  assert.deepEqual((await dormantRestartedFiles.read("dormant_renamed.yaml")).filterSettings, dormantFilter);
  await assert.rejects(readFile(dormantPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal(
    JSON.parse(await readFile(dormantRestartedFiles.options.statePath, "utf8")).operationJournal,
    null,
  );

  const reenabledDormant = await dormantRestartedService.update(dormantOwned.id, {
    ...input,
    name: "Dormant owned",
    providerName: "dormant_renamed",
    url: "",
  });
  assert.equal(reenabledDormant.extractProvider, true);
  assert.equal(reenabledDormant.providerSha256, dormantPublished.providerSha256);
  await dormantRestartedService.update(dormantOwned.id, {
    ...input,
    name: "Dormant owned",
    extractProvider: false,
    providerName: "dormant_renamed",
    url: "",
  });
  await writeFile(dormantRenamedPath, "proxies:\n  - { name: changed, type: direct }\n", "utf8");
  const dormantStateBeforeTamper = await readFile(dormantRestartedService.options.statePath);
  await assert.rejects(dormantRestartedService.update(dormantOwned.id, {
    ...input,
    name: "Dormant owned",
    providerName: "dormant_renamed",
    url: "",
  }));
  assert.deepEqual(await readFile(dormantRestartedService.options.statePath), dormantStateBeforeTamper);
  assert.equal(dormantRestartedService.list().find((item) => item.id === dormantOwned.id)?.extractProvider, false);
  await writeFile(dormantRenamedPath, dormantContent, "utf8");
  await unlink(dormantRenamedPath);
  await assert.rejects(dormantRestartedService.update(dormantOwned.id, {
    ...input,
    name: "Dormant owned",
    providerName: "dormant_renamed",
    url: "",
  }));
  assert.deepEqual(await readFile(dormantRestartedService.options.statePath), dormantStateBeforeTamper);
  dormantRestartedService.close();

  if (process.platform === "win32") {
    let caseRenameCleanup: "fail" | "replace" | null = null;
    let caseRenameRaceTarget = "";
    let replaceCaseProofAfterAliasRemoval = false;
    let caseProofReplacementContent = "";
    let caseFixtureRoot = "";
    let caseProviderStatePath = "";
    const caseRenameExternalContent = "proxies:\n  - { name: external-case, type: direct }\n";
    const caseFixture = await fixtureService(async () => new Response(validYaml), {
      beforeProviderRenameCleanup: async (phase) => {
        if (phase !== "commit-source") return;
        if (caseRenameCleanup === "fail") {
          throw new Error("case-only rename cleanup failed");
        }
        if (caseRenameCleanup === "replace") {
          caseRenameCleanup = null;
          await unlink(caseRenameRaceTarget);
          await writeFile(caseRenameRaceTarget, caseRenameExternalContent, "utf8");
        }
      },
      afterCaseAliasRemoval: async () => {
        if (!replaceCaseProofAfterAliasRemoval) return;
        replaceCaseProofAfterAliasRemoval = false;
        const journal = JSON.parse(
          await readFile(caseProviderStatePath, "utf8"),
        ).operationJournal;
        const proofPath = join(caseFixtureRoot, "providers", journal.caseProofFileName);
        await unlink(proofPath);
        await writeFile(proofPath, caseProofReplacementContent, "utf8");
      },
    });
    caseFixtureRoot = caseFixture.root;
    caseProviderStatePath = caseFixture.providerFiles.options.statePath;
    const caseReserved = await caseFixture.service.create({
      ...input,
      name: "Case reserved",
      providerName: "CaseProvider",
    });
    await assert.rejects(caseFixture.service.create({
      ...input,
      name: "Case duplicate",
      providerName: "caseprovider",
    }), /already exists|unavailable/);
    assert.equal(caseFixture.service.list().length, 1);
    await assert.rejects(caseFixture.providerFiles.create("proxy", "caseprovider.yaml"));
    const caseStateBeforeUnpublishedRename = await readFile(caseFixture.service.options.statePath);
    const unpublishedCaseTarget = join(caseFixture.root, "providers", "caseprovider.yaml");
    await writeFile(unpublishedCaseTarget, "proxies: []\n", "utf8");
    await assert.rejects(caseFixture.service.update(caseReserved.id, {
      ...input,
      name: "Case reserved",
      providerName: "caseprovider",
      url: "",
    }), /unavailable/);
    assert.deepEqual(await readFile(caseFixture.service.options.statePath), caseStateBeforeUnpublishedRename);
    assert.equal(caseFixture.service.list()[0]?.providerName, "CaseProvider");
    await unlink(unpublishedCaseTarget);
    await caseFixture.service.updateNow(caseReserved.id);
    const casePublishedSha = caseFixture.service.list()[0]!.providerSha256;
    caseRenameCleanup = "fail";
    await assert.rejects(caseFixture.service.update(caseReserved.id, {
      ...input,
      name: "Case reserved",
      providerName: "caseprovider",
      url: "",
    }), /recovery is incomplete/);
    assert.equal(caseFixture.service.list()[0]?.providerName, "caseprovider");
    assert.equal(caseFixture.service.list()[0]?.providerSha256, casePublishedSha);
    assert.equal((await readdir(join(caseFixture.root, "providers"))).includes("caseprovider.yaml"), true);
    assert.equal((await readdir(join(caseFixture.root, "providers"))).includes("CaseProvider.yaml"), false);
    caseRenameCleanup = null;
    caseFixture.service.close();
    const caseRestartQueue = new WriteQueue();
    let caseRestartedService!: SubscriptionService;
    const caseRestartedFiles = new ProviderFileService({
      ...caseFixture.providerFiles.options,
      writeQueue: caseRestartQueue,
      subscriptions: () => caseRestartedService?.list() ?? [],
    });
    caseRestartedService = new SubscriptionService({
      ...caseFixture.service.options,
      writeQueue: caseRestartQueue,
      publishProvider: (identity, commitState) => caseRestartedFiles.publishSubscriptionProvider(identity, commitState),
      renameProvider: (identity, commitState) => caseRestartedFiles.renameSubscriptionProvider(identity, commitState),
      ensureProviderOwnershipReady: () => caseRestartedFiles.ensureProviderOperationRecovered(),
      assertProviderReservationAvailable: (identity) =>
        caseRestartedFiles.assertSubscriptionReservationAvailable(identity),
      assertProviderIdentity: (identity) => caseRestartedFiles.assertSubscriptionPublish(identity),
    });
    await caseRestartedService.init();
    await caseRestartedFiles.init();
    assert.equal(caseRestartedService.list()[0]?.providerName, "caseprovider");
    assert.equal(caseRestartedService.list()[0]?.providerSha256, casePublishedSha);
    assert.equal((await caseRestartedFiles.read("caseprovider.yaml")).source, "subscription");
    assert.equal(JSON.parse(await readFile(caseRestartedFiles.options.statePath, "utf8")).operationJournal, null);

    const caseOwnedContent = await readFile(join(caseFixture.root, "providers", "caseprovider.yaml"), "utf8");
    caseRenameRaceTarget = join(caseFixture.root, "providers", "CASEPROVIDER.yaml");
    caseRenameCleanup = "replace";
    await assert.rejects(caseRestartedService.update(caseReserved.id, {
      ...input,
      name: "Case reserved",
      providerName: "CASEPROVIDER",
      url: "",
    }), /recovery is incomplete/);
    assert.equal(caseRestartedService.list()[0]?.providerName, "CASEPROVIDER");
    assert.equal(caseRestartedService.list()[0]?.providerSha256, casePublishedSha);
    assert.equal(await readFile(caseRenameRaceTarget, "utf8"), caseRenameExternalContent);
    const caseRaceJournal = JSON.parse(
      await readFile(caseRestartedFiles.options.statePath, "utf8"),
    ).operationJournal;
    assert.equal(caseRaceJournal?.phase, "committed");
    assert.equal(
      await readFile(join(caseFixture.root, "providers", caseRaceJournal.caseProofFileName), "utf8"),
      caseOwnedContent,
    );
    const caseProofPath = join(caseFixture.root, "providers", caseRaceJournal.caseProofFileName);
    const caseProofBeforeReplacement = await stat(caseProofPath);
    await unlink(caseRenameRaceTarget);
    await link(caseProofPath, join(caseFixture.root, "providers", "caseprovider.yaml"));
    caseProofReplacementContent = caseOwnedContent;
    replaceCaseProofAfterAliasRemoval = true;
    const caseRaceRecoveredFiles = new ProviderFileService({
      ...caseRestartedFiles.options,
      subscriptions: () => caseRestartedService.list(),
    });
    await assert.rejects(caseRaceRecoveredFiles.init(), ProviderFileRecoveryError);
    await assert.rejects(
      readFile(caseRenameRaceTarget),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    const caseProofAfterReplacement = await stat(caseProofPath);
    assert.notEqual(caseProofAfterReplacement.ino, caseProofBeforeReplacement.ino);
    assert.equal(await readFile(caseProofPath, "utf8"), caseOwnedContent);
    assert.equal(
      JSON.parse(await readFile(caseRaceRecoveredFiles.options.statePath, "utf8")).operationJournal?.phase,
      "committed",
    );
    caseRestartedService.close();
  }

  const manualTarget = await providerFiles.create("proxy", "manual_target.yaml");
  await assert.rejects(service.create({ ...input, providerName: "manual_target" }), /unavailable/);
  assert.equal(service.list().some((item) => item.providerName === "manual_target" && item.extractProvider), false);
  const manualAfterReject = await providerFiles.read("manual_target.yaml");
  assert.equal(manualAfterReject.source, "manual");
  assert.equal(manualAfterReject.writable, true);
  const manualSaved = await providerFiles.save(
    "proxy",
    "manual_target.yaml",
    "proxies:\n  - { name: manual, type: direct }\n",
    manualTarget.sha256,
  );
  assert.notEqual(manualSaved.sha256, manualTarget.sha256);
  const dormantManual = await service.create({
    ...input,
    name: "Dormant manual",
    extractProvider: false,
    providerName: "manual_target",
  });
  await assert.rejects(service.update(dormantManual.id, {
    ...input,
    name: "Dormant manual",
    providerName: "manual_target",
    url: "",
  }), /unavailable/);
  assert.equal(service.list().find((item) => item.id === dormantManual.id)?.extractProvider, false);

  const externalTargetPath = join(root, "providers", "external_target.yaml");
  const externalTargetContent = "proxies: []\n";
  await writeFile(externalTargetPath, externalTargetContent, "utf8");
  await assert.rejects(
    service.create({ ...input, name: "External", providerName: "external_target" }),
    /unavailable/,
  );
  const unpublishedActive = await service.create({
    ...input,
    name: "Unpublished active",
    providerName: "unpublished_initial",
  });
  const stateBeforeOccupiedRename = await readFile(service.options.statePath);
  await assert.rejects(service.update(unpublishedActive.id, {
    ...input,
    name: "Unpublished active",
    providerName: "manual_target",
    url: "",
  }), /unavailable/);
  assert.deepEqual(await readFile(service.options.statePath), stateBeforeOccupiedRename);
  assert.equal((await providerFiles.read("manual_target.yaml")).source, "manual");
  assert.equal((await providerFiles.read("manual_target.yaml")).writable, true);
  await assert.rejects(service.update(unpublishedActive.id, {
    ...input,
    name: "Unpublished active",
    providerName: "external_target",
    url: "",
  }), /unavailable/);
  assert.deepEqual(await readFile(service.options.statePath), stateBeforeOccupiedRename);
  const renamedUnpublished = await service.update(unpublishedActive.id, {
    ...input,
    name: "Unpublished active",
    providerName: "unpublished_available",
    url: "",
  });
  assert.equal(renamedUnpublished.providerName, "unpublished_available");
  assert.equal(renamedUnpublished.providerSha256, null);
  const dormantExternal = await service.create({
    ...input,
    name: "Dormant external",
    extractProvider: false,
    providerName: "external_target",
  });
  await assert.rejects(service.update(dormantExternal.id, {
    ...input,
    name: "Dormant external",
    providerName: "external_target",
    url: "",
  }), /unavailable/);
  assert.equal(service.list().find((item) => item.id === dormantExternal.id)?.extractProvider, false);
  assert.equal(await readFile(externalTargetPath, "utf8"), externalTargetContent);
  assert.equal(JSON.parse(await readFile(providerFiles.options.statePath, "utf8")).operationJournal, null);
  assert.equal((await providerFiles.create("proxy", "after-collision.yaml")).source, "manual");

  const reserved = await service.create({ ...input, name: "Reserved", providerName: "reserved_target" });
  await providerFiles.assertSubscriptionPublish({
    subscriptionId: reserved.id,
    fileName: "reserved_target.yaml",
    expectedSha256: null,
  });
  const stageAttackContent = "proxies:\n  - { name: stage-candidate, type: direct }\n";
  const stateBeforeFirstStageAttack = await readFile(service.options.statePath);
  let stageAttackCommits = 0;
  replacePublishStage = true;
  await assert.rejects(providerFiles.publishSubscriptionProvider({
    subscriptionId: reserved.id,
    fileName: "reserved_target.yaml",
    expectedSha256: null,
    content: stageAttackContent,
  }, async () => { stageAttackCommits += 1; }), ProviderFileConflictError);
  assert.equal(stageAttackCommits, 0);
  assert.deepEqual(await readFile(service.options.statePath), stateBeforeFirstStageAttack);
  await assert.rejects(
    readFile(join(root, "providers", "reserved_target.yaml")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  assert.equal(JSON.parse(await readFile(providerFiles.options.statePath, "utf8")).operationJournal, null);
  const dormantFree = await service.create({
    ...input,
    name: "Dormant free",
    extractProvider: false,
    providerName: "free_enabled",
  });
  const enabledFree = await service.update(dormantFree.id, {
    ...input,
    name: "Dormant free",
    providerName: "free_enabled",
    url: "",
  });
  assert.equal(enabledFree.extractProvider, true);
  assert.equal(enabledFree.providerName, "free_enabled");

  const created = await service.create({
    ...input,
    mergeIntoConfig: true,
    configName: "profile.yaml",
    groupNames: ["Alpha", "Beta", "Alpha"],
  });
  assert.deepEqual(created.groupNames, ["Alpha", "Beta"]);
  const generated = await service.updateNow(created.id);
  assert.match(generated.providerSha256 ?? "", /^[a-f0-9]{64}$/);
  const oldPath = join(root, "providers", "example_provider.yaml");
  const newPath = join(root, "providers", "renamed_provider.yaml");
  const previous = await readFile(oldPath, "utf8");

  const stateBeforeExistingStageAttack = await readFile(service.options.statePath);
  replacePublishStage = true;
  await assert.rejects(providerFiles.publishSubscriptionProvider({
    subscriptionId: created.id,
    fileName: "example_provider.yaml",
    expectedSha256: generated.providerSha256,
    content: stageAttackContent,
  }, async () => { stageAttackCommits += 1; }), ProviderFileConflictError);
  assert.equal(stageAttackCommits, 0);
  assert.deepEqual(await readFile(oldPath, "utf8"), previous);
  assert.deepEqual(await readFile(service.options.statePath), stateBeforeExistingStageAttack);
  assert.equal(service.list().find((item) => item.id === created.id)?.providerSha256, generated.providerSha256);
  assert.equal(JSON.parse(await readFile(providerFiles.options.statePath, "utf8")).operationJournal, null);
  assert.equal((await providerFiles.create("proxy", "after-stage-attacks.yaml")).source, "manual");

  for (const providerName of ["manual_target", "external_target", reserved.providerName]) {
    await assert.rejects(service.update(created.id, {
      ...input,
      providerName,
      mergeIntoConfig: true,
      configName: "profile.yaml",
      groupNames: ["Alpha", "Beta"],
      url: "",
    }));
    assert.equal(service.list().find((item) => item.id === created.id)?.providerName, "example_provider");
    assert.equal(await readFile(oldPath, "utf8"), previous);
  }

  configs.set("referencing.yaml", [
    "proxy-providers:",
    "  example_provider:",
    "    type: file",
    "    path: ./providers/example_provider.yaml",
    "",
  ].join("\n"));
  await assert.rejects(service.update(created.id, {
    ...input,
    providerName: "renamed_provider",
    mergeIntoConfig: true,
    configName: "profile.yaml",
    groupNames: ["Alpha", "Beta"],
    url: "",
  }), (error: ProviderFileReferencedError) => error.configNames.join(",") === "referencing.yaml");
  assert.equal(service.list().find((item) => item.id === created.id)?.providerName, "example_provider");
  assert.equal(await readFile(oldPath, "utf8"), previous);
  await assert.rejects(readFile(newPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal(JSON.parse(await readFile(providerFiles.options.statePath, "utf8")).operationJournal, null);
  configs.delete("referencing.yaml");

  const renamed = await service.update(created.id, {
    ...input,
    providerName: "renamed_provider",
    mergeIntoConfig: true,
    configName: "profile.yaml",
    groupNames: ["Alpha", "Beta"],
    url: "",
  });
  assert.equal(renamed.providerName, "renamed_provider");
  assert.equal(renamed.providerSha256, generated.providerSha256);
  assert.equal(await readFile(newPath, "utf8"), previous);
  await assert.rejects(readFile(oldPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  const failedPath = join(root, "providers", "failed_provider.yaml");
  failStateWrite = true;
  await assert.rejects(service.update(created.id, {
    ...input,
    providerName: "failed_provider",
    mergeIntoConfig: true,
    configName: "profile.yaml",
    groupNames: ["Alpha", "Beta"],
    url: "",
  }), /state publish failed/);
  assert.equal(await readFile(newPath, "utf8"), previous);
  await assert.rejects(readFile(failedPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  const afterFailure = service.list().find((item) => item.id === created.id);
  assert.equal(afterFailure?.providerName, "renamed_provider");
  assert.equal(afterFailure?.providerSha256, generated.providerSha256);
  assert.deepEqual(afterFailure?.groupNames, ["Alpha", "Beta"]);

  failStateWrite = false;
  failCommitCleanup = true;
  const livePath = join(root, "providers", "live_provider.yaml");
  await assert.rejects(service.update(created.id, {
    ...input,
    providerName: "live_provider",
    mergeIntoConfig: true,
    configName: "profile.yaml",
    groupNames: ["Alpha", "Beta"],
    autoUpdate: true,
    intervalMinutes: 30,
    url: "",
  }), /recovery is incomplete/);
  const durableState = JSON.parse(await readFile(join(root, "state", "subscriptions.json"), "utf8"));
  assert.equal(
    durableState.subscriptions.find((item: { id: string }) => item.id === created.id)?.providerName,
    "live_provider",
  );
  const liveMemory = service.list().find((item) => item.id === created.id);
  assert.equal(liveMemory?.providerName, "live_provider");
  assert.equal(liveMemory?.providerSha256, generated.providerSha256);
  assert.equal(liveMemory?.autoUpdate, true);
  assert.equal(liveMemory?.intervalMinutes, 30);
  assert.equal(scheduled, 1);
  const sourceBeforeGate = await readFile(newPath);
  const targetBeforeGate = await readFile(livePath);
  assert.deepEqual(targetBeforeGate, sourceBeforeGate);
  assert.equal(JSON.parse(await readFile(providerFiles.options.statePath, "utf8")).operationJournal?.phase, "committed");
  const subscriptionStateBeforeGate = await readFile(join(root, "state", "subscriptions.json"));
  let configRenameCalls = 0;
  const unownedSnapshot = {
    name: "unowned-renamed.yaml",
    path: join(root, "unowned-renamed.yaml"),
    content: "mode: rule\n",
    sha256: "b".repeat(64),
  };

  await assert.rejects(service.updateNow(created.id), /recovery is incomplete/);
  await assert.rejects(service.beginBinding(created.id), /recovery is incomplete/);
  await assert.rejects(service.renameConfigFile(
    "unowned.yaml",
    unownedSnapshot.name,
    async () => {
      configRenameCalls += 1;
      return unownedSnapshot;
    },
    async () => undefined,
  ), /recovery is incomplete/);
  assert.equal(configRenameCalls, 0);
  assert.equal(service.list().find((item) => item.id === created.id)?.binding, null);
  assert.deepEqual(await readFile(join(root, "state", "subscriptions.json")), subscriptionStateBeforeGate);
  await assert.rejects(
    providerFiles.save("proxy", "live_provider.yaml", "proxies: []\n", generated.providerSha256!),
    /recovery is incomplete/,
  );
  assert.deepEqual(await readFile(newPath), sourceBeforeGate);
  assert.deepEqual(await readFile(livePath), targetBeforeGate);
  assert.equal(JSON.parse(await readFile(providerFiles.options.statePath, "utf8")).operationJournal?.phase, "committed");
  assert.equal(service.list().find((item) => item.id === created.id)?.providerName, "live_provider");

  failCommitCleanup = false;
  const recoveredProviderFiles = new ProviderFileService({ ...providerFiles.options });
  await recoveredProviderFiles.init();
  await assert.rejects(readFile(newPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.deepEqual(await readFile(livePath), targetBeforeGate);
  assert.equal(JSON.parse(await readFile(providerFiles.options.statePath, "utf8")).operationJournal, null);
  service.options.publishProvider = (identity, commitState) =>
    recoveredProviderFiles.publishSubscriptionProvider(identity, commitState);
  service.options.renameProvider = (identity, commitState) =>
    recoveredProviderFiles.renameSubscriptionProvider(identity, commitState);
  service.options.ensureProviderOwnershipReady = () => recoveredProviderFiles.ensureProviderOperationRecovered();
  service.options.assertProviderReservationAvailable = (identity) =>
    recoveredProviderFiles.assertSubscriptionReservationAvailable(identity);
  service.options.assertProviderIdentity = (identity) => recoveredProviderFiles.assertSubscriptionPublish(identity);
  const claimedAfterRecovery = await service.beginBinding(created.id);
  assert.equal(claimedAfterRecovery.binding?.status, "pending-add");
  const renamedAfterRecovery = await service.renameConfigFile(
    "unowned.yaml",
    unownedSnapshot.name,
    async () => {
      configRenameCalls += 1;
      return unownedSnapshot;
    },
    async () => undefined,
  );
  assert.equal(renamedAfterRecovery.name, unownedSnapshot.name);
  assert.equal(configRenameCalls, 1);
  assert.equal((await service.releaseBinding(created.id)).binding, null);
  await service.updateNow(created.id);
  const postRecoveryManual = await recoveredProviderFiles.create("proxy", "post-recovery.yaml");
  const postRecoverySaved = await recoveredProviderFiles.save(
    "proxy",
    "post-recovery.yaml",
    "proxies:\n  - { name: post-recovery, type: direct }\n",
    postRecoveryManual.sha256,
  );
  assert.notEqual(postRecoverySaved.sha256, postRecoveryManual.sha256);

  const sameContentBefore = service.list().find((item) => item.id === created.id)!;
  const sameContentIdentity = await stat(livePath);
  await service.updateNow(created.id);
  const sameContentAfter = await stat(livePath);
  assert.equal(sameContentAfter.dev, sameContentIdentity.dev);
  assert.equal(sameContentAfter.ino, sameContentIdentity.ino);
  assert.equal((await recoveredProviderFiles.read("live_provider.yaml")).sha256, sameContentBefore.providerSha256);
  assert.equal(JSON.parse(await readFile(providerFiles.options.statePath, "utf8")).operationJournal, null);
  const beforeSameContentFailure = service.list().find((item) => item.id === created.id)!;
  failStateWrite = true;
  await assert.rejects(service.updateNow(created.id), /state publish failed/);
  failStateWrite = false;
  const afterSameContentFailure = service.list().find((item) => item.id === created.id)!;
  assert.deepEqual(afterSameContentFailure, beforeSameContentFailure);
  const sameContentFailureIdentity = await stat(livePath);
  assert.equal(sameContentFailureIdentity.dev, sameContentIdentity.dev);
  assert.equal(sameContentFailureIdentity.ino, sameContentIdentity.ino);
  assert.equal(JSON.parse(await readFile(providerFiles.options.statePath, "utf8")).operationJournal, null);

  const preparedContent = "proxies:\n  - { name: prepared-recovery, type: direct }\n";
  const beforePreparedContent = await readFile(livePath);
  const stateBeforePreparedRecovery = await readFile(service.options.statePath);
  crashProviderOperation = "publish:prepared";
  await assert.rejects(recoveredProviderFiles.publishSubscriptionProvider({
    subscriptionId: created.id,
    fileName: "live_provider.yaml",
    expectedSha256: service.list().find((item) => item.id === created.id)!.providerSha256,
    content: preparedContent,
  }, async () => { throw new Error("state callback must not run after interruption"); }), /simulated provider interruption/);
  crashProviderOperation = null;
  const preparedJournal = JSON.parse(
    await readFile(providerFiles.options.statePath, "utf8"),
  ).operationJournal;
  assert.equal(preparedJournal.phase, "prepared");
  await writeFile(join(root, "providers", preparedJournal.stageFileName), preparedContent, "utf8");
  await assert.rejects(
    readFile(join(root, "providers", preparedJournal.backupFileName)),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  const preparedRecoveredFiles = new ProviderFileService({ ...providerFiles.options });
  await preparedRecoveredFiles.init();
  assert.deepEqual(await readFile(livePath), beforePreparedContent);
  assert.deepEqual(await readFile(service.options.statePath), stateBeforePreparedRecovery);
  assert.equal(JSON.parse(await readFile(providerFiles.options.statePath, "utf8")).operationJournal, null);
  service.options.publishProvider = (identity, commitState) =>
    preparedRecoveredFiles.publishSubscriptionProvider(identity, commitState);
  service.options.renameProvider = (identity, commitState) =>
    preparedRecoveredFiles.renameSubscriptionProvider(identity, commitState);
  service.options.ensureProviderOwnershipReady = () => preparedRecoveredFiles.ensureProviderOperationRecovered();
  service.options.assertProviderReservationAvailable = (identity) =>
    preparedRecoveredFiles.assertSubscriptionReservationAvailable(identity);
  service.options.assertProviderIdentity = (identity) => preparedRecoveredFiles.assertSubscriptionPublish(identity);
  downloadContent = preparedContent;
  const afterPreparedRecovery = await service.updateNow(created.id);
  assert.equal((await preparedRecoveredFiles.read("live_provider.yaml")).sha256, afterPreparedRecovery.providerSha256);

  const beforePublish = await readFile(livePath);
  const replacement = [
    "proxies:",
    "  - name: replacement",
    "    type: socks5",
    "    server: 127.0.0.2",
    "    port: 1081",
    "",
  ].join("\n");
  crashProviderOperation = "publish:published";
  await assert.rejects(preparedRecoveredFiles.publishSubscriptionProvider({
    subscriptionId: created.id,
    fileName: "live_provider.yaml",
    expectedSha256: service.list().find((item) => item.id === created.id)!.providerSha256,
    content: replacement,
  }, async () => { throw new Error("state callback must not run after interruption"); }), /simulated provider interruption/);
  assert.notDeepEqual(await readFile(livePath), beforePublish);
  crashProviderOperation = null;
  let recoveredPublishFiles = new ProviderFileService({ ...providerFiles.options });
  await recoveredPublishFiles.init();
  assert.deepEqual(await readFile(livePath), beforePublish);
  assert.equal(JSON.parse(await readFile(providerFiles.options.statePath, "utf8")).operationJournal, null);

  crashProviderOperation = "publish:published";
  const firstPublishPath = join(root, "providers", "reserved_target.yaml");
  await assert.rejects(recoveredPublishFiles.publishSubscriptionProvider({
    subscriptionId: reserved.id,
    fileName: "reserved_target.yaml",
    expectedSha256: null,
    content: replacement,
  }, async () => { throw new Error("state callback must not run after interruption"); }), /simulated provider interruption/);
  assert.equal((await readFile(firstPublishPath)).byteLength > 0, true);
  crashProviderOperation = null;
  recoveredPublishFiles = new ProviderFileService({ ...providerFiles.options });
  await recoveredPublishFiles.init();
  await assert.rejects(readFile(firstPublishPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  service.options.publishProvider = (identity, commitState) =>
    recoveredPublishFiles.publishSubscriptionProvider(identity, commitState);
  service.options.renameProvider = (identity, commitState) =>
    recoveredPublishFiles.renameSubscriptionProvider(identity, commitState);
  service.options.ensureProviderOwnershipReady = () => recoveredPublishFiles.ensureProviderOperationRecovered();
  service.options.assertProviderReservationAvailable = (identity) =>
    recoveredPublishFiles.assertSubscriptionReservationAvailable(identity);
  service.options.assertProviderIdentity = (identity) => recoveredPublishFiles.assertSubscriptionPublish(identity);
  downloadContent = replacement;
  crashProviderOperation = "publish:committed";
  await assert.rejects(service.updateNow(created.id), /recovery is incomplete/);
  const committedPublish = service.list().find((item) => item.id === created.id)!;
  assert.notEqual(committedPublish.providerSha256, generated.providerSha256);
  assert.equal(
    JSON.parse(await readFile(join(root, "state", "subscriptions.json"), "utf8"))
      .subscriptions.find((item: { id: string }) => item.id === created.id)?.providerSha256,
    committedPublish.providerSha256,
  );
  crashProviderOperation = null;
  recoveredPublishFiles = new ProviderFileService({ ...providerFiles.options });
  await recoveredPublishFiles.init();
  assert.equal((await recoveredPublishFiles.read("live_provider.yaml")).sha256, committedPublish.providerSha256);
  assert.equal(JSON.parse(await readFile(providerFiles.options.statePath, "utf8")).operationJournal, null);

  let startupCrashPhase: string | null = null;
  const startupFixture = await fixtureService(async () => new Response(validYaml), {
    afterProviderOperationPhase: async (operation, phase) => {
      if (`${operation}:${phase}` === startupCrashPhase) throw new Error("simulated startup journal");
    },
  });
  const startupSubscription = await startupFixture.service.create({
    ...input,
    name: "Startup recovery",
    providerName: "startup_recovery",
    autoUpdate: true,
    intervalMinutes: 1,
  });
  const startupCommitted = await startupFixture.service.updateNow(startupSubscription.id);
  startupFixture.service.close();
  startupCrashPhase = "publish:published";
  await assert.rejects(startupFixture.providerFiles.publishSubscriptionProvider({
    subscriptionId: startupSubscription.id,
    fileName: "startup_recovery.yaml",
    expectedSha256: startupCommitted.providerSha256,
    content: replacement,
  }, async () => { throw new Error("state callback must not run after interruption"); }), /simulated startup journal/);
  startupCrashPhase = null;
  const startupStatePath = join(startupFixture.root, "state", "subscriptions.json");
  const overdueState = JSON.parse(await readFile(startupStatePath, "utf8"));
  overdueState.subscriptions[0].nextUpdateAt = "2020-01-01T00:00:00.000Z";
  await writeFile(startupStatePath, JSON.stringify(overdueState), "utf8");

  const startupTimers: Array<() => void> = [];
  let startupDownloads = 0;
  let releaseRecovery!: () => void;
  let markRecoveryStarted!: () => void;
  const recoveryBlocked = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  const recoveryStarted = new Promise<void>((resolve) => { markRecoveryStarted = resolve; });
  let startupRecoveredProvider!: ProviderFileService;
  const startupReloaded = new SubscriptionService({
    ...startupFixture.service.options,
    writeQueue: startupFixture.providerFiles.options.writeQueue!,
    fetchImpl: async () => {
      startupDownloads += 1;
      return new Response(validYaml);
    },
    setTimer: ((callback: () => void) => {
      startupTimers.push(callback);
      return { unref() {} } as NodeJS.Timeout;
    }),
    clearTimer: () => undefined,
    publishProvider: (identity, commitState) => startupRecoveredProvider.publishSubscriptionProvider(identity, commitState),
    renameProvider: (identity, commitState) => startupRecoveredProvider.renameSubscriptionProvider(identity, commitState),
    ensureProviderOwnershipReady: () => startupRecoveredProvider.ensureProviderOperationRecovered(),
    assertProviderReservationAvailable: (identity) =>
      startupRecoveredProvider.assertSubscriptionReservationAvailable(identity),
    assertProviderIdentity: (identity) => startupRecoveredProvider.assertSubscriptionPublish(identity),
  });
  await startupReloaded.init();
  startupRecoveredProvider = new ProviderFileService({
    ...startupFixture.providerFiles.options,
    subscriptions: () => startupReloaded.list(),
    beforeOperationCleanup: async (operation, phase) => {
      if (operation === "publish" && phase === "rollback-target") {
        markRecoveryStarted();
        await recoveryBlocked;
      }
    },
  });
  const startupProviderInit = startupRecoveredProvider.init();
  await recoveryStarted;
  assert.equal(startupTimers.length, 0);
  assert.equal(startupDownloads, 0);
  await assert.rejects(startupRecoveredProvider.ensureProviderOperationRecovered(), /recovery is incomplete/);
  releaseRecovery();
  await startupProviderInit;
  startupReloaded.startScheduling();
  startupReloaded.startScheduling();
  assert.equal(startupTimers.length, 1);
  startupTimers[0]!();
  for (let attempt = 0; attempt < 50 && startupDownloads === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(startupDownloads, 1);
  for (let attempt = 0; attempt < 50 && startupReloaded.list()[0]?.status !== "success"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const startupAfterRecovery = startupReloaded.list()[0]!;
  assert.equal(
    (await startupRecoveredProvider.read("startup_recovery.yaml")).sha256,
    startupAfterRecovery.providerSha256,
  );
  assert.equal(
    JSON.parse(await readFile(startupFixture.providerFiles.options.statePath, "utf8")).operationJournal,
    null,
  );
  startupReloaded.close();

  let collisionTarget: string | null = null;
  let failCollisionCleanup = false;
  const collisionFixture = await fixtureService(async () => new Response(validYaml), {
    afterProviderOperationPhase: async (operation, phase) => {
      if (operation === "publish" && phase === "staged" && collisionTarget) {
        await writeFile(collisionTarget, "proxies: []\n", "utf8");
      }
    },
    beforeProviderOperationCleanup: async (operation, phase) => {
      if (failCollisionCleanup && operation === "publish" && phase === "cleanup-anchor") {
        throw new Error("publish collision cleanup failed");
      }
    },
  });
  const collisionSubscription = await collisionFixture.service.create({
    ...input,
    name: "Publish collision",
    providerName: "publish_collision",
  });
  collisionTarget = join(collisionFixture.root, "providers", "publish_collision.yaml");
  await assert.rejects(collisionFixture.service.updateNow(collisionSubscription.id), /ownership/);
  assert.equal(await readFile(collisionTarget, "utf8"), "proxies: []\n");
  assert.equal(
    JSON.parse(await readFile(collisionFixture.providerFiles.options.statePath, "utf8")).operationJournal,
    null,
  );
  collisionTarget = null;
  assert.equal((await collisionFixture.providerFiles.create("proxy", "collision-unrelated.yaml")).source, "manual");

  const cleanupCollision = await collisionFixture.service.create({
    ...input,
    name: "Publish cleanup collision",
    providerName: "publish_cleanup_collision",
  });
  collisionTarget = join(collisionFixture.root, "providers", "publish_cleanup_collision.yaml");
  failCollisionCleanup = true;
  await assert.rejects(collisionFixture.service.updateNow(cleanupCollision.id), ProviderFileRecoveryError);
  assert.equal(await readFile(collisionTarget, "utf8"), "proxies: []\n");
  assert.equal(
    JSON.parse(await readFile(collisionFixture.providerFiles.options.statePath, "utf8")).operationJournal?.phase,
    "aborting",
  );
  failCollisionCleanup = false;
  collisionTarget = null;
  const collisionRecoveredProvider = new ProviderFileService({ ...collisionFixture.providerFiles.options });
  await collisionRecoveredProvider.init();
  assert.equal(await readFile(join(collisionFixture.root, "providers", "publish_cleanup_collision.yaml"), "utf8"), "proxies: []\n");
  assert.equal(
    JSON.parse(await readFile(collisionFixture.providerFiles.options.statePath, "utf8")).operationJournal,
    null,
  );

  let beforeIdentityCrash = false;
  const beforeIdentityFixture = await fixtureService(async () => new Response(validYaml), {
    afterProviderOperationPhase: async (operation, phase) => {
      if (beforeIdentityCrash && operation === "publish" && phase === "published") {
        throw new Error("stop before SHA commit");
      }
    },
  });
  const beforeIdentitySubscription = await beforeIdentityFixture.service.create({
    ...input,
    name: "Before identity",
    providerName: "before_identity",
  });
  const beforeIdentityCommitted = await beforeIdentityFixture.service.updateNow(beforeIdentitySubscription.id);
  const beforeIdentityPath = join(beforeIdentityFixture.root, "providers", "before_identity.yaml");
  const beforeIdentityContent = await readFile(beforeIdentityPath);
  beforeIdentityCrash = true;
  await assert.rejects(beforeIdentityFixture.providerFiles.publishSubscriptionProvider({
    subscriptionId: beforeIdentitySubscription.id,
    fileName: "before_identity.yaml",
    expectedSha256: beforeIdentityCommitted.providerSha256,
    content: replacement,
  }, async () => { throw new Error("state callback must not run after interruption"); }), /stop before SHA commit/);
  const beforeIdentityJournal = JSON.parse(
    await readFile(beforeIdentityFixture.providerFiles.options.statePath, "utf8"),
  ).operationJournal;
  await unlink(beforeIdentityPath);
  await writeFile(beforeIdentityPath, beforeIdentityContent);
  beforeIdentityCrash = false;
  const beforeIdentityReload = new ProviderFileService({ ...beforeIdentityFixture.providerFiles.options });
  await assert.rejects(beforeIdentityReload.init(), ProviderFileRecoveryError);
  assert.deepEqual(await readFile(beforeIdentityPath), beforeIdentityContent);
  assert.deepEqual(
    await readFile(join(beforeIdentityFixture.root, "providers", beforeIdentityJournal.backupFileName)),
    beforeIdentityContent,
  );
  assert.equal(
    JSON.parse(await readFile(beforeIdentityFixture.providerFiles.options.statePath, "utf8"))
      .operationJournal?.operation,
    "publish",
  );

  crashProviderOperation = "publish:published";
  const independentIntended = validYaml;
  await assert.rejects(recoveredPublishFiles.publishSubscriptionProvider({
    subscriptionId: created.id,
    fileName: "live_provider.yaml",
    expectedSha256: committedPublish.providerSha256,
    content: independentIntended,
  }, async () => { throw new Error("state callback must not run after interruption"); }), /simulated provider interruption/);
  const independentJournal = JSON.parse(await readFile(providerFiles.options.statePath, "utf8")).operationJournal;
  await unlink(livePath);
  await writeFile(livePath, independentIntended, "utf8");
  crashProviderOperation = null;
  const conflictedPublishFiles = new ProviderFileService({ ...providerFiles.options });
  await assert.rejects(conflictedPublishFiles.init(), /recovery is incomplete/);
  assert.equal(await readFile(livePath, "utf8"), independentIntended);
  assert.equal(
    (await readFile(join(root, "providers", independentJournal.backupFileName))).byteLength > 0,
    true,
  );
  assert.equal(
    await readFile(join(root, "providers", independentJournal.anchorFileName), "utf8"),
    independentIntended,
  );
  assert.equal(JSON.parse(await readFile(providerFiles.options.statePath, "utf8")).operationJournal?.operation, "publish");
});

test("subscription metadata can be saved without Provider extraction", async () => {
  const { root, service } = await fixtureService(async () => new Response(validYaml, {
    headers: { "subscription-userinfo": "upload=1024; download=invalid; total=4096; expire=1785542400; ignored=" },
  }));
  const created = await service.create({
    name: "Metadata only",
    url: "https://example.test/metadata",
    extractProvider: false,
    mergeIntoConfig: false,
    autoUpdate: true,
    intervalMinutes: 60,
  });
  assert.equal(created.extractProvider, false);
  assert.equal(created.providerName, "");
  assert.equal(created.autoUpdate, true);
  assert.ok(created.nextUpdateAt);
  const updated = await service.updateNow(created.id);
  assert.equal(updated.providerName, null);
  assert.equal(updated.providerPath, null);
  assert.equal(service.list()[0]?.status, "success");
  assert.equal(service.list()[0]?.nodeCount, 1);
  assert.equal(service.list()[0]?.uploadBytes, 1024);
  assert.equal(service.list()[0]?.downloadBytes, null);
  assert.equal(service.list()[0]?.totalBytes, 4096);
  assert.equal(service.list()[0]?.expiresAt, "2026-08-01T00:00:00.000Z");
  const persisted = JSON.parse(await readFile(join(root, "state", "subscriptions.json"), "utf8"));
  assert.equal(persisted.subscriptions[0].uploadBytes, 1024);
});

test("binding requires an independently committed and verified Provider file after extraction is enabled", async () => {
  let failDownload = false;
  const { root, service } = await fixtureService(async () => {
    if (failDownload) throw new Error("injected download failure");
    return new Response(validYaml);
  });
  const created = await service.create({
    ...input,
    extractProvider: false,
    providerName: "",
  });
  await service.updateNow(created.id);
  const enabled = await service.update(created.id, {
    ...input,
    mergeIntoConfig: true,
    configName: "profile.yaml",
    groupNames: ["Proxy"],
    url: "",
  });
  assert.ok(enabled.lastUpdatedAt);
  assert.equal(enabled.providerSha256, null);
  await assert.rejects(service.beginBinding(created.id), /provider has not been generated/);

  failDownload = true;
  await assert.rejects(service.updateNow(created.id));
  assert.equal(service.list()[0]?.extractProvider, true);
  assert.equal(service.list()[0]?.providerSha256, null);
  assert.equal(service.list()[0]?.binding, null);

  failDownload = false;
  const generated = await service.updateNow(created.id);
  assert.match(generated.providerSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(service.list()[0]?.providerSha256, generated.providerSha256);
  assert.equal((await service.beginBinding(created.id)).binding?.status, "pending-add");
  const generatedProviderPath = join(root, "providers", "example_provider.yaml");
  const generatedProviderContent = await readFile(generatedProviderPath);
  await unlink(generatedProviderPath);
  await assert.rejects(service.activateBinding(created.id), /provider is unavailable or changed/);
  assert.equal(service.list().find((item) => item.id === created.id)?.binding?.status, "pending-add");
  const bindingStateAfterMissing = JSON.parse(await readFile(join(root, "state", "subscriptions.json"), "utf8"));
  assert.equal(
    bindingStateAfterMissing.subscriptions.find((item: { id: string }) => item.id === created.id)?.binding?.status,
    "pending-add",
  );
  await writeFile(generatedProviderPath, generatedProviderContent);
  assert.equal((await service.activateBinding(created.id)).binding?.status, "active");
  const activeStateBeforeRetry = await readFile(join(root, "state", "subscriptions.json"));
  await unlink(generatedProviderPath);
  assert.equal((await service.activateBinding(created.id)).binding?.status, "active");
  assert.deepEqual(await readFile(join(root, "state", "subscriptions.json")), activeStateBeforeRetry);
  await writeFile(generatedProviderPath, generatedProviderContent);

  const missing = await service.create({
    ...input,
    name: "Missing Provider",
    providerName: "missing_provider",
    mergeIntoConfig: true,
    configName: "profile.yaml",
    groupNames: ["Proxy"],
  });
  await service.updateNow(missing.id);
  await unlink(join(root, "providers", "missing_provider.yaml"));
  await assert.rejects(service.beginBinding(missing.id), /provider is unavailable or changed/);
  assert.equal(service.list().find((item) => item.id === missing.id)?.binding, null);

  const changed = await service.create({
    ...input,
    name: "Changed Provider",
    providerName: "changed_provider",
    mergeIntoConfig: true,
    configName: "profile.yaml",
    groupNames: ["Proxy"],
  });
  await service.updateNow(changed.id);
  await writeFile(join(root, "providers", "changed_provider.yaml"), "proxies: []\n", "utf8");
  await assert.rejects(service.beginBinding(changed.id), /provider is unavailable or changed/);
  assert.equal(service.list().find((item) => item.id === changed.id)?.binding, null);
});

test("Provider name follow mode persists and legacy subscriptions infer without renaming custom Providers", async () => {
  const { root, service } = await fixtureService(async () => new Response(validYaml));
  const followed = await service.create({
    ...input,
    name: "跟随名称",
    extractProvider: false,
    providerName: "",
    providerNameMode: "follow",
  });
  assert.equal(followed.providerName, "跟随名称");
  assert.equal(followed.providerNameMode, "follow");
  const renamed = await service.update(followed.id, {
    ...input,
    name: "新的名称",
    extractProvider: false,
    providerName: followed.providerName,
    providerNameMode: "follow",
    url: "",
  });
  assert.equal(renamed.providerName, "新的名称");
  const customized = await service.update(followed.id, {
    ...input,
    name: "再次改名",
    extractProvider: false,
    providerName: "独立代理集",
    providerNameMode: "custom",
    url: "",
  });
  assert.equal(customized.providerName, "独立代理集");
  assert.equal(customized.providerNameMode, "custom");

  const legacyFollow = await service.create({
    ...input,
    name: "旧同名",
    extractProvider: false,
    providerName: "旧同名",
    providerNameMode: "follow",
  });
  service.close();
  const statePath = join(root, "state", "subscriptions.json");
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  for (const subscription of persisted.subscriptions) delete subscription.providerNameMode;
  await writeFile(statePath, JSON.stringify(persisted), "utf8");
  const reloaded = new SubscriptionService(service.options);
  await reloaded.init();
  assert.equal(reloaded.list().find((item) => item.id === customized.id)?.providerNameMode, "custom");
  assert.equal(reloaded.list().find((item) => item.id === customized.id)?.providerName, "独立代理集");
  assert.equal(reloaded.list().find((item) => item.id === legacyFollow.id)?.providerNameMode, "follow");
  reloaded.close();
});

test("empty known userinfo fields and an out-of-range expiry never block a valid update", async () => {
  const { service } = await fixtureService(async () => new Response(validYaml, {
    headers: {
      "subscription-userinfo": "upload=; download= ; total=; expire=9007199254740991",
    },
  }));
  const created = await service.create({ ...input, extractProvider: false, providerName: "" });
  const result = await service.updateNow(created.id);
  assert.equal(result.nodeCount, 1);
  const updated = service.list()[0]!;
  assert.equal(updated.status, "success");
  assert.equal(updated.uploadBytes, null);
  assert.equal(updated.downloadBytes, null);
  assert.equal(updated.totalBytes, null);
  assert.equal(updated.expiresAt, null);
});

test("an empty expiry field is ignored without blocking a valid update", async () => {
  const { service } = await fixtureService(async () => new Response(validYaml, {
    headers: { "subscription-userinfo": "upload=1; expire=" },
  }));
  const created = await service.create({ ...input, extractProvider: false, providerName: "" });
  const result = await service.updateNow(created.id);
  assert.equal(result.nodeCount, 1);
  const updated = service.list()[0]!;
  assert.equal(updated.status, "success");
  assert.equal(updated.uploadBytes, 1);
  assert.equal(updated.expiresAt, null);
});

test("automatic updates run without Provider extraction, sync raw YAML, and write no Provider file", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const synced: Array<{ name: string; existing: boolean }> = [];
  let rawContentMatched = true;
  const { root, service } = await fixtureService(
    async () => new Response(validYaml, {
      headers: { "subscription-userinfo": "upload=512; download=1536; total=8192; expire=1785542400" },
    }),
    {
      setTimer: ((callback: () => void, delay: number) => {
        scheduled.push({ callback, delay });
        return { unref() {} } as NodeJS.Timeout;
      }),
      clearTimer: () => undefined,
      syncConfigFile: async (name, content, existing) => {
        synced.push({ name, existing });
        rawContentMatched &&= content === validYaml;
        return {
          name,
          path: join(root, name),
          content,
          sha256: "a".repeat(64),
        };
      },
    },
  );
  const created = await service.create({
    name: "订阅示例",
    url: "https://example.test/scheduled-metadata",
    extractProvider: false,
    mergeIntoConfig: false,
    autoUpdate: true,
    intervalMinutes: 30,
  });
  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0]!.delay > 0);
  scheduled[0]!.callback();
  for (let attempt = 0; attempt < 50 && service.list()[0]?.status !== "success"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const updated = service.list().find((item) => item.id === created.id);
  assert.equal(updated?.status, "success");
  assert.equal(updated?.nodeCount, 1);
  assert.equal(updated?.configFileName, "订阅示例.yaml");
  assert.equal(updated?.uploadBytes, 512);
  assert.equal(updated?.downloadBytes, 1536);
  assert.equal(updated?.totalBytes, 8192);
  assert.equal(synced.length, 1);
  assert.equal(synced[0]?.name, "订阅示例.yaml");
  assert.equal(synced[0]?.existing, false);
  assert.equal(rawContentMatched, true);
  await assert.rejects(
    readFile(join(root, "providers", ".yaml"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  await service.updateNow(created.id);
  assert.equal(synced.length, 2);
  assert.equal(synced[1]?.name, "订阅示例.yaml");
  assert.equal(synced[1]?.existing, true);
  assert.equal(rawContentMatched, true);
  service.close();
});

test("successful responses clear missing usage metadata while failures preserve the last success", async () => {
  let mode: "metadata" | "missing" | "failure" = "metadata";
  const { service } = await fixtureService(async () => {
    if (mode === "failure") throw new Error("network unavailable");
    return new Response(validYaml, mode === "metadata" ? {
      headers: { "subscription-userinfo": "upload=10; download=20; total=100; expire=1785542400" },
    } : undefined);
  });
  const created = await service.create({ ...input, extractProvider: false, providerName: "" });
  await service.updateNow(created.id);
  assert.equal(service.list()[0]?.totalBytes, 100);
  mode = "failure";
  await assert.rejects(service.updateNow(created.id), SubscriptionDownloadError);
  assert.equal(service.list()[0]?.status, "error");
  assert.equal(service.list()[0]?.totalBytes, 100);
  assert.equal(service.list()[0]?.expiresAt, "2026-08-01T00:00:00.000Z");
  mode = "missing";
  await service.updateNow(created.id);
  assert.equal(service.list()[0]?.status, "success");
  assert.equal(service.list()[0]?.uploadBytes, null);
  assert.equal(service.list()[0]?.downloadBytes, null);
  assert.equal(service.list()[0]?.totalBytes, null);
  assert.equal(service.list()[0]?.expiresAt, null);
});

test("a first subscription update never overwrites an occupied non-subscription config name", async () => {
  let attemptedExisting: boolean | null = null;
  const { service } = await fixtureService(async () => new Response(validYaml), {
    syncConfigFile: async (_name, _content, existing) => {
      attemptedExisting = existing;
      throw new ConfigFileExistsError("configuration file already exists");
    },
  });
  const created = await service.create({ ...input, name: "Occupied", extractProvider: false, providerName: "" });
  await assert.rejects(service.updateNow(created.id), ConfigFileExistsError);
  assert.equal(attemptedExisting, false);
  assert.equal(service.list()[0]?.configFileName, null);
  assert.equal(service.list()[0]?.status, "error");
});

test("renaming a subscription-managed config updates ownership and all later sync targets", async () => {
  const synced: Array<{ name: string; existing: boolean }> = [];
  const { service } = await fixtureService(async () => new Response(validYaml), {
    syncConfigFile: async (name, content, existing) => {
      synced.push({ name, existing });
      return { name, path: join("controlled", name), content, sha256: "a".repeat(64) };
    },
  });
  const created = await service.create({ ...input, name: "Managed", extractProvider: false, providerName: "" });
  await service.updateNow(created.id);
  assert.deepEqual(service.configOwner("Managed.yaml"), { id: created.id, name: "Managed" });
  const renamed = await service.renameConfigFile(
    "Managed.yaml",
    "Renamed.yml",
    async () => ({ name: "Renamed.yml", path: join("controlled", "Renamed.yml"), content: validYaml, sha256: "a".repeat(64) }),
    async () => undefined,
  );
  assert.equal(renamed.name, "Renamed.yml");
  assert.equal(service.configOwner("Managed.yaml"), null);
  assert.deepEqual(service.configOwner("Renamed.yml"), { id: created.id, name: "Managed" });
  await service.updateNow(created.id);
  assert.deepEqual(synced.map((entry) => entry.name), ["Managed.yaml", "Renamed.yml"]);
  assert.equal(synced[1]?.existing, true);
});

test("a failed subscription association write rolls the config rename back", async () => {
  let failStateWrite = false;
  let rolledBack = false;
  const { service } = await fixtureService(async () => new Response(validYaml), {
    beforeStateRename: async () => { if (failStateWrite) throw new Error("state write failed"); },
    syncConfigFile: async (name, content) => ({
      name,
      path: join("controlled", name),
      content,
      sha256: "a".repeat(64),
    }),
  });
  const created = await service.create({ ...input, name: "Rollback", extractProvider: false, providerName: "" });
  await service.updateNow(created.id);
  failStateWrite = true;
  await assert.rejects(service.renameConfigFile(
    "Rollback.yaml",
    "Renamed.yaml",
    async () => ({ name: "Renamed.yaml", path: join("controlled", "Renamed.yaml"), content: validYaml, sha256: "a".repeat(64) }),
    async () => { rolledBack = true; },
  ), /state write failed/);
  assert.equal(rolledBack, true);
  assert.deepEqual(service.configOwner("Rollback.yaml"), { id: created.id, name: "Rollback" });
  assert.equal(service.configOwner("Renamed.yaml"), null);
});

test("subscription CRUD returns the original URL to the trusted editor", async () => {
  const { service } = await fixtureService(async () => new Response(validYaml));
  const created = await service.create(input);
  assert.equal(created.url, input.url);
  assert.equal(created.urlConfigured, true);
  const updated = await service.update(created.id, { ...input, name: "Updated", url: "" });
  assert.equal(updated.name, "Updated");
  assert.equal(updated.url, input.url);
  assert.equal(service.list()[0]?.url, input.url);
  await service.delete(created.id);
  assert.deepEqual(service.list(), []);
});

test("subscription API supports CRUD and returns URLs", async () => {
  const { service } = await fixtureService(async () => new Response(validYaml));
  const server = createConfigdServer({
    store: {} as ConfigStore,
    subscriptions: service,
    maxBodyBytes: 4096,
  });
  const port = await listenSafe(server, 19140);
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${port}`;
    const createdResponse = await fetch(`${base}/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { id: string; url: string };
    assert.equal(created.url, input.url);
    const listed = await fetch(`${base}/subscriptions`);
    const listedBody = await listed.json() as { subscriptions: Array<{ url: string }> };
    assert.equal(listedBody.subscriptions[0]?.url, input.url);
    const metadataOnly = await fetch(`${base}/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Metadata only",
        url: "https://example.test/metadata-only",
        extractProvider: false,
        mergeIntoConfig: false,
        autoUpdate: false,
        intervalMinutes: 60,
      }),
    });
    assert.equal(metadataOnly.status, 201);
    const mergeEnabled = await fetch(`${base}/subscriptions/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input,
        mergeIntoConfig: true,
        configName: "profile.yaml",
        groupNames: ["Proxy"],
        url: "",
      }),
    });
    assert.equal(mergeEnabled.status, 200);
    const providerUpdated = await fetch(`${base}/subscriptions/${created.id}/update`, {
      method: "POST",
    });
    assert.equal(providerUpdated.status, 200);
    const claimed = await fetch(`${base}/subscriptions/${created.id}/binding`, {
      method: "POST",
    });
    assert.equal(claimed.status, 200);
    assert.deepEqual((await claimed.json() as { binding: { status: string; groupNames: string[] } }).binding, {
      configName: "profile.yaml",
      providerName: "example_provider",
      providerPath: "./providers/example_provider.yaml",
      groupNames: ["Proxy"],
      status: "pending-add",
    });
    const activated = await fetch(`${base}/subscriptions/${created.id}/binding`, {
      method: "PUT",
    });
    assert.equal(activated.status, 200);
    assert.deepEqual((await activated.json() as { binding: { status: string; groupNames: string[] } }).binding, {
      configName: "profile.yaml",
      providerName: "example_provider",
      providerPath: "./providers/example_provider.yaml",
      groupNames: ["Proxy"],
      status: "active",
    });
    const removing = await fetch(`${base}/subscriptions/${created.id}/binding/removal`, {
      method: "POST",
    });
    assert.equal(removing.status, 200);
    assert.deepEqual((await removing.json() as { binding: { status: string; groupNames: string[] } }).binding, {
      configName: "profile.yaml",
      providerName: "example_provider",
      providerPath: "./providers/example_provider.yaml",
      groupNames: ["Proxy"],
      status: "pending-remove",
    });
    const released = await fetch(`${base}/subscriptions/${created.id}/binding`, {
      method: "DELETE",
    });
    assert.equal(released.status, 200);
    assert.equal((await released.json() as { binding: unknown }).binding, null);
    const updated = await fetch(`${base}/subscriptions/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, name: "API Updated", url: "" }),
    });
    assert.equal(updated.status, 200);
    const removed = await fetch(`${base}/subscriptions/${created.id}`, { method: "DELETE" });
    assert.equal(removed.status, 204);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    service.close();
  }
});

test("subscription URLs only allow HTTP and HTTPS", async () => {
  const { service } = await fixtureService(async () => new Response(validYaml));
  await assert.rejects(
    service.create({ ...input, url: "file:///private/config.yaml" }),
    SubscriptionValidationError,
  );
});

test("valid YAML writes a provider while invalid YAML preserves the old provider", async () => {
  let responseBody = validYaml;
  let failBeforeProviderPublish = false;
  let failCommittedProviderCleanup = false;
  let configReadCount = 0;
  const sourceConfigs = new Map<string, string>();
  const configSnapshot = (name: string, content: string) => ({
    name,
    path: join("/fixture", name),
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  const { root, service, providerFiles, writeQueue } = await fixtureService(
    async () => new Response(responseBody),
    {
      beforeProviderRename: async () => {
        if (failBeforeProviderPublish) throw new Error("provider publish failed before commit");
      },
      afterProviderOperationPhase: async (operation, phase) => {
        if (failCommittedProviderCleanup && operation === "publish" && phase === "committed") {
          throw new Error("provider publish cleanup failed");
        }
      },
      syncConfigFile: async (name, content) => {
        sourceConfigs.set(name, content);
        return configSnapshot(name, content);
      },
      readConfigFile: async (name) => {
        configReadCount += 1;
        return configSnapshot(name, sourceConfigs.get(name)!);
      },
    },
  );
  const created = await service.create(input);
  const result = await service.updateNow(created.id);
  assert.equal(result.nodeCount, 1);
  const providerPath = join(root, "providers", "example_provider.yaml");
  const before = await readFile(providerPath, "utf8");
  await providerFiles.saveFilterSettings("example_provider.yaml", {
    expectedVersion: 0,
    enabled: true,
    rules: ["套餐 & 到期", "/upgrade/i"],
  });
  responseBody = [
    validYaml.trimEnd(),
    "  - name: 套餐将在明天到期",
    "    type: socks5",
    "    server: 127.0.0.2",
    "    port: 1080",
    "  - name: Upgrade client",
    "    type: socks5",
    "    server: 127.0.0.3",
    "    port: 1080",
    "",
  ].join("\n");
  const filtered = await service.updateNow(created.id);
  assert.equal(filtered.nodeCount, 1);
  const filteredContent = await readFile(providerPath, "utf8");
  assert.match(filteredContent, /node-a/);
  assert.doesNotMatch(filteredContent, /套餐将在明天到期|Upgrade client/);
  assert.deepEqual(parse(sourceConfigs.get("Example.yaml")!).proxies, parse(filteredContent).proxies);
  const preview = await service.previewProviderFilter("example_provider.yaml", ["套餐 & 到期", "upgrade"]);
  assert.deepEqual(preview, { totalCount: 3, matchedNames: ["套餐将在明天到期", "Upgrade client"], remainingCount: 1 });
  sourceConfigs.set("Example.yaml", responseBody.replace("node-a", "node-local"));
  await service.regenerateProviderFile("example_provider.yaml");
  const regeneratedContent = await readFile(providerPath, "utf8");
  assert.match(regeneratedContent, /node-local/);

  let releaseQueue!: () => void;
  const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const held = writeQueue.enqueue(() => queueGate);
  const readsBeforeQueuedRegeneration = configReadCount;
  const queuedRegeneration = service.regenerateProviderFile("example_provider.yaml");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(configReadCount, readsBeforeQueuedRegeneration);
  releaseQueue();
  await held;
  await queuedRegeneration;
  assert.equal(configReadCount, readsBeforeQueuedRegeneration + 1);

  const staleConfig = sourceConfigs.get("Example.yaml")!;
  const currentConfig = staleConfig.replace("node-local", "node-current");
  sourceConfigs.set("Example.yaml", currentConfig);
  const contentBeforeStaleRegeneration = await readFile(providerPath, "utf8");
  await assert.rejects(
    service.regenerateProvidersForConfig("Example.yaml", configSnapshot("Example.yaml", staleConfig).sha256),
    /superseded/,
  );
  assert.equal(await readFile(providerPath, "utf8"), contentBeforeStaleRegeneration);
  await service.regenerateProvidersForConfig(
    "Example.yaml",
    configSnapshot("Example.yaml", currentConfig).sha256,
  );
  assert.match(await readFile(providerPath, "utf8"), /node-current/);

  const settingsBeforePrecommitFailure = (await providerFiles.read("example_provider.yaml")).filterSettings!;
  const subscriptionBeforePrecommitFailure = service.list().find((item) => item.id === created.id)!;
  const providerBeforePrecommitFailure = await readFile(providerPath, "utf8");
  sourceConfigs.set("Example.yaml", currentConfig.replace("node-current", "node-precommit"));
  failBeforeProviderPublish = true;
  await assert.rejects(providerFiles.saveFilterSettingsAndRegenerate("example_provider.yaml", {
    expectedVersion: settingsBeforePrecommitFailure.version,
    enabled: false,
    rules: [],
  }, (markCommitted) => service.regenerateProviderFileUnqueued("example_provider.yaml", markCommitted)));
  failBeforeProviderPublish = false;
  assert.deepEqual(
    (await providerFiles.read("example_provider.yaml")).filterSettings,
    settingsBeforePrecommitFailure,
  );
  assert.equal(await readFile(providerPath, "utf8"), providerBeforePrecommitFailure);
  assert.equal(
    service.list().find((item) => item.id === created.id)?.providerSha256,
    subscriptionBeforePrecommitFailure.providerSha256,
  );

  const committedConfig = [
    validYaml.trimEnd().replace("node-a", "node-committed"),
    "  - name: node-second",
    "    type: socks5",
    "    server: 127.0.0.2",
    "    port: 1080",
    "",
  ].join("\n");
  sourceConfigs.set("Example.yaml", committedConfig);
  failCommittedProviderCleanup = true;
  await assert.rejects(providerFiles.saveFilterSettingsAndRegenerate("example_provider.yaml", {
    expectedVersion: settingsBeforePrecommitFailure.version,
    enabled: false,
    rules: [],
  }, (markCommitted) => service.regenerateProviderFileUnqueued("example_provider.yaml", markCommitted)), /recovery is incomplete/);
  const settingsAfterCommittedFailure = providerFiles.filterSettingsForSubscription(created.id);
  const providerAfterCommittedFailure = await readFile(providerPath, "utf8");
  const subscriptionAfterCommittedFailure = service.list().find((item) => item.id === created.id)!;
  const providerStateAfterCommittedFailure = JSON.parse(
    await readFile(providerFiles.options.statePath, "utf8"),
  ) as { operationJournal: { operation: string; phase: string } | null };
  const persistedSubscriptionAfterCommittedFailure = (JSON.parse(
    await readFile(service.options.statePath, "utf8"),
  ) as { subscriptions: Array<{ id: string; providerSha256: string | null; nodeCount: number }> })
    .subscriptions.find((item) => item.id === created.id)!;
  assert.equal(settingsAfterCommittedFailure.version, settingsBeforePrecommitFailure.version + 1);
  assert.equal(settingsAfterCommittedFailure.enabled, false);
  assert.equal(providerStateAfterCommittedFailure.operationJournal?.operation, "publish");
  assert.equal(providerStateAfterCommittedFailure.operationJournal?.phase, "committed");
  assert.match(providerAfterCommittedFailure, /node-committed/);
  assert.match(providerAfterCommittedFailure, /node-second/);
  assert.equal(subscriptionAfterCommittedFailure.nodeCount, 2);
  assert.equal(
    subscriptionAfterCommittedFailure.providerSha256,
    createHash("sha256").update(providerAfterCommittedFailure).digest("hex"),
  );
  assert.equal(
    persistedSubscriptionAfterCommittedFailure.providerSha256,
    subscriptionAfterCommittedFailure.providerSha256,
  );
  assert.equal(persistedSubscriptionAfterCommittedFailure.nodeCount, 2);
  failCommittedProviderCleanup = false;
  await providerFiles.ensureProviderOperationRecovered();
  assert.deepEqual(
    (await providerFiles.read("example_provider.yaml")).filterSettings,
    settingsAfterCommittedFailure,
  );
  assert.equal(await readFile(providerPath, "utf8"), providerAfterCommittedFailure);
  assert.equal(
    service.list().find((item) => item.id === created.id)?.providerSha256,
    subscriptionAfterCommittedFailure.providerSha256,
  );

  responseBody = "mode: rule\n";
  await assert.rejects(service.updateNow(created.id), SubscriptionDownloadError);
  assert.equal(await readFile(providerPath, "utf8"), providerAfterCommittedFailure);
  assert.equal(filteredContent, before);
});

test("an atomic Provider write failure preserves the previous file", async () => {
  let failWrite = false;
  let responseBody = validYaml;
  const { root, service } = await fixtureService(
    async () => new Response(responseBody),
    { beforeProviderRename: async () => { if (failWrite) throw new Error("write failed"); } },
  );
  const created = await service.create(input);
  await service.updateNow(created.id);
  const providerPath = join(root, "providers", "example_provider.yaml");
  const before = await readFile(providerPath, "utf8");
  responseBody = validYaml.replace("node-a", "node-b");
  failWrite = true;
  await assert.rejects(service.updateNow(created.id));
  assert.equal(await readFile(providerPath, "utf8"), before);
});

test("download timeout and response size limits are enforced", async () => {
  const timeoutFixture = await fixtureService(
    ((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch,
    { timeout: 20 },
  );
  const timed = await timeoutFixture.service.create(input);
  await assert.rejects(timeoutFixture.service.updateNow(timed.id), SubscriptionTimeoutError);

  const sizeFixture = await fixtureService(
    async () => new Response("x".repeat(128)),
    { maxBytes: 32 },
  );
  const oversized = await sizeFixture.service.create(input);
  await assert.rejects(sizeFixture.service.updateNow(oversized.id), SubscriptionTooLargeError);
});

test("provider names cannot escape the configured directory", async () => {
  const { service } = await fixtureService(async () => new Response(validYaml));
  const localized = await service.create({ ...input, providerName: "宝贝云" });
  assert.equal(localized.providerName, "宝贝云");
  await assert.rejects(
    service.create({ ...input, providerName: "../outside" }),
    SubscriptionValidationError,
  );
});

test("persisted scheduling state is restored after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "configd-schedule-"));
  const statePath = join(root, "subscriptions.json");
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  await writeFile(statePath, JSON.stringify({
    version: 1,
    subscriptions: [{
      id: "scheduled-id",
      name: "Scheduled",
      url: "https://example.test/scheduled",
      providerName: "",
      providerNameMode: "custom",
      extractProvider: false,
      mergeIntoConfig: false,
      configName: "",
      groupNames: [],
      autoUpdate: true,
      intervalMinutes: 30,
      status: "idle",
      nodeCount: 0,
      lastAttemptAt: null,
      lastUpdatedAt: null,
      nextUpdateAt: "2025-01-01T00:00:00.000Z",
    }],
  }));
  const service = new SubscriptionService({
    statePath,
    providerDir: join(root, "providers"),
    requestTimeoutMs: 1000,
    maxResponseBytes: 4096,
    writeQueue: new WriteQueue(),
    fetchImpl: async () => new Response(validYaml),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    setTimer: ((callback: () => void, delay: number) => {
      scheduled.push({ callback, delay });
      return { unref() {} } as NodeJS.Timeout;
    }),
    clearTimer: () => {},
  });
  await service.init();
  service.startScheduling();
  service.startScheduling();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]!.delay, 0);
  scheduled[0]!.callback();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const updated = (await service.list()).find((item) => item.id === "scheduled-id");
  assert.equal(updated?.status, "success");
  assert.equal(updated?.lastUpdatedAt, "2026-01-01T00:00:00.000Z");
  service.close();
});

test("binding state is durable and removal must begin before settings change or deletion", async () => {
  const { service } = await fixtureService(async () => new Response(validYaml));
  const created = await service.create({
    ...input,
    mergeIntoConfig: true,
    configName: "profile.yaml",
    groupNames: ["Proxy"],
  });
  const provider = await service.updateNow(created.id);
  assert.equal(provider.providerPath, "./providers/example_provider.yaml");
  const claimed = await service.beginBinding(created.id);
  assert.deepEqual(claimed.binding, {
    configName: "profile.yaml",
    providerName: "example_provider",
    providerPath: "./providers/example_provider.yaml",
    groupNames: ["Proxy"],
    status: "pending-add",
  });
  await assert.rejects(
    service.update(created.id, { ...input, mergeIntoConfig: false, configName: "" }),
    SubscriptionValidationError,
  );
  await assert.rejects(service.delete(created.id), SubscriptionValidationError);
  assert.equal((await service.activateBinding(created.id)).binding?.status, "active");
  assert.equal((await service.beginBindingRemoval(created.id)).binding?.status, "pending-remove");
  await assert.rejects(
    service.update(created.id, {
      ...input,
      mergeIntoConfig: true,
      configName: "profile.yaml",
      groupNames: ["Proxy"],
      url: "",
    }),
    SubscriptionValidationError,
  );
  const updated = await service.update(created.id, { ...input, mergeIntoConfig: false, configName: "" });
  assert.equal(updated.binding, null);
  await service.delete(created.id);
});

test("binding metadata is published only after its atomic state write succeeds", async () => {
  let failStateWrite = false;
  const { service } = await fixtureService(
    async () => new Response(validYaml),
    { beforeStateRename: async () => { if (failStateWrite) throw new Error("state write failed"); } },
  );
  const created = await service.create({
    ...input,
    mergeIntoConfig: true,
    configName: "profile.yaml",
    groupNames: ["Proxy"],
  });
  await service.updateNow(created.id);
  failStateWrite = true;
  await assert.rejects(service.beginBinding(created.id), /state write failed/);
  assert.equal(service.list().find((item) => item.id === created.id)?.binding, null);
  failStateWrite = false;
  assert.equal((await service.beginBinding(created.id)).binding?.status, "pending-add");
  failStateWrite = true;
  await assert.rejects(service.activateBinding(created.id), /state write failed/);
  assert.equal(service.list().find((item) => item.id === created.id)?.binding?.status, "pending-add");
  failStateWrite = false;
  await service.activateBinding(created.id);
  await service.beginBindingRemoval(created.id);
  failStateWrite = true;
  await assert.rejects(service.releaseBinding(created.id), /state write failed/);
  assert.equal(service.list().find((item) => item.id === created.id)?.binding?.status, "pending-remove");
  await assert.rejects(
    service.update(created.id, { ...input, mergeIntoConfig: false, configName: "", url: "" }),
    /state write failed/,
  );
  const afterFailedUpdate = service.list().find((item) => item.id === created.id);
  assert.equal(afterFailedUpdate?.mergeIntoConfig, true);
  assert.equal(afterFailedUpdate?.binding?.status, "pending-remove");
  await assert.rejects(service.delete(created.id), /state write failed/);
  assert.ok(service.list().some((item) => item.id === created.id));
});

test("subscription creation is published only after its atomic state write succeeds", async () => {
  let failStateWrite = true;
  const { service } = await fixtureService(
    async () => new Response(validYaml),
    { beforeStateRename: async () => { if (failStateWrite) throw new Error("state write failed"); } },
  );
  await assert.rejects(service.create(input), /state write failed/);
  assert.equal(service.list().length, 0);
  failStateWrite = false;
  const created = await service.create(input);
  assert.equal(service.list().length, 1);
  assert.equal(service.list()[0]?.id, created.id);
});

test("WriteQueue runs writes serially and continues after a failure", async () => {
  const queue = new WriteQueue();
  const events: string[] = [];
  const first = queue.enqueue(async () => {
    events.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push("first:end");
  });
  const failed = queue.enqueue(async () => {
    events.push("failed");
    throw new Error("expected");
  });
  const last = queue.enqueue(async () => events.push("last"));
  await first;
  await assert.rejects(failed);
  await last;
  assert.deepEqual(events, ["first:start", "first:end", "failed", "last"]);
});
