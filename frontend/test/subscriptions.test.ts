import { subscriptionUpdateErrorMessage } from "../src/shared/configMessages.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { ControllerError } from "../src/api/controllerClient.ts";
import { readSubscriptionRuntimeTargets, providerRefreshFailureMessage, subscriptionRefreshMessage } from "../src/features/config-center/subscriptionRuntime.ts";
import {
  ConfigError,
  activateSubscriptionBinding,
  beginSubscriptionBinding,
  beginSubscriptionBindingRemoval,
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  releaseSubscriptionBinding,
  updateSubscription,
  type ConfigSubscription,
  type ConfigSubscriptionInput,
} from "../src/api/configClient.ts";
import { LatestRequestController } from "../src/shared/requestLifecycle.ts";
import {
  SubscriptionPreviewSession,
  subscriptionPreviewIdentity,
} from "../src/features/config-center/subscriptionPreview.ts";
import {
  applySubscriptionConfigBinding,
  clearSubscriptionConfigBinding,
  deleteSubscriptionAfterBindingRemoval,
  generateInitialProviderAndApplyBinding,
  InitialProviderGenerationError,
  prepareSubscriptionConfigBindingRemoval,
  ProviderReloadError,
  migrateSubscriptionBinding,
  SubscriptionBindingTransactionError,
  updateSubscriptionAndReloadProvider,
} from "../src/features/config-center/subscriptionActions.ts";
import {
  addSubscriptionBinding,
  removeSubscriptionBinding,
  subscriptionBindableGroups,
  SubscriptionBindingError,
} from "../src/features/config-center/subscriptionConfigBinding.ts";
import {
  editSubscriptionDraft,
  editSubscriptionConfigTarget,
  emptySubscriptionDraft,
  isSubscriptionDirty,
  subscriptionDraftFromSnapshot,
  canStartSubscriptionUpdate,
  refreshedSubscriptionSelection,
  subscriptionUpdateControls,
  upsertSubscriptionSnapshot,
  formatSubscriptionBytes,
  subscriptionDomain,
  subscriptionRelativeTime,
  subscriptionUsage,
  subscriptionIntervalOption,
  subscriptionIntervalLabel,
  rememberSubscriptionGroups,
  subscriptionGroupDrafts,
  canSaveSubscriptionDraft,
  invalidSubscriptionGroups,
  mergeConfigurationSources,
  applyPersistedDraftPatch,
  persistedDraftSynchronized,
  reconcilePersistedDraft,
  subscriptionGroupQueryIdentity,
  subscriptionFilterControl,
  DEFAULT_PROVIDER_FILTER_RULES,
  mergeFilterRuleError,
  commitProviderFileSettings,
} from "../src/features/config-center/subscriptionWorkspaceState.ts";

test("subscription filter control stays actionable before and after extraction exists", () => {
  assert.deepEqual(subscriptionFilterControl(false), {
    available: true,
    description: "无需建立 Provider 提取关系，过滤将在订阅下载阶段生效。",
  });
  assert.deepEqual(subscriptionFilterControl(true), {
    available: true,
    description: "过滤规则将在下次订阅下载时生效。",
  });
});

test("subscription preview deduplicates clicks and rejects stale identity or rules", async () => {
  const session = new SubscriptionPreviewSession();
  const first = deferred<{ totalCount: number; remainingCount: number; matchedNames: string[] }>();
  const calls: Array<{ id: string; rules: string[]; signal: AbortSignal }> = [];
  const reader = async (id: string, rules: string[], signal: AbortSignal) => {
    calls.push({ id, rules, signal });
    return first.promise;
  };
  const target = { subscriptionId: "subscription-a", rules: ["notice"], rulesVersion: "notice" };
  const request = session.start(target, reader);
  assert.ok(request);
  assert.equal(session.start(target, reader), null);
  assert.equal(calls.length, 1);
  assert.equal(session.isCurrent(request.key), true);

  const staleSignal = calls[0]!.signal;
  const changed = session.start(
    { subscriptionId: "subscription-a", rules: ["expired"], rulesVersion: "expired" },
    async () => ({ totalCount: 2, remainingCount: 1, matchedNames: ["expired"] }),
  );
  assert.ok(changed);
  assert.equal(staleSignal.aborted, true);
  assert.equal(session.isCurrent(request.key), false);
  assert.deepEqual(await changed.promise, { totalCount: 2, remainingCount: 1, matchedNames: ["expired"] });
  assert.equal(session.finish(changed.key), true);

  const switched = session.start(
    { subscriptionId: "subscription-b", rules: ["expired"], rulesVersion: "expired" },
    async () => ({ totalCount: 3, remainingCount: 3, matchedNames: [] }),
  );
  assert.ok(switched);
  assert.notEqual(switched.key, subscriptionPreviewIdentity("subscription-a", "expired"));
  assert.deepEqual(await switched.promise, { totalCount: 3, remainingCount: 3, matchedNames: [] });
});

test("merge configuration sources include subscriptions and every ordinary config without duplicates", () => {
  const subscription = { ...savedSubscription, id: "sub", configFileName: "subscription.yaml" };
  const configs = [
    { name: "subscription.yaml", sha256: "a".repeat(64), size: 1, updatedAt: "", subscriptionManaged: true },
    { name: "alpha.yaml", sha256: "b".repeat(64), size: 1, updatedAt: "" },
    { name: "beta.yaml", sha256: "c".repeat(64), size: 1, updatedAt: "" },
  ];
  const local = {
    id: "local-alpha", configName: "alpha.yaml", sourceSha256: "b".repeat(64), fileName: "alpha-provider.yaml",
    providerSha256: "d".repeat(64), nodeCount: 1, enabled: false,
    filterSettings: { version: 3, enabled: true, rules: ["notice"] },
  };
  const missing = { ...local, id: "missing", configName: "missing.yaml", fileName: "missing-provider.yaml" };
  const sources = mergeConfigurationSources([subscription], configs, [local, missing], []);
  assert.deepEqual(sources.map((source) => source.id), ["subscription:sub", "local:alpha.yaml", "local:beta.yaml", "local:missing.yaml"]);
  assert.equal(sources.filter((source) => source.kind === "subscription").length, 1);
  assert.deepEqual(sources.find((source) => source.id === "local:alpha.yaml")?.local?.filterSettings, local.filterSettings);
  assert.equal(sources.find((source) => source.id === "local:beta.yaml")?.local, null);
  assert.equal(sources.find((source) => source.id === "local:missing.yaml")?.config, null);

  const duplicate = { ...local, id: "local-alpha-2", fileName: "alpha-second.yaml" };
  const missingDuplicate = { ...missing, id: "missing-2", fileName: "missing-second.yaml" };
  const conflicted = mergeConfigurationSources(
    [subscription],
    configs,
    [local, duplicate, missing, missingDuplicate],
    [],
  );
  const alphaConflict = conflicted.find((source) => source.id === "local:alpha.yaml")!;
  const missingConflict = conflicted.find((source) => source.id === "local:missing.yaml")!;
  assert.equal(alphaConflict.kind, "local");
  assert.equal(alphaConflict.kind === "local" && alphaConflict.conflict, true);
  assert.deepEqual(alphaConflict.kind === "local" ? alphaConflict.localRelations.map((entry) => entry.id) : [], [
    "local-alpha",
    "local-alpha-2",
  ]);
  assert.equal(missingConflict.kind === "local" && missingConflict.conflict, true);
  assert.equal(missingConflict.kind === "local" ? missingConflict.config : undefined, null);
  assert.deepEqual(missingConflict.kind === "local" ? missingConflict.localRelations.map((entry) => entry.id) : [], [
    "missing",
    "missing-2",
  ]);
});

test("merge configuration sources exclude the loaded config and preserve other sources", () => {
  const subscription = { ...savedSubscription, id: "sub", configFileName: "subscription.yaml", filterSettings: { version: 0, enabled: false, rules: [] } };
  const configs = [
    { name: "loaded.yaml", sha256: "a".repeat(64), size: 1, updatedAt: "", subscriptionManaged: false },
    { name: "other.yaml", sha256: "b".repeat(64), size: 1, updatedAt: "", subscriptionManaged: false },
    { name: "subscription.yaml", sha256: "c".repeat(64), size: 1, updatedAt: "", subscriptionManaged: true },
  ];
  const sources = mergeConfigurationSources([subscription], configs, [], [], "loaded.yaml");
  assert.deepEqual(sources.map((source) => source.id), ["subscription:sub", "local:other.yaml"]);
});

test("merge draft reconciles delayed persisted relations without overwriting user edits", () => {
  const initialDraft = {
    providerName: "alpha", enabled: true, filterEnabled: false, filterRules: "",
  };
  const persistedDraft = {
    providerName: "kept-provider", enabled: false, filterEnabled: true, filterRules: "notice\nexpired",
  };
  const initial = reconcilePersistedDraft(null, "local:alpha.yaml", "unconfigured", initialDraft);
  const synchronized = reconcilePersistedDraft(
    initial,
    "local:alpha.yaml",
    "persisted-v7",
    persistedDraft,
  );
  assert.deepEqual(synchronized.draft, persistedDraft);
  assert.equal(synchronized.draft.providerName, "kept-provider");
  assert.equal(synchronized.draft.enabled, false);
  assert.equal(synchronized.draft.filterEnabled, true);
  assert.equal(synchronized.draft.filterRules, "notice\nexpired");

  const edited = applyPersistedDraftPatch(initial, { providerName: "unsaved-name" });
  const preserved = reconcilePersistedDraft(
    edited,
    "local:alpha.yaml",
    "persisted-v7",
    persistedDraft,
  );
  assert.deepEqual(preserved.dirtyFields, ["providerName"]);
  assert.equal(preserved.draft.providerName, "unsaved-name");
  assert.equal(preserved.draft.enabled, false);
  assert.equal(preserved.draft.filterEnabled, true);
  assert.equal(preserved.draft.filterRules, "notice\nexpired");
  assert.equal(preserved.identity, "persisted-v7");

  assert.equal(persistedDraftSynchronized(
    true,
    "local:alpha.yaml",
    "persisted-v7",
    edited,
  ), false);
  assert.equal(persistedDraftSynchronized(
    true,
    "local:alpha.yaml",
    "persisted-v7",
    preserved,
  ), true);
  assert.equal(DEFAULT_PROVIDER_FILTER_RULES.length > 0, true);
  assert.equal(mergeFilterRuleError("套餐 & 到期\n/^(官网|公告)/i"), null);
  assert.match(mergeFilterRuleError("/[invalid/") ?? "", /无效正则/);
  assert.equal(persistedDraftSynchronized(
    false,
    "local:alpha.yaml",
    "persisted-v7",
    preserved,
  ), false);
});

test("subscription and merge pages reconcile one shared Provider filter snapshot", () => {
  const file = {
    fileName: "shared.yaml", referencePath: "./providers/shared.yaml", category: "proxy" as const,
    source: "subscription" as const, writable: false, sha256: "a".repeat(64), size: 1,
    updatedAt: "", extractionId: "sub", filterSettings: { version: 1, enabled: false, rules: ["old"] },
  };
  const fromMerge = { version: 2, enabled: true, rules: ["merge-rule"] };
  let shared = commitProviderFileSettings([file], file.fileName, fromMerge);
  assert.deepEqual(shared[0].filterSettings, fromMerge);

  const initialDraft = {
    enabled: true, providerName: "shared", mergeIntoConfig: false, configName: "", groupNames: [],
    filterEnabled: true, filterRules: "merge-rule",
  };
  const initial = reconcilePersistedDraft(null, "subscription:sub", "v2", initialDraft);
  const dirty = applyPersistedDraftPatch(initial, { providerName: "user-name" });
  const fromSubscription = { version: 3, enabled: false, rules: ["subscription-rule"] };
  shared = commitProviderFileSettings(shared, file.fileName, fromSubscription);
  const reconciled = reconcilePersistedDraft(dirty, "subscription:sub", "v3", {
    ...initialDraft,
    filterEnabled: shared[0].filterSettings!.enabled,
    filterRules: shared[0].filterSettings!.rules.join("\n"),
  });
  assert.equal(reconciled.draft.providerName, "user-name");
  assert.equal(reconciled.draft.filterEnabled, false);
  assert.equal(reconciled.draft.filterRules, "subscription-rule");
  assert.deepEqual(reconciled.dirtyFields, ["providerName"]);
});

const savedSubscription: ConfigSubscription = {
  id: "saved/id",
  name: "Production",
  url: "https://example.invalid/subscription",
  configFileName: "Production.yaml",
  extractProvider: true,
  providerName: "production",
  providerNameMode: "custom",
  providerSha256: "a".repeat(64),
  mergeIntoConfig: false,
  configName: "",
  groupNames: [],
  binding: null,
  autoUpdate: true,
  intervalMinutes: 120,
  status: "success",
  nodeCount: 2,
  lastAttemptAt: "2026-08-01T00:00:00.000Z",
  lastUpdatedAt: "2026-08-01T00:00:00.000Z",
  nextUpdateAt: "2026-08-01T02:00:00.000Z",
  uploadBytes: 1024,
  downloadBytes: 3072,
  totalBytes: 8192,
  expiresAt: "2026-09-01T00:00:00.000Z",
  urlConfigured: true,
};

test("subscription multi-group binding uses exact eligible groups and interval presets", () => {
  const content = [
    "proxy-providers:",
    "  user-owned: { type: file, path: ./providers/user.yaml }",
    "proxy-groups:",
    "  - name: Alpha",
    "    type: select",
    "    proxies: [DIRECT]",
    "  - name: Beta",
    "    type: select",
    "    use: [user-owned]",
    "  - name: Automatic",
    "    type: select",
    "    include-all-providers: true",
    "",
  ].join("\n");
  const binding = {
    configName: "profile.yaml",
    providerName: "managed",
    providerPath: "./providers/managed.yaml",
    groupNames: ["Alpha", "Beta"],
    status: "pending-add" as const,
  };

  assert.deepEqual(subscriptionBindableGroups(content, "managed"), ["Alpha", "Beta"]);
  const added = addSubscriptionBinding(content, binding);
  const parsed = parse(added) as { "proxy-groups": Array<{ name: string; use?: string[] }> };
  assert.deepEqual(parsed["proxy-groups"].find((group) => group.name === "Alpha")?.use, ["managed"]);
  assert.deepEqual(parsed["proxy-groups"].find((group) => group.name === "Beta")?.use, ["user-owned", "managed"]);
  assert.equal(parsed["proxy-groups"].some((group) => group.name === "managed"), false);
  const removed = parse(removeSubscriptionBinding(added, binding)) as {
    "proxy-providers": Record<string, unknown>;
    "proxy-groups": Array<{ name: string; use?: string[] }>;
  };
  assert.equal("managed" in removed["proxy-providers"], false);
  assert.deepEqual(removed["proxy-groups"].find((group) => group.name === "Beta")?.use, ["user-owned"]);
  assert.equal(subscriptionIntervalOption(30), "30");
  assert.equal(subscriptionIntervalOption(10080), "10080");
  assert.equal(subscriptionIntervalOption(75), "custom");
});

test("subscription extraction toggles preserve dormant Provider and binding fields", () => {
  const enabled = {
    name: "Example",
    url: "https://example.invalid/redacted",
    extractProvider: true,
    providerName: "provider-a",
    mergeIntoConfig: true,
    configName: "profile.yaml",
    groupNames: ["Proxy", "Fallback"],
    autoUpdate: true,
    intervalMinutes: 60,
  };
  const extractionOff = editSubscriptionDraft(enabled, { extractProvider: false });
  assert.equal(extractionOff.extractProvider, false);
  assert.equal(extractionOff.providerName, "provider-a");
  assert.equal(extractionOff.mergeIntoConfig, true);
  assert.equal(extractionOff.configName, "profile.yaml");
  assert.deepEqual(extractionOff.groupNames, ["Proxy", "Fallback"]);
  const mergeOff = editSubscriptionDraft(enabled, { mergeIntoConfig: false });
  assert.equal(mergeOff.configName, "profile.yaml");
  assert.deepEqual(mergeOff.groupNames, ["Proxy", "Fallback"]);

  assert.equal(canSaveSubscriptionDraft({
    ...enabled,
    extractProvider: false,
    configName: "",
    groupNames: [],
  }, true), true);
  assert.equal(canSaveSubscriptionDraft({
    ...enabled,
    extractProvider: true,
    mergeIntoConfig: false,
    configName: "",
    groupNames: [],
  }, true), true);
  assert.equal(canSaveSubscriptionDraft({
    ...enabled,
    extractProvider: true,
    mergeIntoConfig: true,
    configName: "",
    groupNames: [],
  }, true), false);
  assert.equal(canSaveSubscriptionDraft({ ...enabled, groupNames: [""] }, true), false);
  assert.equal(canSaveSubscriptionDraft(enabled, true), true);

  const currentIdentity = subscriptionGroupQueryIdentity(enabled, null);
  const invalidOptions = {
    form: enabled,
    currentIdentity,
    resultIdentity: currentIdentity,
    status: "success" as const,
    availableGroups: ["Proxy"],
  };
  assert.deepEqual(invalidSubscriptionGroups(invalidOptions), ["Fallback"]);
  assert.deepEqual(invalidSubscriptionGroups({
    ...invalidOptions,
    form: { ...enabled, extractProvider: false },
  }), []);
  assert.deepEqual(invalidSubscriptionGroups({
    ...invalidOptions,
    form: { ...enabled, mergeIntoConfig: false },
  }), []);
  assert.deepEqual(invalidSubscriptionGroups({ ...invalidOptions, status: "loading" }), []);
  assert.deepEqual(invalidSubscriptionGroups({ ...invalidOptions, status: "error" }), []);
  assert.deepEqual(invalidSubscriptionGroups({ ...invalidOptions, resultIdentity: "stale" }), []);

  let draft = emptySubscriptionDraft("初始名称");
  assert.equal(draft.providerName, "初始名称");
  assert.equal(draft.providerNameMode, "follow");
  draft = editSubscriptionDraft(draft, { name: "跟随改名" });
  assert.equal(draft.providerName, "跟随改名");
  draft = editSubscriptionDraft(draft, { providerName: "独立代理集" });
  assert.equal(draft.providerNameMode, "custom");
  draft = editSubscriptionDraft(draft, { name: "订阅再次改名" });
  assert.equal(draft.providerName, "独立代理集");
  const subscriptionOnlyEdit = { ...draft, name: "订阅页改名" };
  assert.equal(subscriptionOnlyEdit.providerName, "独立代理集");
  assert.equal(subscriptionOnlyEdit.extractProvider, draft.extractProvider);
  assert.deepEqual(subscriptionOnlyEdit.groupNames, draft.groupNames);

  let remembered = subscriptionGroupDrafts({ ...draft, configName: "A.yaml", groupNames: ["A1"] });
  let switched = editSubscriptionConfigTarget(
    { ...draft, configName: "A.yaml", groupNames: ["A1"] },
    "B.yaml",
    remembered,
  );
  remembered = rememberSubscriptionGroups(switched.remembered, "B.yaml", ["B1", "B2"]);
  switched = editSubscriptionConfigTarget(
    { ...switched.form, groupNames: ["B1", "B2"] },
    "A.yaml",
    remembered,
  );
  assert.deepEqual(switched.form.groupNames, ["A1"]);
  assert.equal(switched.form.configName, "A.yaml");
  assert.equal(subscriptionIntervalLabel(30), "每 30 分钟");
  assert.equal(subscriptionIntervalLabel(60), "每 1 小时");
  assert.equal(subscriptionIntervalLabel(1440), "每 1 天");
  assert.equal(subscriptionIntervalLabel(10080), "每 7 天");
});

test("initial Provider generation binds from the committed SHA despite best-effort list refresh", async () => {
  const committedSha = "b".repeat(64);
  for (const listResult of ["failure", "missing"] as const) {
    let applyCalls = 0;
    const result = await generateInitialProviderAndApplyBinding(
      { ...savedSubscription, providerSha256: null, mergeIntoConfig: true, configName: "profile.yaml" },
      () => undefined,
      {
        update: async () => ({
          providerName: "production",
          providerPath: "./providers/production.yaml",
          providerSha256: committedSha,
          nodeCount: 2,
          updatedAt: "2026-08-11T00:00:00.000Z",
          config: null,
        }),
        list: async () => {
          if (listResult === "failure") throw new Error("fixture refresh failure");
          return [];
        },
        apply: async (subscription) => {
          applyCalls += 1;
          assert.equal(subscription.providerSha256, committedSha);
          return { ...subscription, binding: {
            configName: "profile.yaml",
            providerName: "production",
            providerPath: "./providers/production.yaml",
            groupNames: [],
            status: "active" as const,
          } };
        },
      },
    );
    assert.equal(applyCalls, 1);
    assert.equal(result.subscription.providerSha256, committedSha);
    assert.equal(result.subscription.binding?.status, "active");
    assert.equal(Boolean(result.refreshError), listResult === "failure");
  }

  let applyCalls = 0;
  await assert.rejects(
    generateInitialProviderAndApplyBinding(
      { ...savedSubscription, providerSha256: null, mergeIntoConfig: true, configName: "profile.yaml" },
      () => undefined,
      {
        update: async () => { throw new Error("fixture generation failure"); },
        list: async () => [],
        apply: async (subscription) => { applyCalls += 1; return subscription; },
      },
    ),
    (error: InitialProviderGenerationError) =>
      error.message === "Provider 首次生成失败；尚未写入配置绑定",
  );
  assert.equal(applyCalls, 0);
});

test("subscription binding cleanup is exact and idempotent across missing and include-all groups", () => {
  const binding = {
    configName: "profile.yaml",
    providerName: "managed",
    providerPath: "./providers/managed.yaml",
    groupNames: ["Deleted", "Automatic"],
    status: "pending-remove" as const,
  };
  const content = [
    "proxy-providers:",
    "  managed: { type: file, path: ./providers/managed.yaml }",
    "  foreign: { type: file, path: ./providers/foreign.yaml }",
    "proxy-groups:",
    "  - name: Automatic",
    "    type: select",
    "    include-all-providers: true",
    "    use: [foreign, managed]",
    "",
  ].join("\n");
  const cleaned = removeSubscriptionBinding(content, binding);
  const parsed = parse(cleaned) as {
    "proxy-providers": Record<string, unknown>;
    "proxy-groups": Array<{ use: string[] }>;
  };
  assert.deepEqual(Object.keys(parsed["proxy-providers"]), ["foreign"]);
  assert.deepEqual(parsed["proxy-groups"][0]?.use, ["foreign"]);
  assert.equal(removeSubscriptionBinding(cleaned, binding), cleaned);
  assert.throws(() => removeSubscriptionBinding(
    "proxy-providers:\n  managed: { type: http, url: redacted }\n",
    binding,
  ), SubscriptionBindingError);
  assert.throws(() => removeSubscriptionBinding(
    "proxy-providers:\n  managed: { type: file, path: ./providers/managed.yaml }\nproxy-groups:\n  - name: Automatic\n    use: managed\n",
    binding,
  ), SubscriptionBindingError);
});

test("subscription provider migration commits once or restores old metadata, file, YAML, and active binding", async () => {
  const oldBinding = {
    configName: "profile.yaml",
    providerName: "old-provider",
    providerPath: "./providers/old-provider.yaml",
    groupNames: ["Alpha"],
    status: "active" as const,
  };
  const originalContent = [
    "proxy-providers:",
    "  old-provider: { type: file, path: ./providers/old-provider.yaml }",
    "proxy-groups:",
    "  - name: Alpha",
    "    type: select",
    "    use: [old-provider]",
    "  - name: Beta",
    "    type: select",
    "",
  ].join("\n");

  for (const failure of ["none", "update", "save", "save-after-commit", "activate", "activate-unrelated", "external-after"] as const) {
    let disk = { name: "profile.yaml", path: "/controlled/profile.yaml", content: originalContent, sha256: "a".repeat(64) };
    let current: ConfigSubscription = {
      ...savedSubscription,
      providerName: "old-provider",
      mergeIntoConfig: true,
      configName: "profile.yaml",
      groupNames: ["Alpha"],
      binding: oldBinding,
    };
    const files = new Set(["old-provider"]);
    let forwardSaveCount = 0;
    let readCount = 0;
    const nextInput: ConfigSubscriptionInput = {
      ...subscriptionDraftFromSnapshot(current),
      providerName: "new-provider",
      groupNames: ["Beta"],
      url: "https://new.invalid/redacted",
    };
    const dependencies = {
      list: async () => [current],
      read: async () => {
        readCount += 1;
        if (failure === "activate-unrelated" && readCount === 2) {
          disk = { ...disk, content: `${disk.content}unrelated: keep\n`, sha256: "u".repeat(64) };
        }
        return disk;
      },
      save: async (_name: string, content: string) => {
        if (current.providerName === "new-provider") {
          forwardSaveCount += 1;
          if (failure === "save") throw new Error("fixture save failure");
          if (failure === "save-after-commit") {
            disk = { ...disk, content, sha256: "q".repeat(64) };
            throw new Error("fixture response failure after commit");
          }
        }
        disk = { ...disk, content, sha256: String.fromCharCode(98 + forwardSaveCount).repeat(64) };
        return disk;
      },
      update: async (_id: string, input: ConfigSubscriptionInput) => {
        const nextProvider = input.providerName ?? "";
        if (nextProvider === "new-provider" && failure === "update") throw new Error("fixture rename failure");
        if (nextProvider !== current.providerName) {
          files.delete(current.providerName);
          files.add(nextProvider);
        }
        current = {
          ...current,
          providerName: nextProvider,
          mergeIntoConfig: input.mergeIntoConfig,
          configName: input.configName ?? "",
          groupNames: input.groupNames ?? [],
          url: input.url || current.url,
          binding: null,
        };
        return current;
      },
      beginRemoval: async () => {
        current = { ...current, binding: current.binding && { ...current.binding, status: "pending-remove" } };
        return current;
      },
      release: async () => {
        current = { ...current, binding: null };
        return current;
      },
      begin: async () => {
        const providerName = current.providerName;
        current = { ...current, binding: {
          configName: current.configName,
          providerName,
          providerPath: `./providers/${providerName}.yaml`,
          groupNames: current.groupNames,
          status: "pending-add",
        } };
        return current;
      },
      activate: async () => {
        if (current.providerName === "new-provider" && ["activate", "activate-unrelated", "external-after"].includes(failure)) {
          if (failure === "external-after") {
            disk = { ...disk, content: `${disk.content}external: keep\n`, sha256: "z".repeat(64) };
          }
          throw new Error("fixture activation failure");
        }
        current = { ...current, binding: current.binding && { ...current.binding, status: "active" } };
        return current;
      },
    };

    if (failure === "none") {
      const saved = await migrateSubscriptionBinding(current, nextInput, () => undefined, dependencies);
      assert.equal(saved.providerName, "new-provider");
      assert.equal(saved.binding?.status, "active");
      assert.equal(forwardSaveCount, 1);
      const parsed = parse(disk.content) as { "proxy-providers": Record<string, unknown>; "proxy-groups": Array<{ name: string; use?: string[] }> };
      assert.deepEqual(Object.keys(parsed["proxy-providers"]), ["new-provider"]);
      assert.deepEqual(parsed["proxy-groups"].find((group) => group.name === "Beta")?.use, ["new-provider"]);
      continue;
    }

    await assert.rejects(
      migrateSubscriptionBinding(current, nextInput, () => undefined, dependencies),
      failure === "external-after" ? /恢复未完成/ : /旧名称和绑定已恢复/,
    );
    assert.equal(current.providerName, "old-provider", failure);
    assert.deepEqual(current.groupNames, ["Alpha"], failure);
    assert.equal(current.url, savedSubscription.url, failure);
    assert.deepEqual([...files], ["old-provider"], failure);
    if (failure === "external-after") {
      assert.equal(disk.content.includes("external: keep"), true);
      assert.notEqual(disk.content, originalContent);
    } else {
      assert.equal(current.binding?.status, "active", failure);
      assert.equal(disk.content, failure === "activate-unrelated" ? `${originalContent}unrelated: keep\n` : originalContent, failure);
    }
  }
});

test("subscription card data shows only the domain and degrades when usage metadata is incomplete", () => {
  assert.equal(subscriptionDomain("https://user:secret@example.invalid/private?token=hidden"), "example.invalid");
  assert.equal(subscriptionDomain("not a URL"), "地址不可用");
  assert.equal(formatSubscriptionBytes(1536), "1.5 KB");
  assert.equal(subscriptionRelativeTime("2026-08-01T00:00:00.000Z", Date.parse("2026-08-01T02:05:00.000Z")), "2 小时前");
  assert.deepEqual(subscriptionUsage(savedSubscription), { used: 4096, total: 8192, progress: 50 });
  assert.deepEqual(subscriptionUsage({ uploadBytes: 10, downloadBytes: null, totalBytes: 100 }), {
    used: null,
    total: 100,
    progress: null,
  });
  assert.deepEqual(subscriptionUsage({ uploadBytes: 10, downloadBytes: 20, totalBytes: 0 }), {
    used: 30,
    total: 0,
    progress: null,
  });
});

test("subscription update errors distinguish Mihomo validation from other update failures without echoing details", () => {
  const validation = subscriptionUpdateErrorMessage(
    new ConfigError("hidden response", 422, "validation_failed")
  );
  const updateFailure = subscriptionUpdateErrorMessage(
    new ConfigError("hidden response", 422, "subscription_update_failed")
  );
  assert.equal(validation, "Mihomo 校验未通过，磁盘配置未更新");
  assert.equal(updateFailure, "订阅下载或内容处理失败，磁盘配置未更新");
  assert.notEqual(validation, updateFailure);
  assert.equal(validation.includes("hidden response"), false);
  assert.equal(updateFailure.includes("hidden response"), false);
});

test("an item update isolates its spinner while other subscriptions remain selectable", () => {
  const aUpdating = subscriptionUpdateControls({
    busy: null,
    updatingId: "a",
    itemId: "a",
    activeId: "a",
    dirty: false,
  });
  const bWhileAUpdates = subscriptionUpdateControls({
    busy: null,
    updatingId: "a",
    itemId: "b",
    activeId: "a",
    dirty: false,
  });
  assert.deepEqual(aUpdating, {
    updating: true,
    canSelect: true,
    canRefresh: false,
    writeLocked: true,
    reason: null,
  });
  assert.equal(bWhileAUpdates.updating, false);
  assert.equal(bWhileAUpdates.canSelect, true);
  assert.equal(bWhileAUpdates.canRefresh, false);
  assert.equal(bWhileAUpdates.writeLocked, true);
  assert.equal(canStartSubscriptionUpdate({
    busy: null,
    updatingId: "a",
    itemId: "a",
    activeId: "a",
    dirty: false,
  }), false);

  const refreshed = [
    { ...savedSubscription, id: "a", name: "A updated" },
    { ...savedSubscription, id: "b", name: "B" },
  ];
  assert.equal(refreshedSubscriptionSelection(refreshed, "b", false)?.name, "B");
  assert.equal(refreshedSubscriptionSelection(refreshed, "b", true), null);

  let requests = 0;
  const dirtyA = {
    busy: null,
    updatingId: null,
    itemId: "a",
    activeId: "a",
    dirty: true,
  } as const;
  if (canStartSubscriptionUpdate(dirtyA)) requests += 1;
  assert.equal(requests, 0);
  assert.equal(subscriptionUpdateControls(dirtyA).reason, "请先保存当前订阅设置再更新");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("manual subscription update reloads the generated proxy Provider", async () => {
  const calls: string[] = [];
  const result = await updateSubscriptionAndReloadProvider("subscription-id", {
    update: async (id) => {
      calls.push(`update:${id}`);
      return { providerName: "provider name", providerPath: "./providers/provider name.yaml", nodeCount: 2, updatedAt: "2026-08-01T00:00:00.000Z", config: null };
    },
    reload: async (providerName) => { calls.push(`reload:${providerName}`); },
    targets: async () => ({ status: "matched", names: ["provider name"] }),
  });
  assert.equal(result.nodeCount, 2);
  assert.deepEqual(calls, ["update:subscription-id", "reload:provider name"]);
});

test("manual subscription endpoints use configd and native Controller paths", async () => {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    const path = String(input);
    const body = path.endsWith("/update") ? { ...runtimeProviderResult, providerName: "provider/name" }
      : path.endsWith("/applied") ? { state: subscriptionRuntimeState, content: 'proxy-providers: {provider/name: {type: file, path: ./providers/provider.yaml}}' }
      : path.endsWith("/state") ? subscriptionRuntimeState
      : path.endsWith("/managed-providers") ? { files: [{ ...subscriptionProviderFile, ownerId: "subscription/id" }] }
      : path.endsWith("/providers/proxies") ? { providers: { "provider/name": { vehicleType: "File" } } } : null;
    if (body) {
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 204 });
  };
  try {
    await updateSubscriptionAndReloadProvider("subscription/id");
    assert.deepEqual(calls, [
      "/api/config/subscriptions/subscription%2Fid/update",
      "/api/config/runtime-config/applied",
      "/api/config/managed-providers",
      "/api/controller/providers/proxies",
      "/api/config/runtime-config/state",
      "/api/controller/providers/proxies/provider%2Fname",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a reload failure remains distinct from a failed subscription update", async () => {
  await assert.rejects(
    updateSubscriptionAndReloadProvider("subscription-id", {
      update: async () => ({ providerName: "provider", providerPath: "./providers/provider.yaml", nodeCount: 1, updatedAt: "now", config: null }),
      reload: async () => { throw new Error("offline"); },
      targets: async () => ({ status: "matched", names: ["provider"] }),
    }),
    (error: ProviderReloadError) => error.result.providerName === "provider",
  );
});

test("a failed subscription update never attempts a Controller reload", async () => {
  const failure = new Error("configd rejected the update");
  let reloads = 0;
  await assert.rejects(
    updateSubscriptionAndReloadProvider("subscription-id", {
      update: async () => { throw failure; },
      reload: async () => { reloads += 1; },
      targets: async () => { throw new Error("must not inspect runtime after failed update") },
    }),
    (error) => error === failure,
  );
  assert.equal(reloads, 0);
});

test("a subscription update without Provider extraction does not reload Controller", async () => {
  let reloads = 0;
  const result = await updateSubscriptionAndReloadProvider("subscription-id", {
    update: async () => ({
      providerName: null,
      providerPath: null,
      nodeCount: 1,
      updatedAt: "now",
      config: null,
    }),
    reload: async () => { reloads += 1; },
    targets: async () => { throw new Error("must not inspect runtime without a file") },
  });
  assert.equal(result.providerName, null);
  assert.equal(reloads, 0);
});

const runtimeProviderResult = { providerName: "provider", providerPath: "./providers/provider.yaml", providerSha256: "file-sha", nodeCount: 2, updatedAt: "now", config: null };
const generatedSubscriptionRuntime = { schemaVersion: 1 as const, version: "v1", sourceName: "another-config.yaml", sourceSha256: "source-sha", settingsVersion: 1, contentSha256: "runtime-sha", generatedAt: "now", path: "/runtime/v1.yaml" };
const subscriptionRuntimeState = { schemaVersion: 1 as const, version: 2, lastAttempt: { id: "attempt", generated: generatedSubscriptionRuntime, status: "succeeded" as const, startedAt: "now", finishedAt: "now" }, lastSuccessful: { generated: generatedSubscriptionRuntime, loadedAt: "now" } };
const subscriptionProviderFile = { fileName: "provider.yaml", referencePath: "./providers/provider.yaml", category: "proxy" as const, source: "subscription" as const, writable: false, sha256: "file-sha", size: 50, updatedAt: "now", filterSettings: null, extractionId: null, ownerId: "subscription-id" };
const subscriptionRuntimeReaders = {
  applied: async () => ({ state: subscriptionRuntimeState, content: 'proxy-providers: {running-alias: {type: file, path: providers/provider.yaml}}' }),
  files: async () => [subscriptionProviderFile],
  state: async () => subscriptionRuntimeState,
  providers: async () => ({ providers: { "running-alias": { vehicleType: "File" } } }),
};

test("subscription refresh resolves a file shared by a different config and runtime name", async () => {
  const target = await readSubscriptionRuntimeTargets("subscription-id", runtimeProviderResult, subscriptionRuntimeReaders);
  assert.deepEqual(target, { status: "matched", names: ["running-alias"] });
  const calls: string[] = [];
  const result = await updateSubscriptionAndReloadProvider("subscription-id", { update: async () => runtimeProviderResult, targets: async () => target, reload: async name => { calls.push(name) } });
  assert.deepEqual(calls, ["running-alias"]);
  assert.equal(result.runtimeRefresh, "refreshed");
});

test("same provider name on a different file and unreferenced files only update disk", async () => {
  for (const content of ['proxy-providers: {provider: {type: file, path: ./providers/other.yaml}}', 'rules: [MATCH,DIRECT]']) {
    const target = await readSubscriptionRuntimeTargets("subscription-id", runtimeProviderResult, { ...subscriptionRuntimeReaders, applied: async () => ({ state: subscriptionRuntimeState, content }) });
    assert.equal(target.status, "unreferenced");
    const result = await updateSubscriptionAndReloadProvider("subscription-id", { update: async () => runtimeProviderResult, targets: async () => target, reload: async () => { assert.fail("unrelated Controller refresh") } });
    assert.match(subscriptionRefreshMessage(result), /订阅已更新.*未引用/);
  }
});

test("unknown or changing runtime identity preserves the subscription success", async () => {
  const readers = [
    { ...subscriptionRuntimeReaders, applied: async () => ({ state: { ...subscriptionRuntimeState, lastAttempt: { ...subscriptionRuntimeState.lastAttempt, status: "pending" as const } }, content: 'proxy-providers: {}' }) },
    { ...subscriptionRuntimeReaders, state: async () => ({ ...subscriptionRuntimeState, version: 3 }) },
    { ...subscriptionRuntimeReaders, files: async () => [{ ...subscriptionProviderFile, sha256: "changed" }] },
    { ...subscriptionRuntimeReaders, files: async () => [{ ...subscriptionProviderFile, ownerId: "someone-else" }] },
    { ...subscriptionRuntimeReaders, providers: async () => ({ providers: {} }) },
    { ...subscriptionRuntimeReaders, providers: async () => ({ providers: { "running-alias": { vehicleType: "HTTP" } } }) },
    { ...subscriptionRuntimeReaders, applied: async () => { throw new Error("unavailable") } },
  ];
  for (const reader of readers) {
    const target = await readSubscriptionRuntimeTargets("subscription-id", runtimeProviderResult, reader);
    assert.equal(target.status, "unknown");
    const result = await updateSubscriptionAndReloadProvider("subscription-id", { update: async () => runtimeProviderResult, targets: async () => target, reload: async () => { assert.fail("unconfirmed Controller refresh") } });
    assert.match(subscriptionRefreshMessage(result), /订阅已更新.*身份未确认/);
  }
});

test("provider refresh retains HTTP, connection and timeout causes with partial success text", async () => {
  for (const failure of [new ControllerError("Controller 请求失败 (404)", 404), new ControllerError("Controller 请求失败 (503)", 503), new Error("Controller 连接失败"), new DOMException("Controller 请求超时", "TimeoutError")]) {
    await assert.rejects(updateSubscriptionAndReloadProvider("subscription-id", { update: async () => runtimeProviderResult, targets: async () => ({ status: "matched", names: ["running-alias"] }), reload: async () => { throw failure } }), (error: ProviderReloadError) => {
      assert.equal(error.cause, failure);
      assert.equal(error.result, runtimeProviderResult);
      const message = providerRefreshFailureMessage(error.cause);
      assert.match(message, /订阅已更新.*运行中的代理集合刷新失败/);
      assert.match(message, failure instanceof ControllerError ? new RegExp(String(failure.status)) : failure.name === "TimeoutError" ? /超时/ : /连接失败/);
      return true;
    });
  }
});

test("an identical user-owned Provider and group are treated as occupied and never claimed", async () => {
  const binding = {
    configName: "profile.yaml",
    providerName: "existing",
    providerPath: "./providers/existing.yaml",
  };
  const existing = [
    "proxy-providers:",
    "  existing:",
    "    type: file",
    "    path: ./providers/existing.yaml",
    "proxy-groups:",
    "  - name: existing",
    "    type: select",
    "    use: [existing]",
    "",
  ].join("\n");
  assert.throws(
    () => addSubscriptionBinding(existing, binding),
    SubscriptionBindingError,
  );

  let touched = false;
  const unowned = {
    ...savedSubscription,
    mergeIntoConfig: true,
    configName: "profile.yaml",
    binding: null,
  };
  const result = await clearSubscriptionConfigBinding(
    unowned,
    () => { touched = true; },
    {
      read: async () => { touched = true; throw new Error("must not read"); },
      save: async () => { touched = true; throw new Error("must not save"); },
      release: async () => { touched = true; throw new Error("must not release"); },
    },
  );
  assert.equal(result, unowned);
  assert.equal(touched, false);
});

test("binding apply and release use fresh SHA snapshots and recorded ownership", async () => {
  const subscription = {
    ...savedSubscription,
    id: "binding-id",
    mergeIntoConfig: true,
    configName: "profile.yaml",
  };
  const initial = {
    name: "profile.yaml",
    path: "/srv/profile.yaml",
    content: "mode: rule\nproxy-groups:\n  - { name: production, type: select, proxies: [DIRECT] }\n",
    sha256: "a".repeat(64),
  };
  let disk = initial;
  const synced: string[] = [];
  const claimed = await applySubscriptionConfigBinding(
    subscription,
    {
      providerName: "production",
      providerPath: "./providers/production.yaml",
      nodeCount: 2,
      updatedAt: "now",
    },
    (snapshot) => synced.push(snapshot.sha256),
    {
      read: async () => disk,
      save: async (name, content, expectedSha256) => {
        assert.equal(name, "profile.yaml");
        assert.equal(expectedSha256, disk.sha256);
        disk = { ...disk, content, sha256: "b".repeat(64) };
        return disk;
      },
      begin: async () => ({
        ...subscription,
        binding: {
          configName: "profile.yaml",
          providerName: "production",
          providerPath: "./providers/production.yaml",
          status: "pending-add" as const,
        },
      }),
      activate: async () => ({
        ...subscription,
        binding: {
          configName: "profile.yaml",
          providerName: "production",
          providerPath: "./providers/production.yaml",
          status: "active" as const,
        },
      }),
      release: async () => subscription,
    },
  );
  assert.ok(claimed.binding);
  assert.deepEqual(Object.keys((parse(disk.content) as Record<string, object>)["proxy-providers"]!), ["production"]);

  const released = await clearSubscriptionConfigBinding(
    claimed,
    (snapshot) => synced.push(snapshot.sha256),
    {
      read: async () => disk,
      save: async (_name, content, expectedSha256) => {
        assert.equal(expectedSha256, "b".repeat(64));
        disk = { ...disk, content, sha256: "c".repeat(64) };
        return disk;
      },
      beginRemoval: async () => ({
        ...claimed,
        binding: claimed.binding && {
          ...claimed.binding,
          status: "pending-remove" as const,
        },
      }),
      release: async () => ({ ...claimed, binding: null }),
    },
  );
  assert.equal(released.binding, null);
  assert.equal((parse(disk.content) as Record<string, object>)["proxy-providers"] && "production" in (parse(disk.content) as Record<string, Record<string, unknown>>)["proxy-providers"]!, false);
  assert.deepEqual(synced, ["b".repeat(64), "c".repeat(64)]);
});

test("activation failure leaves a retryable pending-add binding without duplicating YAML", async () => {
  const subscription = {
    ...savedSubscription,
    mergeIntoConfig: true,
    configName: "profile.yaml",
  };
  let disk = {
    name: "profile.yaml",
    path: "/srv/profile.yaml",
    content: "mode: rule\nproxy-groups:\n  - { name: production, type: select, proxies: [DIRECT] }\n",
    sha256: "a".repeat(64),
  };
  let pending = {
    ...subscription,
    binding: {
      configName: "profile.yaml",
      providerName: "production",
      providerPath: "./providers/production.yaml",
      status: "pending-add" as const,
    },
  };
  const provider = {
    providerName: "production",
    providerPath: "./providers/production.yaml",
    nodeCount: 1,
    updatedAt: "now",
  };
  await assert.rejects(
    applySubscriptionConfigBinding(subscription, provider, () => undefined, {
      read: async () => disk,
      begin: async () => pending,
      save: async (_name, content) => {
        disk = { ...disk, content, sha256: "b".repeat(64) };
        return disk;
      },
      activate: async () => { throw new Error("activation unavailable"); },
      release: async () => subscription,
    }),
    SubscriptionBindingTransactionError,
  );
  assert.equal(pending.binding.status, "pending-add");
  assert.equal((parse(disk.content) as { "proxy-groups": unknown[] })["proxy-groups"].length, 1);

  let saves = 0;
  const active = await applySubscriptionConfigBinding(pending, provider, () => undefined, {
    read: async () => disk,
    begin: async () => assert.fail("pending retry must not begin again"),
    save: async () => { saves += 1; return disk; },
    activate: async () => ({
      ...pending,
      binding: { ...pending.binding, status: "active" as const },
    }),
    release: async () => subscription,
  });
  assert.equal(saves, 0);
  assert.equal(active.binding?.status, "active");
  assert.equal((parse(disk.content) as { "proxy-groups": unknown[] })["proxy-groups"].length, 1);
});

test("failed config save compensates ownership, and a failed compensation remains retryable", async () => {
  const subscription = {
    ...savedSubscription,
    mergeIntoConfig: true,
    configName: "profile.yaml",
  };
  const provider = {
    providerName: "production",
    providerPath: "./providers/production.yaml",
    nodeCount: 1,
    updatedAt: "now",
  };
  const disk = {
    name: "profile.yaml",
    path: "/srv/profile.yaml",
    content: "mode: rule\nproxy-groups:\n  - { name: production, type: select, proxies: [DIRECT] }\n",
    sha256: "a".repeat(64),
  };
  let server: ConfigSubscription = subscription;
  const pending = {
    ...subscription,
    binding: {
      configName: "profile.yaml",
      providerName: "production",
      providerPath: "./providers/production.yaml",
      status: "pending-add" as const,
    },
  };
  await assert.rejects(
    applySubscriptionConfigBinding(subscription, provider, () => undefined, {
      read: async () => disk,
      begin: async () => { server = pending; return pending; },
      save: async () => { throw new Error("config save failed"); },
      activate: async () => assert.fail("activation must not run"),
      release: async () => { server = subscription; return subscription; },
    }),
    /config save failed/,
  );
  assert.equal(server.binding, null);

  await assert.rejects(
    applySubscriptionConfigBinding(subscription, provider, () => undefined, {
      read: async () => disk,
      begin: async () => { server = pending; return pending; },
      save: async () => { throw new Error("config save failed"); },
      activate: async () => assert.fail("activation must not run"),
      release: async () => { throw new Error("release failed"); },
    }),
    SubscriptionBindingTransactionError,
  );
  assert.equal(server.binding?.status, "pending-add");

  const active = await applySubscriptionConfigBinding(server, provider, () => undefined, {
    read: async () => disk,
    begin: async () => assert.fail("retry must reuse pending ownership"),
    save: async (_name, content) => ({ ...disk, content, sha256: "b".repeat(64) }),
    activate: async () => ({ ...server, binding: server.binding && { ...server.binding, status: "active" as const } }),
    release: async () => subscription,
  });
  assert.equal(active.binding?.status, "active");
});

test("release failure after cleanup remains pending-remove and retries without another disk write", async () => {
  const binding = {
    configName: "profile.yaml",
    providerName: "production",
    providerPath: "./providers/production.yaml",
    status: "active" as const,
  };
  const active = { ...savedSubscription, binding };
  let disk = {
    name: "profile.yaml",
    path: "/srv/profile.yaml",
    content: addSubscriptionBinding("mode: rule\nproxy-groups:\n  - { name: production, type: select, proxies: [DIRECT] }\n", binding),
    sha256: "a".repeat(64),
  };
  const pending = {
    ...active,
    binding: { ...binding, status: "pending-remove" as const },
  };
  await assert.rejects(
    clearSubscriptionConfigBinding(active, () => undefined, {
      read: async () => disk,
      beginRemoval: async () => pending,
      save: async (_name, content) => {
        disk = { ...disk, content, sha256: "b".repeat(64) };
        return disk;
      },
      release: async () => { throw new Error("release unavailable"); },
    }),
    SubscriptionBindingTransactionError,
  );
  assert.equal(pending.binding.status, "pending-remove");
  assert.equal("production" in ((parse(disk.content) as Record<string, Record<string, unknown>>)["proxy-providers"] ?? {}), false);

  let saves = 0;
  const released = await clearSubscriptionConfigBinding(pending, () => undefined, {
    read: async () => disk,
    beginRemoval: async () => assert.fail("pending removal must not begin again"),
    save: async () => { saves += 1; return disk; },
    release: async () => ({ ...pending, binding: null }),
  });
  assert.equal(saves, 0);
  assert.equal(released.binding, null);
});

test("failed subscription update restores binding and allows a removal retry", async () => {
  const binding = {
    configName: "profile.yaml",
    providerName: "production",
    providerPath: "./providers/production.yaml",
    status: "active" as const,
  };
  const active = { ...savedSubscription, mergeIntoConfig: true, configName: "profile.yaml", binding };
  let disk = {
    name: "profile.yaml",
    path: "/srv/profile.yaml",
    content: addSubscriptionBinding("mode: rule\nproxy-groups:\n  - { name: production, type: select, proxies: [DIRECT] }\n", binding),
    sha256: "a".repeat(64),
  };
  const pending = { ...active, binding: { ...binding, status: "pending-remove" as const } };
  let current: ConfigSubscription = active;
  let saves = 0;
  let failUpdate = true;
  const dependencies = {
      list: async () => [current],
      read: async () => disk,
      beginRemoval: async () => { current = pending; return current; },
      release: async () => { current = { ...current, binding: null }; return current; },
      begin: async () => { current = { ...active, binding: { ...binding, status: "pending-add" } }; return current; },
      activate: async () => { current = active; return current; },
      update: async (_id: string, input: ConfigSubscriptionInput) => {
        if (failUpdate && !input.mergeIntoConfig) throw new Error("subscription update failed");
        current = { ...current, ...input, binding: null };
        return current;
      },
      save: async (_name: string, content: string) => {
        saves += 1;
        disk = { ...disk, content, sha256: "b".repeat(64) };
        return disk;
      },
  };
  await assert.rejects(
    migrateSubscriptionBinding(
      current,
      { ...subscriptionDraftFromSnapshot(current), mergeIntoConfig: false, configName: "" },
      () => undefined,
      dependencies,
    ),
    /旧名称和绑定已恢复/,
  );
  assert.equal(current.binding?.status, "active");
  assert.equal(saves, 0);
  failUpdate = false;
  const saved = await migrateSubscriptionBinding(
    current,
    { ...subscriptionDraftFromSnapshot(current), mergeIntoConfig: false, configName: "" },
    () => undefined,
    dependencies,
  );
  assert.equal(saves, 1);
  assert.equal(saved.binding, null);
});

test("failed subscription delete after cleanup retains retryable removal ownership", async () => {
  const binding = {
    configName: "profile.yaml",
    providerName: "production",
    providerPath: "./providers/production.yaml",
    status: "active" as const,
  };
  let current: ConfigSubscription = { ...savedSubscription, binding };
  let disk = {
    name: "profile.yaml",
    path: "/srv/profile.yaml",
    content: addSubscriptionBinding("mode: rule\nproxy-groups:\n  - { name: production, type: select, proxies: [DIRECT] }\n", binding),
    sha256: "a".repeat(64),
  };
  let saves = 0;
  const prepare = (value: ConfigSubscription, sync: (snapshot: typeof disk) => void) =>
    prepareSubscriptionConfigBindingRemoval(value, sync, {
      read: async () => disk,
      beginRemoval: async () => ({ ...value, binding: { ...binding, status: "pending-remove" as const } }),
      save: async (_name, content) => {
        saves += 1;
        disk = { ...disk, content, sha256: "b".repeat(64) };
        return disk;
      },
    });
  await assert.rejects(
    deleteSubscriptionAfterBindingRemoval(
      current,
      () => undefined,
      (prepared) => { current = prepared; },
      { prepare, delete: async () => { throw new Error("subscription delete failed"); } },
    ),
    /subscription delete failed/,
  );
  assert.equal(current.binding?.status, "pending-remove");
  assert.equal(saves, 1);
  await deleteSubscriptionAfterBindingRemoval(
    current,
    () => undefined,
    (prepared) => { current = prepared; },
    { prepare, delete: async () => undefined },
  );
  assert.equal(saves, 1);
});

test("saved subscription snapshots preserve the original URL and stable dirty state", () => {
  const responseWithUnexpectedToken = {
    ...savedSubscription,
    url: "https://example.invalid/private-path",
    token: "not-returned-by-configd",
  } as ConfigSubscription;
  const draft = subscriptionDraftFromSnapshot(responseWithUnexpectedToken);

  assert.deepEqual(draft, {
    name: "Production",
    url: "https://example.invalid/private-path",
    extractProvider: true,
    providerName: "production",
    providerNameMode: "custom",
    mergeIntoConfig: false,
    configName: "",
    groupNames: [],
    autoUpdate: true,
    intervalMinutes: 120,
  });
  assert.doesNotMatch(JSON.stringify(draft), /not-returned-by-configd/);
  assert.equal(isSubscriptionDirty(draft, draft, false), false);
  assert.equal(isSubscriptionDirty({ ...draft, intervalMinutes: 60 }, draft, false), true);
  assert.equal(isSubscriptionDirty(draft, draft, true), true);
});

test("subscription CRUD preserves paths, auto-update fields, and blank URL retention", async () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url: String(input), body });
    if (method === "GET") {
      return new Response(JSON.stringify({ subscriptions: [savedSubscription] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify(savedSubscription), {
      headers: { "content-type": "application/json" },
    });
  };

  const createInput: ConfigSubscriptionInput = {
    name: "Production",
    url: "https://example.invalid/subscription",
    extractProvider: true,
    providerName: "production",
    mergeIntoConfig: false,
    configName: "",
    autoUpdate: true,
    intervalMinutes: 120,
  };
  const retainedUrlInput = { ...createInput, url: "" };

  try {
    assert.deepEqual(await listSubscriptions(), [savedSubscription]);
    await createSubscription(createInput);
    await updateSubscription("saved/id", retainedUrlInput);
    await deleteSubscription("saved/id");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [
    { method: "GET", url: "/api/config/subscriptions", body: null },
    { method: "POST", url: "/api/config/subscriptions", body: createInput },
    {
      method: "PUT",
      url: "/api/config/subscriptions/saved%2Fid",
      body: retainedUrlInput,
    },
    {
      method: "DELETE",
      url: "/api/config/subscriptions/saved%2Fid",
      body: null,
    },
  ]);
});

test("subscription binding ownership uses explicit configd metadata endpoints", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method} ${String(input)}`);
    return new Response(JSON.stringify(savedSubscription), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await beginSubscriptionBinding("saved/id");
    await activateSubscriptionBinding("saved/id");
    await beginSubscriptionBindingRemoval("saved/id");
    await releaseSubscriptionBinding("saved/id");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(calls, [
    "POST /api/config/subscriptions/saved%2Fid/binding",
    "PUT /api/config/subscriptions/saved%2Fid/binding",
    "POST /api/config/subscriptions/saved%2Fid/binding/removal",
    "DELETE /api/config/subscriptions/saved%2Fid/binding",
  ]);
});

test("subscription snapshots replace the same id without duplication", () => {
  const other = { ...savedSubscription, id: "other", name: "Other" };
  const initial = [savedSubscription, other];
  const replacement = { ...savedSubscription, name: "Updated" };
  const replaced = upsertSubscriptionSnapshot(initial, replacement);

  assert.deepEqual(replaced, [replacement, other]);
  assert.notEqual(replaced, initial);
  assert.equal(initial[0]?.name, "Production");
});

test("disposing subscription reads aborts and suppresses late publication", async () => {
  const requests = new LatestRequestController();
  const result = deferred<ConfigSubscription[]>();
  const published: ConfigSubscription[][] = [];
  const request = requests.begin();
  const run = result.promise.then((subscriptions) => {
    if (request.isCurrent()) published.push(subscriptions);
  }).finally(() => request.finish());

  requests.dispose();
  assert.equal(request.signal.aborted, true);
  assert.equal(request.isCurrent(), false);
  const afterDispose = requests.begin();
  assert.equal(afterDispose.signal.aborted, true);
  assert.equal(afterDispose.isCurrent(), false);
  result.resolve([savedSubscription]);
  await run;

  assert.deepEqual(published, []);
});
