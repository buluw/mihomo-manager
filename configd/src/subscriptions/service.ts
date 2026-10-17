// 持久化订阅元数据、执行受限下载调度，并原子写入 Mihomo Provider 文件。
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import {
  SubscriptionDownloadError,
  SubscriptionNotFoundError,
  SubscriptionTimeoutError,
  SubscriptionTooLargeError,
  SubscriptionValidationError,
} from "../config/errors.js";
import { WriteQueue } from "../writeQueue.js";
import type { ConfigSnapshot } from "../config/store.js";
import {
  providerFileNameKey,
} from "../providerFiles/controlledFiles.js";
import { extractProxyProvider, filterSubscriptionConfig, matchesProviderFilter } from "../providerFiles/extraction.js";
import type { PublicSubscription, Subscription, SubscriptionBinding, SubscriptionFilterSettings, SubscriptionInput } from "./types.js";

interface PersistedState {
  version: 1;
  subscriptions: Subscription[];
}

const SUBSCRIPTION_USER_AGENT = "clash.meta/mihomo-manager";

function isWithin(root: string, target: string) {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function isWithinOrSame(root: string, target: string) {
  return resolve(root) === resolve(target) || isWithin(root, target);
}

interface ConfigPublishTransaction {
  snapshot: ConfigSnapshot;
  rollback: () => Promise<void>;
}

export interface SubscriptionServiceOptions {
  statePath: string;
  providerDir: string;
  dataDir?: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  writeQueue: WriteQueue;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  setTimer?: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  publishProvider?: (input: {
    subscriptionId: string;
    fileName: string;
    expectedSha256: string | null;
    content: string;
  }, commitState: (sha256: string) => Promise<void>) => Promise<string>;
  renameProvider?: (input: {
    subscriptionId: string;
    fileName: string;
    nextFileName: string;
    expectedSha256: string | null;
  }, commitState: () => Promise<void>) => Promise<void>;
  ensureProviderOwnershipReady?: () => Promise<void>;
  assertProviderReservationAvailable?: (input: {
    subscriptionId: string | null;
    fileName: string;
  }) => Promise<void>;
  assertProviderIdentity?: (input: {
    subscriptionId: string;
    fileName: string;
    expectedSha256: string | null;
  }) => Promise<void>;
  beforeStateRename?: () => Promise<void>;
  syncConfigFile?: (
    name: string,
    content: string,
    existing: boolean,
  ) => Promise<ConfigSnapshot | ConfigPublishTransaction>;
  deleteConfigFile?: (name: string, expectedSha256: string) => Promise<ConfigSnapshot>;
  readConfigFile?: (name: string) => Promise<ConfigSnapshot>;
  providerFilterSettings?: (subscriptionId: string) => {
    version: number;
    enabled: boolean;
    rules: string[];
  };
}

function validateUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SubscriptionValidationError("invalid subscription URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SubscriptionValidationError("unsupported subscription protocol");
  }
  return url.toString();
}

function validateProviderName(value: string) {
  const name = value.trim();
  if (!/^[\p{L}\p{N}_ -]{1,80}$/u.test(name)) {
    throw new SubscriptionValidationError("invalid provider name");
  }
  return name;
}

function providerNameKey(providerName: string) {
  return providerFileNameKey(`${providerName}.yaml`);
}

function reservesProviderName(subscription: Pick<Subscription, "extractProvider" | "providerName" | "providerSha256">) {
  return Boolean(subscription.providerName && (subscription.extractProvider || subscription.providerSha256));
}

function validateInput(input: SubscriptionInput, existing?: Subscription): SubscriptionInput {
  const name = input.name?.trim();
  if (
    !name ||
    name.length > 100 ||
    !/^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u.test(name)
  ) throw new SubscriptionValidationError("invalid subscription name");
  const intervalMinutes = Number(input.intervalMinutes);
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1) {
    throw new SubscriptionValidationError("invalid update interval");
  }
  const url = input.url?.trim();
  if (!existing && !url) throw new SubscriptionValidationError("subscription URL is required");
  const extractProvider = input.extractProvider === true;
  const mergeIntoConfig = input.mergeIntoConfig === true;
  const rawProviderName = (input.providerName ?? "").trim();
  const providerNameMode = input.providerNameMode === "follow" || input.providerNameMode === "custom"
    ? input.providerNameMode
    : existing?.providerNameMode ?? (rawProviderName === name ? "follow" : "custom");
  const effectiveProviderName = providerNameMode === "follow" ? name : rawProviderName;
  const providerName = effectiveProviderName
    ? extractProvider ? validateProviderName(effectiveProviderName) : effectiveProviderName
    : existing?.providerSha256 ? existing.providerName : "";
  if (extractProvider && !providerName) throw new SubscriptionValidationError("provider name is required");
  const configName = (input.configName ?? "").trim();
  if (extractProvider && mergeIntoConfig && !configName) throw new SubscriptionValidationError("configuration name is required");
  const groupNames = [...new Set((input.groupNames ?? []).map((value) => value.trim()).filter(Boolean))];
  if (extractProvider && mergeIntoConfig && groupNames.length === 0) throw new SubscriptionValidationError("proxy group is required");
  if (groupNames.some((value) => value.length > 120)) throw new SubscriptionValidationError("invalid proxy group name");
  return {
    name,
    ...(url ? { url: validateUrl(url) } : {}),
    extractProvider,
    providerName,
    providerNameMode,
    mergeIntoConfig,
    configName,
    groupNames,
    autoUpdate: input.autoUpdate === true,
    intervalMinutes,
  };
}

function normalizeSubscription(value: Subscription): Subscription {
  const extractProvider = typeof value.extractProvider === "boolean"
    ? value.extractProvider
    : Boolean(value.providerName);
  const providerName = typeof value.providerName === "string" ? value.providerName : "";
  return {
    ...value,
    configFileName: typeof value.configFileName === "string" ? value.configFileName : null,
    extractProvider,
    providerName,
    providerNameMode: value.providerNameMode === "follow" || value.providerNameMode === "custom"
      ? value.providerNameMode
      : providerName.trim() === value.name.trim() ? "follow" : "custom",
    providerSha256: providerName && typeof value.providerSha256 === "string" && /^[a-f0-9]{64}$/i.test(value.providerSha256)
      ? value.providerSha256
      : null,
    mergeIntoConfig: value.mergeIntoConfig === true,
    configName: typeof value.configName === "string"
      ? value.configName
      : "",
    groupNames: Array.isArray(value.groupNames)
      ? value.groupNames.filter((name): name is string => typeof name === "string" && Boolean(name))
      : value.binding?.groupNames ?? (value.binding?.providerName ? [value.binding.providerName] : []),
    binding: value.binding &&
      typeof value.binding.configName === "string" &&
      typeof value.binding.providerName === "string" &&
      typeof value.binding.providerPath === "string"
      ? {
          ...value.binding,
          groupNames: Array.isArray(value.binding.groupNames)
            ? value.binding.groupNames.filter((name): name is string => typeof name === "string" && Boolean(name))
            : [value.binding.providerName],
          status: ["pending-add", "active", "pending-remove"].includes(value.binding.status)
            ? value.binding.status
            : "active",
        }
      : null,
    autoUpdate: value.autoUpdate === true,
    uploadBytes: Number.isFinite(value.uploadBytes) ? value.uploadBytes : null,
    downloadBytes: Number.isFinite(value.downloadBytes) ? value.downloadBytes : null,
    totalBytes: Number.isFinite(value.totalBytes) ? value.totalBytes : null,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null,
    filterSettings: value.filterSettings && Number.isSafeInteger(value.filterSettings.version) && value.filterSettings.version >= 0 &&
      typeof value.filterSettings.enabled === "boolean" && Array.isArray(value.filterSettings.rules) &&
      value.filterSettings.rules.every((rule) => typeof rule === "string")
      ? { ...value.filterSettings, rules: [...value.filterSettings.rules] }
      : { version: 0, enabled: false, rules: [] },
  };
}

function parseSubscriptionUserInfo(value: string | null) {
  const fields = new Map<string, string>();
  for (const part of value?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    fields.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  const bytes = (key: string) => {
    const raw = fields.get(key);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  };
  const rawExpire = fields.get("expire");
  const expire = rawExpire ? Number(rawExpire) : Number.NaN;
  const expiresAt = Number.isSafeInteger(expire) && expire > 0
    ? new Date(expire * 1000)
    : null;
  return {
    uploadBytes: bytes("upload"),
    downloadBytes: bytes("download"),
    totalBytes: bytes("total"),
    expiresAt: expiresAt && Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : null,
  };
}

export { matchesProviderFilter };

function parseProvider(content: string, settings?: { enabled: boolean; rules: string[] }) {
  try {
    return extractProxyProvider(content, settings);
  } catch {
    throw new SubscriptionDownloadError("subscription YAML is invalid");
  }
}

function countProxies(content: string) {
  try {
    const parsed = parse(content);
    return parsed && typeof parsed === "object" && Array.isArray((parsed as { proxies?: unknown }).proxies)
      ? (parsed as { proxies: unknown[] }).proxies.length
      : 0;
  } catch {
    return 0;
  }
}

export class SubscriptionService {
  private subscriptions: Subscription[] = [];
  private legacyFilterMigrationIds = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly configCommitListeners = new Set<(snapshot: ConfigSnapshot) => void>();
  private readonly updating = new Map<string, Promise<{
    providerName: string | null;
    providerPath: string | null;
    nodeCount: number;
    updatedAt: string;
    config: ConfigSnapshot | null;
  }>>();
  private readonly now: () => Date;
  private readonly setTimer: NonNullable<SubscriptionServiceOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<SubscriptionServiceOptions["clearTimer"]>;
  private schedulingStarted = false;
  private providerDirectoryValidated = false;

  constructor(readonly options: SubscriptionServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  async init() {
    this.providerDirectoryValidated = false;
    await this.validateExistingProviderDirectory();
    try {
      const state = JSON.parse(await readFile(this.options.statePath, "utf8")) as PersistedState;
      if (state.version !== 1 || !Array.isArray(state.subscriptions)) throw new Error();
      this.legacyFilterMigrationIds = new Set(state.subscriptions.filter((value) => {
        const settings = (value as Partial<Subscription>).filterSettings;
        return !(settings && Number.isSafeInteger(settings.version) && settings.version >= 0 &&
          typeof settings.enabled === "boolean" && Array.isArray(settings.rules) &&
          settings.rules.every((rule) => typeof rule === "string"));
      }).map((value) => value.id));
      this.subscriptions = state.subscriptions.map(normalizeSubscription);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("subscription state is invalid");
      }
    }
    this.providerDirectoryValidated = true;
  }

  async migrateLegacyFilterSettings() {
    if (this.legacyFilterMigrationIds.size === 0) return false;
    return this.options.writeQueue.enqueue(async () => {
      if (this.legacyFilterMigrationIds.size === 0) return false;
      const next = this.subscriptions.map((subscription) => {
        if (!this.legacyFilterMigrationIds.has(subscription.id)) return subscription;
        const legacy = this.options.providerFilterSettings?.(subscription.id) ?? { version: 0, enabled: false, rules: [] };
        return { ...subscription, filterSettings: { version: legacy.version, enabled: legacy.enabled, rules: [...legacy.rules] } };
      });
      await this.writeState(next);
      this.subscriptions = next;
      this.legacyFilterMigrationIds.clear();
      return true;
    });
  }

  startScheduling() {
    this.assertProviderDirectoryControlled();
    if (this.schedulingStarted) return;
    this.schedulingStarted = true;
    for (const subscription of this.subscriptions) this.schedule(subscription);
  }

  close() {
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    this.schedulingStarted = false;
  }

  list(): PublicSubscription[] {
    return this.subscriptions.map((subscription) => ({
      ...subscription,
      urlConfigured: Boolean(subscription.url),
    }));
  }

  async create(input: SubscriptionInput) {
    this.assertProviderDirectoryControlled();
    const validated = validateInput(input);
    const now = this.now();
    const subscription: Subscription = {
      id: randomUUID(),
      name: validated.name,
      url: validated.url!,
      configFileName: null,
      extractProvider: validated.extractProvider === true,
      providerName: validated.providerName!,
      providerNameMode: validated.providerNameMode!,
      providerSha256: null,
      mergeIntoConfig: validated.mergeIntoConfig === true,
      configName: validated.configName ?? "",
      groupNames: validated.groupNames ?? [],
      binding: null,
      autoUpdate: validated.autoUpdate,
      intervalMinutes: validated.intervalMinutes,
      status: "idle",
      nodeCount: 0,
      lastAttemptAt: null,
      lastUpdatedAt: null,
      nextUpdateAt: validated.autoUpdate
        ? new Date(now.getTime() + validated.intervalMinutes * 60_000).toISOString()
        : null,
      uploadBytes: null,
      downloadBytes: null,
      totalBytes: null,
      expiresAt: null,
      filterSettings: { version: 0, enabled: false, rules: [] },
    };
    await this.options.writeQueue.enqueue(async () => {
      await this.options.ensureProviderOwnershipReady?.();
      if (subscription.extractProvider && this.subscriptions.some(
        (item) => reservesProviderName(item) &&
          providerNameKey(item.providerName) === providerNameKey(subscription.providerName),
      )) {
        throw new SubscriptionValidationError("provider name already exists");
      }
      if (subscription.extractProvider) {
        if (!this.options.assertProviderReservationAvailable) {
          throw new SubscriptionValidationError("provider ownership service is unavailable");
        }
        await this.options.assertProviderReservationAvailable?.({
          subscriptionId: subscription.id,
          fileName: `${subscription.providerName}.yaml`,
        });
      }
      const next = [...this.subscriptions, subscription];
      await this.writeState(next);
      this.subscriptions = next;
    });
    this.schedule(subscription);
    return this.public(subscription);
  }

  async update(id: string, input: SubscriptionInput) {
    this.assertProviderDirectoryControlled();
    let updated!: Subscription;
    let providerRenameCommitted = false;
    try {
      await this.options.writeQueue.enqueue(async () => {
      await this.options.ensureProviderOwnershipReady?.();
      const index = this.subscriptions.findIndex((item) => item.id === id);
      if (index < 0) throw new SubscriptionNotFoundError("subscription not found");
      const current = this.subscriptions[index]!;
      const validated = validateInput(input, current);
      const reservesValidatedName = validated.extractProvider || Boolean(current.providerSha256);
      if (reservesValidatedName && validated.providerName && this.subscriptions.some(
        (item) => item.id !== id && reservesProviderName(item) &&
          providerNameKey(item.providerName) === providerNameKey(validated.providerName!),
      )) {
        throw new SubscriptionValidationError("provider name already exists");
      }
      const providerNameChanged = current.providerName !== validated.providerName;
      if (validated.extractProvider && (
        !current.extractProvider || (!current.providerSha256 && providerNameChanged)
      )) {
        if (!this.options.assertProviderReservationAvailable) {
          throw new SubscriptionValidationError("provider ownership service is unavailable");
        }
        await this.options.assertProviderReservationAvailable?.({
          subscriptionId: current.id,
          fileName: `${validated.providerName}.yaml`,
        });
      }
      const bindingTargetChanged = current.binding && (
        !validated.extractProvider || !validated.mergeIntoConfig ||
        current.binding.configName !== validated.configName ||
        current.binding.providerName !== validated.providerName
        || JSON.stringify(current.binding.groupNames) !== JSON.stringify(validated.groupNames)
      );
      if (current.binding) {
        if (bindingTargetChanged && current.binding.status !== "pending-remove") {
          throw new SubscriptionValidationError("subscription binding must begin removal first");
        }
        if (!bindingTargetChanged && current.binding.status === "pending-remove") {
          throw new SubscriptionValidationError("subscription binding removal must be completed or retried");
        }
      }
      updated = {
        ...current,
        ...validated,
        providerSha256: current.providerSha256,
        binding: current.binding?.status === "pending-remove" && bindingTargetChanged
          ? null
          : current.binding,
        url: validated.url ?? current.url,
        nextUpdateAt: validated.autoUpdate
          ? new Date(this.now().getTime() + validated.intervalMinutes * 60_000).toISOString()
          : null,
      };
      const next = [...this.subscriptions];
      next[index] = updated;
      const renameProvider = Boolean(current.providerSha256) && providerNameChanged;
      if (renameProvider) {
        if (!this.options.renameProvider) {
          throw new SubscriptionValidationError("provider ownership service is unavailable");
        }
        await this.options.renameProvider({
          subscriptionId: current.id,
          fileName: `${current.providerName}.yaml`,
          nextFileName: `${validated.providerName}.yaml`,
          expectedSha256: current.providerSha256,
        }, async () => {
          await this.writeState(next);
          this.subscriptions = next;
          providerRenameCommitted = true;
        });
      } else {
        await this.writeState(next);
      }
      this.subscriptions = next;
      });
    } catch (error) {
      if (providerRenameCommitted) this.schedule(updated);
      throw error;
    }
    this.schedule(updated);
    return this.public(updated);
  }

  async delete(id: string) {
    this.assertProviderDirectoryControlled();
    await this.options.writeQueue.enqueue(async () => {
      await this.options.ensureProviderOwnershipReady?.();
      const index = this.subscriptions.findIndex((item) => item.id === id);
      if (index < 0) throw new SubscriptionNotFoundError("subscription not found");
      const current = this.subscriptions[index]!;
      if (current.binding && current.binding.status !== "pending-remove") {
        throw new SubscriptionValidationError("subscription binding must begin removal first");
      }
      const next = this.subscriptions.filter((item) => item.id !== id);
      await this.writeState(next);
      this.subscriptions = next;
    });
    const timer = this.timers.get(id);
    if (timer) this.clearTimer(timer);
    this.timers.delete(id);
  }

  // Only call while holding the shared WriteQueue as part of a Provider source transaction.
  async clearProviderFileUnqueued(identity: { subscriptionId: string; fileName: string; expectedSha256: string | null }) {
    const current = this.subscriptions.find((item) => item.id === identity.subscriptionId);
    if (!current || `${current.providerName}.yaml` !== identity.fileName ||
      (current.providerSha256 !== null && current.providerSha256 !== identity.expectedSha256)) {
      throw new SubscriptionValidationError("subscription provider ownership changed");
    }
    // Idempotent recovery after the delete journal confirms that the body is gone.
    if (current.providerSha256 === null) return;
    const next = this.subscriptions.map((item) => item.id === current.id
      ? { ...item, providerSha256: null, nodeCount: 0 } : item);
    await this.writeState(next);
    this.subscriptions = next;
  }

  // Only call while holding the shared WriteQueue as part of a Provider source transaction.
  async disableProviderExtractionUnqueued(id: string, expectedProviderSha256: string) {
    const index = this.subscriptions.findIndex((item) => item.id === id);
    if (index < 0) throw new SubscriptionNotFoundError("subscription not found");
    const current = this.subscriptions[index]!;
    if (!current.extractProvider || current.providerSha256 !== expectedProviderSha256) {
      throw new SubscriptionValidationError("subscription provider ownership changed");
    }
    if (this.updating.has(id)) throw new SubscriptionValidationError("subscription provider is updating");
    const updated = {
      ...current,
      extractProvider: false,
      providerSha256: null,
      mergeIntoConfig: false,
      binding: null,
    };
    const next = [...this.subscriptions];
    next[index] = updated;
    await this.writeState(next);
    this.subscriptions = next;
    this.schedule(updated);
    return async () => {
      const rollbackIndex = this.subscriptions.findIndex((item) => item.id === id);
      if (rollbackIndex < 0 || this.subscriptions[rollbackIndex]?.providerSha256 !== null) {
        throw new SubscriptionValidationError("subscription provider rollback conflict");
      }
      const restored = [...this.subscriptions];
      restored[rollbackIndex] = current;
      await this.writeState(restored);
      this.subscriptions = restored;
      this.schedule(current);
    };
  }

  updateNow(id: string) {
    this.assertProviderDirectoryControlled();
    // 同一订阅复用正在执行的 Promise，定时更新与手动更新不会并发写同一 Provider。
    const active = this.updating.get(id);
    if (active) return active;
    const operation = this.performUpdate(id).finally(() => this.updating.delete(id));
    this.updating.set(id, operation);
    return operation;
  }

  subscribeConfigCommits(listener: (snapshot: ConfigSnapshot) => void) {
    this.configCommitListeners.add(listener);
    return () => this.configCommitListeners.delete(listener);
  }

  private async performUpdate(id: string) {
    const subscription = this.subscriptions.find((item) => item.id === id);
    if (!subscription) throw new SubscriptionNotFoundError("subscription not found");
    try {
      const downloaded = await this.download(subscription.url);
      const updatedAt = this.now().toISOString();
      const committed = await this.options.writeQueue.enqueue(async () => {
        const current = this.subscriptions.find((item) => item.id === id);
        if (!current) throw new SubscriptionNotFoundError("subscription not found");
        if (current !== subscription) throw new SubscriptionValidationError("subscription update was superseded");
        await this.options.ensureProviderOwnershipReady?.();
        const filters = this.effectiveFilters(current);
        const filtered = current.extractProvider || filters.enabled ? parseProvider(downloaded.content, filters) : null;
        const provider = current.extractProvider ? filtered : null;
        const configContent = filterSubscriptionConfig(downloaded.content, filtered?.matchedNames ?? []);
        const nodeCount = filtered?.nodeCount ?? countProxies(downloaded.content);
        const configName = current.configFileName ?? `${current.name}.yaml`;
        const creatingConfig = current.configFileName == null;
        let config: ConfigSnapshot | null = null;
        let rollbackConfig: (() => Promise<void>) | null = null;
        let committedSubscription: Subscription | null = null;
        try {
          const publishedConfig = this.options.syncConfigFile
            ? await this.options.syncConfigFile(configName, configContent, !creatingConfig)
            : null;
          if (publishedConfig && "snapshot" in publishedConfig) {
            config = publishedConfig.snapshot;
            rollbackConfig = publishedConfig.rollback;
          } else {
            config = publishedConfig;
            if (creatingConfig && config && this.options.deleteConfigFile) {
              rollbackConfig = async () => {
                await this.options.deleteConfigFile?.(config!.name, config!.sha256);
              };
            }
          }
          const buildUpdated = (providerSha256: string | null): Subscription => ({
            ...current,
            ...downloaded.userInfo,
            status: "success",
            configFileName: config?.name ?? current.configFileName,
            nodeCount,
            providerSha256,
            lastAttemptAt: updatedAt,
            lastUpdatedAt: updatedAt,
            nextUpdateAt: current.autoUpdate
              ? new Date(this.now().getTime() + current.intervalMinutes * 60_000).toISOString()
              : null,
          });
          if (provider) {
            if (!this.options.publishProvider) {
              throw new SubscriptionValidationError("provider ownership service is unavailable");
            }
            await this.options.publishProvider({
              subscriptionId: current.id,
              fileName: `${current.providerName}.yaml`,
              expectedSha256: current.providerSha256,
              content: provider.content,
            }, async (providerSha256) => {
              const updated = buildUpdated(providerSha256);
              const next = this.subscriptions.map((item) => item.id === id ? updated : item);
              await this.writeState(next);
              this.subscriptions = next;
              committedSubscription = updated;
            });
          } else {
            const updated = buildUpdated(current.providerSha256);
            const next = this.subscriptions.map((item) => item.id === id ? updated : item);
            await this.writeState(next);
            this.subscriptions = next;
            committedSubscription = updated;
          }
          const publishedSubscription = committedSubscription as Subscription | null;
          if (!publishedSubscription) throw new Error("subscription update did not commit");
          return { current: publishedSubscription, config, nodeCount };
        } catch (error) {
          if (committedSubscription) {
            this.schedule(committedSubscription);
            throw error;
          }
          const rollbackErrors: unknown[] = [];
          if (rollbackConfig) {
            try {
              await rollbackConfig();
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
          if (rollbackErrors.length > 0) {
            throw new Error("subscription update failed and rollback failed", {
              cause: new AggregateError(rollbackErrors, "subscription rollback failed"),
            });
          }
          throw error;
        }
      });
      this.schedule(committed.current);
      if (committed.config) {
        for (const listener of this.configCommitListeners) {
          try {
            listener(committed.config);
          } catch {
            // Notification delivery is best-effort after the transaction has committed.
          }
        }
      }
      return {
        providerName: committed.current.extractProvider ? committed.current.providerName : null,
        providerPath: committed.current.extractProvider
          ? this.providerReferencePath(committed.current.providerName)
          : null,
        providerSha256: committed.current.providerSha256,
        nodeCount: committed.nodeCount,
        updatedAt,
        config: committed.config
          ? { ...committed.config, subscriptionManaged: true, subscriptionId: id }
          : null,
      };
    } catch (error) {
      const attemptedAt = this.now().toISOString();
      let failedSubscription: Subscription | null = null;
      await this.options.writeQueue.enqueue(async () => {
        const current = this.subscriptions.find((item) => item.id === id);
        if (!current || current !== subscription) return;
        await this.options.ensureProviderOwnershipReady?.();
        const failed: Subscription = {
          ...current,
          status: "error",
          lastAttemptAt: attemptedAt,
          nextUpdateAt: current.autoUpdate
            ? new Date(this.now().getTime() + current.intervalMinutes * 60_000).toISOString()
            : null,
        };
        const next = this.subscriptions.map((item) => item.id === id ? failed : item);
        await this.writeState(next);
        this.subscriptions = next;
        failedSubscription = failed;
      });
      if (failedSubscription) this.schedule(failedSubscription);
      throw error;
    }
  }

  async previewFilter(id: string, rules: string[]) {
    const subscription = this.subscriptions.find((item) => item.id === id);
    if (!subscription) throw new SubscriptionNotFoundError("subscription not found");
    const downloaded = await this.download(subscription.url);
    const provider = parseProvider(downloaded.content, this.effectiveFilters({ ...subscription, filterSettings: { ...subscription.filterSettings, enabled: true, rules } }));
    return {
      totalCount: provider.totalCount,
      matchedNames: provider.matchedNames,
      remainingCount: provider.nodeCount,
    };
  }

  async previewProviderFilter(fileName: string, rules: string[]) {
    return this.previewFilter(this.subscriptionForProviderFile(fileName).id, rules);
  }

  saveFilterSettings(id: string, input: SubscriptionFilterSettings) {
    return this.options.writeQueue.enqueue(async () => {
      const current = this.subscriptions.find((item) => item.id === id);
      if (!current) throw new SubscriptionNotFoundError("subscription not found");
      if (current.filterSettings.version !== input.version) throw new SubscriptionValidationError("subscription filter settings changed");
      if (!Array.isArray(input.rules) || input.rules.length > 100 || input.rules.some((rule) => typeof rule !== "string" || rule.length > 200)) {
        throw new SubscriptionValidationError("invalid subscription filter settings");
      }
      try { parseProvider("proxies: []\n", { enabled: input.enabled, rules: input.rules }); } catch {
        throw new SubscriptionValidationError("invalid subscription filter settings");
      }
      const settings = { version: current.filterSettings.version + 1, enabled: input.enabled, rules: input.rules.map((rule) => rule.trim()).filter(Boolean) };
      const updated = { ...current, filterSettings: settings };
      const next = this.subscriptions.map((item) => item.id === id ? updated : item);
      await this.writeState(next);
      this.subscriptions = next;
      return settings;
    });
  }

  async regenerateProviderFile(fileName: string) {
    return this.options.writeQueue.enqueue(() => this.regenerateProviderFileUnqueued(fileName));
  }

  // Only call while holding the shared WriteQueue.
  async regenerateProviderFileUnqueued(
    fileName: string,
    markCommitted?: () => void,
    sourceSnapshot?: ConfigSnapshot,
  ) {
    if (!this.options.publishProvider) throw new SubscriptionValidationError("provider ownership service is unavailable");
    const subscription = this.subscriptionForProviderFile(fileName);
    if (!subscription.extractProvider || !subscription.configFileName) {
      throw new SubscriptionValidationError("subscription extraction is disabled");
    }
    const snapshot = sourceSnapshot ?? await this.options.readConfigFile?.(subscription.configFileName);
    if (!snapshot) throw new SubscriptionValidationError("configuration reader is unavailable");
    if (snapshot.name !== subscription.configFileName) {
      throw new SubscriptionValidationError("subscription configuration changed");
    }
    const provider = this.extractProvider(snapshot.content, subscription);
    await this.options.publishProvider({
      subscriptionId: subscription.id,
      fileName,
      expectedSha256: subscription.providerSha256,
      content: provider.content,
    }, async (providerSha256) => {
      const current = this.subscriptions.find((item) => item.id === subscription.id);
      if (current !== subscription) throw new SubscriptionValidationError("subscription update was superseded");
      const updated = { ...current, providerSha256, nodeCount: provider.nodeCount };
      const next = this.subscriptions.map((item) => item.id === current.id ? updated : item);
      await this.writeState(next);
      this.subscriptions = next;
      markCommitted?.();
    });
    return { providerName: subscription.providerName, nodeCount: provider.nodeCount };
  }

  async regenerateProvidersForConfig(configName: string, expectedSha256: string) {
    return this.options.writeQueue.enqueue(() => this.regenerateProvidersForConfigUnqueued(configName, expectedSha256));
  }

  async regenerateProvidersForConfigUnqueued(configName: string, expectedSha256: string) {
      if (!this.options.readConfigFile) {
        throw new SubscriptionValidationError("configuration reader is unavailable");
      }
      const snapshot = await this.options.readConfigFile(configName);
      if (snapshot.sha256 !== expectedSha256) {
        throw new SubscriptionValidationError("configuration update was superseded");
      }
      const subscriptions = this.subscriptions.filter((item) =>
        item.extractProvider && item.configFileName === configName && item.providerName);
      const results = [];
      for (const subscription of subscriptions) {
        results.push(await this.regenerateProviderFileUnqueued(
          `${subscription.providerName}.yaml`,
          undefined,
          snapshot,
        ));
      }
      return results;
  }

  private subscriptionForProviderFile(fileName: string) {
    const key = providerFileNameKey(fileName);
    const matches = this.subscriptions.filter((item) =>
      item.providerName && providerFileNameKey(`${item.providerName}.yaml`) === key &&
      (item.extractProvider || item.providerSha256));
    if (matches.length !== 1) throw new SubscriptionValidationError("provider ownership is ambiguous");
    return matches[0]!;
  }

  private extractProvider(content: string, subscription: Subscription) {
    return parseProvider(content, this.effectiveFilters(subscription));
  }

  private effectiveFilters(subscription: Subscription) {
    const settings = [subscription.filterSettings, this.options.providerFilterSettings?.(subscription.id)];
    return {
      enabled: settings.some((value) => value?.enabled),
      rules: settings.flatMap((value) => value?.enabled ? value.rules : []),
    };
  }

  private async download(url: string) {
    // 同时检查 Content-Length 和实际流量，响应未声明长度时仍受硬上限保护。
    const safeUrl = validateUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(safeUrl, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          accept: "application/yaml, text/yaml, text/plain",
          "user-agent": SUBSCRIPTION_USER_AGENT,
        },
      });
      if (!response.ok || !response.body) throw new SubscriptionDownloadError("subscription response failed");
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > this.options.maxResponseBytes) {
        await response.body.cancel();
        throw new SubscriptionTooLargeError("subscription response too large");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.options.maxResponseBytes) {
          await reader.cancel();
          throw new SubscriptionTooLargeError("subscription response too large");
        }
        chunks.push(value);
      }
      const content = Buffer.concat(chunks).toString("utf8");
      if (content.trim().length === 0) {
        throw new SubscriptionDownloadError("subscription response is empty");
      }
      return {
        content,
        userInfo: parseSubscriptionUserInfo(response.headers.get("subscription-userinfo")),
      };
    } catch (error) {
      if (error instanceof SubscriptionDownloadError) throw error;
      if (controller.signal.aborted) throw new SubscriptionTimeoutError("subscription request timed out");
      throw new SubscriptionDownloadError("subscription request failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  private providerPath(providerName: string) {
    const root = resolve(this.options.providerDir);
    const path = resolve(root, `${validateProviderName(providerName)}.yaml`);
    if (!isWithin(root, path)) {
      throw new SubscriptionValidationError("provider path escapes provider directory");
    }
    return path;
  }

  private assertProviderDirectoryControlled() {
    if (!this.options.dataDir) return;
    const dataDir = resolve(this.options.dataDir);
    const providerDir = resolve(this.options.providerDir);
    if (!isWithinOrSame(dataDir, providerDir)) {
      throw new SubscriptionValidationError("provider directory is outside the Mihomo data directory");
    }
    if (!this.providerDirectoryValidated) {
      throw new SubscriptionValidationError("provider directory has not been validated");
    }
  }

  private async validateExistingProviderDirectory() {
    if (!this.options.dataDir) return;
    const dataDir = resolve(this.options.dataDir);
    const providerDir = resolve(this.options.providerDir);
    if (!isWithinOrSame(dataDir, providerDir)) {
      throw new SubscriptionValidationError("provider directory is outside the Mihomo data directory");
    }
    try {
      const dataMetadata = await lstat(dataDir);
      if (!dataMetadata.isDirectory() || dataMetadata.isSymbolicLink()) throw new Error();
      const realDataDir = await realpath(dataDir);
      let current = dataDir;
      const child = relative(dataDir, providerDir);
      for (const segment of child ? child.split(sep) : []) {
        current = join(current, segment);
        let metadata;
        try {
          metadata = await lstat(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error();
        if (!isWithinOrSame(realDataDir, await realpath(current))) throw new Error();
      }
    } catch {
      throw new SubscriptionValidationError("provider directory is unavailable");
    }
  }

  private providerReferencePath(providerName: string) {
    const dataDir = resolve(this.options.dataDir ?? dirname(this.options.providerDir));
    const path = this.providerPath(providerName);
    if (!isWithin(dataDir, path)) {
      throw new SubscriptionValidationError("provider directory is outside the Mihomo data directory");
    }
    const child = relative(dataDir, path);
    return `./${child.split(sep).join("/")}`;
  }

  private async assertCommittedProviderIdentity(subscription: Subscription) {
    if (!subscription.providerSha256 || !this.options.assertProviderIdentity) {
      throw new SubscriptionValidationError("subscription provider is unavailable or changed");
    }
    try {
      await this.options.assertProviderIdentity({
        subscriptionId: subscription.id,
        fileName: `${subscription.providerName}.yaml`,
        expectedSha256: subscription.providerSha256,
      });
    } catch {
      throw new SubscriptionValidationError("subscription provider is unavailable or changed");
    }
  }

  private async writeState(subscriptions = this.subscriptions) {
    await mkdir(dirname(this.options.statePath), { recursive: true });
    // 元数据也采用同目录临时文件替换，避免进程中断留下半写 JSON。
    const temporary = `${this.options.statePath}.tmp-${randomBytes(8).toString("hex")}`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, subscriptions } satisfies PersistedState),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await this.options.beforeStateRename?.();
      await rename(temporary, this.options.statePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private schedule(subscription: Subscription) {
    // 重排前先取消旧定时器；延迟钳制到 Node 上限，unref 避免定时器阻止进程退出。
    const previous = this.timers.get(subscription.id);
    if (previous) this.clearTimer(previous);
    this.timers.delete(subscription.id);
    if (!this.schedulingStarted) return;
    if (!subscription.autoUpdate || !subscription.nextUpdateAt) return;
    const delay = Math.max(0, new Date(subscription.nextUpdateAt).getTime() - this.now().getTime());
    const timer = this.setTimer(() => {
      this.timers.delete(subscription.id);
      void this.updateNow(subscription.id).catch(() => undefined);
    }, Math.min(delay, 2_147_483_647));
    timer.unref?.();
    this.timers.set(subscription.id, timer);
  }

  private public(subscription: Subscription): PublicSubscription {
    return { ...subscription, urlConfigured: Boolean(subscription.url) };
  }

  configOwner(name: string) {
    const owner = this.subscriptions.find((item) => item.configFileName === name);
    return owner ? { id: owner.id, name: owner.name } : null;
  }

  renameConfigFile(
    oldName: string,
    newName: string,
    renameFile: () => Promise<ConfigSnapshot>,
    rollbackFile: (snapshot: ConfigSnapshot) => Promise<void>,
  ) {
    this.assertProviderDirectoryControlled();
    return this.options.writeQueue.enqueue(async () => {
      await this.options.ensureProviderOwnershipReady?.();
      const owner = this.subscriptions.find((item) => item.configFileName === oldName);
      const snapshot = await renameFile();
      if (!owner) return snapshot;
      const next = this.subscriptions.map((item) => item.id === owner.id
        ? { ...item, configFileName: snapshot.name }
        : item);
      try {
        await this.writeState(next);
      } catch (error) {
        await rollbackFile(snapshot).catch(() => undefined);
        throw error;
      }
      this.subscriptions = next;
      return snapshot;
    });
  }

  deleteManagedConfigFile(
    name: string,
    deleteFile: () => Promise<ConfigSnapshot>,
    restoreFile: (snapshot: ConfigSnapshot) => Promise<ConfigSnapshot>,
  ) {
    this.assertProviderDirectoryControlled();
    return this.options.writeQueue.enqueue(async () => {
      await this.options.ensureProviderOwnershipReady?.();
      const owner = this.subscriptions.find((item) => item.configFileName === name);
      const deleted = await deleteFile();
      if (!owner) return deleted;
      const next = this.subscriptions.map((item) => item.id === owner.id
        ? { ...item, configFileName: null }
        : item);
      try {
        await this.writeState(next);
      } catch (error) {
        await restoreFile(deleted);
        throw error;
      }
      this.subscriptions = next;
      return deleted;
    });
  }

  async beginBinding(id: string): Promise<PublicSubscription> {
    this.assertProviderDirectoryControlled();
    let updated!: Subscription;
    await this.options.writeQueue.enqueue(async () => {
      await this.options.ensureProviderOwnershipReady?.();
      await this.validateExistingProviderDirectory();
      const current = this.subscriptions.find((item) => item.id === id);
      if (!current) throw new SubscriptionNotFoundError("subscription not found");
      if (!current.extractProvider || !current.mergeIntoConfig || !current.configName) {
        throw new SubscriptionValidationError("subscription merge is not enabled");
      }
      if (!current.providerSha256) {
        throw new SubscriptionValidationError("subscription provider has not been generated");
      }
      await this.assertCommittedProviderIdentity(current);
      const binding: SubscriptionBinding = {
        configName: current.configName,
        providerName: current.providerName,
        providerPath: this.providerReferencePath(current.providerName),
        groupNames: current.groupNames,
        status: "pending-add",
      };
      if (current.binding) {
        const sameTarget = current.binding.configName === binding.configName &&
          current.binding.providerName === binding.providerName &&
          current.binding.providerPath === binding.providerPath;
        const sameGroups = JSON.stringify(current.binding.groupNames) === JSON.stringify(binding.groupNames);
        if (!sameTarget || !sameGroups || current.binding.status === "pending-remove") {
          throw new SubscriptionValidationError("subscription already owns another binding");
        }
      }
      updated = current.binding ? current : { ...current, binding };
      const next = this.subscriptions.map((item) => item.id === id ? updated : item);
      await this.writeState(next);
      this.subscriptions = next;
    });
    return this.public(updated);
  }

  async activateBinding(id: string): Promise<PublicSubscription> {
    this.assertProviderDirectoryControlled();
    let updated!: Subscription;
    await this.options.writeQueue.enqueue(async () => {
      await this.options.ensureProviderOwnershipReady?.();
      const current = this.subscriptions.find((item) => item.id === id);
      if (!current) throw new SubscriptionNotFoundError("subscription not found");
      if (!current.binding || current.binding.status === "pending-remove") {
        throw new SubscriptionValidationError("subscription binding is not pending activation");
      }
      if (current.binding.status === "active") {
        updated = current;
        return;
      }
      await this.assertCommittedProviderIdentity(current);
      updated = { ...current, binding: { ...current.binding, status: "active" } };
      const next = this.subscriptions.map((item) => item.id === id ? updated : item);
      await this.writeState(next);
      this.subscriptions = next;
    });
    return this.public(updated);
  }

  async beginBindingRemoval(id: string): Promise<PublicSubscription> {
    this.assertProviderDirectoryControlled();
    let updated!: Subscription;
    await this.options.writeQueue.enqueue(async () => {
      await this.options.ensureProviderOwnershipReady?.();
      const current = this.subscriptions.find((item) => item.id === id);
      if (!current) throw new SubscriptionNotFoundError("subscription not found");
      if (!current.binding) throw new SubscriptionValidationError("subscription binding is not owned");
      updated = { ...current, binding: { ...current.binding, status: "pending-remove" } };
      const next = this.subscriptions.map((item) => item.id === id ? updated : item);
      await this.writeState(next);
      this.subscriptions = next;
    });
    return this.public(updated);
  }

  async releaseBinding(id: string): Promise<PublicSubscription> {
    this.assertProviderDirectoryControlled();
    let updated!: Subscription;
    await this.options.writeQueue.enqueue(async () => {
      await this.options.ensureProviderOwnershipReady?.();
      const current = this.subscriptions.find((item) => item.id === id);
      if (!current) throw new SubscriptionNotFoundError("subscription not found");
      if (current.binding?.status === "active") {
        throw new SubscriptionValidationError("active subscription binding must begin removal first");
      }
      updated = { ...current, binding: null };
      const next = this.subscriptions.map((item) => item.id === id ? updated : item);
      await this.writeState(next);
      this.subscriptions = next;
    });
    return this.public(updated);
  }
}
