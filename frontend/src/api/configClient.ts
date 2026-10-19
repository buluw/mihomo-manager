import { accessFetch } from "./accessClient.ts";
import { createAccessEventSource } from "./accessEvents.ts";
// configd Client 只访问固定同源命名空间，集中处理超时、取消和脱敏错误。
const CONFIG_BASE = "/api/config";
const DEFAULT_TIMEOUT_MS = 6_000;
const LONG_OPERATION_TIMEOUT_MS = 30_000;

export class ConfigError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, status: number, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ConfigSnapshot {
  name: string;
  path: string;
  content: string;
  sha256: string;
  providerIssues?: ProviderFileIssue[];
  collectionPaths?: Array<{ category: "proxy" | "rule"; name: string; sourcePath: string; fileName: string | null; referencePath: string | null; writable?: boolean; status?: ProviderFileIssue["status"] }>;
  collectionPathChanges?: CollectionPathChange[];
  subscriptionManaged?: boolean;
  subscriptionId?: string | null;
  providerRefreshFailed?: boolean;
  providerRefreshes?: Array<{ category: "proxy" | "rule"; name: string }>;
}

export interface ProviderFileIssue {
  category: "proxy" | "rule";
  name: string;
  status: "missing" | "outside_scope" | "unreadable" | "conflict" | "ownership_unknown";
}

export type CollectionPathChange = { category: "proxy" | "rule"; name: string; fromPath: string; toPath: string; fileSha256: string };
export type ProviderConfigReference = { configName: string; kind: "path" | "identity" | "unreadable"; path?: string };
export type ProviderRuntimeReferences = {
  references: Array<{ kind: "path" | "identity"; path: string }>;
  uncertain: boolean;
  hasSuccessfulRecord?: boolean;
  scanComplete?: boolean;
  unknownReason?: "no_record" | "load_pending" | "load_unknown" | "load_failed" | "record_unreadable" | "core_unverified";
};
export type RetainedProviderFile = {
  fileName: string; reason: "referenced" | "runtime_reference" | "runtime_unknown"; configNames?: string[];
  configReferences?: ProviderConfigReference[]; runtime?: ProviderRuntimeReferences;
};

export function resolveCollectionPath(input: { configName: string; expectedConfigSha256: string; category: "proxy" | "rule";
  name: string; fromPath: string; toPath: string; expectedFileSha256: string; draftContent: string; action: "rename" | "restore" }, signal?: AbortSignal) {
  return configApi<{ fromPath?: string; content: string; config?: ConfigSnapshot; retainedSource?: RetainedProviderFile }>("/collection-path",
    { method: "POST", body: JSON.stringify(input), signal });
}

export interface ConfigDiagnostic { code: string; message: string; path?: Array<string | number> }

export function configDiagnostics(error: unknown): ConfigDiagnostic[] {
  if (!(error instanceof ConfigError) || error.code !== "validation_failed" || !Array.isArray(error.details.diagnostics)) return [];
  return error.details.diagnostics.filter((item): item is ConfigDiagnostic => Boolean(item) && typeof item.code === "string" && typeof item.message === "string");
}

export type CollectionCategory = "proxy" | "rule"

export interface ProxyCollectionInput {
  operationId: string;
  name: string;
  content: string;
  groupNames: string[];
  newGroupName?: string;
  repair?: boolean;
  category?: CollectionCategory;
  ruleSetRules?: string[];
  behavior?: string;
  format?: string;
  targetFileName?: string;
  expectedFileSha256?: string;
  replace?: boolean;
  interval?: number;
  snippet?: string;
}

export function createProxyCollection(input: ProxyCollectionInput & { configName: string; expectedConfigSha256: string }) {
  return configApi<{ file: ManagedProviderFileSnapshot; config: ConfigSnapshot }>("/proxy-collections", {
    method: "POST", body: JSON.stringify(input),
  }, LONG_OPERATION_TIMEOUT_MS);
}

export function createManagedCollection(input: ProxyCollectionInput & {
  configName: string;
  expectedConfigSha256: string;
  category: CollectionCategory;
}, signal?: AbortSignal) {
  return configApi<{ file: ManagedProviderFileSnapshot; config: ConfigSnapshot; name: string }>("/collection-files", {
    method: "POST", body: JSON.stringify(input), signal,
  }, LONG_OPERATION_TIMEOUT_MS);
}

export function readCollectionUploadDeclaration(input: { category: CollectionCategory; configName: string; name: string; operationId: string }, signal?: AbortSignal) {
  return configApi<{ snippet: string }>("/collection-files/declaration", { method: "POST", body: JSON.stringify(input), signal });
}

export interface ConfigFileRecord {
  name: string;
  path: string;
  sha256: string;
  size: number;
  updatedAt: string;
  subscriptionManaged?: boolean;
  subscriptionId?: string | null;
}

export interface ConfigChangeEvent {
  sequence: number;
  operation: "ready" | "create" | "save" | "rename" | "delete" | "subscription-update";
  name?: string;
  previousName?: string;
  sha256?: string;
}

export function createConfigChangeSource(
  onChange: (event: ConfigChangeEvent) => void,
  createSource: (url: string) => EventSource = createAccessEventSource,
) {
  const source = createSource(`${CONFIG_BASE}/changes`);
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as ConfigChangeEvent;
      if (Number.isSafeInteger(event.sequence) && typeof event.operation === "string") onChange(event);
    } catch {
      // Reconnect/focus reconciliation will recover from malformed or truncated events.
    }
  };
  return source;
}

export interface ConfigSubscription {
  id: string;
  name: string;
  url: string;
  configFileName: string | null;
  extractProvider: boolean;
  providerName: string;
  providerNameMode: "follow" | "custom";
  providerSha256: string | null;
  mergeIntoConfig: boolean;
  configName: string;
  groupNames: string[];
  binding: ConfigSubscriptionBinding | null;
  autoUpdate: boolean;
  intervalMinutes: number;
  status: "idle" | "success" | "error";
  nodeCount: number;
  lastAttemptAt: string | null;
  lastUpdatedAt: string | null;
  nextUpdateAt: string | null;
  uploadBytes: number | null;
  downloadBytes: number | null;
  totalBytes: number | null;
  expiresAt: string | null;
  urlConfigured: boolean;
  filterSettings: ManagedProviderFilterSettings;
}

export interface ConfigSubscriptionBinding {
  configName: string;
  providerName: string;
  providerPath: string;
  groupNames: string[];
  status: "pending-add" | "active" | "pending-remove";
}

export interface ConfigSubscriptionInput {
  name: string;
  url?: string;
  extractProvider: boolean;
  providerName?: string;
  providerNameMode?: "follow" | "custom";
  mergeIntoConfig: boolean;
  configName?: string;
  groupNames?: string[];
  autoUpdate: boolean;
  intervalMinutes: number;
}

export interface ManagedProviderFilterSettings {
  version: number;
  enabled: boolean;
  rules: string[];
}

export interface ProviderTemplateSettings {
  version: number;
  ruleBehavior: string;
  ruleFormat: string;
  interval: number | null;
  healthCheck: boolean;
}

export interface ManagedHttpProviderOwner {
  configName: string;
  category: "proxy" | "rule";
  name: string;
  declaration?: Record<string, unknown>;
  writable?: boolean;
  originalName?: string;
  originalDeclaration?: Record<string, unknown>;
}

export interface ManagedProviderFile {
  fileName: string;
  referencePath: string;
  category: "proxy" | "rule" | "unknown";
  source: "manual" | "subscription" | "local" | "external";
  writable: boolean;
  sha256: string;
  size: number;
  updatedAt: string;
  filterSettings: ManagedProviderFilterSettings | null;
  extractionId: string | null;
  ownerId?: string | null;
}

export interface LocalProviderExtraction {
  id: string;
  configName: string;
  sourceSha256: string;
  fileName: string;
  providerSha256: string | null;
  nodeCount: number;
  enabled: boolean;
  filterSettings: ManagedProviderFilterSettings;
}

export interface ManagedProviderFileSnapshot extends ManagedProviderFile {
  content: string;
}

export interface ProxyAddresses {
  source?: { name: string; sha256: string; generatedVersion: string; loadVersion: number };
  inline: Record<string, string>;
  providers: Record<string, Record<string, string>>;
  groups: Record<string, ProxyNodeGroup[]>;
  countries: Record<string, ProxyCountry>;
}

export interface ProxyCountry {
  countryCode: string;
  country: string;
  region?: string;
  ip?: string;
  updatedAt: string;
}

export interface ProxyNodeGroup {
  suffix: string;
  members: Array<{ name: string; protocol: string; port: string }>;
}

export interface ProxyNodeIdentity {
  provider: string;
  name: string;
}

export interface ProxyMergeGroup {
  id: string;
  displayName: string;
  source: "manual" | "automatic";
  members: ProxyNodeIdentity[];
}

export interface ProxyMergeSettings {
  schemaVersion: 1;
  version: number;
  groups: ProxyMergeGroup[];
  exclusions: ProxyNodeIdentity[];
}

export interface ProxyNodeRegion extends ProxyNodeIdentity {
  label: string;
}

export interface ProxyNodeSettings {
  schemaVersion: 1;
  version: number;
  regions: ProxyNodeRegion[];
}

async function configRequest(
  path: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  // configd 不接收 Controller 凭据；长操作仅延长内部超时，调用方仍可主动取消。
  const headers = new Headers(options.headers);
  if (options.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await accessFetch(`${CONFIG_BASE}${path}`, { ...options, headers }, timeoutMs);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ConfigError("配置服务暂不可用", 0, "configd_unavailable");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const code = typeof payload.error === "string" ? payload.error : "request_failed";
    throw new ConfigError("配置服务请求失败（" + response.status + "）", response.status, code, payload);
  }
  return response;
}

export async function configApi<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const response = await configRequest(path, options, timeoutMs);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function readConfig(signal?: AbortSignal) {
  return configApi<ConfigSnapshot>("/file", { ...(signal ? { signal } : {}) });
}

export type ManagerOverrides = {
  ipv6?: boolean;
  "allow-lan"?: boolean;
  "tcp-concurrent"?: boolean;
  mode?: "rule" | "global" | "direct";
  "log-level"?: "silent" | "error" | "warning" | "info" | "debug";
  dns?: { enable?: boolean; listen?: string; nameserver?: string[]; ipv6?: boolean; "enhanced-mode"?: "fake-ip" | "redir-host"; "fake-ip-filter"?: string[] };
  tun?: { enable?: boolean; stack?: "system" | "gvisor" | "mixed"; "auto-route"?: boolean; "auto-detect-interface"?: boolean; "dns-hijack"?: string[] };
  "interface-name"?: string;
  sniffer?: { enable?: boolean; "skip-domain"?: string[]; sniff?: { HTTP?: { ports?: (string | number)[] }; TLS?: { ports?: (string | number)[] }; QUIC?: { ports?: (string | number)[] } } };
};

export type DirectDelayTestSettings = { version: number; preset: "huawei" | "xiaomi" | "vivo" | "custom"; url?: string };
export type ManagerSettings = { schemaVersion: 1; version: number; overrides: ManagerOverrides; directDelayTest?: DirectDelayTestSettings };
export type GeneratedRuntime = {
  schemaVersion: 1;
  version: string;
  sourceName: string;
  sourceSha256: string;
  settingsVersion: number;
  contentSha256: string;
  generatedAt: string;
  path: string;
  appliedOverrides?: ManagerOverrides;
  mode?: "rule" | "global" | "direct";
};

export type RuntimeLoadResult = "succeeded" | "failed" | "unknown";
export type RuntimeLoadState = {
  collectionCleanup?: Array<Pick<ProviderCleanupItem, "fileName" | "action" | "reason"> & Partial<ProviderCleanupItem>>;
  schemaVersion: 1;
  version: number;
  lastAttempt: {
    kind?: "mode";
    id: string;
    generated: GeneratedRuntime;
    status: "pending" | RuntimeLoadResult;
    startedAt: string;
    finishedAt: string | null;
  } | null;
  lastSuccessful: { generated: GeneratedRuntime; loadedAt: string; modeUpdatedAt?: string } | null;
};

export function readRuntimeLoadState(signal?: AbortSignal) {
  return configApi<RuntimeLoadState>("/runtime-config/state", { signal });
}

export function prepareRuntimeMode(mode: "rule" | "direct" | "global", expectedSettingsVersion: number, expectedVersion: number) {
  return configApi<{ settings: ManagerSettings; state: RuntimeLoadState }>("/runtime-config/mode-attempt", {
    method: "POST", body: JSON.stringify({ mode, expectedSettingsVersion, expectedVersion }),
  });
}

export function readAppliedRuntime(signal?: AbortSignal) {
  return configApi<{ state: RuntimeLoadState; content: string | null }>("/runtime-config/applied", { signal });
}

export function beginRuntimeLoad(generatedVersion: string, expectedVersion: number) {
  return configApi<RuntimeLoadState>("/runtime-config/load-attempt", {
    method: "POST", body: JSON.stringify({ generatedVersion, expectedVersion }),
  });
}

export function finishRuntimeLoad(attemptId: string, expectedVersion: number, result: RuntimeLoadResult) {
  return configApi<RuntimeLoadState>("/runtime-config/load-result", {
    method: "PUT", body: JSON.stringify({ attemptId, expectedVersion, result }),
  });
}

export function readManagerSettings(signal?: AbortSignal) {
  return configApi<ManagerSettings>("/manager-settings", { signal });
}

export function saveManagerSettings(overrides: ManagerOverrides, expectedVersion: number) {
  return configApi<ManagerSettings>("/manager-settings", {
    method: "PUT", body: JSON.stringify({ overrides, expectedVersion }),
  });
}

export function saveDirectDelayTest(value: Omit<DirectDelayTestSettings, "version">, expectedVersion: number) {
  return configApi<ManagerSettings>("/manager-settings/direct-delay-test", {
    method: "PUT", body: JSON.stringify({ ...value, expectedVersion }),
  });
}

export function generateRuntimeConfig(sourceName: string, expectedSourceSha256: string, expectedSettingsVersion: number) {
  return configApi<GeneratedRuntime>("/runtime-config/generate", {
    method: "POST", body: JSON.stringify({ sourceName, expectedSourceSha256, expectedSettingsVersion }),
  });
}

export function readRuntimeCandidate(signal?: AbortSignal) {
  return configApi<(GeneratedRuntime & { content: string }) | null>("/runtime-config/candidate", { signal });
}

export async function listConfigFiles(signal?: AbortSignal) {
  const result = await configApi<{ files: ConfigFileRecord[] }>(
    "/files",
    { ...(signal ? { signal } : {}) },
  );
  return result.files;
}

export function readConfigFile(name: string, signal?: AbortSignal) {
  return configApi<ConfigSnapshot>(
    `/files/${encodeURIComponent(name)}`,
    { ...(signal ? { signal } : {}) },
  );
}

export function createConfigFile(name: string, content: string) {
  return configApi<ConfigSnapshot>("/files", {
    method: "POST",
    body: JSON.stringify({ name, content }),
  });
}

export function saveConfigFile(name: string, content: string, expectedSha256: string, signal?: AbortSignal) {
  return configApi<ConfigSnapshot>(
    `/files/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      body: JSON.stringify({ content, expectedSha256 }),
      signal,
    },
    LONG_OPERATION_TIMEOUT_MS,
  );
}

export function saveCollectionWorkspace(name: string, input: { content: string; expectedSha256: string;
  bodies: Array<{ category: CollectionCategory; name: string; content: string; expectedSha256: string | null }>;
  removals: Array<{ category: CollectionCategory; name: string }>; httpProviders?: Array<{ category: CollectionCategory; name: string }> }) {
  return configApi<ConfigSnapshot>(`/files/${encodeURIComponent(name)}/collections`, { method: "PUT", body: JSON.stringify(input) }, LONG_OPERATION_TIMEOUT_MS);
}

export function validateCollectionWorkspace(name: string, input: Parameters<typeof saveCollectionWorkspace>[1]) {
  return configApi<{ valid: true }>(`/files/${encodeURIComponent(name)}/collections/validate`, { method: "POST", body: JSON.stringify(input) });
}

export interface ProviderCleanupItem {
  category: CollectionCategory; fileName: string; sha256: string; identity: string;
  action: "delete" | "keep" | "deleted";
  reason: "unused" | "referenced" | "runtime_reference" | "runtime_unknown" | "maintained" | "ownership_unknown" | "unreadable" | "changed" | "deleted" | "delete_failed";
  configNames?: string[];
  configReferences?: ProviderConfigReference[];
  runtime?: ProviderRuntimeReferences;
}
export interface ProviderCleanupResult { files: ProviderCleanupItem[] }

export function previewProviderCleanup(category: CollectionCategory, signal?: AbortSignal) {
  return configApi<ProviderCleanupResult>("/provider-cleanup/preview", { method: "POST", body: JSON.stringify({ category }), signal }, LONG_OPERATION_TIMEOUT_MS);
}
export function previewConfigDelete(name: string, expectedSha256: string, signal?: AbortSignal) {
  return configApi<ProviderCleanupResult>(`/files/${encodeURIComponent(name)}/delete-preview`, { method: "POST", body: JSON.stringify({ expectedSha256 }), signal }, LONG_OPERATION_TIMEOUT_MS);
}
export function cleanupProviderFiles(files: ProviderCleanupItem[], signal?: AbortSignal) {
  return configApi<ProviderCleanupResult>("/provider-cleanup", { method: "POST", body: JSON.stringify({ files }), signal }, LONG_OPERATION_TIMEOUT_MS);
}
export function cleanupSelectedProviderFiles(category: CollectionCategory, files: ProviderCleanupItem[], signal?: AbortSignal) {
  return configApi<ProviderCleanupResult>("/provider-cleanup/selected", { method: "POST", body: JSON.stringify({ category, files }), signal }, LONG_OPERATION_TIMEOUT_MS);
}
export function deleteConfigFile(name: string, expectedSha256: string, cleanupFiles?: ProviderCleanupItem[]) {
  return configApi<{ cleanup: ProviderCleanupResult | null; cleanupFailed?: boolean; extractionCleanupFailed?: boolean } | undefined>(`/files/${encodeURIComponent(name)}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedSha256, cleanupFiles }),
  }, LONG_OPERATION_TIMEOUT_MS);
}

export function renameConfigFile(name: string, nextName: string, expectedSha256: string) {
  return configApi<ConfigSnapshot>(`/files/${encodeURIComponent(name)}/rename`, {
    method: "POST",
    body: JSON.stringify({ name: nextName, expectedSha256 }),
  });
}

export function readProxyAddresses(signal?: AbortSignal) {
  return configApi<ProxyAddresses>(
    "/proxy-addresses",
    { ...(signal ? { signal } : {}) },
  );
}

async function readProviderText(
  resource: "provider-configs" | "provider-files",
  category: "proxy" | "rule",
  name: string,
  signal?: AbortSignal,
  source?: Pick<ConfigSnapshot, "name" | "sha256">,
) {
  const query = source ? `?${new URLSearchParams({ configName: source.name, sha256: source.sha256 })}` : "";
  const response = await configRequest(
    `/${resource}/${category}/${encodeURIComponent(name)}${query}`,
    { ...(signal ? { signal } : {}) },
  );
  return response.text();
}

export function readProviderDeclaration(category: "proxy" | "rule", name: string, signal?: AbortSignal, source?: Pick<ConfigSnapshot, "name" | "sha256">) {
  return readProviderText("provider-configs", category, name, signal, source);
}

export function readProviderPayload(category: "proxy" | "rule", name: string, signal?: AbortSignal, source?: Pick<ConfigSnapshot, "name" | "sha256">) {
  return readProviderText("provider-files", category, name, signal, source);
}

export type CollectionPreferences = { version: number; readOnly: string[] };

export function readCollectionPreferences(signal?: AbortSignal) {
  return configApi<CollectionPreferences>("/collection-preferences", { signal });
}

export function saveCollectionReadOnly(input: { configName: string; category: "proxy" | "rule"; name: string; readOnly: boolean; expectedVersion: number }) {
  return configApi<CollectionPreferences>("/collection-preferences", { method: "PUT", body: JSON.stringify(input) });
}

export function saveCollectionSettings(input: { configName: string; expectedConfigSha256: string;
  category: "proxy" | "rule"; name: string; snippet: string; loaded: boolean; selectedGroups: string[]; expectedFileSha256?: string }) {
  return configApi<{ config: ConfigSnapshot; name: string; retainedSource?: RetainedProviderFile }>("/collection-settings", { method: "PUT", body: JSON.stringify(input) });
}

export async function listManagedProviderFiles(signal?: AbortSignal) {
  const result = await configApi<{ files: ManagedProviderFile[] }>(
    "/managed-providers",
    { ...(signal ? { signal } : {}) },
  );
  return result.files;
}

export function readProviderTemplates(signal?: AbortSignal) {
  return configApi<ProviderTemplateSettings>("/provider-templates", { ...(signal ? { signal } : {}) });
}

export function saveProviderTemplates(settings: ProviderTemplateSettings) {
  return configApi<ProviderTemplateSettings>("/provider-templates", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function listManagedHttpProviders(configName: string, signal?: AbortSignal) {
  const result = await configApi<{ providers: ManagedHttpProviderOwner[] }>(
    `/managed-http-providers?configName=${encodeURIComponent(configName)}`,
    { ...(signal ? { signal } : {}) },
  );
  return result.providers;
}

export function applyManagedHttpProviders(input: {
  configName: string;
  content: string;
  expectedSha256: string;
  providers: Array<{ category: "proxy" | "rule"; name: string }>;
}) {
  return configApi<ConfigSnapshot>("/managed-http-providers/apply", {
    method: "PUT",
    body: JSON.stringify(input),
  }, LONG_OPERATION_TIMEOUT_MS);
}

export async function listLocalProviderExtractions(signal?: AbortSignal) {
  const result = await configApi<{ extractions: LocalProviderExtraction[] }>(
    "/local-provider-extractions",
    { ...(signal ? { signal } : {}) },
  );
  return result.extractions;
}

export function deleteLocalProviderExtraction(relation: LocalProviderExtraction) {
  return configApi<void>(`/local-provider-extractions/${encodeURIComponent(relation.id)}`, {
    method: "DELETE",
    body: JSON.stringify({ configName: relation.configName, sourceSha256: relation.sourceSha256,
      fileName: relation.fileName, filterVersion: relation.filterSettings.version }),
  });
}

export function createLocalProviderExtraction(input: {
  configName: string;
  sourceSha256: string;
  fileName: string;
  enabled?: boolean;
  filterSettings?: { enabled: boolean; rules: string[] };
}) {
  return configApi<{ category: "proxy"; name: string; nodeCount: number }>(
    "/local-provider-extractions",
    { method: "POST", body: JSON.stringify(input) },
    LONG_OPERATION_TIMEOUT_MS,
  );
}

export function previewLocalProviderExtraction(id: string, rules: string[]) {
  return configApi<{ totalCount: number; remainingCount: number; matchedNames: string[] }>(
    `/local-provider-extractions/${encodeURIComponent(id)}/preview`,
    { method: "POST", body: JSON.stringify({ rules }) },
  );
}

export function saveLocalProviderExtractionSettings(
  id: string,
  settings: ManagedProviderFilterSettings,
) {
  return configApi<{
    settings: ManagedProviderFilterSettings;
    provider: { category: "proxy"; name: string; nodeCount: number };
  }>(`/local-provider-extractions/${encodeURIComponent(id)}/filter-settings`, {
    method: "PUT",
    body: JSON.stringify({
      expectedVersion: settings.version,
      enabled: settings.enabled,
      rules: settings.rules,
    }),
  });
}

export function regenerateLocalProviderExtraction(id: string) {
  return configApi<{ category: "proxy"; name: string; nodeCount: number }>(
    `/local-provider-extractions/${encodeURIComponent(id)}/update`,
    { method: "POST" },
    LONG_OPERATION_TIMEOUT_MS,
  );
}

export function setLocalProviderExtractionEnabled(id: string, enabled: boolean) {
  return configApi<LocalProviderExtraction>(
    `/local-provider-extractions/${encodeURIComponent(id)}`,
    { method: "PUT", body: JSON.stringify({ enabled }) },
  );
}

export function renameLocalProviderExtraction(id: string, fileName: string) {
  return configApi<LocalProviderExtraction>(
    `/local-provider-extractions/${encodeURIComponent(id)}/rename`,
    { method: "POST", body: JSON.stringify({ fileName }) },
    LONG_OPERATION_TIMEOUT_MS,
  );
}

export function updateLocalProviderExtraction(input: {
  id: string;
  currentFileName: string;
  fileName: string;
  providerSha256: string | null;
  currentEnabled: boolean;
  enabled: boolean;
  filterSettings: ManagedProviderFilterSettings;
}) {
  return configApi<LocalProviderExtraction>(`/local-provider-extractions/${encodeURIComponent(input.id)}/combined`, {
    method: "PUT",
    body: JSON.stringify(input),
  }, LONG_OPERATION_TIMEOUT_MS);
}

function managedProviderPath(category: "proxy" | "rule", fileName: string) {
  return `/managed-providers/${category}/${encodeURIComponent(fileName)}`;
}

export function readManagedProviderFile(category: "proxy" | "rule", fileName: string, signal?: AbortSignal) {
  return configApi<ManagedProviderFileSnapshot>(managedProviderPath(category, fileName), {
    ...(signal ? { signal } : {}),
  });
}

export function createManagedProviderFile(category: "proxy" | "rule", fileName: string, content?: string) {
  return configApi<ManagedProviderFileSnapshot>("/managed-providers", {
    method: "POST",
    body: JSON.stringify({ category, fileName, content }),
  });
}

export function validateManagedProviderFile(category: "proxy" | "rule", fileName: string, content: string) {
  return configApi<{ valid: true }>(`${managedProviderPath(category, fileName)}/validate`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

export function saveManagedProviderFile(
  category: "proxy" | "rule",
  fileName: string,
  content: string,
  expectedSha256: string,
) {
  return configApi<ManagedProviderFileSnapshot>(managedProviderPath(category, fileName), {
    method: "PUT",
    body: JSON.stringify({ content, expectedSha256 }),
  });
}

export function renameManagedProviderFile(
  category: "proxy" | "rule",
  fileName: string,
  nextFileName: string,
  expectedSha256: string,
) {
  return configApi<ManagedProviderFileSnapshot>(`${managedProviderPath(category, fileName)}/rename`, {
    method: "POST",
    body: JSON.stringify({ fileName: nextFileName, expectedSha256 }),
  });
}

export function renameManagedProviderWithConfig(
  category: "proxy" | "rule",
  fileName: string,
  input: {
    fileName: string;
    expectedSha256: string;
    configName: string;
    configContent: string;
    expectedConfigSha256: string;
  },
) {
  return configApi<{ file: ManagedProviderFileSnapshot; config: ConfigSnapshot }>(
    `${managedProviderPath(category, fileName)}/rename-with-config`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function deleteManagedProviderWithConfig(
  category: "proxy" | "rule",
  fileName: string,
  input: {
    expectedSha256: string;
    configName: string;
    configContent: string;
    expectedConfigSha256: string;
  },
) {
  return configApi<{ config: ConfigSnapshot }>(
    `${managedProviderPath(category, fileName)}/delete-with-config`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function deleteManagedProviderSource(
  fileName: string,
  input: {
    source: "local" | "subscription";
    ownerId: string;
    expectedSha256: string;
    configName: string;
    configContent: string;
    expectedConfigSha256: string;
  },
) {
  return configApi<{ config: ConfigSnapshot }>(
    `${managedProviderPath("proxy", fileName)}/delete-source`,
    { method: "POST", body: JSON.stringify(input) },
    LONG_OPERATION_TIMEOUT_MS,
  );
}

export function deleteManagedProviderFile(category: "proxy" | "rule", fileName: string, expectedSha256: string) {
  return configApi<void>(managedProviderPath(category, fileName), {
    method: "DELETE",
    body: JSON.stringify({ expectedSha256 }),
  });
}

export function saveManagedProviderFilterSettings(
  category: "proxy" | "rule",
  fileName: string,
  settings: ManagedProviderFilterSettings,
) {
  return configApi<{
    settings: ManagedProviderFilterSettings;
    provider: { providerName: string; nodeCount: number };
  }>(`${managedProviderPath(category, fileName)}/filter-settings`, {
    method: "PUT",
    body: JSON.stringify({
      expectedVersion: settings.version,
      enabled: settings.enabled,
      rules: settings.rules,
    }),
  });
}

export function saveManagedProviderFilterSettingsOnly(
  category: "proxy" | "rule",
  fileName: string,
  settings: ManagedProviderFilterSettings,
) {
  return configApi<ManagedProviderFilterSettings>(`${managedProviderPath(category, fileName)}/filter-settings-only`, {
    method: "PUT",
    body: JSON.stringify({
      expectedVersion: settings.version,
      enabled: settings.enabled,
      rules: settings.rules,
    }),
  });
}

export function previewManagedProviderFilter(
  category: "proxy" | "rule",
  fileName: string,
  rules: string[],
  signal?: AbortSignal,
) {
  return configApi<{
    totalCount: number;
    remainingCount: number;
    matchedNames: string[];
  }>(`${managedProviderPath(category, fileName)}/filter-preview`, {
    method: "POST",
    body: JSON.stringify({ rules }),
    ...(signal ? { signal } : {}),
  });
}

export function refreshProxyCountries(signal?: AbortSignal, expectedLoadVersion?: number) {
  return configApi<{ addresses: ProxyAddresses; recognized: number; failed: number }>(
    "/proxy-addresses/countries",
    { method: "POST", body: JSON.stringify({ expectedLoadVersion }), ...(signal ? { signal } : {}) },
    5 * 60_000,
  );
}

export function recognizeProxyNodeCountry(identity: ProxyNodeIdentity, signal?: AbortSignal, expectedLoadVersion?: number) {
  return configApi<ProxyCountry>(
    "/proxy-addresses/country",
    {
      method: "POST",
      body: JSON.stringify({ ...identity, expectedLoadVersion }),
      ...(signal ? { signal } : {}),
    },
    LONG_OPERATION_TIMEOUT_MS,
  );
}

export function readProxyMergeSettings(signal?: AbortSignal) {
  return configApi<ProxyMergeSettings>(
    "/proxy-merge-settings",
    { ...(signal ? { signal } : {}) },
  );
}

export function saveProxyMergeSettings(settings: ProxyMergeSettings) {
  return configApi<ProxyMergeSettings>("/proxy-merge-settings", {
    method: "PUT",
    body: JSON.stringify({
      expectedVersion: settings.version,
      groups: settings.groups,
      exclusions: settings.exclusions,
    }),
  });
}

export function readProxyNodeSettings(signal?: AbortSignal) {
  return configApi<ProxyNodeSettings>(
    "/proxy-node-settings",
    { ...(signal ? { signal } : {}) },
  );
}

export function saveProxyNodeSettings(settings: ProxyNodeSettings) {
  return configApi<ProxyNodeSettings>("/proxy-node-settings", {
    method: "PUT",
    body: JSON.stringify({
      expectedVersion: settings.version,
      regions: settings.regions,
    }),
  });
}

export function saveProxyNodeInfo(input: {
  configName: string;
  content: string;
  expectedSha256: string;
  settingsVersion: number;
  from: ProxyNodeIdentity;
  to: ProxyNodeIdentity;
  region: string | null;
}) {
  return configApi<{ config: ConfigSnapshot; settings: ProxyNodeSettings }>(
    "/proxy-node-settings/rename",
    {
      method: "PUT",
      body: JSON.stringify({
        configName: input.configName,
        content: input.content,
        expectedSha256: input.expectedSha256,
        expectedVersion: input.settingsVersion,
        from: input.from,
        to: input.to,
        region: input.region,
      }),
    },
    LONG_OPERATION_TIMEOUT_MS,
  );
}

export function validateConfig(content: string, signal?: AbortSignal, sourceName?: string) {
  // 候选配置校验可能等待 Mihomo 子进程，需覆盖服务端默认校验时限及网络余量。
  return configApi<{ valid: true }>("/validate", {
    method: "POST",
    body: JSON.stringify({ content, sourceName }),
    ...(signal ? { signal } : {}),
  }, LONG_OPERATION_TIMEOUT_MS);
}

export function saveConfig(content: string, expectedSha256: string) {
  return configApi<{ sha256: string }>(
    "/file",
    {
      method: "PUT",
      body: JSON.stringify({ content, expectedSha256 }),
    },
    LONG_OPERATION_TIMEOUT_MS,
  );
}

export async function listSubscriptions(signal?: AbortSignal) {
  const result = await configApi<{ subscriptions: ConfigSubscription[] }>(
    "/subscriptions",
    { ...(signal ? { signal } : {}) },
  );
  return result.subscriptions;
}

export function createSubscription(input: ConfigSubscriptionInput) {
  return configApi<ConfigSubscription>("/subscriptions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateSubscription(id: string, input: ConfigSubscriptionInput) {
  return configApi<ConfigSubscription>(`/subscriptions/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteSubscription(id: string) {
  return configApi<void>(`/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function updateSubscriptionProvider(id: string) {
  return configApi<{
    providerName: string | null;
    providerPath: string | null;
    providerSha256: string | null;
    nodeCount: number;
    updatedAt: string;
    config: ConfigSnapshot | null;
  }>(
    `/subscriptions/${encodeURIComponent(id)}/update`,
    { method: "POST" },
  );
}

export function saveSubscriptionFilterSettings(id: string, settings: ManagedProviderFilterSettings) {
  return configApi<ManagedProviderFilterSettings>(`/subscriptions/${encodeURIComponent(id)}/filter-settings`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function previewSubscriptionFilter(id: string, rules: string[], signal?: AbortSignal) {
  return configApi<{ totalCount: number; remainingCount: number; matchedNames: string[] }>(
    `/subscriptions/${encodeURIComponent(id)}/filter-preview`,
    { method: "POST", body: JSON.stringify({ rules }), ...(signal ? { signal } : {}) },
    LONG_OPERATION_TIMEOUT_MS,
  );
}

export function beginSubscriptionBinding(id: string) {
  return configApi<ConfigSubscription>(`/subscriptions/${encodeURIComponent(id)}/binding`, {
    method: "POST",
  });
}

export function activateSubscriptionBinding(id: string) {
  return configApi<ConfigSubscription>(`/subscriptions/${encodeURIComponent(id)}/binding`, {
    method: "PUT",
  });
}

export function beginSubscriptionBindingRemoval(id: string) {
  return configApi<ConfigSubscription>(`/subscriptions/${encodeURIComponent(id)}/binding/removal`, {
    method: "POST",
  });
}

export function releaseSubscriptionBinding(id: string) {
  return configApi<ConfigSubscription>(`/subscriptions/${encodeURIComponent(id)}/binding`, {
    method: "DELETE",
  });
}
