// HTTP 层映射 configd 路由与稳定错误码，不转换配置或 Controller 数据。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  ConfigConflictError,
  ConfigSourceInUseError,
  ConfigSourceUsageUnknownError,
  ConfigProviderFilesError,
  ConfigFileExistsError,
  ConfigFileNameError,
  ConfigFileNotFoundError,
  ConfigTooLargeError,
  ConfigValidationError,
  ProviderSourceNotFoundError,
  ProxyMergeSettingsConflictError,
  ProxyMergeSettingsValidationError,
  ProxyNodeInfoTransactionError,
  ProxyNodeSettingsConflictError,
  ProxyNodeSettingsValidationError,
  SubscriptionDownloadError,
  SubscriptionNotFoundError,
  SubscriptionTimeoutError,
  SubscriptionTooLargeError,
  SubscriptionValidationError,
} from "./config/errors.js";
import { ConfigStore } from "./config/store.js";
import { ProxyAddressSourceError, type ProxyAddressReader } from "./config/proxyAddresses.js";
import type { ProxyMergeSettingsService } from "./proxyMergeSettings/service.js";
import {
  ProviderFileConflictError,
  ProviderFileExistsError,
  ProviderFileNameError,
  ProviderFileNotFoundError,
  ProviderFileReadOnlyError,
  ProviderFileReferencedError,
  ProviderRuntimeReferenceError,
  ProviderFileValidationError,
  ProviderFilterConflictError,
} from "./providerFiles/errors.js";
import {
  type ProviderCleanupItem,
  type ProviderFileService,
} from "./providerFiles/service.js";
import type {
  ProxyNodeIdentity,
  ProxyNodeSettingsService,
} from "./proxyNodeSettings/service.js";
import { SubscriptionService } from "./subscriptions/service.js";
import type { SubscriptionInput } from "./subscriptions/types.js";
import { ManagerSettingsConflictError, ManagerSettingsValidationError, type ManagerSettingsService, type ManagerOverrides } from "./managerSettings/service.js";

export interface ConfigdServerOptions {
  store: ConfigStore;
  subscriptions?: SubscriptionService;
  proxyAddresses?: ProxyAddressReader;
  proxyMergeSettings?: ProxyMergeSettingsService;
  proxyNodeSettings?: ProxyNodeSettingsService;
  providerFiles?: ProviderFileService;
  managerSettings?: ManagerSettingsService;
  saveProxyNodeInfo?: (input: {
    configName: string;
    content: string;
    expectedSha256: string;
    expectedVersion: number;
    from: ProxyNodeIdentity;
    to: ProxyNodeIdentity;
    region: string | null;
  }) => Promise<unknown>;
  maxBodyBytes: number;
  allowedOrigin?: string;
}

class RequestError extends Error {}

function cleanupFiles(value: unknown): Pick<ProviderCleanupItem, "category" | "fileName" | "sha256" | "identity">[] {
  if (!Array.isArray(value) || value.length > 512 || value.some((item) => !item ||
    (item.category !== "proxy" && item.category !== "rule") || typeof item.fileName !== "string" ||
    typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) ||
    typeof item.identity !== "string" || !/^[a-f0-9]{64}$/.test(item.identity))) throw new RequestError("invalid cleanup selection");
  return value.map(({ category, fileName, sha256, identity }) => ({ category, fileName, sha256, identity }));
}

function pathId(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RequestError("invalid path id");
  }
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new ConfigTooLargeError("request body too large");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new RequestError("invalid JSON request");
  }
}

function subscriptionInput(body: Record<string, unknown>): SubscriptionInput {
  if (
    typeof body.name !== "string" ||
    (body.url != null && typeof body.url !== "string") ||
    (body.extractProvider != null && typeof body.extractProvider !== "boolean") ||
    (body.providerName != null && typeof body.providerName !== "string") ||
    (body.mergeIntoConfig != null && typeof body.mergeIntoConfig !== "boolean") ||
    (body.configName != null && typeof body.configName !== "string") ||
    (body.groupNames != null && (!Array.isArray(body.groupNames) || body.groupNames.some((name) => typeof name !== "string"))) ||
    typeof body.autoUpdate !== "boolean" ||
    typeof body.intervalMinutes !== "number"
  ) {
    throw new RequestError("invalid subscription request");
  }
  return {
    name: body.name,
    ...(typeof body.url === "string" ? { url: body.url } : {}),
    ...(typeof body.extractProvider === "boolean" ? { extractProvider: body.extractProvider } : {}),
    ...(typeof body.providerName === "string" ? { providerName: body.providerName } : {}),
    ...(body.providerNameMode === "follow" || body.providerNameMode === "custom"
      ? { providerNameMode: body.providerNameMode }
      : {}),
    ...(typeof body.mergeIntoConfig === "boolean" ? { mergeIntoConfig: body.mergeIntoConfig } : {}),
    ...(typeof body.configName === "string" ? { configName: body.configName } : {}),
    ...(Array.isArray(body.groupNames) ? { groupNames: body.groupNames as string[] } : {}),
    autoUpdate: body.autoUpdate,
    intervalMinutes: body.intervalMinutes,
  };
}

export function createConfigdServer(options: ConfigdServerOptions) {
  let changeSequence = 0;
  const changeListeners = new Set<ServerResponse>();
  const emitConfigChange = (
    operation: "create" | "save" | "rename" | "delete" | "subscription-update",
    name: string,
    sha256?: string,
    previousName?: string,
  ) => {
    changeSequence += 1;
    const data = JSON.stringify({ sequence: changeSequence, operation, name, ...(sha256 ? { sha256 } : {}), ...(previousName ? { previousName } : {}) });
    for (const listener of changeListeners) {
      try {
        listener.write(`id: ${changeSequence}\ndata: ${data}\n\n`);
      } catch {
        changeListeners.delete(listener);
      }
    }
  };
  const unsubscribeSubscriptionChanges = options.subscriptions?.subscribeConfigCommits((snapshot) => {
    emitConfigChange("subscription-update", snapshot.name, snapshot.sha256);
  });
  const finalizeConfigSave = async (saved: Awaited<ReturnType<ConfigStore["saveFile"]>>) => {
    emitConfigChange("save", saved.name, saved.sha256);
    return saved;
  };
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    if (options.allowedOrigin) {
      response.setHeader("access-control-allow-origin", options.allowedOrigin);
      response.setHeader("vary", "origin");
    }
    try {
      const url = new URL(request.url ?? "/", "http://configd.local");
      if (request.method === "GET" && url.pathname === "/changes") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          connection: "keep-alive",
          "cache-control": "no-cache, no-transform",
        });
        response.write(`retry: 2000\ndata: ${JSON.stringify({ sequence: changeSequence, operation: "ready" })}\n\n`);
        changeListeners.add(response);
        request.once("close", () => changeListeners.delete(response));
        return;
      }
      if (request.method === "GET" && url.pathname === "/file") {
        return json(response, 200, await (options.providerFiles?.readConfig() ?? options.store.read()));
      }
      if (request.method === "GET" && url.pathname === "/files") {
        const files = await options.store.list();
        return json(response, 200, { files: files.map((file) => {
          const owner = options.subscriptions?.configOwner(file.name) ?? null;
          return { ...file, subscriptionManaged: Boolean(owner), subscriptionId: owner?.id ?? null };
        }) });
      }
      if (request.method === "POST" && url.pathname === "/files") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.name !== "string" || typeof body.content !== "string") {
          throw new RequestError("name and content are required");
        }
        const created = await options.store.create(body.name, body.content);
        emitConfigChange("create", created.name, created.sha256);
        return json(response, 201, created);
      }
      const configFile = url.pathname.match(/^\/files\/([^/]+)$/);
      const deletePreview = url.pathname.match(/^\/files\/([^/]+)\/delete-preview$/);
      if (deletePreview && request.method === "POST" && options.providerFiles) {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.expectedSha256 !== "string") throw new RequestError("expectedSha256 is required");
        return json(response, 200, await options.providerFiles.previewCleanup({ configName: pathId(deletePreview[1]!), expectedConfigSha256: body.expectedSha256 }));
      }
      if (url.pathname === "/provider-cleanup/preview" && request.method === "POST" && options.providerFiles) {
        const body = await readJson(request, options.maxBodyBytes);
        if (body.category !== "proxy" && body.category !== "rule") throw new RequestError("category is required");
        return json(response, 200, await options.providerFiles.previewCleanup({ category: body.category }));
      }
      if (url.pathname === "/provider-cleanup" && request.method === "POST" && options.providerFiles) {
        const body = await readJson(request, options.maxBodyBytes);
        return json(response, 200, await options.providerFiles.cleanup(cleanupFiles(body.files)));
      }
      if (url.pathname === "/provider-cleanup/selected" && request.method === "POST" && options.providerFiles) {
        const body = await readJson(request, options.maxBodyBytes);
        if (body.category !== "proxy" && body.category !== "rule") throw new RequestError("category is required");
        const files = cleanupFiles(body.files);
        if (files.some((file) => file.category !== body.category)) throw new RequestError("cleanup category changed");
        return json(response, 200, await options.providerFiles.cleanup(files, true));
      }
      const configRename = url.pathname.match(/^\/files\/([^/]+)\/rename$/);
      if (configRename && request.method === "POST") {
        const oldName = pathId(configRename[1]!);
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.name !== "string" || typeof body.expectedSha256 !== "string") {
          throw new RequestError("name and expectedSha256 are required");
        }
        if (!/^[a-f0-9]{64}$/i.test(body.expectedSha256)) throw new RequestError("expectedSha256 is invalid");
        const renameSource = () => options.store.renameUnqueued(oldName, body.name as string, body.expectedSha256 as string);
        const renameFile = () => options.providerFiles
          ? options.providerFiles.renameConfigSourceUnqueued(oldName, body.name as string, renameSource) : renameSource();
        const rollbackFile = (snapshot: Awaited<ReturnType<typeof renameFile>>) => (options.providerFiles
          ? options.providerFiles.renameConfigSourceUnqueued(snapshot.name, oldName, () => options.store.renameUnqueued(snapshot.name, oldName, snapshot.sha256))
          : options.store.renameUnqueued(snapshot.name, oldName, snapshot.sha256)).then(() => undefined);
        const renamed = options.subscriptions
          ? await options.subscriptions.renameConfigFile(oldName, body.name, renameFile, rollbackFile)
          : options.providerFiles ? await options.providerFiles.renameConfigSource(oldName, body.name, renameSource)
          : await options.store.rename(oldName, body.name, body.expectedSha256);
        emitConfigChange("rename", renamed.name, renamed.sha256, oldName);
        return json(response, 200, renamed);
      }
      if (configFile && request.method === "GET") {
        const name = pathId(configFile[1]!);
        return json(response, 200, await (options.providerFiles?.readConfig(name) ?? options.store.read(name)));
      }
      if (configFile && request.method === "PUT") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.content !== "string" || typeof body.expectedSha256 !== "string") {
          throw new RequestError("content and expectedSha256 are required");
        }
        if (!/^[a-f0-9]{64}$/i.test(body.expectedSha256)) throw new RequestError("expectedSha256 is invalid");
        const name = pathId(configFile[1]!);
        const saved = await (options.providerFiles?.saveConfig(name, body.content, body.expectedSha256) ??
          options.store.saveFile(name, body.content, body.expectedSha256));
        return json(response, 200, await finalizeConfigSave(saved));
      }
      const collectionWorkspace = url.pathname.match(/^\/files\/([^/]+)\/collections(\/validate)?$/);
      if (collectionWorkspace && (request.method === "PUT" || (request.method === "POST" && collectionWorkspace[2])) && options.providerFiles) {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.content !== "string" || typeof body.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(body.expectedSha256) ||
          !Array.isArray(body.bodies) || !Array.isArray(body.removals) ||
          body.bodies.some((entry) => !entry || !["proxy", "rule"].includes(entry.category) || typeof entry.name !== "string" || typeof entry.content !== "string" ||
            (entry.expectedSha256 !== null && (typeof entry.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.expectedSha256)))) ||
          body.removals.some((entry) => !entry || !["proxy", "rule"].includes(entry.category) || typeof entry.name !== "string")) throw new RequestError("invalid collection workspace");
        if (body.httpProviders !== undefined && (!Array.isArray(body.httpProviders) || body.httpProviders.some((entry) => !entry || !["proxy", "rule"].includes(entry.category) || typeof entry.name !== "string"))) throw new RequestError("invalid HTTP collection catalog");
        if (collectionWorkspace[2]) return json(response, 200, await options.providerFiles.validateCollectionWorkspace(pathId(collectionWorkspace[1]!), body.content, body.bodies));
        return json(response, 200, await finalizeConfigSave(await options.providerFiles.saveCollectionWorkspace({
          configName: pathId(collectionWorkspace[1]!), content: body.content, expectedSha256: body.expectedSha256, bodies: body.bodies, removals: body.removals, httpProviders: body.httpProviders,
        })));
      }
      if (configFile && request.method === "DELETE") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.expectedSha256 !== "string") throw new RequestError("expectedSha256 is required");
        if (!/^[a-f0-9]{64}$/i.test(body.expectedSha256)) throw new RequestError("expectedSha256 is invalid");
        const name = pathId(configFile[1]!);
        let selected: ReturnType<typeof cleanupFiles> | undefined;
        if (body.cleanupFiles !== undefined) {
          if (!options.providerFiles) throw new RequestError("cleanup is unavailable");
          const requested = cleanupFiles(body.cleanupFiles);
          const preview = await options.providerFiles.previewCleanup({ configName: name, expectedConfigSha256: body.expectedSha256 });
          // A config deletion may only clean dependencies shown for that source.
          selected = requested.filter((item) => preview.files.some((file) => file.category === item.category && file.fileName === item.fileName));
        }
        let deleted;
        if (options.subscriptions) {
          deleted = await options.subscriptions.deleteManagedConfigFile(
            name,
            () => options.store.deleteUnqueued(name, body.expectedSha256 as string),
            (snapshot) => options.store.createUnqueued(snapshot.name, snapshot.content),
          );
        } else {
          deleted = await options.store.delete(name, body.expectedSha256);
        }
        emitConfigChange("delete", name, deleted.sha256);
        let extractionCleanupFailed = false;
        for (const relation of options.providerFiles?.localExtractions().filter((entry) =>
          entry.configName === name && !entry.enabled && entry.providerSha256 === null && entry.nodeCount === 0) ?? []) {
          try {
            await options.providerFiles!.deleteLocalExtraction({ ...relation, filterVersion: relation.filterSettings.version });
          } catch { extractionCleanupFailed = true; }
        }
        if (selected) {
          try { return json(response, 200, { cleanup: await options.providerFiles!.cleanup(selected), extractionCleanupFailed }); }
          catch { return json(response, 200, { cleanup: null, cleanupFailed: true, extractionCleanupFailed }); }
        }
        if (extractionCleanupFailed) return json(response, 200, { cleanup: null, extractionCleanupFailed });
        response.writeHead(204);
        return response.end();
      }
      if (options.proxyAddresses && request.method === "GET" && url.pathname === "/proxy-addresses") {
        return json(response, 200, await options.proxyAddresses.read());
      }
      if (options.proxyAddresses && request.method === "POST" && url.pathname === "/proxy-addresses/countries") {
        const body = await readJson(request, options.maxBodyBytes);
        if (!Number.isSafeInteger(body.expectedLoadVersion)) throw new RequestError("source version is required");
        return json(response, 200, await options.proxyAddresses.refreshCountries(body.expectedLoadVersion as number));
      }
      if (options.proxyAddresses && request.method === "POST" && url.pathname === "/proxy-addresses/country") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.provider !== "string" || typeof body.name !== "string" || !body.name.trim() || !Number.isSafeInteger(body.expectedLoadVersion)) {
          throw new RequestError("provider and name are required");
        }
        return json(response, 200, await options.proxyAddresses.recognizeCountry({
          provider: body.provider,
          name: body.name,
        }, body.expectedLoadVersion as number));
      }
      if (options.managerSettings && request.method === "GET" && url.pathname === "/manager-settings") {
        return json(response, 200, await options.managerSettings.read());
      }
      if (options.managerSettings && request.method === "PUT" && url.pathname === "/manager-settings") {
        const body = await readJson(request, options.maxBodyBytes);
        return json(response, 200, await options.managerSettings.save({
          expectedVersion: body.expectedVersion as number,
          overrides: body.overrides as ManagerOverrides,
        }));
      }
      if (options.managerSettings && request.method === "PUT" && url.pathname === "/manager-settings/direct-delay-test") {
        const body = await readJson(request, options.maxBodyBytes);
        return json(response, 200, await options.managerSettings.saveDirectDelayTest({
          expectedVersion: body.expectedVersion as number,
          preset: body.preset as "huawei" | "xiaomi" | "vivo" | "custom",
          ...(body.url === undefined ? {} : { url: body.url as string }),
        }));
      }
      if (options.managerSettings && request.method === "POST" && url.pathname === "/runtime-config/generate") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.sourceName !== "string" || typeof body.expectedSourceSha256 !== "string") {
          throw new RequestError("source identity is required");
        }
        return json(response, 200, await options.managerSettings.generate({
          sourceName: body.sourceName,
          expectedSourceSha256: body.expectedSourceSha256,
          expectedSettingsVersion: body.expectedSettingsVersion as number,
        }, async (name, sha256) => {
          await options.subscriptions?.regenerateProvidersForConfigUnqueued(name, sha256);
          await options.providerFiles?.regenerateLocalExtractionsForConfigUnqueued(name, sha256);
          await options.providerFiles?.validateSourceCollectionsUnqueued(name, sha256);
        }));
      }
      if (options.managerSettings && request.method === "POST" && url.pathname === "/runtime-config/mode-attempt") {
        const body = await readJson(request, options.maxBodyBytes);
        return json(response, 200, await options.managerSettings.prepareMode({
          mode: body.mode as ManagerOverrides["mode"],
          expectedSettingsVersion: body.expectedSettingsVersion as number,
          expectedVersion: body.expectedVersion as number,
        }));
      }
      if (options.managerSettings && request.method === "GET" && url.pathname === "/runtime-config/candidate") {
        return json(response, 200, await options.managerSettings.readCandidate());
      }
      if (options.managerSettings && request.method === "GET" && url.pathname === "/runtime-config/state") {
        return json(response, 200, await options.managerSettings.readLoadState());
      }
      if (options.managerSettings && request.method === "GET" && url.pathname === "/runtime-config/applied") {
        return json(response, 200, await options.managerSettings.readApplied());
      }
      if (options.managerSettings && request.method === "POST" && url.pathname === "/runtime-config/load-attempt") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.generatedVersion !== "string") throw new RequestError("generated version is required");
        return json(response, 200, await options.managerSettings.beginLoad({
          generatedVersion: body.generatedVersion, expectedVersion: body.expectedVersion as number,
        }));
      }
      if (options.managerSettings && request.method === "PUT" && url.pathname === "/runtime-config/load-result") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.attemptId !== "string" || !["succeeded", "failed", "unknown"].includes(body.result as string)) {
          throw new RequestError("invalid load result");
        }
        const state = await options.managerSettings.finishLoad({
          attemptId: body.attemptId, expectedVersion: body.expectedVersion as number,
          result: body.result as "succeeded" | "failed" | "unknown",
        });
        let collectionCleanup;
        if (body.result === "succeeded" && state.lastSuccessful && options.providerFiles) {
          const generated = state.lastSuccessful.generated;
          try {
            collectionCleanup = await options.providerFiles.cleanupAppliedCollections(generated.sourceName, generated.sourceSha256, async () => {
              const current = await options.managerSettings!.readAppliedUnqueued();
              return { content: current.content, uncertain: current.state.version !== state.version || current.state.lastAttempt?.id !== body.attemptId || current.state.lastAttempt?.status !== "succeeded", hasSuccessfulRecord: true };
            });
          } catch { collectionCleanup = [{ fileName: "集合文件", action: "keep", reason: "delete_failed" }]; }
        }
        return json(response, 200, { ...state, ...(collectionCleanup ? { collectionCleanup } : {}) });
      }
      if (options.proxyMergeSettings && request.method === "GET" && url.pathname === "/proxy-merge-settings") {
        return json(response, 200, await options.proxyMergeSettings.read());
      }
      if (options.proxyMergeSettings && request.method === "PUT" && url.pathname === "/proxy-merge-settings") {
        const body = await readJson(request, options.maxBodyBytes);
        return json(response, 200, await options.proxyMergeSettings.save({
          expectedVersion: body.expectedVersion as number,
          groups: body.groups as never,
          exclusions: body.exclusions as never,
        }));
      }
      if (options.proxyNodeSettings && request.method === "GET" && url.pathname === "/proxy-node-settings") {
        return json(response, 200, await options.proxyNodeSettings.read());
      }
      if (options.proxyNodeSettings && request.method === "PUT" && url.pathname === "/proxy-node-settings") {
        const body = await readJson(request, options.maxBodyBytes);
        return json(response, 200, await options.proxyNodeSettings.save({
          expectedVersion: body.expectedVersion as number,
          regions: body.regions as never,
        }));
      }
      if (options.saveProxyNodeInfo && request.method === "PUT" && url.pathname === "/proxy-node-settings/rename") {
        const body = await readJson(request, options.maxBodyBytes);
        if (
          typeof body.configName !== "string"
          || typeof body.content !== "string"
          || typeof body.expectedSha256 !== "string"
          || !/^[a-f0-9]{64}$/i.test(body.expectedSha256)
          || !Number.isSafeInteger(body.expectedVersion)
          || (body.expectedVersion as number) < 0
          || !body.from
          || typeof body.from !== "object"
          || Array.isArray(body.from)
          || !body.to
          || typeof body.to !== "object"
          || Array.isArray(body.to)
          || (body.region !== null && typeof body.region !== "string")
        ) throw new RequestError("invalid proxy node rename request");
        const from = body.from as Record<string, unknown>;
        const to = body.to as Record<string, unknown>;
        if (
          from.provider !== ""
          || to.provider !== ""
          || typeof from.name !== "string"
          || !from.name
          || typeof to.name !== "string"
          || !to.name
        ) {
          throw new RequestError("provider nodes cannot be renamed");
        }
        return json(response, 200, await options.saveProxyNodeInfo({
          configName: body.configName,
          content: body.content,
          expectedSha256: body.expectedSha256,
          expectedVersion: body.expectedVersion as number,
          from: from as ProxyNodeIdentity,
          to: to as ProxyNodeIdentity,
          region: body.region,
        }));
      }
      if (request.method === "POST" && url.pathname === "/validate") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.content !== "string") throw new RequestError("content is required");
        await options.store.validate(body.content, typeof body.sourceName === "string" ? body.sourceName : undefined);
        return json(response, 200, { valid: true });
      }
      if (request.method === "PUT" && url.pathname === "/file") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.content !== "string" || typeof body.expectedSha256 !== "string") {
          throw new RequestError("content and expectedSha256 are required");
        }
        if (!/^[a-f0-9]{64}$/i.test(body.expectedSha256)) throw new RequestError("expectedSha256 is invalid");
        const saved = await options.store.save(body.content, body.expectedSha256);
        emitConfigChange("save", saved.name, saved.sha256);
        return json(response, 200, { sha256: saved.sha256 });
      }
      const providerFiles = options.providerFiles;
      if (providerFiles && request.method === "GET" && url.pathname === "/provider-templates") {
        return json(response, 200, providerFiles.templateSettings());
      }
      if (providerFiles && request.method === "PUT" && url.pathname === "/provider-templates") {
        const body = await readJson(request, options.maxBodyBytes);
        if (!Number.isSafeInteger(body.version) || typeof body.ruleBehavior !== "string" ||
          typeof body.ruleFormat !== "string" || (body.interval !== null && !Number.isSafeInteger(body.interval)) ||
          typeof body.healthCheck !== "boolean") throw new RequestError("invalid provider templates");
        return json(response, 200, await providerFiles.saveTemplateSettings({
          version: body.version as number,
          ruleBehavior: body.ruleBehavior,
          ruleFormat: body.ruleFormat,
          interval: body.interval as number | null,
          healthCheck: body.healthCheck,
        }));
      }
      if (providerFiles && request.method === "GET" && url.pathname === "/managed-http-providers") {
        const configName = url.searchParams.get("configName");
        if (!configName) throw new RequestError("configName is required");
        return json(response, 200, { providers: providerFiles.manualHttpProviders(configName) });
      }
      if (providerFiles && request.method === "PUT" && url.pathname === "/managed-http-providers/apply") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.configName !== "string" || typeof body.content !== "string" || typeof body.expectedSha256 !== "string" ||
          !Array.isArray(body.providers)) throw new RequestError("invalid manual http apply request");
        const saved = await providerFiles.saveConfigWithManualHttp({
          configName: body.configName,
          content: body.content,
          expectedSha256: body.expectedSha256,
          providers: body.providers as Array<{ category: "proxy" | "rule"; name: string }>,
        });
        return json(response, 200, await finalizeConfigSave(saved));
      }
      if (providerFiles && request.method === "GET" && url.pathname === "/local-provider-extractions") {
        return json(response, 200, { extractions: providerFiles.localExtractions() });
      }
      const localExtractionDelete = /^\/local-provider-extractions\/([^/]+)$/.exec(url.pathname);
      if (providerFiles && localExtractionDelete && request.method === "DELETE") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.configName !== "string" || typeof body.sourceSha256 !== "string" ||
          typeof body.fileName !== "string" || !Number.isSafeInteger(body.filterVersion)) {
          throw new RequestError("local extraction identity is required");
        }
        await providerFiles.deleteLocalExtraction({ id: pathId(localExtractionDelete[1]!), configName: body.configName,
          sourceSha256: body.sourceSha256, fileName: body.fileName, filterVersion: body.filterVersion as number });
        response.writeHead(204);
        return response.end();
      }
      if (providerFiles && request.method === "POST" && url.pathname === "/local-provider-extractions") {
        const body = await readJson(request, options.maxBodyBytes);
        if (
          typeof body.configName !== "string" || typeof body.sourceSha256 !== "string" ||
          typeof body.fileName !== "string" ||
          (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
          (body.filterSettings !== undefined && (
            !body.filterSettings || typeof body.filterSettings !== "object" ||
            typeof (body.filterSettings as { enabled?: unknown }).enabled !== "boolean" ||
            !Array.isArray((body.filterSettings as { rules?: unknown }).rules)
          ))
        ) throw new RequestError("configuration identity and provider file name are required");
        return json(response, 201, await providerFiles.createLocalExtraction({
          configName: body.configName,
          sourceSha256: body.sourceSha256,
          fileName: body.fileName,
          ...(body.enabled === undefined ? {} : { enabled: body.enabled as boolean }),
          ...(body.filterSettings === undefined ? {} : {
            filterSettings: body.filterSettings as { enabled: boolean; rules: string[] },
          }),
        }));
      }
      const localExtractionPreview = url.pathname.match(/^\/local-provider-extractions\/([^/]+)\/preview$/);
      const localExtractionSettings = url.pathname.match(/^\/local-provider-extractions\/([^/]+)\/filter-settings$/);
      const localExtractionUpdate = url.pathname.match(/^\/local-provider-extractions\/([^/]+)\/update$/);
      const localExtraction = url.pathname.match(/^\/local-provider-extractions\/([^/]+)$/);
      const localExtractionRename = url.pathname.match(/^\/local-provider-extractions\/([^/]+)\/rename$/);
      const localExtractionCombined = url.pathname.match(/^\/local-provider-extractions\/([^/]+)\/combined$/);
      if (providerFiles && localExtractionCombined && request.method === "PUT") {
        const body = await readJson(request, options.maxBodyBytes);
        const filterSettings = body.filterSettings as {
          version?: unknown;
          enabled?: unknown;
          rules?: unknown;
        };
        if (typeof body.currentFileName !== "string" || typeof body.fileName !== "string" || (body.providerSha256 !== null && typeof body.providerSha256 !== "string") ||
          typeof body.currentEnabled !== "boolean" || typeof body.enabled !== "boolean" || !filterSettings || !Number.isSafeInteger(filterSettings.version) ||
          typeof filterSettings.enabled !== "boolean" || !Array.isArray(filterSettings.rules)) {
          throw new RequestError("invalid local extraction update");
        }
        return json(response, 200, await providerFiles.updateLocalExtraction({
          id: pathId(localExtractionCombined[1]!), currentFileName: body.currentFileName, fileName: body.fileName,
          providerSha256: body.providerSha256, currentEnabled: body.currentEnabled as boolean, enabled: body.enabled as boolean,
          filterSettings: {
            version: filterSettings.version as number,
            enabled: filterSettings.enabled as boolean,
            rules: filterSettings.rules as string[],
          },
        }));
      }
      if (providerFiles && localExtraction && request.method === "PUT") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.enabled !== "boolean") throw new RequestError("enabled is required");
        return json(response, 200, await providerFiles.setLocalExtractionEnabled(
          pathId(localExtraction[1]!),
          body.enabled,
        ));
      }
      if (providerFiles && localExtractionRename && request.method === "POST") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.fileName !== "string") throw new RequestError("fileName is required");
        return json(response, 200, await providerFiles.renameLocalExtraction(
          pathId(localExtractionRename[1]!),
          body.fileName,
        ));
      }
      if (providerFiles && localExtractionUpdate && request.method === "POST") {
        return json(response, 200, await providerFiles.regenerateLocalExtraction(
          pathId(localExtractionUpdate[1]!),
        ));
      }
      if (providerFiles && localExtractionPreview && request.method === "POST") {
        const body = await readJson(request, options.maxBodyBytes);
        if (!Array.isArray(body.rules) || body.rules.some((rule) => typeof rule !== "string")) {
          throw new RequestError("rules are required");
        }
        return json(response, 200, await providerFiles.previewLocalExtraction(
          pathId(localExtractionPreview[1]!),
          body.rules as string[],
        ));
      }
      if (providerFiles && localExtractionSettings && request.method === "PUT") {
        const body = await readJson(request, options.maxBodyBytes);
        if (
          !Number.isSafeInteger(body.expectedVersion) || typeof body.enabled !== "boolean" ||
          !Array.isArray(body.rules) || body.rules.some((rule) => typeof rule !== "string")
        ) throw new RequestError("invalid provider filter settings");
        return json(response, 200, await providerFiles.saveLocalExtractionSettings(
          pathId(localExtractionSettings[1]!),
          {
            expectedVersion: body.expectedVersion as number,
            enabled: body.enabled,
            rules: body.rules as string[],
          },
        ));
      }
      if (providerFiles && url.pathname === "/collection-preferences") {
        if (request.method === "GET") return json(response, 200, providerFiles.collectionPreferences());
        if (request.method === "PUT") {
          const body = await readJson(request, options.maxBodyBytes);
          if (typeof body.configName !== "string" || typeof body.name !== "string" ||
            (body.category !== "proxy" && body.category !== "rule") || typeof body.readOnly !== "boolean" ||
            !Number.isSafeInteger(body.expectedVersion)) throw new RequestError("invalid collection preferences");
          return json(response, 200, await providerFiles.setCollectionReadOnly({ configName: body.configName,
            name: body.name, category: body.category, readOnly: body.readOnly, expectedVersion: body.expectedVersion as number }));
        }
      }
      if (providerFiles && request.method === "PUT" && url.pathname === "/collection-settings") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.configName !== "string" || typeof body.expectedConfigSha256 !== "string" ||
          typeof body.name !== "string" || typeof body.snippet !== "string" || typeof body.loaded !== "boolean" ||
          (body.category !== "proxy" && body.category !== "rule") || !Array.isArray(body.selectedGroups) ||
          body.selectedGroups.some((name) => typeof name !== "string") ||
          (body.expectedFileSha256 !== undefined && typeof body.expectedFileSha256 !== "string")) throw new RequestError("invalid collection settings");
        const result = await providerFiles.saveCollectionSettings({ configName: body.configName,
          expectedConfigSha256: body.expectedConfigSha256, category: body.category, name: body.name,
          snippet: body.snippet, loaded: body.loaded, selectedGroups: body.selectedGroups as string[],
          ...(typeof body.expectedFileSha256 === "string" ? { expectedFileSha256: body.expectedFileSha256 } : {}) });
        return json(response, 200, { ...result, config: await finalizeConfigSave(result.config) });
      }
      if (providerFiles && request.method === "POST" && url.pathname === "/collection-path") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.configName !== "string" || typeof body.expectedConfigSha256 !== "string" ||
          typeof body.name !== "string" || typeof body.fromPath !== "string" || typeof body.toPath !== "string" ||
          typeof body.expectedFileSha256 !== "string" || typeof body.draftContent !== "string" ||
          (body.category !== "proxy" && body.category !== "rule") || (body.action !== "rename" && body.action !== "restore")) {
          throw new RequestError("invalid collection path recovery");
        }
        return json(response, 200, await providerFiles.resolveCollectionPath({ configName: body.configName,
          expectedConfigSha256: body.expectedConfigSha256, category: body.category, name: body.name,
          fromPath: body.fromPath, toPath: body.toPath, expectedFileSha256: body.expectedFileSha256,
          draftContent: body.draftContent, action: body.action }));
      }
      if (providerFiles && request.method === "GET" && url.pathname === "/managed-providers") {
        return json(response, 200, { files: await providerFiles.list() });
      }
      if (providerFiles && request.method === "POST" && url.pathname === "/managed-providers") {
        const body = await readJson(request, options.maxBodyBytes);
        if (
          (body.category !== "proxy" && body.category !== "rule") ||
          typeof body.fileName !== "string" ||
          (body.content !== undefined && typeof body.content !== "string")
        ) throw new RequestError("category and fileName are required");
        return json(response, 201, await providerFiles.create(body.category, body.fileName, body.content));
      }
      if (providerFiles && request.method === "POST" && url.pathname === "/proxy-collections") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.configName !== "string" || typeof body.expectedConfigSha256 !== "string" ||
          typeof body.operationId !== "string" || typeof body.name !== "string" || typeof body.content !== "string" ||
          !Array.isArray(body.groupNames) || body.groupNames.some((name) => typeof name !== "string") ||
          (body.newGroupName !== undefined && typeof body.newGroupName !== "string") ||
          (body.repair !== undefined && typeof body.repair !== "boolean")) throw new RequestError("collection and configuration identities are required");
        const result = await providerFiles.createProxyCollection({
          configName: body.configName, expectedConfigSha256: body.expectedConfigSha256,
          operationId: body.operationId, name: body.name, content: body.content,
          groupNames: body.groupNames as string[],
          ...(typeof body.newGroupName === "string" ? { newGroupName: body.newGroupName } : {}),
          ...(typeof body.repair === "boolean" ? { repair: body.repair } : {}),
        });
        return json(response, 201, { ...result, config: await finalizeConfigSave(result.config) });
      }
      if (providerFiles && request.method === "POST" && url.pathname === "/collection-files/declaration") {
        const body = await readJson(request, options.maxBodyBytes);
        if ((body.category !== "proxy" && body.category !== "rule") || typeof body.configName !== "string" ||
          typeof body.name !== "string" || typeof body.operationId !== "string") throw new RequestError("collection identity is required");
        return json(response, 200, { snippet: providerFiles.collectionUploadDeclaration({
          category: body.category, configName: body.configName, name: body.name, operationId: body.operationId,
        }) });
      }
      if (providerFiles && request.method === "POST" && url.pathname === "/collection-files") {
        const body = await readJson(request, options.maxBodyBytes);
        if ((body.category !== "proxy" && body.category !== "rule") ||
          typeof body.configName !== "string" || typeof body.expectedConfigSha256 !== "string" ||
          typeof body.operationId !== "string" || typeof body.name !== "string" || typeof body.content !== "string" ||
          !Array.isArray(body.groupNames) || body.groupNames.some((name) => typeof name !== "string") ||
          (body.newGroupName !== undefined && typeof body.newGroupName !== "string") ||
          (body.repair !== undefined && typeof body.repair !== "boolean") ||
          (body.ruleSetRules !== undefined && (!Array.isArray(body.ruleSetRules) || body.ruleSetRules.some((rule) => typeof rule !== "string"))) ||
          (body.behavior !== undefined && typeof body.behavior !== "string") ||
          (body.format !== undefined && typeof body.format !== "string") ||
          (body.replace !== undefined && typeof body.replace !== "boolean") ||
          (body.targetFileName !== undefined && typeof body.targetFileName !== "string") ||
          (body.expectedFileSha256 !== undefined && typeof body.expectedFileSha256 !== "string") ||
          (body.snippet !== undefined && typeof body.snippet !== "string")) {
          throw new RequestError("collection and configuration identities are required");
        }
        const result = await providerFiles.createCollection({
          category: body.category as "proxy" | "rule",
          configName: body.configName,
          expectedConfigSha256: body.expectedConfigSha256,
          operationId: body.operationId,
          name: body.name,
          content: body.content,
          groupNames: body.groupNames as string[],
          ...(typeof body.newGroupName === "string" ? { newGroupName: body.newGroupName } : {}),
          ...(typeof body.repair === "boolean" ? { repair: body.repair } : {}),
          ...(Array.isArray(body.ruleSetRules) ? { ruleSetRules: body.ruleSetRules as string[] } : {}),
          ...(typeof body.behavior === "string" ? { behavior: body.behavior } : {}),
          ...(typeof body.format === "string" ? { format: body.format } : {}),
          ...(typeof body.replace === "boolean" ? { replace: body.replace } : {}),
          ...(typeof body.targetFileName === "string" ? { targetFileName: body.targetFileName } : {}),
          ...(typeof body.expectedFileSha256 === "string" ? { expectedFileSha256: body.expectedFileSha256 } : {}),
          ...(typeof body.snippet === "string" ? { snippet: body.snippet } : {}),
        });
        return json(response, 201, { ...result, config: await finalizeConfigSave(result.config) });
      }
      const managedProvider = url.pathname.match(/^\/managed-providers\/(proxy|rule)\/((?:config-[a-f0-9]{24}\/)?[^/]+)$/);
      const managedProviderRename = url.pathname.match(/^\/managed-providers\/(proxy|rule)\/((?:config-[a-f0-9]{24}\/)?[^/]+)\/rename$/);
      const managedProviderRenameWithConfig = url.pathname.match(/^\/managed-providers\/(proxy|rule)\/((?:config-[a-f0-9]{24}\/)?[^/]+)\/rename-with-config$/);
      const managedProviderDeleteWithConfig = url.pathname.match(/^\/managed-providers\/(proxy|rule)\/((?:config-[a-f0-9]{24}\/)?[^/]+)\/delete-with-config$/);
      const managedProviderSourceDelete = url.pathname.match(/^\/managed-providers\/proxy\/((?:config-[a-f0-9]{24}\/)?[^/]+)\/delete-source$/);
      const managedProviderFilters = url.pathname.match(/^\/managed-providers\/(proxy|rule)\/((?:config-[a-f0-9]{24}\/)?[^/]+)\/filter-settings$/);
      const managedProviderFiltersOnly = url.pathname.match(/^\/managed-providers\/(proxy|rule)\/((?:config-[a-f0-9]{24}\/)?[^/]+)\/filter-settings-only$/);
      const managedProviderFilterPreview = url.pathname.match(/^\/managed-providers\/(proxy|rule)\/((?:config-[a-f0-9]{24}\/)?[^/]+)\/filter-preview$/);
      const managedProviderValidate = url.pathname.match(/^\/managed-providers\/(proxy|rule)\/((?:config-[a-f0-9]{24}\/)?[^/]+)\/validate$/);
      if (providerFiles && managedProviderRenameWithConfig && request.method === "POST") {
        const body = await readJson(request, options.maxBodyBytes);
        if (
          typeof body.fileName !== "string" || typeof body.expectedSha256 !== "string" ||
          typeof body.configName !== "string" || typeof body.configContent !== "string" ||
          typeof body.expectedConfigSha256 !== "string"
        ) throw new RequestError("provider and configuration identities are required");
        const result = await providerFiles.renameWithConfig({
          category: managedProviderRenameWithConfig[1] as "proxy" | "rule",
          fileName: pathId(managedProviderRenameWithConfig[2]!),
          nextFileName: body.fileName,
          expectedSha256: body.expectedSha256,
          configName: body.configName,
          configContent: body.configContent,
          expectedConfigSha256: body.expectedConfigSha256,
        });
        return json(response, 200, { ...result, config: await finalizeConfigSave(result.config) });
      }
      if (providerFiles && managedProviderDeleteWithConfig && request.method === "POST") {
        const body = await readJson(request, options.maxBodyBytes);
        if (
          typeof body.expectedSha256 !== "string" || typeof body.configName !== "string" ||
          typeof body.configContent !== "string" || typeof body.expectedConfigSha256 !== "string"
        ) throw new RequestError("provider and configuration identities are required");
        const result = await providerFiles.deleteWithConfig({
          category: managedProviderDeleteWithConfig[1] as "proxy" | "rule",
          fileName: pathId(managedProviderDeleteWithConfig[2]!),
          expectedSha256: body.expectedSha256,
          configName: body.configName,
          configContent: body.configContent,
          expectedConfigSha256: body.expectedConfigSha256,
        });
        return json(response, 200, { ...result, config: await finalizeConfigSave(result.config) });
      }
      if (providerFiles && managedProviderSourceDelete && request.method === "POST") {
        const body = await readJson(request, options.maxBodyBytes);
        if (
          (body.source !== "local" && body.source !== "subscription") || typeof body.ownerId !== "string" ||
          typeof body.expectedSha256 !== "string" || typeof body.configName !== "string" ||
          typeof body.configContent !== "string" || typeof body.expectedConfigSha256 !== "string"
        ) throw new RequestError("provider source and configuration identities are required");
        if (body.source === "subscription" && !options.subscriptions) {
          throw new RequestError("subscription service is unavailable");
        }
        const ownerId = body.ownerId as string;
        const expectedSha256 = body.expectedSha256 as string;
        const result = await providerFiles.deleteOwnedSourceWithConfig({
          source: body.source,
          ownerId,
          fileName: pathId(managedProviderSourceDelete[1]!),
          expectedSha256,
          configName: body.configName,
          configContent: body.configContent,
          expectedConfigSha256: body.expectedConfigSha256,
        }, body.source === "subscription"
          ? () => options.subscriptions!.disableProviderExtractionUnqueued(ownerId, expectedSha256)
          : undefined);
        return json(response, 200, { ...result, config: await finalizeConfigSave(result.config) });
      }
      if (providerFiles && managedProviderRename && request.method === "POST") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.fileName !== "string" || typeof body.expectedSha256 !== "string") {
          throw new RequestError("fileName and expectedSha256 are required");
        }
        return json(response, 200, await providerFiles.rename(
          managedProviderRename[1] as "proxy" | "rule",
          pathId(managedProviderRename[2]!),
          body.fileName,
          body.expectedSha256,
        ));
      }
      if (providerFiles && managedProviderFilters && request.method === "PUT") {
        const body = await readJson(request, options.maxBodyBytes);
        if (
          !Number.isSafeInteger(body.expectedVersion) ||
          typeof body.enabled !== "boolean" ||
          !Array.isArray(body.rules) || body.rules.some((rule) => typeof rule !== "string")
        ) throw new RequestError("invalid provider filter settings");
        if (!options.subscriptions) throw new RequestError("subscription service is unavailable");
        const fileName = pathId(managedProviderFilters[2]!);
        const result = await providerFiles.saveFilterSettingsAndRegenerate(fileName, {
          expectedVersion: body.expectedVersion as number,
          enabled: body.enabled,
          rules: body.rules as string[],
        }, (markCommitted) =>
          options.subscriptions!.regenerateProviderFileUnqueued(fileName, markCommitted));
        return json(response, 200, result);
      }
      if (providerFiles && managedProviderFiltersOnly && request.method === "PUT") {
        const body = await readJson(request, options.maxBodyBytes);
        if (
          !Number.isSafeInteger(body.expectedVersion) || typeof body.enabled !== "boolean" ||
          !Array.isArray(body.rules) || body.rules.some((rule) => typeof rule !== "string")
        ) throw new RequestError("invalid provider filter settings");
        return json(response, 200, await providerFiles.saveFilterSettings(
          pathId(managedProviderFiltersOnly[2]!),
          {
            expectedVersion: body.expectedVersion as number,
            enabled: body.enabled,
            rules: body.rules as string[],
          },
        ));
      }
      if (providerFiles && managedProviderFilterPreview && request.method === "POST") {
        if (!options.subscriptions) throw new RequestError("subscription service is unavailable");
        const body = await readJson(request, options.maxBodyBytes);
        if (!Array.isArray(body.rules) || body.rules.some((rule) => typeof rule !== "string")) {
          throw new RequestError("rules are required");
        }
        const fileName = pathId(managedProviderFilterPreview[2]!);
        const record = await providerFiles.read("proxy", fileName);
        if (record.source !== "subscription") {
          throw new ProviderFileReadOnlyError("filter settings require a subscription provider");
        }
        return json(response, 200, await options.subscriptions.previewProviderFilter(
          fileName,
          body.rules as string[],
        ));
      }
      if (providerFiles && managedProviderValidate && request.method === "POST") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.content !== "string") throw new RequestError("content is required");
        return json(response, 200, providerFiles.validate(
          managedProviderValidate[1] as "proxy" | "rule",
          body.content,
        ));
      }
      if (providerFiles && managedProvider && request.method === "GET") {
        return json(response, 200, await providerFiles.read(
          managedProvider[1] as "proxy" | "rule",
          pathId(managedProvider[2]!),
        ));
      }
      if (providerFiles && managedProvider && request.method === "PUT") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.content !== "string" || typeof body.expectedSha256 !== "string") {
          throw new RequestError("content and expectedSha256 are required");
        }
        return json(response, 200, await providerFiles.save(
          managedProvider[1] as "proxy" | "rule",
          pathId(managedProvider[2]!),
          body.content,
          body.expectedSha256,
        ));
      }
      if (providerFiles && managedProvider && request.method === "DELETE") {
        const body = await readJson(request, options.maxBodyBytes);
        if (typeof body.expectedSha256 !== "string") throw new RequestError("expectedSha256 is required");
        await providerFiles.delete(
          managedProvider[1] as "proxy" | "rule",
          pathId(managedProvider[2]!),
          body.expectedSha256,
        );
        response.writeHead(204);
        return response.end();
      }
      const providerSource = url.pathname.match(/^\/(provider-configs|provider-files)\/(proxy|rule)\/([^/]+)$/);
      if (providerSource && request.method === "GET") {
        const category = providerSource[2] as "proxy" | "rule";
        const name = pathId(providerSource[3]!);
        const configName = url.searchParams.get("configName");
        const expectedSha256 = url.searchParams.get("sha256") ?? undefined;
        if (!configName) throw new RequestError("configuration source is required");
        const content = providerSource[1] === "provider-configs"
          ? await options.store.readProviderDeclaration(category, name, configName, expectedSha256)
          : await options.store.readProviderPayload(category, name, configName, expectedSha256);
        response.writeHead(200, {
          "content-type": "application/yaml; charset=utf-8",
          "content-length": Buffer.byteLength(content),
        });
        return response.end(content);
      }

      const subscriptions = options.subscriptions;
      if (subscriptions && request.method === "GET" && url.pathname === "/subscriptions") {
        return json(response, 200, { subscriptions: subscriptions.list() });
      }
      if (subscriptions && request.method === "POST" && url.pathname === "/subscriptions") {
        const created = await subscriptions.create(subscriptionInput(await readJson(request, options.maxBodyBytes)));
        return json(response, 201, created);
      }
      const match = url.pathname.match(/^\/subscriptions\/([^/]+)$/);
      const subscriptionFilter = url.pathname.match(/^\/subscriptions\/([^/]+)\/filter-settings$/);
      const subscriptionFilterPreview = url.pathname.match(/^\/subscriptions\/([^/]+)\/filter-preview$/);
      if (subscriptions && subscriptionFilter && request.method === "PUT") {
        const body = await readJson(request, options.maxBodyBytes);
        if (!Number.isSafeInteger(body.version) || typeof body.enabled !== "boolean" || !Array.isArray(body.rules) ||
          body.rules.some((rule) => typeof rule !== "string")) throw new RequestError("invalid subscription filter settings");
        return json(response, 200, await subscriptions.saveFilterSettings(pathId(subscriptionFilter[1]!), {
          version: body.version as number, enabled: body.enabled, rules: body.rules as string[],
        }));
      }
      if (subscriptions && subscriptionFilterPreview && request.method === "POST") {
        const body = await readJson(request, options.maxBodyBytes);
        if (!Array.isArray(body.rules) || body.rules.some((rule) => typeof rule !== "string")) throw new RequestError("rules are required");
        return json(response, 200, await subscriptions.previewFilter(pathId(subscriptionFilterPreview[1]!), body.rules as string[]));
      }
      if (subscriptions && match && request.method === "PUT") {
        const updated = await subscriptions.update(
          pathId(match[1]!),
          subscriptionInput(await readJson(request, options.maxBodyBytes)),
        );
        return json(response, 200, updated);
      }
      if (subscriptions && match && request.method === "DELETE") {
        await subscriptions.delete(pathId(match[1]!));
        response.writeHead(204);
        return response.end();
      }
      const updateMatch = url.pathname.match(/^\/subscriptions\/([^/]+)\/update$/);
      if (subscriptions && updateMatch && request.method === "POST") {
        const updated = await subscriptions.updateNow(pathId(updateMatch[1]!));
        return json(response, 200, updated);
      }
      const bindingMatch = url.pathname.match(/^\/subscriptions\/([^/]+)\/binding$/);
      if (subscriptions && bindingMatch && request.method === "POST") {
        return json(response, 200, await subscriptions.beginBinding(pathId(bindingMatch[1]!)));
      }
      if (subscriptions && bindingMatch && request.method === "PUT") {
        return json(response, 200, await subscriptions.activateBinding(pathId(bindingMatch[1]!)));
      }
      if (subscriptions && bindingMatch && request.method === "DELETE") {
        return json(response, 200, await subscriptions.releaseBinding(pathId(bindingMatch[1]!)));
      }
      const bindingRemovalMatch = url.pathname.match(/^\/subscriptions\/([^/]+)\/binding\/removal$/);
      if (subscriptions && bindingRemovalMatch && request.method === "POST") {
        return json(response, 200, await subscriptions.beginBindingRemoval(pathId(bindingRemovalMatch[1]!)));
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof ProxyAddressSourceError) return json(response, 409, { error: "proxy_address_source_unavailable" });
      if (error instanceof ManagerSettingsValidationError) return json(response, 400, { error: "invalid_manager_settings" });
      if (error instanceof ManagerSettingsConflictError) return json(response, 409, { error: "manager_settings_conflict" });
      if (error instanceof RequestError || error instanceof SubscriptionValidationError) {
        return json(response, 400, { error: "invalid_request" });
      }
      if (error instanceof ConfigFileNameError) return json(response, 400, { error: "invalid_config_name" });
      if (error instanceof ConfigFileExistsError) return json(response, 409, { error: "config_exists" });
      if (error instanceof ConfigFileNotFoundError) return json(response, 404, { error: "config_not_found" });
      if (error instanceof ConfigProviderFilesError) return json(response, 422, { error: "provider_files_unavailable", issues: error.issues });
      if (error instanceof ProviderSourceNotFoundError) return json(response, 404, { error: "provider_source_not_found" });
      if (error instanceof ProviderFileNameError) return json(response, 400, { error: "invalid_provider_file_name" });
      if (error instanceof ProviderFileNotFoundError) return json(response, 404, { error: "provider_file_not_found" });
      if (error instanceof ProviderFileExistsError) return json(response, 409, { error: "provider_file_exists" });
      if (error instanceof ProviderFileConflictError) return json(response, 409, { error: "provider_file_conflict" });
      if (error instanceof ProviderFilterConflictError) return json(response, 409, { error: "provider_filter_conflict" });
      if (error instanceof ProviderFileReadOnlyError) return json(response, 403, { error: "provider_file_read_only" });
      if (error instanceof ProviderFileReferencedError) {
        return json(response, 409, { error: "provider_file_referenced", configNames: error.configNames });
      }
      if (error instanceof ProviderRuntimeReferenceError) return json(response, 409, { error: error.reason });
      if (error instanceof ProviderFileValidationError) return json(response, 422, { error: "invalid_provider_file" });
      if (error instanceof SubscriptionNotFoundError) return json(response, 404, { error: "subscription_not_found" });
      if (error instanceof ConfigSourceInUseError) return json(response, 409, { error: "config_source_in_use" });
      if (error instanceof ConfigSourceUsageUnknownError) return json(response, 409, { error: "config_source_usage_unknown" });
      if (error instanceof ConfigConflictError) return json(response, 409, { error: "config_conflict" });
      if (error instanceof ProxyMergeSettingsConflictError) return json(response, 409, { error: "proxy_merge_settings_conflict" });
      if (error instanceof ProxyMergeSettingsValidationError) return json(response, 400, { error: "invalid_proxy_merge_settings" });
      if (error instanceof ProxyNodeSettingsConflictError) return json(response, 409, { error: "proxy_node_settings_conflict" });
      if (error instanceof ProxyNodeSettingsValidationError) return json(response, 400, { error: "invalid_proxy_node_settings" });
      if (error instanceof ProxyNodeInfoTransactionError) return json(response, 500, { error: "proxy_node_info_transaction_failed" });
      if (error instanceof ConfigTooLargeError || error instanceof SubscriptionTooLargeError) {
        return json(response, 413, { error: error instanceof ConfigTooLargeError ? "content_too_large" : "subscription_too_large" });
      }
      if (error instanceof ConfigValidationError) return json(response, 422, { error: "validation_failed", diagnostics: error.diagnostics });
      if (error instanceof SubscriptionTimeoutError) return json(response, 504, { error: "subscription_timeout" });
      if (error instanceof SubscriptionDownloadError) return json(response, 422, { error: "subscription_update_failed" });
      return json(response, 500, { error: "config_operation_failed" });
    }
  });
  server.once("close", () => unsubscribeSubscriptionChanges?.());
  return server;
}
