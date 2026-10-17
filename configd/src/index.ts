// 服务入口读取受控环境配置，并以同一 WriteQueue 装配配置和订阅服务。
import { join, resolve } from "node:path";
import { ConfigStore } from "./config/store.js";
import { ProxyAddressReader, proxyAddressSource } from "./config/proxyAddresses.js";
import { ProxyMergeSettingsService } from "./proxyMergeSettings/service.js";
import { ProxyNodeSettingsService, saveProxyNodeInfoUnqueued } from "./proxyNodeSettings/service.js";
import { ProviderFileService } from "./providerFiles/service.js";
import { createConfigdServer } from "./server.js";
import { SubscriptionService } from "./subscriptions/service.js";
import { WriteQueue } from "./writeQueue.js";
import { ManagerSettingsService } from "./managerSettings/service.js";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInt(name: string, fallback: number) {
  const raw = process.env[name];
  const value = raw == null ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

const maxBodyBytes = positiveInt("CONFIGD_MAX_BODY_BYTES", 2 * 1024 * 1024);
const maxProviderSourceBytes = positiveInt("CONFIGD_SUBSCRIPTION_MAX_BYTES", 8 * 1024 * 1024);
const dataDir = resolve(required("MIHOMO_DATA_DIR"));
const writeQueue = new WriteQueue();
let providerFiles: ProviderFileService | null = null;
const store = new ConfigStore({
  configPath: resolve(required("MIHOMO_CONFIG_PATH")),
  mihomoBinary: resolve(required("MIHOMO_BINARY_PATH")),
  dataDir,
  validationTimeoutMs: positiveInt("MIHOMO_VALIDATE_TIMEOUT_MS", 10_000),
  maxContentBytes: maxBodyBytes,
  maxProviderSourceBytes,
  writeQueue,
});
const managerSettings = new ManagerSettingsService({
  statePath: resolve(process.env.CONFIGD_MANAGER_SETTINGS_PATH || join(dataDir, "manager-settings.json")),
  runtimeDir: resolve(process.env.CONFIGD_RUNTIME_DIR || join(dataDir, "generated-runtime")),
  store,
  writeQueue,
});
const subscriptions = new SubscriptionService({
  statePath: resolve(process.env.CONFIGD_SUBSCRIPTIONS_PATH || join(dataDir, "subscriptions.json")),
  providerDir: resolve(required("MIHOMO_PROVIDER_DIR")),
  dataDir,
  requestTimeoutMs: positiveInt("CONFIGD_SUBSCRIPTION_TIMEOUT_MS", 15_000),
  maxResponseBytes: maxProviderSourceBytes,
  writeQueue,
  publishProvider: async (identity, commitState) => {
    if (!providerFiles) throw new Error("provider file service is unavailable");
    return providerFiles.publishSubscriptionProvider(identity, commitState);
  },
  renameProvider: async (identity, commitState) => {
    if (!providerFiles) throw new Error("provider file service is unavailable");
    await providerFiles.renameSubscriptionProvider(identity, commitState);
  },
  ensureProviderOwnershipReady: async () => {
    if (!providerFiles) throw new Error("provider file service is unavailable");
    await providerFiles.ensureProviderOperationRecovered();
  },
  assertProviderReservationAvailable: async (identity) => {
    if (!providerFiles) throw new Error("provider file service is unavailable");
    await providerFiles.assertSubscriptionReservationAvailable(identity);
  },
  assertProviderIdentity: async (identity) => {
    if (!providerFiles) throw new Error("provider file service is unavailable");
    await providerFiles.assertSubscriptionPublish(identity);
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
  readConfigFile: (name) => store.read(name),
  providerFilterSettings: (subscriptionId) =>
    providerFiles?.filterSettingsForSubscription(subscriptionId) ?? { version: 0, enabled: false, rules: [] },
});
await subscriptions.init();
providerFiles = new ProviderFileService({
  providerDir: resolve(required("MIHOMO_PROVIDER_DIR")),
  ruleProviderDir: resolve(process.env.MIHOMO_RULE_PROVIDER_DIR || join(dataDir, "ruleset")),
  statePath: resolve(process.env.CONFIGD_PROVIDER_FILES_PATH || join(dataDir, "provider-files.json")),
  dataDir,
  maxContentBytes: maxProviderSourceBytes,
  writeQueue,
  store,
  subscriptions: () => subscriptions.list(),
  clearSubscriptionProviderUnqueued: (identity) => subscriptions.clearProviderFileUnqueued(identity),
  readRuntimeDependencies: async () => {
    const { content, state } = await managerSettings.readAppliedUnqueued();
    // A successful load record can protect referenced files, but cannot prove
    // which dependencies Core currently uses, even when its versions match.
    const status = state.lastAttempt?.status;
    const unknownReason = status === "pending" ? "load_pending" : status === "unknown" ? "load_unknown"
      : status === "failed" ? "load_failed" : content ? "core_unverified" : "no_record";
    return { content, uncertain: true, unknownReason, hasSuccessfulRecord: state.lastSuccessful !== null };
  },
});
await providerFiles.init();
await subscriptions.migrateLegacyFilterSettings();
subscriptions.startScheduling();
const proxyAddresses = new ProxyAddressReader({
  readSource: async () => proxyAddressSource(await managerSettings.readApplied()),
  dataDir,
  providerDir: resolve(required("MIHOMO_PROVIDER_DIR")),
  countryCachePath: resolve(process.env.CONFIGD_PROXY_COUNTRIES_PATH || join(dataDir, "proxy-countries.json")),
  countryLookupTimeoutMs: positiveInt("CONFIGD_COUNTRY_LOOKUP_TIMEOUT_MS", 5_000),
});
const proxyMergeSettings = new ProxyMergeSettingsService({
  statePath: resolve(process.env.CONFIGD_PROXY_MERGE_SETTINGS_PATH || join(dataDir, "proxy-merge-settings.json")),
  writeQueue,
});
const proxyNodeSettings = new ProxyNodeSettingsService({
  statePath: resolve(process.env.CONFIGD_PROXY_NODE_SETTINGS_PATH || join(dataDir, "proxy-node-settings.json")),
  writeQueue,
});

const host = process.env.CONFIGD_HOST?.trim() || "127.0.0.1";
const port = positiveInt("CONFIGD_PORT", 9081);
const server = createConfigdServer({
  store,
  subscriptions,
  proxyAddresses,
  proxyMergeSettings,
  proxyNodeSettings,
  managerSettings,
  providerFiles,
  saveProxyNodeInfo: (input) => writeQueue.enqueue(() => saveProxyNodeInfoUnqueued({
    store,
    settingsService: proxyNodeSettings,
    ...input,
  })),
  maxBodyBytes,
  ...(process.env.CONFIGD_ALLOWED_ORIGIN ? { allowedOrigin: process.env.CONFIGD_ALLOWED_ORIGIN } : {}),
});
server.listen(port, host, () => process.stdout.write(`configd listening on ${host}:${port}\n`));
