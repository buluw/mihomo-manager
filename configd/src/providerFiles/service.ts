import { deleteLocalExtraction, setLocalExtractionEnabled, renameLocalExtraction, updateLocalExtraction, previewLocalExtraction, saveLocalExtractionSettings, createLocalExtraction, regenerateLocalExtraction, regenerateLocalExtractionsForConfig, type LocalExtractionContext } from "./localExtractions.js";
import type { LocalExtractionDeleteInput, LocalExtractionUpdateInput, LocalExtractionFilterInput, LocalExtractionCreateInput } from "./types.js";
import type { ProviderRuntimeDependencies, ProviderRuntimeReferences } from "./types.js";
import { saveConfigWithManualHttp, recoverHttpConfigIntent, rememberHttpCachePaths, parseHttpCollections, type HttpCollectionContext } from "./httpCollections.js";
import type { ManagedHttpProviderRecord, ProviderHttpConfigIntent, SaveManualHttpConfigInput } from "./types.js";
export type { ManagedHttpProviderRecord } from "./types.js";
import { publishProvider, recoverPublish, publishOwner, type ProviderPublishContext } from "./publishOperation.js";
import { reservesProviderIdentity, manualEntries, subscriptionReservations, localReservations, assertRenameTargetAvailable } from "./ownership.js";
import { renameProviderFile, recoverRename, renameStateCommitted, type ProviderRenameContext } from "./renameOperation.js";
import { createProviderFile, recoverCreate } from "./createOperation.js";
import { deleteProviderFile, recoverDelete } from "./deleteOperation.js";
import type { ProviderFileRecord, LocalProviderExtraction, ProviderFilterSettings, RetainedProviderFile, SubscriptionProviderIdentity, SubscriptionProviderPublish } from "./types.js";
export type { ProviderFileSource, ProviderFileRecord, LocalProviderExtraction, ProviderFilterSettings, RetainedProviderFile, SubscriptionProviderIdentity, SubscriptionProviderPublish } from "./types.js";
import { parseLegacyRenameJournal, parseOperationJournal, type ProviderOperationContext, type ProviderOperationJournal, type ProviderRenameJournal } from "./operationJournal.js";
import { randomBytes } from "node:crypto";
import { chmod, chown, link, lstat, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMap, isSeq, parse, parseDocument, stringify } from "yaml";
import type { ConfigSnapshot, ConfigStore } from "../config/store.js";
import { ConfigConflictError, ConfigProviderFilesError, ConfigValidationError } from "../config/errors.js";
import { saveWorkspace, recoverWorkspace, parseWorkspaceJournal, type WorkspaceJournal, type WorkspaceOperationContext, type CollectionBodyDraft, type CollectionRemoval, type PendingCollectionRemoval } from "./workspaceOperation.js";
import { resolveCollectionPaths, mappedCollectionContent, controlledPathStatus } from "./collectionPaths.js";
import { collectionScope, COLLECTION_SCOPE, validProviderKey, providerFileKeys, ensureProviderParent } from "./controlledFiles.js";
import type { PublicSubscription } from "../subscriptions/types.js";
import { WriteQueue } from "../writeQueue.js";
import { validateProviderFilterRules } from "./extraction.js";
import { hash, FILE_NAME_PATTERN, providerFilePath, hiddenProviderPath, hiddenFileName, isWithin, providerFileNameKey, ensureProviderDirectoryControlled, readControlledFile, readControlledIdentity, readStableFile, sameFileIdentity } from "./controlledFiles.js";
import { type ProviderCategory, type CollectionSettingsInput, type CollectionPathChange, recordValue, extractProvider, collectionDeclarations, pathChangeMatches, inferCategory, assertContent, applyCollectionDeclaration } from "./collectionYaml.js";
import {
  type ConfigReferenceSource,
  readConfigReferenceSource,
  configReferencesLexicalPath,
  configReferencesFile,
  runtimeReferences,
  assertReferencesUnreferenced,
} from "./references.js";
import {
  type ProviderConfigReference,
  ProviderFileNameError,
  ProviderFileNotFoundError,
  ProviderFileExistsError,
  ProviderFileReadOnlyError,
  ProviderFileConflictError,
  ProviderFileValidationError,
  ProviderFilterConflictError,
  ProviderFileReferencedError,
  ProviderFileRecoveryError,
  ProviderRuntimeReferenceError,
} from "./errors.js";

export interface ProxyCollectionCreateInput {
  configName: string;
  expectedConfigSha256: string;
  operationId: string;
  name: string;
  content: string;
  groupNames: string[];
  newGroupName?: string;
  repair?: boolean;
  category?: ProviderCategory;
  ruleSetRules?: string[];
  behavior?: string;
  format?: string;
  replace?: boolean;
  targetFileName?: string;
  expectedFileSha256?: string;
  snippet?: string;
}

export type CleanupReason = "unused" | "referenced" | "runtime_reference" | "runtime_unknown" | "maintained" | "ownership_unknown" | "unreadable" | "changed" | "deleted" | "delete_failed";
export interface ProviderCleanupItem {
  category: ProviderCategory;
  fileName: string;
  sha256: string;
  identity: string;
  action: "delete" | "keep" | "deleted";
  reason: CleanupReason;
  configNames?: string[];
  configReferences?: ProviderConfigReference[];
  runtime?: ProviderRuntimeReferences;
}

export type ProviderTemplateSettings = {
  version: number;
  ruleBehavior: string;
  ruleFormat: string;
  interval: number | null;
  healthCheck: boolean;
};

export type CollectionPreferences = { version: number; readOnly: string[] };
export const collectionPreferenceKey = (configName: string, category: ProviderCategory, name: string) =>
  JSON.stringify([configName, category, name]);

const DEFAULT_PROVIDER_TEMPLATES: ProviderTemplateSettings = {
  version: 0,
  ruleBehavior: "classical",
  ruleFormat: "yaml",
  interval: null,
  healthCheck: false,
};

type ProviderFileState = {
  version: 1;
  manual: Array<{ fileName: string; category: ProviderCategory }>;
  filters: Record<string, ProviderFilterSettings>;
  local: LocalProviderExtraction[];
  templates?: ProviderTemplateSettings;
  manualHttp?: ManagedHttpProviderRecord[];
  collectionPreferences?: CollectionPreferences | undefined;
  httpCachePaths?: string[];
  collectionPathChanges?: CollectionPathChange[] | undefined;
  sourceDirectories?: Record<string, string>;
  pathMappingVersion?: 1;
  legacyPaths?: Record<string, string[]>;
  workspaceJournal?: WorkspaceJournal | null;
  pendingRemovals?: PendingCollectionRemoval[] | undefined;
  httpConfigIntent?: ProviderHttpConfigIntent;
  operationJournal?: ProviderOperationJournal | null;
  renameJournal?: ProviderRenameJournal | null;
};

export interface ProviderFileServiceOptions {
  providerDir: string;
  ruleProviderDir?: string;
  statePath: string;
  dataDir: string;
  maxContentBytes: number;
  writeQueue?: WriteQueue;
  store: Pick<ConfigStore, "list" | "read" | "saveFileUnqueued" | "restoreFileUnqueued"> & Partial<Pick<ConfigStore, "resolveProviderPaths" | "mapProviderContent">>;
  subscriptions?: () => PublicSubscription[];
  clearSubscriptionProviderUnqueued?: (identity: SubscriptionProviderIdentity) => Promise<void>;
  readRuntimeDependencies?: () => Promise<ProviderRuntimeDependencies>;
  beforeFileRename?: () => Promise<void>;
  beforeStateRename?: () => Promise<void>;
  beforeRenameCleanup?: (phase: "rollback-target" | "commit-source") => Promise<void>;
  afterRenamePhase?: (phase: ProviderRenameJournal["phase"]) => Promise<void>;
  beforeOperationCleanup?: (operation: ProviderOperationJournal["operation"], phase: string) => Promise<void>;
  afterOperationPhase?: (operation: ProviderOperationJournal["operation"], phase: string) => Promise<void>;
  afterProviderFilePublish?: () => Promise<void>;
  afterCaseAliasRemoval?: () => Promise<void>;
  beforeOwnedSourceFileDelete?: () => Promise<void>;
}

export interface SubscriptionProviderReservation {
  subscriptionId: string | null;
  fileName: string;
}

export interface SubscriptionProviderRename extends SubscriptionProviderIdentity {
  nextFileName: string;
}

function filterKey(sourceId: string) {
  return `subscription:${sourceId}`;
}

export class ProviderFileService {
  private readonly writeQueue: WriteQueue;
  private state: ProviderFileState = { version: 1, manual: [], filters: {}, local: [], templates: DEFAULT_PROVIDER_TEMPLATES, manualHttp: [] };
  private initialized = false;
  private cleanupRuntime: ProviderRuntimeDependencies | undefined;

  constructor(readonly options: ProviderFileServiceOptions) {
    this.writeQueue = options.writeQueue ?? new WriteQueue();
    options.store.resolveProviderPaths = (name, content) => this.resolvePaths(name, content);
  }

  private async resolvePaths(name: string, content: string) {
    const paths = await resolveCollectionPaths(this.options, name, content, this.state.sourceDirectories?.[name] ?? collectionScope(name),
      this.state.pathMappingVersion ? new Set(this.state.legacyPaths?.[name] ?? []) : undefined, Object.hasOwn(this.state.legacyPaths ?? {}, name));
    for (const item of paths) {
      const originalKey = this.collectionFileName(item.sourcePath, item.category);
      if (!originalKey || item.status === "outside_scope" || item.status === "unreadable") continue;
      const originalPath = this.pathForName(originalKey, item.category);
      const maintained = (this.state.httpCachePaths ?? []).includes(originalPath) || (item.category === "proxy" &&
        (subscriptionReservations(this.options.subscriptions?.() ?? [], originalKey).length || localReservations(this.state.local, originalKey).length));
      if (!maintained) continue;
      item.fileName = originalKey;
      item.referencePath = `./${relative(this.options.dataDir, originalPath).split(sep).join("/")}`;
      item.status = await controlledPathStatus(this.directoryFor(item.category), originalPath);
      item.writable = false;
    }
    return paths;
  }

  async init() {
    this.initialized = false;
    await ensureProviderDirectoryControlled(this.options.dataDir, this.options.providerDir, this.options.ruleProviderDir);
    try {
      const value = JSON.parse(await readFile(this.options.statePath, "utf8")) as Partial<ProviderFileState>;
      if (value.version !== 1 || !Array.isArray(value.manual) || !recordValue(value.filters)) throw new Error();
      const manual = value.manual.filter((entry): entry is { fileName: string; category: ProviderCategory } =>
        Boolean(entry) && typeof entry.fileName === "string" &&
        (entry.category === "proxy" || entry.category === "rule") &&
        validProviderKey(entry.fileName));
      const filters: Record<string, ProviderFilterSettings> = {};
      for (const [key, raw] of Object.entries(value.filters ?? {})) {
        const setting = recordValue(raw);
        if (
          !setting || !Number.isSafeInteger(setting.version) || (setting.version as number) < 0 ||
          typeof setting.enabled !== "boolean" || !Array.isArray(setting.rules) ||
          setting.rules.some((rule) => typeof rule !== "string")
        ) continue;
        filters[key] = {
          version: setting.version as number,
          enabled: setting.enabled,
          rules: setting.rules as string[],
        };
      }
      const operationJournal = value.operationJournal
        ? parseOperationJournal(value.operationJournal)
        : parseLegacyRenameJournal(value.renameJournal);
      const local = Array.isArray(value.local) ? value.local.filter((entry) =>
        Boolean(entry) && typeof entry.id === "string" && typeof entry.configName === "string" &&
        typeof entry.sourceSha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sourceSha256) &&
        typeof entry.fileName === "string" && FILE_NAME_PATTERN.test(entry.fileName) &&
        (entry.providerSha256 === null ||
          (typeof entry.providerSha256 === "string" && /^[a-f0-9]{64}$/.test(entry.providerSha256))) &&
        Number.isSafeInteger(entry.nodeCount) && entry.nodeCount >= 0 &&
        Boolean(entry.filterSettings) && Number.isSafeInteger(entry.filterSettings.version) &&
        entry.filterSettings.version >= 0 && typeof entry.filterSettings.enabled === "boolean" &&
        Array.isArray(entry.filterSettings.rules) &&
        entry.filterSettings.rules.every((rule) => typeof rule === "string")).map((entry) => ({
          ...entry,
          enabled: typeof (entry as Partial<LocalProviderExtraction>).enabled === "boolean"
            ? (entry as LocalProviderExtraction).enabled
            : true,
        })) : [];
      const templateValue = recordValue(value.templates);
      const templates = templateValue && Number.isSafeInteger(templateValue.version) && (templateValue.version as number) >= 0 &&
        typeof templateValue.ruleBehavior === "string" && Boolean(templateValue.ruleBehavior) &&
        typeof templateValue.ruleFormat === "string" && Boolean(templateValue.ruleFormat) &&
        (templateValue.interval === null || (Number.isSafeInteger(templateValue.interval) && (templateValue.interval as number) > 0)) &&
        typeof templateValue.healthCheck === "boolean"
        ? templateValue as ProviderTemplateSettings
        : DEFAULT_PROVIDER_TEMPLATES;
      const { manualHttp, httpConfigIntent } = parseHttpCollections(value);
      const preferences = value.collectionPreferences;
      if (preferences && (!Number.isSafeInteger(preferences.version) || preferences.version < 0 ||
        !Array.isArray(preferences.readOnly) || preferences.readOnly.some((key) => typeof key !== "string"))) throw new Error();
      this.state = { version: 1, manual, filters, local, templates, manualHttp, httpConfigIntent, operationJournal,
        sourceDirectories: Object.fromEntries(Object.entries(value.sourceDirectories ?? {}).filter(([, scope]) => typeof scope === "string" && COLLECTION_SCOPE.test(scope))),
        ...(value.pathMappingVersion === 1 ? { pathMappingVersion: 1 as const } : {}),
        legacyPaths: Object.fromEntries(Object.entries(value.legacyPaths ?? {}).filter(([, paths]) => Array.isArray(paths) && paths.every((path) => typeof path === "string"))),
        workspaceJournal: parseWorkspaceJournal(value.workspaceJournal),
        pendingRemovals: Array.isArray(value.pendingRemovals) ? value.pendingRemovals : [],
        collectionPreferences: preferences ?? { version: 0, readOnly: [] },
        httpCachePaths: Array.isArray(value.httpCachePaths) ? value.httpCachePaths.filter((path) => typeof path === "string") : [],
        collectionPathChanges: Array.isArray(value.collectionPathChanges) ? value.collectionPathChanges.filter((entry) =>
          entry && typeof entry.configName === "string" && typeof entry.name === "string" &&
          (entry.category === "proxy" || entry.category === "rule") &&
          typeof entry.fromPath === "string" && typeof entry.toPath === "string" &&
          [entry.beforeConfigSha256, entry.configSha256, entry.fileSha256].every((sha) => typeof sha === "string" && /^[a-f0-9]{64}$/.test(sha)) &&
          typeof entry.device === "string" && /^\d+$/.test(entry.device) && typeof entry.inode === "string" && /^[1-9]\d*$/.test(entry.inode)) : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("provider file state is invalid");
      }
    }
    await recoverHttpConfigIntent(this.httpContext());
    await this.recoverProviderOperationSafely();
    await recoverWorkspace(this.workspaceContext());
    if (!this.state.pathMappingVersion) {
      const legacyPaths: Record<string, string[]> = {};
      for (const config of await this.options.store.list()) {
        legacyPaths[config.name] = [];
        const source = await this.options.store.read(config.name);
        const document = parseDocument(source.content);
        if (document.errors.length) continue;
        let root; try { root = recordValue(document.toJS()); } catch { continue; }
        for (const category of ["proxy", "rule"] as const) for (const value of Object.values(recordValue(root?.[`${category}-providers`]) ?? {})) {
          const declaration = recordValue(value);
          const key = declaration?.type === "file" ? this.collectionFileName(declaration.path, category) : null;
          if (!key) continue;
          const path = this.pathForName(key, category);
          if (!await controlledPathStatus(this.directoryFor(category), path)) (legacyPaths[source.name] ??= []).push(path);
        }
      }
      const next = { ...this.state, pathMappingVersion: 1 as const, legacyPaths };
      await this.writeState(next, false); this.state = next;
    }
    this.initialized = true;
  }

  list(): Promise<ProviderFileRecord[]> {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      return this.listUnqueued();
    });
  }

  read(categoryOrFileName: ProviderCategory | string, requestedFileName?: string) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      const fileName = requestedFileName ?? categoryOrFileName;
      const category = requestedFileName
        ? categoryOrFileName as ProviderCategory
        : this.state.manual.find((entry) => providerFileNameKey(entry.fileName) === providerFileNameKey(fileName))?.category ?? "proxy";
      return this.readSnapshotUnqueued(fileName, category);
    });
  }

  private async listUnqueued(): Promise<ProviderFileRecord[]> {
    const references = await rememberHttpCachePaths(this.httpContext());
    const records: ProviderFileRecord[] = [];
    for (const category of ["proxy", "rule"] as const) {
      for (const fileName of await providerFileKeys(this.directoryFor(category))) {
        try {
          records.push(await this.record(fileName, category, references));
        } catch (error) {
          if (!(error instanceof ProviderFileNotFoundError)) throw error;
        }
      }
    }
    return records.sort((left, right) => left.category.localeCompare(right.category) || left.fileName.localeCompare(right.fileName, "en"));
  }

  async ensureProviderOperationRecovered() {
    if (!this.initialized) throw new ProviderFileRecoveryError("provider operation recovery is incomplete");
    await ensureProviderDirectoryControlled(this.options.dataDir, this.options.providerDir, this.options.ruleProviderDir);
    if (this.state.workspaceJournal) await recoverWorkspace(this.workspaceContext());
    if (this.state.httpConfigIntent) await recoverHttpConfigIntent(this.httpContext());
    if (!this.state.operationJournal) return;
    await this.recoverProviderOperationSafely();
  }

  async assertSubscriptionPublish(identity: SubscriptionProviderIdentity) {
    await this.ensureProviderOperationRecovered();
    const owner = this.assertSubscriptionReservation(identity);
    if (owner.providerSha256 !== identity.expectedSha256) {
      throw new ProviderFileConflictError("subscription provider ownership changed");
    }
    const path = this.pathForName(identity.fileName);
    const authorityPath = this.pathForName(`${owner.providerName}.yaml`);
    if (manualEntries(this.state.manual, identity.fileName).length > 0 || localReservations(this.state.local, identity.fileName).length > 0) {
      throw new ProviderFileReadOnlyError("subscription provider ownership is unavailable");
    }
    const reservations = subscriptionReservations(this.options.subscriptions?.() ?? [], identity.fileName);
    if (reservations.length !== 1 || reservations[0]?.id !== owner.id) {
      throw new ProviderFileReadOnlyError("subscription provider ownership is unavailable");
    }
    const existing = await readControlledFile(path, this.options.maxContentBytes);
    const authority = await readControlledFile(authorityPath, this.options.maxContentBytes);
    if (!identity.expectedSha256) {
      if (existing || authority) throw new ProviderFileReadOnlyError("subscription provider ownership is unavailable");
      return;
    }
    if (!existing || !authority || !sameFileIdentity(existing, authority)) {
      throw new ProviderFileConflictError("subscription provider ownership changed");
    }
    if (existing.sha256 !== identity.expectedSha256) {
      throw new ProviderFileConflictError("subscription provider file changed");
    }
  }

  async assertSubscriptionReservationAvailable(input: SubscriptionProviderReservation) {
    await this.ensureProviderOperationRecovered();
    const path = this.pathForName(input.fileName);
    if (manualEntries(this.state.manual, input.fileName).length > 0 || localReservations(this.state.local, input.fileName).length > 0) {
      throw new ProviderFileExistsError("provider file name is unavailable");
    }
    const reservations = subscriptionReservations(this.options.subscriptions?.() ?? [], input.fileName);
    if (reservations.some((item) => item.id !== input.subscriptionId)) {
      throw new ProviderFileExistsError("provider file name is unavailable");
    }
    const existingReservation = reservations.find((item) => item.id === input.subscriptionId);
    if (existingReservation?.providerSha256) {
      const existing = await readControlledFile(path, this.options.maxContentBytes);
      const authority = await readControlledFile(
        this.pathForName(`${existingReservation.providerName}.yaml`),
       this.options.maxContentBytes);
      if (
        !existing || !authority || !sameFileIdentity(existing, authority) ||
        existing.sha256 !== existingReservation.providerSha256
      ) {
        throw new ProviderFileConflictError("subscription provider ownership changed");
      }
      return;
    }
    try {
      await lstat(path);
      throw new ProviderFileExistsError("provider file name is unavailable");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async renameSubscriptionProvider(
    input: SubscriptionProviderRename,
    commitState: () => Promise<void>,
  ) {
    await this.ensureProviderOperationRecovered();
    const owner = this.assertSubscriptionReservation(input, false);
    if (owner.providerSha256 !== input.expectedSha256) {
      throw new ProviderFileConflictError("subscription provider ownership changed");
    }
    const sourceReservations = subscriptionReservations(this.options.subscriptions?.() ?? [], input.fileName);
    if (
      manualEntries(this.state.manual, input.fileName).length > 0 || sourceReservations.length !== 1 ||
      sourceReservations[0]?.id !== input.subscriptionId
    ) throw new ProviderFileReadOnlyError("subscription provider ownership is unavailable");
    await this.assertUnreferenced(input.fileName);
    await assertRenameTargetAvailable(this.renameContext("proxy"), input.subscriptionId, input.nextFileName, input.fileName);
    if (!input.expectedSha256) {
      const source = await readControlledFile(this.pathForName(input.fileName), this.options.maxContentBytes);
      if (source) throw new ProviderFileReadOnlyError("subscription provider ownership is unavailable");
      await commitState();
      return;
    }
    const source = await readControlledFile(this.pathForName(input.fileName), this.options.maxContentBytes);
    const authority = await readControlledFile(this.pathForName(`${owner.providerName}.yaml`), this.options.maxContentBytes);
    if (
      !source || !authority || !sameFileIdentity(source, authority) ||
      source.sha256 !== input.expectedSha256
    ) {
      throw new ProviderFileConflictError("subscription provider file changed");
    }
    await renameProviderFile(this.renameContext("proxy"), {
      kind: "subscription",
      subscriptionId: input.subscriptionId,
      sourceFileName: input.fileName,
      targetFileName: input.nextFileName,
      sha256: input.expectedSha256,
    }, commitState);
  }

  async publishSubscriptionProvider(
    input: SubscriptionProviderPublish,
    commitState: (sha256: string) => Promise<void>,
  ) {
    await this.ensureProviderOperationRecovered();
    assertContent("proxy", input.content, this.options.maxContentBytes);
    await this.assertSubscriptionPublish(input);
    return publishProvider(this.publishContext(), input, commitState, "subscription");
  }

  localExtractions() {
    return this.state.local.map((entry) => ({ ...entry, filterSettings: { ...entry.filterSettings } }));
  }

  templateSettings() {
    return { ...(this.state.templates ?? DEFAULT_PROVIDER_TEMPLATES) };
  }

  manualHttpProviders(configName: string) {
    return (this.state.manualHttp ?? []).filter((entry) => entry.configName === configName)
      .map((entry) => ({ ...entry, ...(entry.declaration ? { declaration: structuredClone(entry.declaration) } : {}) }));
  }

  saveConfigWithManualHttp(input: SaveManualHttpConfigInput) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      return saveConfigWithManualHttp(this.httpContext(), input);
    });
  }

  saveTemplateSettings(input: ProviderTemplateSettings) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      const current = this.templateSettings();
      if (input.version !== current.version) throw new ProviderFileConflictError("provider templates changed");
      if (!input.ruleBehavior.trim() || !input.ruleFormat.trim() ||
        (input.interval !== null && (!Number.isSafeInteger(input.interval) || input.interval <= 0))) {
        throw new ProviderFileValidationError("provider templates are invalid");
      }
      const templates = {
        version: current.version + 1,
        ruleBehavior: input.ruleBehavior.trim(),
        ruleFormat: input.ruleFormat.trim(),
        interval: input.interval,
        healthCheck: input.healthCheck,
      };
      const next = { ...this.state, templates };
      await this.writeState(next);
      this.state = next;
      return { ...templates };
    });
  }

  setLocalExtractionEnabled(id: string, enabled: boolean) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      return setLocalExtractionEnabled(this.localContext(), id, enabled);
    });
  }

  deleteLocalExtraction(input: LocalExtractionDeleteInput) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      return deleteLocalExtraction(this.localContext(), input);
    });
  }

  renameLocalExtraction(id: string, fileName: string) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      return renameLocalExtraction(this.localContext(), id, fileName);
    });
  }

  updateLocalExtraction(input: LocalExtractionUpdateInput) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      return updateLocalExtraction(this.localContext(), input);
    });
  }

  previewLocalExtraction(id: string, rules: string[]) {
    return this.writeQueue.enqueue(async () => {
      return previewLocalExtraction(this.localContext(), id, rules);
    });
  }

  saveLocalExtractionSettings(id: string, input: LocalExtractionFilterInput) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      return saveLocalExtractionSettings(this.localContext(), id, input);
    });
  }

  createLocalExtraction(input: LocalExtractionCreateInput) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      return createLocalExtraction(this.localContext(), input);
    });
  }

  regenerateLocalExtractionsForConfig(configName: string, expectedSha256: string) {
    return this.writeQueue.enqueue(() => this.regenerateLocalExtractionsForConfigUnqueued(configName, expectedSha256));
  }

  async regenerateLocalExtractionsForConfigUnqueued(configName: string, expectedSha256: string) {
    await this.ensureProviderOperationRecovered();
    return regenerateLocalExtractionsForConfig(this.localContext(), configName, expectedSha256);
  }

  regenerateLocalExtraction(id: string) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      return regenerateLocalExtraction(this.localContext(), id);
    });
  }

  collectionPreferences() {
    return structuredClone(this.state.collectionPreferences ?? { version: 0, readOnly: [] });
  }

  setCollectionReadOnly(input: { configName: string; category: ProviderCategory; name: string; readOnly: boolean; expectedVersion: number }) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      const current = this.collectionPreferences();
      if (current.version !== input.expectedVersion) throw new ProviderFileConflictError("collection preferences changed");
      const config = recordValue(parse((await this.options.store.read(input.configName)).content));
      const declaration = recordValue(recordValue(config?.[`${input.category}-providers`])?.[input.name]);
      if (!declaration) throw new ProviderFileNotFoundError("collection not found");
      if (declaration.type !== "inline") {
        const fileName = await this.mappedFileName(input.configName, input.category, declaration.path);
        if (declaration.type !== "file" || !fileName) throw new ProviderFileReadOnlyError("collection body is read-only");
        await this.assertWritable(input.category, fileName);
      }
      const key = collectionPreferenceKey(input.configName, input.category, input.name);
      const readOnly = current.readOnly.filter((entry) => entry !== key);
      if (input.readOnly) readOnly.push(key);
      const next = { ...this.state, collectionPreferences: { version: current.version + 1, readOnly } };
      await this.writeState(next);
      this.state = next;
      return this.collectionPreferences();
    });
  }

  private collectionFileName(path: unknown, category: ProviderCategory) {
    if (typeof path !== "string" || path.split(/[\\/]/).includes("..")) return null;
    const fileName = relative(this.directoryFor(category), resolve(this.options.dataDir, path)).split(sep).join("/");
    return validProviderKey(fileName) ? fileName : null;
  }

  private async mappedFileName(configName: string, category: ProviderCategory, path: unknown) {
    const paths = await this.resolvePaths(configName, stringify({ [`${category}-providers`]: { target: { type: "file", path } } }));
    const target = paths[0];
    return target && (!target.status || target.status === "missing") ? target.fileName : null;
  }

  private async verifyPathChangeFile(change: CollectionPathChange) {
    const fileName = await this.mappedFileName(change.configName, change.category, change.fromPath);
    if (!fileName) throw new ProviderFileNameError("provider path is outside its controlled directory");
    const references = await rememberHttpCachePaths(this.httpContext());
    const path = this.pathForName(fileName, change.category);
    if ((this.state.httpCachePaths ?? []).includes(path) || references.get(path) === null ||
      (change.category === "proxy" && (subscriptionReservations(this.options.subscriptions?.() ?? [], fileName).length || localReservations(this.state.local, fileName).length))) {
      throw new ProviderFileReadOnlyError("provider body is read-only");
    }
    const file = await readControlledFile(path, this.options.maxContentBytes);
    if (!file || file.sha256 !== change.fileSha256 || String(file.device) !== change.device || String(file.inode) !== change.inode) {
      throw new ProviderFileConflictError("original provider file changed");
    }
    return file;
  }

  private async configPathChanges(snapshot: ConfigSnapshot) {
    const changes: Array<Pick<CollectionPathChange, "category" | "name" | "fromPath" | "toPath" | "fileSha256">> = [];
    for (const change of this.state.collectionPathChanges ?? []) {
      if (!pathChangeMatches(change, snapshot)) continue;
      try {
        const target = await this.mappedFileName(change.configName, change.category, change.toPath);
        if (!target || await readControlledFile(this.pathForName(target, change.category), this.options.maxContentBytes)) continue;
        await this.verifyPathChangeFile(change);
        const { category, name, fromPath, toPath, fileSha256 } = change;
        changes.push({ category, name, fromPath, toPath, fileSha256 });
      } catch { /* Changed or unreadable evidence must not authorize recovery. */ }
    }
    return { ...snapshot, collectionPathChanges: changes };
  }

  readConfig(name?: string) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      return this.configPathChanges(await this.options.store.read(name));
    });
  }

  saveConfig(name: string, content: string, expectedSha256: string) {
    return this.writeQueue.enqueue(() => this.saveConfigUnqueued(name, content, expectedSha256));
  }

  private workspaceContext(): WorkspaceOperationContext {
    const service = this;
    return {
      store: this.options.store, maxContentBytes: this.options.maxContentBytes, directory: (category) => this.directoryFor(category),
      get journal() { return service.state.workspaceJournal ?? null; }, beforePublish: this.options.beforeFileRename,
      writeJournal: async (workspaceJournal) => {
        const next = { ...this.state, workspaceJournal }; await this.writeState(next, false); this.state = next;
      },
      commit: async (workspaceJournal) => {
        const manual = [...this.state.manual];
        for (const file of workspaceJournal.files) {
          if (!file.before && !manual.some((entry) => entry.category === file.category && entry.fileName === file.fileName)) manual.push({ category: file.category, fileName: file.fileName });
        }
        const pendingRemovals = [...this.state.pendingRemovals ?? []];
        for (const removal of workspaceJournal.removals) {
          if (!pendingRemovals.some((entry) => entry.configName === workspaceJournal.configName && entry.category === removal.category && entry.fileName === removal.fileName)) pendingRemovals.push({ ...removal, configName: workspaceJournal.configName });
        }
        const next = { ...this.state, manual, pendingRemovals, workspaceJournal, ...(workspaceJournal.httpProviders ? {
          manualHttp: [...(this.state.manualHttp ?? []).filter((owner) => owner.configName !== workspaceJournal.configName), ...workspaceJournal.httpProviders],
        } : {}) };
        await this.writeState(next); this.state = next;
      },
    };
  }

  saveCollectionWorkspace(input: { configName: string; content: string; expectedSha256: string; bodies: CollectionBodyDraft[]; removals: Array<{ category: ProviderCategory; name: string }>; httpProviders?: Array<{ category: ProviderCategory; name: string }> | undefined }) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      const previous = await this.options.store.read(input.configName);
      if (previous.sha256 !== input.expectedSha256) throw new ConfigConflictError("configuration changed");
      const after = collectionDeclarations(input.content);
      const contentForPaths = after ? input.content : previous.content;
      const references = await rememberHttpCachePaths(this.httpContext());
      const paths = await this.resolvePaths(previous.name, contentForPaths);
      const bodies: Array<CollectionBodyDraft & { fileName: string }> = [];
      const seen = new Set<string>();
      for (const body of input.bodies) {
        const path = paths.find((entry) => entry.category === body.category && entry.name === body.name);
        if (!path?.fileName || (path.status && path.status !== "missing")) throw new ConfigProviderFilesError([{ category: body.category, name: body.name, status: path?.status ?? "outside_scope" }]);
        const key = `${body.category}:${providerFileNameKey(path.fileName)}`;
        if (seen.has(key)) throw new ConfigProviderFilesError([{ category: body.category, name: body.name, status: "conflict" }]);
        seen.add(key);
        if (Buffer.byteLength(body.content, "utf8") > this.options.maxContentBytes) throw new ProviderFileValidationError("provider content exceeds the size limit");
        const target = this.pathForName(path.fileName, body.category);
        if (this.collectionPreferences().readOnly.includes(collectionPreferenceKey(previous.name, body.category, body.name)) ||
          (this.state.httpCachePaths ?? []).includes(target) || references.get(target) === null ||
          (body.category === "proxy" && (subscriptionReservations(this.options.subscriptions?.() ?? [], path.fileName).length || localReservations(this.state.local, path.fileName).length))) throw new ProviderFileReadOnlyError("provider body is read-only");
        const existing = await readControlledFile(target, this.options.maxContentBytes);
        if ((existing?.sha256 ?? null) !== body.expectedSha256) throw new ProviderFileConflictError("provider file changed");
        if (existing) await this.assertWritable(body.category, path.fileName);
        await ensureProviderParent(this.directoryFor(body.category), path.fileName);
        bodies.push({ ...body, fileName: path.fileName });
      }
      const removals: CollectionRemoval[] = [];
      const previousPaths = await this.resolvePaths(previous.name, previous.content);
      if (input.removals.length && !after) throw new ProviderFileValidationError("collection removal requires readable declarations");
      const requestedRemovals = [...input.removals.map((entry) => ({ ...entry, explicit: true })),
        ...input.bodies.map((entry) => ({ category: entry.category, name: entry.name, explicit: false }))];
      for (const removal of requestedRemovals) {
        if (removal.explicit && recordValue(after?.[`${removal.category}-providers`])?.[removal.name]) throw new ProviderFileConflictError("collection declaration remains");
        const path = previousPaths.find((entry) => entry.category === removal.category && entry.name === removal.name);
        if (!path?.fileName || path.status) continue;
        if (paths.some((entry) => entry.referencePath === path.referencePath)) continue;
        const file = await readControlledFile(this.pathForName(path.fileName, removal.category), this.options.maxContentBytes);
        if (file && !removals.some((entry) => entry.category === removal.category && entry.fileName === path.fileName)) removals.push({ category: removal.category, name: removal.name, fileName: path.fileName, sha256: file.sha256, identity: `${file.device}:${file.inode}` });
      }
      const httpProviders = after && input.httpProviders ? input.httpProviders.map((owner) => {
        const declaration = recordValue(recordValue(after?.[`${owner.category}-providers`])?.[owner.name]) ??
          this.state.manualHttp?.find((entry) => entry.configName === previous.name && entry.category === owner.category && entry.name === owner.name)?.declaration;
        if (!declaration || declaration.type !== "http") throw new ProviderFileValidationError("HTTP collection declaration is unavailable");
        return { ...owner, configName: previous.name, declaration };
      }) : undefined;
      if (!bodies.length && !removals.length && !httpProviders) return this.saveConfigUnqueued(previous.name, input.content, previous.sha256);
      return saveWorkspace(this.workspaceContext(), previous, input.content, bodies, removals, httpProviders);
    });
  }

  renameConfigSource(oldName: string, newName: string, renameSource: () => Promise<ConfigSnapshot>) {
    return this.writeQueue.enqueue(() => this.renameConfigSourceUnqueued(oldName, newName, renameSource));
  }

  validateCollectionWorkspace(configName: string, content: string, bodies: CollectionBodyDraft[]) {
    return this.writeQueue.enqueue(async () => {
      await this.options.store.read(configName);
      const diagnostics = [];
      const syntaxValid = (text: string) => { try { parse(text); return true; } catch { return false; } };
      if (!syntaxValid(content)) diagnostics.push({ code: "yaml_syntax", message: "源配置 YAML 格式错误。" });
      for (const body of bodies) if (!syntaxValid(body.content)) diagnostics.push({
        code: "collection_yaml", message: "集合正文 YAML 格式错误。", path: [`${body.category}-providers`, body.name],
      });
      if (diagnostics.length) throw new ConfigValidationError("collection YAML is invalid", diagnostics);
      const conflicts = (await this.resolvePaths(configName, content)).filter((entry) => entry.status === "conflict");
      if (conflicts.length) throw new ConfigProviderFilesError(conflicts.map(({ category, name }) => ({ category, name, status: "conflict" })));
      return { valid: true as const };
    });
  }

  async renameConfigSourceUnqueued(oldName: string, newName: string, renameSource: () => Promise<ConfigSnapshot>) {
    await this.ensureProviderOperationRecovered();
    const before = this.state;
    if (oldName === newName) return renameSource();
    const sourceDirectories = { ...before.sourceDirectories, [newName]: before.sourceDirectories?.[oldName] ?? collectionScope(oldName),
      [oldName]: collectionScope(randomBytes(16).toString("hex")) };
    const legacyPaths = { ...before.legacyPaths };
    if (Object.hasOwn(legacyPaths, oldName)) legacyPaths[newName] = legacyPaths[oldName]!;
    delete legacyPaths[oldName];
    const next = { ...before, sourceDirectories, legacyPaths,
      manualHttp: (before.manualHttp ?? []).map((entry) => entry.configName === oldName ? { ...entry, configName: newName } : entry),
      local: before.local.map((entry) => entry.configName === oldName ? { ...entry, configName: newName } : entry),
      pendingRemovals: before.pendingRemovals?.map((entry) => entry.configName === oldName ? { ...entry, configName: newName } : entry),
      collectionPathChanges: before.collectionPathChanges?.map((entry) => entry.configName === oldName ? { ...entry, configName: newName } : entry),
      collectionPreferences: before.collectionPreferences ? { ...before.collectionPreferences, readOnly: before.collectionPreferences.readOnly.map((key) => {
        try { const parts = JSON.parse(key); if (parts[0] === oldName) { parts[0] = newName; return JSON.stringify(parts); } } catch { /* Preserve unrelated preference keys. */ }
        return key;
      }) } : undefined,
    };
    await this.writeState(next); this.state = next;
    try { return await renameSource(); }
    catch (error) { await this.writeState(before); this.state = before; throw error; }
  }

  cleanupAppliedCollections(configName: string, expectedSha256: string, readConfirmedRuntime: () => Promise<ProviderRuntimeDependencies>) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      const pending = (this.state.pendingRemovals ?? []).filter((entry) => entry.configName === configName);
      if (!pending.length) return [];
      const results: ProviderCleanupItem[] = [];
      try {
        this.cleanupRuntime = await readConfirmedRuntime();
        if ((await this.options.store.read(configName)).sha256 !== expectedSha256) this.cleanupRuntime = { ...this.cleanupRuntime, uncertain: true };
        const references = await rememberHttpCachePaths(this.httpContext());
        for (const expected of pending) {
          const item = await this.cleanupItem(expected.category, expected.fileName, undefined, references);
          const proof = await readControlledFile(this.pathForName(expected.fileName, expected.category), this.options.maxContentBytes);
          if (!proof) { item.action = "deleted"; item.reason = "deleted"; }
          else if (proof.sha256 !== expected.sha256 || `${proof.device}:${proof.inode}` !== expected.identity) { item.action = "keep"; item.reason = "changed"; }
          else if (item.action === "delete") {
            try {
              await this.deleteUnqueued(item.category, item.fileName, item.sha256, undefined, undefined, undefined, item.identity, false, references);
              item.action = "deleted"; item.reason = "deleted";
            } catch { item.action = "keep"; item.reason = "delete_failed"; }
          }
          results.push(item);
        }
        const pendingRemovals = (this.state.pendingRemovals ?? []).filter((entry) => entry.configName !== configName ||
          !results.some((item) => item.category === entry.category && item.fileName === entry.fileName && item.action === "deleted"));
        const next = { ...this.state, pendingRemovals }; await this.writeState(next); this.state = next;
        return results;
      } finally { this.cleanupRuntime = undefined; }
    });
  }

  private async saveConfigUnqueued(name: string, content: string, expectedSha256: string) {
    await this.ensureProviderOperationRecovered();
    const previous = await this.options.store.read(name);
    if (previous.sha256 !== expectedSha256) throw new ConfigConflictError("configuration changed");
    const before = collectionDeclarations(previous.content);
    const after = collectionDeclarations(content);
    const references = await rememberHttpCachePaths(this.httpContext());
    const previousChanges = this.state.collectionPathChanges ?? [];
    const changes = previousChanges.filter((entry) => entry.configName !== name);
    for (const category of ["proxy", "rule"] as const) {
      for (const [collectionName, value] of Object.entries(recordValue(after?.[category + "-providers"]) ?? {})) {
        const declaration = recordValue(value);
        const old = recordValue(recordValue(before?.[category + "-providers"])?.[collectionName]);
        const target = await this.mappedFileName(name, category, declaration?.path);
        if (declaration?.type !== "file" || old?.type !== "file" || !target) continue;
        try {
          if (await readControlledFile(this.pathForName(target, category), this.options.maxContentBytes)) continue;
          const carried = previousChanges.find((entry) => entry.category === category && entry.name === collectionName && pathChangeMatches(entry, previous));
          const oldFile = await this.mappedFileName(name, category, old.path);
          const original = oldFile ? await readControlledFile(this.pathForName(oldFile, category), this.options.maxContentBytes) : null;
          if (!original && carried && declaration.path !== carried.fromPath) {
            await this.verifyPathChangeFile(carried);
            changes.push({ ...carried, toPath: declaration.path as string, configSha256: hash(content) });
            continue;
          }
          if (!oldFile || oldFile === target || !await this.ordinaryFileWritable(category, oldFile, references)) continue;
          if (!original) continue;
          changes.push({ configName: name, category, name: collectionName, fromPath: old.path as string, toPath: declaration.path as string,
            beforeConfigSha256: previous.sha256, configSha256: hash(content), fileSha256: original.sha256,
            device: String(original.device), inode: String(original.inode) });
        } catch { /* Saving a draft does not require recoverable collection files. */ }
      }
    }
    const changed = JSON.stringify(changes) !== JSON.stringify(previousChanges);
    if (changed) {
      const next = { ...this.state, collectionPathChanges: changes };
      await this.writeState(next);
      this.state = next;
    }
    let saved: ConfigSnapshot;
    try { saved = await this.options.store.saveFileUnqueued(name, content, expectedSha256, true); }
    catch (error) {
      if (changed) {
        const restored = { ...this.state, collectionPathChanges: previousChanges };
        await this.writeState(restored);
        this.state = restored;
      }
      throw error;
    }
    return this.configPathChanges(saved);
  }

  resolveCollectionPath(input: {
    configName: string; expectedConfigSha256: string; category: ProviderCategory; name: string;
    fromPath: string; toPath: string; expectedFileSha256: string; draftContent: string; action: "rename" | "restore";
  }) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      const source = await this.options.store.read(input.configName);
      if (source.sha256 !== input.expectedConfigSha256) throw new ConfigConflictError("configuration changed");
      const change = (this.state.collectionPathChanges ?? []).find((entry) => pathChangeMatches(entry, source) &&
        entry.category === input.category && entry.name === input.name && entry.fromPath === input.fromPath &&
        entry.toPath === input.toPath && entry.fileSha256 === input.expectedFileSha256);
      if (!change || !pathChangeMatches(change, { ...source, content: input.draftContent })) {
        throw new ProviderFileConflictError("collection path changed");
      }
      const original = await this.verifyPathChangeFile(change);
      const fileName = (await this.mappedFileName(change.configName, change.category, change.fromPath))!;
      const target = (await this.mappedFileName(change.configName, change.category, change.toPath))!;
      if (await readControlledFile(this.pathForName(target, change.category), this.options.maxContentBytes)) throw new ProviderFileExistsError("provider file already exists");
      if (input.action === "restore") return { fromPath: change.fromPath, content: original.content.toString("utf8") };
      const result = await this.renameCollectionFileUnqueued({ category: change.category, fileName, nextFileName: target,
        expectedSha256: change.fileSha256, configName: source.name, configContent: source.content,
        expectedConfigSha256: source.sha256, pathChange: change });
      return { ...result, content: original.content.toString("utf8"), config: await this.configPathChanges(result.config) };
    });
  }

  private async ordinaryFileWritable(category: ProviderCategory, fileName: string, references?: Map<string, Set<ProviderCategory> | null>) {
    // Read all source declarations once per operation, rather than once per Provider file.
    const currentReferences = references ?? await rememberHttpCachePaths(this.httpContext());
    const path = this.pathForName(fileName, category);
    if ((this.state.httpCachePaths ?? []).includes(path) || (category === "proxy" &&
      (subscriptionReservations(this.options.subscriptions?.() ?? [], fileName).length || localReservations(this.state.local, fileName).length))) return false;
    const categories = currentReferences.get(path);
    if (categories === null) return false;
    return manualEntries(this.state.manual, fileName, category).length === 1 || Boolean(categories?.has(category));
  }

  private async assertWritable(category: ProviderCategory, fileName: string) {
    const references = await rememberHttpCachePaths(this.httpContext());
    const current = await this.record(fileName, category, references);
    if (current.category !== category || !current.writable) throw new ProviderFileReadOnlyError("provider body is read-only");
    return current;
  }

  saveCollectionSettings(input: CollectionSettingsInput) {
    return this.writeQueue.enqueue(() => this.saveCollectionSettingsUnqueued(input));
  }

  private async saveCollectionSettingsUnqueued(input: CollectionSettingsInput) {
      await this.ensureProviderOperationRecovered();
      await rememberHttpCachePaths(this.httpContext());
      const previous = await this.options.store.read(input.configName);
      if (previous.sha256 !== input.expectedConfigSha256) throw new ConfigConflictError("configuration changed");
      const document = parseDocument(previous.content);
      const sectionName = `${input.category}-providers`;
      const original = recordValue(recordValue(document.toJS()[sectionName])?.[input.name]);
      const snippet = parseDocument(input.snippet);
      const value = snippet.errors.length ? null : recordValue(snippet.toJS());
      const names = Object.keys(value ?? {});
      const nextName = names[0] ?? "";
      const declaration = recordValue(value?.[nextName]);
      if (!original || !declaration || names.length !== 1 || !nextName.trim() || nextName !== nextName.trim() || nextName.length > 120) {
        throw new ProviderFileValidationError("invalid collection declaration");
      }
      if (nextName !== input.name && (document.hasIn([sectionName, nextName]) ||
        (document.toJS()["proxy-groups"] ?? []).some((group: { name?: string }) => group?.name === nextName))) {
        throw new ProviderFileExistsError("collection name already exists");
      }
      // Source type is fixed here: changing type must never turn a download or extraction into an editable body.
      if (declaration.type !== original.type) throw new ProviderFileReadOnlyError("collection source type cannot be changed");
      const oldFileName = original.type === "file" ? await this.mappedFileName(input.configName, input.category, original.path) : this.collectionFileName(original.path, input.category);
      const nextFileName = original.type === "file" ? await this.mappedFileName(input.configName, input.category, declaration.path) : this.collectionFileName(declaration.path, input.category);
      const pathChanged = declaration.path !== original.path;
      if (pathChanged && !nextFileName) throw new ProviderFileNameError("provider path is outside its controlled directory");
      const owned = oldFileName && input.category === "proxy" &&
        (subscriptionReservations(this.options.subscriptions?.() ?? [], oldFileName).length || localReservations(this.state.local, oldFileName).length);
      if (owned && (pathChanged || JSON.stringify(original.payload) !== JSON.stringify(declaration.payload) ||
        JSON.stringify(original.proxies) !== JSON.stringify(declaration.proxies))) {
        throw new ProviderFileReadOnlyError("extracted body and path are read-only");
      }
      if (original.type === "http" && (declaration.payload !== undefined || declaration.proxies !== undefined)) {
        throw new ProviderFileReadOnlyError("downloaded body is read-only");
      }
      if (pathChanged && (!oldFileName || (original.type !== "file" && original.type !== "http"))) {
        throw new ProviderFileReadOnlyError("provider path cannot be renamed");
      }
      if (pathChanged && original.type === "http" && oldFileName !== nextFileName) {
        await assertRenameTargetAvailable(this.renameContext(input.category), null, nextFileName!, oldFileName!, input.category);
      }
      const content = applyCollectionDeclaration(document, input, nextName, declaration);
      let config: ConfigSnapshot;
      let retainedSource: RetainedProviderFile | undefined;
      if (pathChanged && original.type === "file" && oldFileName !== nextFileName) {
        const file = await this.assertWritable(input.category, oldFileName!);
        if (file.sha256 !== input.expectedFileSha256) throw new ProviderFileConflictError("provider file changed");
        const result = await this.renameCollectionFileUnqueued({
          category: input.category, fileName: oldFileName!, nextFileName: nextFileName!,
          expectedSha256: file.sha256, configName: input.configName,
          configContent: content, expectedConfigSha256: previous.sha256,
        });
        config = result.config;
        retainedSource = result.retainedSource;
      } else {
        config = await this.options.store.saveFileUnqueued(previous.name, content, previous.sha256, true);
      }
      const preferences = this.collectionPreferences();
      const oldKey = collectionPreferenceKey(input.configName, input.category, input.name);
      const nextKey = collectionPreferenceKey(input.configName, input.category, nextName);
      const next = { ...this.state,
        collectionPreferences: oldKey === nextKey ? preferences : { version: preferences.version + 1,
          readOnly: preferences.readOnly.map((key) => key === oldKey ? nextKey : key) },
        manualHttp: (this.state.manualHttp ?? []).map((owner) => owner.configName === input.configName && owner.category === input.category && owner.name === input.name
          ? { ...owner, name: nextName, declaration } : owner),
      };
      await this.writeState(next);
      this.state = next;
      await rememberHttpCachePaths(this.httpContext());
      return { config, name: nextName, ...(retainedSource ? { retainedSource } : {}) };
  }

  validate(category: ProviderCategory, content: string) {
    assertContent(category, content, this.options.maxContentBytes);
    return { valid: true as const };
  }

  // Called while generation holds the shared queue, after maintained files are prepared.
  async validateSourceCollectionsUnqueued(configName: string, expectedSha256: string) {
    const source = await this.options.store.read(configName);
    if (source.sha256 !== expectedSha256) throw new ConfigConflictError("configuration changed");
    const paths = await this.resolvePaths(source.name, source.content);
    const issues = paths.flatMap(({ category, name, status }) => status ? [{ category, name, status }] : []);
    if (issues.length) throw new ConfigProviderFilesError(issues);
    const document = parseDocument(mappedCollectionContent(source.content, paths));
    if (document.errors.length) throw new ProviderFileValidationError("configuration YAML is invalid");
    const root = recordValue(document.toJS());
    const configSources = new Map([[configName, { config: root, unreadable: !root && Boolean(source.content.trim()) }]]);
    let references: Map<string, Set<ProviderCategory> | null> | undefined;
    for (const category of ["proxy", "rule"] as const) {
      for (const raw of Object.values(recordValue(root?.[`${category}-providers`]) ?? {})) {
        const declaration = recordValue(raw);
        if (declaration?.type !== "file" || (category === "rule" && declaration.format != null && declaration.format !== "yaml")) continue;
        const fileName = this.collectionFileName(declaration.path, category);
        if (!fileName) continue;
        references ??= await rememberHttpCachePaths(this.httpContext(), configSources);
        const file = await this.readSnapshotUnqueued(fileName, category, references);
        assertContent(category, file.content, this.options.maxContentBytes);
      }
    }
  }

  create(category: ProviderCategory, fileName: string, initialContent?: string) {
    return this.writeQueue.enqueue(() => this.createUnqueued(category, fileName, initialContent));
  }

  createProxyCollection(input: ProxyCollectionCreateInput) {
    return this.createCollection({ ...input, category: "proxy" });
  }

  collectionUploadDeclaration(input: Pick<ProxyCollectionCreateInput, "configName" | "name" | "operationId"> & { category: ProviderCategory }) {
    const fileName = `collection-${hash(`${input.configName}\0${input.operationId}`).slice(0, 32)}.yaml`;
    const path = `./${relative(this.options.dataDir, this.pathForName(fileName, input.category)).split(sep).join("/")}`;
    return stringify({ [input.name]: { type: "file", path,
      ...(input.category === "rule" ? { behavior: "classical", format: "yaml" } : {}) } }, { lineWidth: 0 });
  }

  createCollection(input: ProxyCollectionCreateInput & { category: ProviderCategory }) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      if (!/^[a-zA-Z0-9-]{16,64}$/.test(input.operationId) || !input.name.trim() ||
        input.name !== input.name.trim() || input.name.length > 120) {
        throw new ProviderFileValidationError("invalid collection identity");
      }
      const category = input.category;
      assertContent(category, input.content, this.options.maxContentBytes);
      const payload = recordValue(parse(input.content));
      const key = category === "proxy" ? "proxies" : "payload";
      if (!payload || Object.keys(payload).some((entry) => entry !== key) ||
        !Array.isArray(payload[key]) || !payload[key].length) {
        throw new ProviderFileValidationError(`a nonempty ${category} collection is required`);
      }
      const previous = await this.options.store.read(input.configName);
      const generatedFileName = `collection-${hash(input.snippet === undefined ? `${input.configName}\0${input.name}\0${input.operationId}` : `${input.configName}\0${input.operationId}`).slice(0, 32)}.yaml`;
      let fileName = generatedFileName;
      let referencePath = `./${relative(this.options.dataDir, this.pathForName(fileName, category)).split(sep).join("/")}`;
      const document = parseDocument(previous.content);
      if (document.errors.length || !isMap(document.contents)) throw new ProviderFileValidationError("invalid main configuration");
      const sectionName = category === "proxy" ? "proxy-providers" : "rule-providers";
      const existing = recordValue(recordValue(document.toJS()[sectionName])?.[input.name]);
      let nextName = input.name;
      let editedDeclaration: Record<string, unknown> | null = null;
      if (input.snippet !== undefined) {
        const snippet = parseDocument(input.snippet);
        const value = snippet.errors.length ? null : recordValue(snippet.toJS());
        const names = Object.keys(value ?? {});
        nextName = names[0] ?? "";
        editedDeclaration = recordValue(value?.[nextName]);
        if (names.length !== 1 || !nextName.trim() || nextName !== nextName.trim() || nextName.length > 120 ||
          (category === "rule" && nextName.includes(",")) || !editedDeclaration || editedDeclaration.type !== "file" ||
          editedDeclaration.payload !== undefined || editedDeclaration.proxies !== undefined || editedDeclaration.url !== undefined) {
          throw new ProviderFileValidationError("invalid uploaded collection declaration");
        }
        const target = this.collectionFileName(editedDeclaration.path, category);
        if (!target) throw new ProviderFileNameError("provider path is outside its controlled directory");
        if (category === "rule" && (!["classical", "domain", "ipcidr"].includes(String(editedDeclaration.behavior)) ||
          (editedDeclaration.format !== undefined && editedDeclaration.format !== "yaml"))) {
          throw new ProviderFileValidationError("invalid uploaded rule declaration");
        }
        if (input.replace && nextName !== input.name && document.hasIn([sectionName, nextName])) throw new ProviderFileExistsError("collection name already exists");
        fileName = target;
        referencePath = String(editedDeclaration.path);
      } else if (input.repair && existing?.type === "file") {
        const target = this.collectionFileName(existing.path, category);
        if (!target) throw new ProviderFileNameError("provider path is outside its controlled directory");
        fileName = target;
        referencePath = String(existing.path);
      }
      if (input.replace) {
        if (previous.sha256 !== input.expectedConfigSha256) throw new ConfigConflictError("configuration changed");
        if (!existing || existing.type !== "file" || !input.targetFileName || !input.expectedFileSha256 ||
          this.collectionFileName(existing.path, category) !== input.targetFileName) {
          throw new ProviderFileConflictError("replacement target changed");
        }
        if (this.collectionPreferences().readOnly.includes(collectionPreferenceKey(input.configName, category, input.name))) {
          throw new ProviderFileReadOnlyError("collection body is read-only");
        }
        if (category === "rule" && existing.format !== undefined && existing.format !== "yaml") {
          throw new ProviderFileValidationError("YAML upload cannot replace another format");
        }
        const before = await this.readSnapshotUnqueued(input.targetFileName, category);
        const file = await this.saveUnqueued(category, input.targetFileName, input.content, input.expectedFileSha256);
        if (!input.snippet) return { file, config: previous, name: input.name };
        try {
          const saved = await this.saveCollectionSettingsUnqueued({ configName: input.configName,
            expectedConfigSha256: previous.sha256, category, name: input.name, snippet: input.snippet,
            loaded: true, selectedGroups: input.groupNames, expectedFileSha256: file.sha256 });
          return { file: await this.readSnapshotUnqueued(fileName, category), config: saved.config, name: saved.name };
        } catch (error) {
          // The existing declaration/rename transaction restores references on failure.
          // Restore the body only while the source is still the original version.
          if ((await this.options.store.read(input.configName)).sha256 === previous.sha256) {
            await this.saveUnqueued(category, input.targetFileName, before.content, file.sha256);
          }
          throw error;
        }
      }
      // The same request may be retried after a lost response or recovered commit.
      // Its private file identity cannot adopt a pre-existing external provider.
      const resulting = recordValue(recordValue(document.toJS()[sectionName])?.[nextName]);
      if (fileName === generatedFileName && resulting?.path === referencePath && manualEntries(this.state.manual, fileName, category).length === 1 &&
        !(input.repair && previous.providerIssues?.some((issue) => issue.category === category && issue.name === input.name && issue.status === "missing"))) {
        const file = await this.readSnapshotUnqueued(fileName, category);
        const groups = document.toJS()["proxy-groups"];
        const bound = category === "proxy" && Array.isArray(groups) ? groups.filter((group) =>
          group?.["include-all"] === true || group?.["include-all-providers"] === true ||
          (Array.isArray(group?.use) && group.use.includes(nextName))).map((group) => group.name) : [];
        const rules = document.toJS().rules;
        const ruleBound = category === "rule" && Array.isArray(rules) && (input.ruleSetRules ?? []).every((rule) => rules.includes(rule));
        if (file.content === input.content && (!editedDeclaration || JSON.stringify(resulting) === JSON.stringify(editedDeclaration)) &&
          (ruleBound || (bound.length && input.groupNames.every((name) => bound.includes(name)))) &&
          (!input.newGroupName?.trim() || bound.includes(input.newGroupName.trim()))) return { file, config: previous, name: nextName };
        throw new ConfigConflictError("created collection or its references changed");
      }
      if (previous.sha256 !== input.expectedConfigSha256) {
        throw new ConfigConflictError("configuration changed");
      }
      if (nextName !== input.name && document.hasIn([sectionName, nextName])) throw new ProviderFileExistsError("collection name already exists");
      await rememberHttpCachePaths(this.httpContext());
      if ((this.state.httpCachePaths ?? []).includes(this.pathForName(fileName, category))) {
        throw new ProviderFileReadOnlyError("downloaded body is read-only");
      }
      let groups = document.get("proxy-groups", true);
      if (category === "proxy" && groups != null && !isSeq(groups)) throw new ProviderFileValidationError("invalid proxy groups");
      const groupEntries = category === "proxy" && isSeq(groups) ? groups.items : [];
      const groupNames = groupEntries.map((group) => isMap(group) ? group.get("name") : null);
      if (category === "proxy" && groupNames.includes(nextName)) throw new ProviderFileExistsError("collection name conflicts with a group");
      if (input.repair) {
        if (!existing || existing.type !== "file" || !previous.providerIssues?.some((issue) =>
          issue.category === category && issue.name === input.name && issue.status === "missing")) {
          throw new ProviderFileConflictError("only a missing local collection may be filled");
        }
        if (this.collectionFileName(existing.path, category) !== fileName) {
          throw new ProviderFileConflictError("missing collection target changed");
        }
        await rememberHttpCachePaths(this.httpContext());
        const previousFileName = this.collectionFileName(existing.path, category);
        const previousPath = typeof existing.path === "string" ? resolve(this.options.dataDir, existing.path) : "";
        if ((this.state.httpCachePaths ?? []).includes(previousPath) || (category === "proxy" && previousFileName &&
          (subscriptionReservations(this.options.subscriptions?.() ?? [], previousFileName).length || localReservations(this.state.local, previousFileName).length)) ||
          this.collectionPreferences().readOnly.includes(collectionPreferenceKey(input.configName, category, input.name))) {
          throw new ProviderFileReadOnlyError("collection body is read-only");
        }
        if (category === "rule" && existing.format !== undefined && existing.format !== "yaml") {
          throw new ProviderFileValidationError("YAML upload cannot replace another format");
        }
      } else if (existing) {
        throw new ProviderFileExistsError("collection is already declared");
      }
      const selectedGroups = new Set(input.groupNames);
      if (category === "proxy" && [...selectedGroups].some((name) => !groupNames.includes(name))) throw new ProviderFileValidationError("selected group is unavailable");
      const newGroupName = input.newGroupName?.trim();
      const restoreDeclaredFile = input.repair && nextName === input.name &&
        (!editedDeclaration || JSON.stringify(existing) === JSON.stringify(editedDeclaration)) && !newGroupName &&
        [...selectedGroups].every((name) => groupEntries.some((group) => isMap(group) && group.get("name") === name &&
          (group.get("include-all") === true || group.get("include-all-providers") === true ||
            (isSeq(group.get("use", true)) && (group.get("use", true)!.toJSON() as unknown[]).includes(nextName)))));
      if (category === "proxy" && newGroupName) {
        if (newGroupName.length > 120 || newGroupName === input.name || groupNames.includes(newGroupName) ||
          newGroupName === nextName || document.hasIn(["proxy-providers", newGroupName])) throw new ProviderFileExistsError("group name already exists");
        if (!isSeq(groups)) {
          document.set("proxy-groups", document.createNode([]));
          groups = document.get("proxy-groups", true);
        }
        if (isSeq(groups)) groups.add({ name: newGroupName, type: "select", use: [nextName] });
      }
      let referenced = category === "rule" || Boolean(newGroupName);
      for (const group of category === "proxy" && isSeq(groups) ? groups.items : []) {
        if (!isMap(group)) continue;
        const implicit = group.get("include-all") === true || group.get("include-all-providers") === true;
        const use = group.get("use", true);
        const names = isSeq(use) ? (use.toJSON() as unknown[]).map((name) => input.repair && name === input.name ? nextName : name) : [];
        if (input.repair && isSeq(use)) group.set("use", names);
        if (implicit || names.includes(nextName)) referenced = true;
        if (!selectedGroups.has(String(group.get("name")))) continue;
        referenced = true;
        if (!implicit && !names.includes(nextName)) group.set("use", [...names, nextName]);
      }
      if (!referenced && !restoreDeclaredFile) throw new ProviderFileValidationError("a collection must belong to a proxy group");
      if (category === "rule" && !input.repair && (!["classical", "domain", "ipcidr"].includes(input.behavior ?? "classical") ||
        (input.format !== undefined && input.format !== "yaml"))) throw new ProviderFileValidationError("invalid rule collection settings");
      const declaration = editedDeclaration ?? (category === "proxy"
        ? { type: "file", path: referencePath }
        : { type: "file", behavior: input.behavior ?? "classical", format: input.format ?? "yaml", path: referencePath });
      if (input.repair && !editedDeclaration) document.setIn([sectionName, input.name, "path"], referencePath);
      else { if (input.repair) document.deleteIn([sectionName, input.name]); document.setIn([sectionName, nextName], declaration); }
      if (input.repair && category === "rule" && nextName !== input.name) {
        const rules = document.get("rules", true);
        if (isSeq(rules)) document.set("rules", (rules.toJSON() as unknown[]).map((rule) =>
          typeof rule === "string" && rule.startsWith(`RULE-SET,${input.name},`) ? rule.replace(`RULE-SET,${input.name},`, `RULE-SET,${nextName},`) : rule));
      }
      if (category === "rule" && !input.repair) {
        const policies = new Set(["DIRECT", ...(isSeq(groups) ? groups.toJSON().map((group: unknown) => recordValue(group)?.name) : [])]);
        if (!input.ruleSetRules?.length || input.ruleSetRules.some((rule) => {
          const parts = rule.split(",");
          return parts.length !== 3 || parts[0] !== "RULE-SET" || parts[1] !== nextName || !policies.has(parts[2]);
        })) throw new ProviderFileValidationError("a rule collection must reference an available policy");
        let rules = document.get("rules", true);
        if (rules != null && !isSeq(rules)) throw new ProviderFileValidationError("invalid rules");
        if (!isSeq(rules)) { document.set("rules", document.createNode([])); rules = document.get("rules", true); }
        if (isSeq(rules)) {
          const fallback = rules.toJSON().findIndex((rule: unknown) => typeof rule === "string" && /^(MATCH|FINAL),/.test(rule));
          rules.items.splice(fallback < 0 ? rules.items.length : fallback, 0, ...input.ruleSetRules.map((rule) => document.createNode(rule)));
        }
      }
      const configContent = document.toString({ lineWidth: 0 });
      // Restoring an unchanged declaration only publishes its missing body. Main
      // config validation remains a separate step, including unrelated errors.
      const file = await this.createUnqueued(category, fileName, input.content,
        restoreDeclaredFile ? undefined : { previous, content: configContent }, Boolean(restoreDeclaredFile));
      return { file, config: await this.options.store.read(input.configName), name: nextName };
    });
  }

  private async createUnqueued(category: ProviderCategory, fileName: string, initialContent?: string,
    configCommit?: { previous: ConfigSnapshot; content: string }, restoreMissing = false) {
      await this.ensureProviderOperationRecovered();
      const path = this.pathForName(fileName, category);
      const content = initialContent ?? (category === "proxy" ? "proxies:\n" : "payload:\n");
      assertContent(category, content, this.options.maxContentBytes);
      const manual = manualEntries(this.state.manual, fileName, category);
      const restoreManual = restoreMissing && !configCommit && manual.length === 1 && manual[0]?.fileName === fileName;
      if ((category === "proxy" && (subscriptionReservations(this.options.subscriptions?.() ?? [], fileName).length > 0 || localReservations(this.state.local, fileName).length > 0)) || (manual.length > 0 && !restoreManual)) {
        throw new ProviderFileExistsError("provider file name is reserved");
      }
      await createProviderFile(this.operationContext(category), { category, fileName, path, content, restoreManual, configCommit }, this.options.store);
      return this.readSnapshotUnqueued(fileName, category);
  }

  save(category: ProviderCategory, fileName: string, content: string, expectedSha256: string) {
    return this.writeQueue.enqueue(() => this.saveUnqueued(category, fileName, content, expectedSha256));
  }

  private async saveUnqueued(category: ProviderCategory, fileName: string, content: string, expectedSha256: string) {
      await this.ensureProviderOperationRecovered();
      if (Buffer.byteLength(content, "utf8") > this.options.maxContentBytes) {
        throw new ProviderFileValidationError("provider file exceeds the size limit");
      }
      const current = await this.assertWritable(category, fileName);
      if (current.sha256 !== expectedSha256) throw new ProviderFileConflictError("provider file changed");
      const path = this.pathForName(fileName, category);
      const baseline = await readControlledFile(path, this.options.maxContentBytes);
      if (!baseline || baseline.sha256 !== expectedSha256) {
        throw new ProviderFileConflictError("provider file changed");
      }
      const metadata = await stat(path);
      const temporary = this.temporaryPath(fileName, "save", category);
      try {
        await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await chmod(temporary, metadata.mode);
        if (process.platform !== "win32") await chown(temporary, metadata.uid, metadata.gid);
        const candidate = await readControlledFile(temporary, this.options.maxContentBytes);
        const candidateSha256 = hash(content);
        if (!candidate || candidate.sha256 !== candidateSha256) {
          throw new ProviderFileConflictError("provider file changed");
        }
        await this.options.beforeFileRename?.();
        const latest = await readControlledFile(path, this.options.maxContentBytes);
        if (
          !latest || latest.sha256 !== expectedSha256 ||
          !sameFileIdentity(baseline, latest)
        ) throw new ProviderFileConflictError("provider file changed");
        const latestCandidate = await readControlledFile(temporary, this.options.maxContentBytes);
        if (
          !latestCandidate || latestCandidate.sha256 !== candidateSha256 ||
          !sameFileIdentity(candidate, latestCandidate)
        ) throw new ProviderFileConflictError("provider file changed");
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      return this.readSnapshotUnqueued(fileName, category);
  }

  rename(category: ProviderCategory, fileName: string, nextFileName: string, expectedSha256: string) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      const current = await this.assertManual(category, fileName);
      if (current.sha256 !== expectedSha256) throw new ProviderFileConflictError("provider file changed");
      await this.assertUnreferenced(fileName, undefined, category);
      const sourcePath = this.pathForName(fileName, category);
      const targetPath = this.pathForName(nextFileName, category);
      if (fileName === nextFileName) {
        return this.readSnapshotUnqueued(fileName, category);
      }
      await assertRenameTargetAvailable(this.renameContext(category), null, nextFileName, fileName, category);
      await renameProviderFile(this.renameContext(category), {
        kind: "manual",
        category,
        subscriptionId: null,
        sourceFileName: fileName,
        targetFileName: nextFileName,
        sha256: expectedSha256,
      }, async () => {
        const next = {
          ...this.state,
          manual: this.state.manual.map((entry) => entry.category === category && entry.fileName === fileName
            ? { ...entry, fileName: nextFileName }
            : entry),
        };
        await this.writeState(next);
        this.state = next;
      });
      return this.readSnapshotUnqueued(nextFileName, category);
    });
  }

  renameWithConfig(input: {
    category: ProviderCategory;
    fileName: string;
    nextFileName: string;
    expectedSha256: string;
    configName: string;
    configContent: string;
    expectedConfigSha256: string;
  }) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      const current = await this.assertManual(input.category, input.fileName);
      if (current.sha256 !== input.expectedSha256) throw new ProviderFileConflictError("provider file changed");
      await this.assertUnreferenced(input.fileName, input.configName, input.category);
      await this.assertConfigCandidateReferences(
        input.configContent,
        input.fileName,
        input.nextFileName,
        input.category,
      );
      if (input.fileName === input.nextFileName) throw new ProviderFileConflictError("provider file name is unchanged");
      await assertRenameTargetAvailable(this.renameContext(input.category), null, input.nextFileName, input.fileName, input.category);
      let savedConfig: Awaited<ReturnType<ConfigStore["saveFileUnqueued"]>> | null = null;
      await renameProviderFile(this.renameContext(input.category), {
        kind: "manual",
        category: input.category,
        subscriptionId: null,
        sourceFileName: input.fileName,
        targetFileName: input.nextFileName,
        sha256: input.expectedSha256,
        configName: input.configName,
        configBeforeSha256: input.expectedConfigSha256,
        configAfterSha256: hash(input.configContent),
      }, async () => {
        const previous = await this.options.store.read(input.configName);
        if (previous.sha256 !== input.expectedConfigSha256) throw new ProviderFileConflictError("configuration changed");
        savedConfig = await this.options.store.saveFileUnqueued(
          input.configName,
          input.configContent,
          input.expectedConfigSha256,
        );
        try {
          const next = {
            ...this.state,
            manual: this.state.manual.map((entry) => entry.category === input.category && entry.fileName === input.fileName
              ? { ...entry, fileName: input.nextFileName }
              : entry),
          };
          await this.writeState(next);
          this.state = next;
        } catch (error) {
          try {
            await this.options.store.restoreFileUnqueued(
              input.configName,
              previous.content,
              savedConfig.sha256,
            );
          } catch (rollbackError) {
            throw new ProviderFileRecoveryError("provider rename configuration rollback failed", {
              cause: new AggregateError([error, rollbackError]),
            });
          }
          throw error;
        }
      });
      return { file: await this.readSnapshotUnqueued(input.nextFileName, input.category), config: savedConfig! };
    });
  }

  private async renameRetention(fileName: string, configName: string, content: string, category: ProviderCategory): Promise<RetainedProviderFile | undefined> {
    const candidate = recordValue(parse(mappedCollectionContent(content, await this.resolvePaths(configName, content))));
    const target = this.pathForName(fileName, category);
    const identity = await readControlledFile(target, this.options.maxContentBytes);
    const evidence = await this.inspectFileReferences(fileName, configName, category);
    try {
      const scan = await configReferencesFile(candidate, target, identity, this.options.dataDir, this.options.maxContentBytes);
      evidence.configReferences.push(...scan.references.map((entry) => ({ ...entry, configName })));
      if (!candidate || !scan.complete) evidence.configReferences.push({ configName, kind: "unreadable" });
    } catch {
      evidence.configReferences.push({ configName, kind: "unreadable" });
    }
    try {
      assertReferencesUnreferenced(evidence.configReferences, evidence.runtime, true);
      return undefined;
    } catch (error) {
      if (error instanceof ProviderFileReferencedError) return { fileName, reason: "referenced", configNames: error.configNames, ...evidence };
      if (error instanceof ProviderRuntimeReferenceError) return { fileName, reason: error.reason, ...evidence };
      throw error;
    }
  }

  private async renameCollectionFileUnqueued(input: {
    category: ProviderCategory; fileName: string; nextFileName: string; expectedSha256: string;
    configName: string; configContent: string; expectedConfigSha256: string;
    pathChange?: CollectionPathChange;
  }) {
    await ensureProviderParent(this.directoryFor(input.category), input.nextFileName);
    const file = input.pathChange
      ? await this.verifyPathChangeFile(input.pathChange)
      : await this.assertWritable(input.category, input.fileName);
    if (file.sha256 !== input.expectedSha256) throw new ProviderFileConflictError("provider file changed");
    await assertRenameTargetAvailable(this.renameContext(input.category), null, input.nextFileName, input.fileName, input.category);
    const identity = await readControlledFile(this.pathForName(input.fileName, input.category), this.options.maxContentBytes);
    if (!identity || identity.sha256 !== input.expectedSha256 || (input.pathChange &&
      (String(identity.device) !== input.pathChange.device || String(identity.inode) !== input.pathChange.inode))) {
      throw new ProviderFileConflictError("provider file changed");
    }
    const previous = await this.options.store.read(input.configName);
    if (previous.sha256 !== input.expectedConfigSha256) throw new ConfigConflictError("configuration changed");
    const retainedSource = await this.renameRetention(input.fileName, input.configName, input.configContent, input.category);
    const configs = [{ name: previous.name, before: previous.content,
      beforeSha256: previous.sha256, afterSha256: hash(input.configContent) }];
    await renameProviderFile(this.renameContext(input.category), {
      kind: manualEntries(this.state.manual, input.fileName, input.category).length === 1 ? "manual" : "external",
      category: input.category, subscriptionId: null,
      sourceFileName: input.fileName, targetFileName: input.nextFileName, sha256: input.expectedSha256, configs,
      proofDevice: String(identity.device), proofInode: String(identity.inode),
      ...(retainedSource ? { retainedSource: { fileName: retainedSource.fileName, reason: retainedSource.reason,
        ...(retainedSource.configNames ? { configNames: retainedSource.configNames } : {}) } } : {}),
    }, async () => {
      if (previous.content !== input.configContent) {
        await this.options.store.saveFileUnqueued(previous.name, input.configContent, previous.sha256, true);
      }
      const manual = this.state.manual.flatMap((entry) => entry.category === input.category && entry.fileName === input.fileName
        ? [...(retainedSource ? [entry] : []), { ...entry, fileName: input.nextFileName }] : [entry]);
      const next = { ...this.state, manual,
        operationJournal: this.state.operationJournal ? { ...this.state.operationJournal, phase: "committed" as const } : null,
      };
      await this.writeState(next);
      this.state = next;
    });
    return { config: await this.options.store.read(input.configName), retainedSource };
  }

  delete(category: ProviderCategory, fileName: string, expectedSha256: string) {
    return this.writeQueue.enqueue(() => this.deleteUnqueued(category, fileName, expectedSha256));
  }

  previewCleanup(input: { category?: ProviderCategory; configName?: string; expectedConfigSha256?: string } = {}) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      const configSources = new Map<string, ConfigReferenceSource>();
      let source: Record<string, unknown> | null = null;
      if (input.configName) {
        const snapshot = await this.options.store.read(input.configName);
        if (snapshot.sha256 !== input.expectedConfigSha256) throw new ProviderFileConflictError("configuration changed");
        source = recordValue(parse(mappedCollectionContent(snapshot.content, snapshot.collectionPaths ?? [])));
        if (!source && snapshot.content.trim()) throw new ProviderFileValidationError("configuration cannot be inspected");
        configSources.set(snapshot.name, { config: source, unreadable: false });
      }
      const references = await rememberHttpCachePaths(this.httpContext(), configSources);
      const files: ProviderCleanupItem[] = [];
      if (input.configName) {
        const seen = new Set<string>();
        for (const category of ["proxy", "rule"] as const) {
          for (const value of Object.values(recordValue(source?.[`${category}-providers`]) ?? {})) {
            const declaration = recordValue(value);
            if (declaration?.type === "inline" || typeof declaration?.path !== "string") continue;
            const target = resolve(this.options.dataDir, declaration.path);
            const key = `${category}:${providerFileNameKey(target)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const fileName = relative(this.directoryFor(category), target).split(sep).join("/");
            if (!validProviderKey(fileName) || providerFileNameKey(target) !== providerFileNameKey(this.pathForName(fileName, category))) {
              files.push({ category, fileName: FILE_NAME_PATTERN.test(basename(target)) ? basename(target) : "不支持清理的集合文件", sha256: "", identity: "", action: "keep", reason: "ownership_unknown" });
            } else files.push(await this.cleanupItem(category, fileName, input.configName, references, false, configSources));
          }
        }
        return { files };
      }
      for (const category of input.category ? [input.category] : ["proxy", "rule"] as const) {
        for (const fileName of await providerFileKeys(this.directoryFor(category))) {
          files.push(await this.cleanupItem(category, fileName, undefined, references, false, configSources));
        }
      }
      return { files };
    });
  }

  cleanup(files: Pick<ProviderCleanupItem, "category" | "fileName" | "sha256" | "identity">[], selected = false) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      const references = await rememberHttpCachePaths(this.httpContext());
      const results: ProviderCleanupItem[] = [];
      for (const expected of files) {
        const current = await this.cleanupItem(expected.category, expected.fileName, undefined, references, selected);
        if (current.action === "delete" && (current.sha256 !== expected.sha256 || current.identity !== expected.identity)) {
          current.action = "keep"; current.reason = "changed";
        }
        if (current.action === "delete") {
          try {
            await this.deleteUnqueued(current.category, current.fileName, current.sha256, undefined, undefined, undefined, current.identity, selected, references);
            current.action = "deleted"; current.reason = "deleted";
          } catch (error) {
            current.action = "keep";
            current.reason = error instanceof ProviderRuntimeReferenceError ? error.reason
              : error instanceof ProviderFileReferencedError ? "referenced"
              : error instanceof ProviderFileConflictError ? "changed" : "delete_failed";
            if (error instanceof ProviderFileReferencedError) {
              current.configNames = error.configNames;
              if (error.configReferences) current.configReferences = error.configReferences;
            }
            // A pending journal must be recovered before attempting another file.
            await this.ensureProviderOperationRecovered();
          }
        }
        results.push(current);
      }
      return { files: results };
    });
  }

  private async cleanupItem(category: ProviderCategory, fileName: string, ignoredConfigName?: string,
    references?: Map<string, Set<ProviderCategory> | null>, selected = false,
    configSources?: Map<string, ConfigReferenceSource>): Promise<ProviderCleanupItem> {
    const item: ProviderCleanupItem = { category, fileName, sha256: "", identity: "", action: "keep", reason: "unreadable" };
    try {
      const file = await this.record(fileName, category, references);
      const proof = await readControlledFile(this.pathForName(fileName, category), this.options.maxContentBytes);
      if (!proof || proof.sha256 !== file.sha256) return item;
      item.sha256 = file.sha256;
      item.identity = hash(JSON.stringify([String(proof.device), String(proof.inode), file.sha256, file.source, file.ownerId, this.isHttpCache(category, fileName)]));
      // Explicit selection authorizes controlled files regardless of reference or maintenance status.
      if (selected) { item.action = "delete"; item.reason = "unused"; return item; }
      const evidence = await this.inspectFileReferences(fileName, ignoredConfigName, category, configSources);
      item.configReferences = evidence.configReferences;
      item.configNames = [...new Set(evidence.configReferences.map((entry) => entry.configName))].sort();
      item.runtime = evidence.runtime;
      if (category === "proxy" && (subscriptionReservations(this.options.subscriptions?.() ?? [], fileName).length || localReservations(this.state.local, fileName).length)) {
        item.reason = "maintained"; return item;
      }
      assertReferencesUnreferenced(evidence.configReferences, evidence.runtime);
      if (file.source !== "manual" && !this.isHttpCache(category, fileName)) { item.reason = "ownership_unknown"; return item; }
      item.action = "delete"; item.reason = "unused";
    } catch (error) {
      if (error instanceof ProviderRuntimeReferenceError) item.reason = error.reason;
      else if (error instanceof ProviderFileReferencedError) {
        item.reason = "referenced"; item.configNames = error.configNames;
        if (error.configReferences) item.configReferences = error.configReferences;
      }
      else if (error instanceof ProviderFileConflictError) item.reason = "changed";
    }
    return item;
  }

  private isHttpCache(category: ProviderCategory, fileName: string) {
    return (this.state.httpCachePaths ?? []).includes(this.pathForName(fileName, category));
  }

  private async deleteUnqueued(
    category: ProviderCategory,
    fileName: string,
    expectedSha256: string,
    commitState?: () => Promise<void>,
    ignoredConfigName?: string,
    configTransaction?: { name: string; beforeSha256: string; afterSha256: string },
    cleanupIdentity?: string,
    selected = false,
    references?: Map<string, Set<ProviderCategory> | null>,
  ) {
      await this.ensureProviderOperationRecovered();
      const httpCache = Boolean(cleanupIdentity) && this.isHttpCache(category, fileName);
      if (cleanupIdentity && !selected) {
        const eligible = await this.cleanupItem(category, fileName, undefined, references);
        if (eligible.action !== "delete") throw new ProviderFileReadOnlyError("file is not eligible for cleanup");
        if (eligible.identity !== cleanupIdentity) throw new ProviderFileConflictError("provider file changed");
      }
      const current = httpCache || selected ? await this.record(fileName, category, references) : await this.assertManual(category, fileName);
      if (current.sha256 !== expectedSha256) throw new ProviderFileConflictError("provider file changed");
      const maintainedOwner = selected && category === "proxy" && current.ownerId &&
        (current.source === "local" || current.source === "subscription")
        ? { kind: current.source, id: current.ownerId } : undefined;
      if (maintainedOwner?.kind === "subscription" && !this.options.clearSubscriptionProviderUnqueued) {
        throw new ProviderFileRecoveryError("subscription state writer is unavailable");
      }
      if (!selected) await this.assertUnreferenced(fileName, ignoredConfigName, category);
      const path = this.pathForName(fileName, category);
      await deleteProviderFile(this.operationContext(category), {
        category, fileName, path, expectedSha256, current, httpCache, selected, maintainedOwner, configTransaction, cleanupIdentity,
      }, commitState);
      return current;
  }

  deleteWithConfig(input: {
    category: ProviderCategory;
    fileName: string;
    expectedSha256: string;
    configName: string;
    configContent: string;
    expectedConfigSha256: string;
  }) {
    return this.writeQueue.enqueue(async () => {
      await this.assertConfigCandidateReferences(input.configContent, input.fileName, null, input.category);
      let savedConfig: Awaited<ReturnType<ConfigStore["saveFileUnqueued"]>> | null = null;
      await this.deleteUnqueued(
        input.category,
        input.fileName,
        input.expectedSha256,
        async () => {
          const previous = await this.options.store.read(input.configName);
          if (previous.sha256 !== input.expectedConfigSha256) {
            throw new ProviderFileConflictError("configuration changed");
          }
          savedConfig = await this.options.store.saveFileUnqueued(
            input.configName,
            input.configContent,
            input.expectedConfigSha256,
          );
          try {
            const next = {
              ...this.state,
              manual: this.state.manual.filter(
                (entry) => entry.category !== input.category || providerFileNameKey(entry.fileName) !== providerFileNameKey(input.fileName),
              ),
            };
            await this.writeState(next);
            this.state = next;
          } catch (error) {
            try {
              await this.options.store.restoreFileUnqueued(
                input.configName,
                previous.content,
                savedConfig.sha256,
              );
            } catch (rollbackError) {
              throw new ProviderFileRecoveryError("provider delete configuration rollback failed", {
                cause: new AggregateError([error, rollbackError]),
              });
            }
            throw error;
          }
        },
        input.configName,
        {
          name: input.configName,
          beforeSha256: input.expectedConfigSha256,
          afterSha256: hash(input.configContent),
        },
      );
      return { config: savedConfig! };
    });
  }

  deleteOwnedSourceWithConfig(input: {
    source: "local" | "subscription";
    ownerId: string;
    fileName: string;
    expectedSha256: string;
    configName: string;
    configContent: string;
    expectedConfigSha256: string;
  }, commitSubscription?: () => Promise<() => Promise<void>>) {
    return this.writeQueue.enqueue(async () => {
      await this.ensureProviderOperationRecovered();
      const current = await this.record(input.fileName, "proxy");
      if (current.source !== input.source || current.ownerId !== input.ownerId) {
        throw new ProviderFileReadOnlyError("provider source ownership is unavailable");
      }
      if (current.sha256 !== input.expectedSha256) throw new ProviderFileConflictError("provider file changed");
      if (input.source === "subscription" && !commitSubscription) {
        throw new ProviderFileReadOnlyError("subscription provider ownership is unavailable");
      }
      const localOwner = input.source === "local"
        ? this.state.local.find((entry) => entry.id === input.ownerId)
        : null;
      if (input.source === "local" && (!localOwner || localOwner.fileName !== input.fileName || localOwner.providerSha256 !== input.expectedSha256)) {
        throw new ProviderFileReadOnlyError("local provider ownership is unavailable");
      }
      await this.assertConfigCandidateReferences(input.configContent, input.fileName, null, "proxy");
      await this.assertUnreferenced(input.fileName, input.configName, "proxy");
      const previousConfig = await this.options.store.read(input.configName);
      if (previousConfig.sha256 !== input.expectedConfigSha256) throw new ProviderFileConflictError("configuration changed");

      const sourcePath = this.pathForName(input.fileName, "proxy");
      const backupPath = this.hiddenPath(hiddenFileName("source-delete"), "proxy");
      const before = await readControlledFile(sourcePath, this.options.maxContentBytes);
      if (!before || before.sha256 !== input.expectedSha256) throw new ProviderFileConflictError("provider file changed");
      await link(sourcePath, backupPath);
      let savedConfig: Awaited<ReturnType<ConfigStore["saveFileUnqueued"]>> | null = null;
      let rollbackOwner: (() => Promise<void>) | null = null;
      let sourceRemoved = false;
      try {
        if (input.configContent !== previousConfig.content) {
          savedConfig = await this.options.store.saveFileUnqueued(
            input.configName,
            input.configContent,
            input.expectedConfigSha256,
          );
        }
        if (input.source === "local") {
          const next = { ...this.state, local: this.state.local.filter((entry) => entry.id !== input.ownerId) };
          await this.writeState(next);
          this.state = next;
          rollbackOwner = async () => {
            const restored = { ...this.state, local: [...this.state.local, localOwner!] };
            await this.writeState(restored);
            this.state = restored;
          };
        } else {
          rollbackOwner = await commitSubscription!();
        }
        const latest = await readControlledFile(sourcePath, this.options.maxContentBytes);
        const backup = await readControlledFile(backupPath, this.options.maxContentBytes);
        if (!latest || !backup || latest.sha256 !== input.expectedSha256 || !sameFileIdentity(latest, backup)) {
          throw new ProviderFileConflictError("provider file changed");
        }
        await this.options.beforeOwnedSourceFileDelete?.();
        await unlink(sourcePath);
        sourceRemoved = true;
        await unlink(backupPath);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (sourceRemoved) {
          try { await link(backupPath, sourcePath); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        if (rollbackOwner) {
          try { await rollbackOwner(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        if (savedConfig) {
          try {
            await this.options.store.restoreFileUnqueued(input.configName, previousConfig.content, savedConfig.sha256);
          } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        await unlink(backupPath).catch((rollbackError) => rollbackErrors.push(rollbackError));
        if (rollbackErrors.length > 0) {
          throw new ProviderFileRecoveryError("provider source delete rollback failed", {
            cause: new AggregateError([error, ...rollbackErrors]),
          });
        }
        throw error;
      }
      return { config: savedConfig ?? previousConfig };
    });
  }

  saveFilterSettings(fileName: string, input: {
    expectedVersion: number;
    enabled: boolean;
    rules: string[];
  }) {
    return this.writeQueue.enqueue(() => this.saveFilterSettingsUnqueued(fileName, input));
  }

  // Only call while holding the shared WriteQueue.
  async saveFilterSettingsUnqueued(fileName: string, input: {
    expectedVersion: number;
    enabled: boolean;
    rules: string[];
  }) {
    await this.ensureProviderOperationRecovered();
    const record = await this.record(fileName);
    const subscription = await this.verifiedSubscriptionForFile(fileName, record.sha256);
    if (record.source !== "subscription" || !subscription) {
      throw new ProviderFileReadOnlyError("filter settings require a subscription provider");
    }
    const key = filterKey(subscription.id);
    const current = this.state.filters[key] ?? { version: 0, enabled: false, rules: [] };
    if (current.version !== input.expectedVersion) {
      throw new ProviderFilterConflictError("provider filter settings changed");
    }
    if (!Array.isArray(input.rules) || input.rules.length > 100 || input.rules.some(
      (rule) => typeof rule !== "string" || rule.length > 200,
    )) throw new ProviderFileValidationError("invalid provider filter settings");
    try { validateProviderFilterRules(input.rules); } catch {
      throw new ProviderFileValidationError("invalid provider filter settings");
    }
    const settings = {
      version: current.version + 1,
      enabled: input.enabled,
      rules: input.rules.map((rule) => rule.trim()).filter(Boolean),
    };
    const next = { ...this.state, filters: { ...this.state.filters, [key]: settings } };
    await this.writeState(next);
    this.state = next;
    return settings;
  }

  filterSettingsForSubscription(subscriptionId: string): ProviderFilterSettings {
    return this.state.filters[filterKey(subscriptionId)] ?? { version: 0, enabled: false, rules: [] };
  }

  async saveFilterSettingsAndRegenerate<T>(
    fileName: string,
    input: { expectedVersion: number; enabled: boolean; rules: string[] },
    regenerate: (markCommitted: () => void) => Promise<T>,
  ) {
    return this.writeQueue.enqueue(async () => {
      const previousRecord = await this.readSnapshotUnqueued(fileName);
      const previous = previousRecord.filterSettings ?? { version: 0, enabled: false, rules: [] };
      const settings = await this.saveFilterSettingsUnqueued(fileName, input);
      let committed = false;
      try {
        const provider = await regenerate(() => { committed = true; });
        return { settings, provider };
      } catch (error) {
        if (!committed) await this.restoreFilterSettingsUnqueued(fileName, settings.version, previous);
        throw error;
      }
    });
  }

  private async restoreFilterSettingsUnqueued(
    fileName: string,
    expectedVersion: number,
    previous: ProviderFilterSettings,
  ) {
    await this.ensureProviderOperationRecovered();
    const record = await this.record(fileName);
    const subscription = await this.verifiedSubscriptionForFile(fileName, record.sha256);
    if (record.source !== "subscription" || !subscription) {
      throw new ProviderFileReadOnlyError("filter settings require a subscription provider");
    }
    const key = filterKey(subscription.id);
    const current = this.state.filters[key] ?? { version: 0, enabled: false, rules: [] };
    if (current.version !== expectedVersion) {
      throw new ProviderFilterConflictError("provider filter settings changed");
    }
    const filters = { ...this.state.filters };
    if (previous.version === 0 && !previous.enabled && previous.rules.length === 0) delete filters[key];
    else filters[key] = previous;
    const next = { ...this.state, filters };
    await this.writeState(next);
    this.state = next;
    return previous;
  }

  private directoryFor(category: ProviderCategory) {
    return resolve(category === "rule"
      ? this.options.ruleProviderDir ?? join(this.options.dataDir, "ruleset")
      : this.options.providerDir);
  }

  private operationCategory(journal: ProviderOperationJournal | ProviderRenameJournal): ProviderCategory {
    return "category" in journal && journal.category === "rule" ? "rule" : "proxy";
  }

  private pathForName(fileName: string, category: ProviderCategory = "proxy") {
    return providerFilePath(this.directoryFor(category), fileName);
  }

  private temporaryPath(fileName: string, operation: string, category: ProviderCategory = "proxy") {
    return resolve(this.directoryFor(category), `.${basename(fileName)}.${operation}-${randomBytes(8).toString("hex")}`);
  }

  private hiddenPath(fileName: string, category: ProviderCategory = "proxy") {
    return hiddenProviderPath(this.directoryFor(category), fileName);
  }

  private async record(fileName: string, category: ProviderCategory = "proxy", references?: Map<string, Set<ProviderCategory> | null>): Promise<ProviderFileRecord> {
    const { content: _content, ...record } = await this.readSnapshotUnqueued(fileName, category, references);
    return record;
  }

  private async readSnapshotUnqueued(fileName: string, requestedCategory: ProviderCategory = "proxy", references?: Map<string, Set<ProviderCategory> | null>): Promise<ProviderFileRecord & { content: string }> {
    if (this.isJournalAliasHidden(fileName, requestedCategory)) {
      throw new ProviderFileNotFoundError("provider file not found");
    }
    const path = this.pathForName(fileName, requestedCategory);
    try {
      const { metadata, content } = await readStableFile(path, this.options.maxContentBytes);
      if (content.byteLength > this.options.maxContentBytes) {
        throw new ProviderFileValidationError("provider file exceeds the size limit");
      }
      const manualCandidates = manualEntries(this.state.manual, fileName, requestedCategory);
      const reservationCandidates = requestedCategory === "proxy" ? subscriptionReservations(this.options.subscriptions?.() ?? [], fileName) : [];
      const localCandidates = requestedCategory === "proxy" ? localReservations(this.state.local, fileName) : [];
      const manuals = [] as typeof manualCandidates;
      for (const candidate of manualCandidates) {
        const authority = await readControlledIdentity(this.pathForName(candidate.fileName, candidate.category));
        if (authority && sameFileIdentity({ device: metadata.dev, inode: metadata.ino }, authority)) {
          manuals.push(candidate);
        }
      }
      const reservations = [] as typeof reservationCandidates;
      for (const candidate of reservationCandidates) {
        const authority = await readControlledIdentity(this.pathForName(`${candidate.providerName}.yaml`));
        if (authority && sameFileIdentity({ device: metadata.dev, inode: metadata.ino }, authority)) {
          reservations.push(candidate);
        }
      }
      const locals = [] as typeof localCandidates;
      for (const candidate of localCandidates) {
        const authority = await readControlledIdentity(this.pathForName(candidate.fileName));
        if (authority && sameFileIdentity({ device: metadata.dev, inode: metadata.ino }, authority)) {
          locals.push(candidate);
        }
      }
      const subscription = manualCandidates.length === 0 && reservationCandidates.length === 1 &&
          reservations.length === 1 && reservations[0]?.providerSha256 === hash(content)
        ? reservations[0]
        : null;
      const local = manualCandidates.length === 0 && reservationCandidates.length === 0 &&
          localCandidates.length === 1 && locals.length === 1 && locals[0]?.providerSha256 === hash(content)
        ? locals[0]
        : null;
      const manual = reservationCandidates.length === 0 && localCandidates.length === 0 &&
          manualCandidates.length === 1 && manuals.length === 1
        ? manuals[0]
        : null;
      const ordinaryWritable = await this.ordinaryFileWritable(requestedCategory, fileName, references);
      const category = manual?.category ?? (subscription || local ? "proxy" : ordinaryWritable ? requestedCategory : requestedCategory === "rule" ? "rule" : inferCategory(content.toString("utf8")));
      const source = manual ? "manual" : subscription ? "subscription" : local ? "local" : "external";
      const referencePath = relative(resolve(this.options.dataDir), path);
      if (!isWithin(resolve(this.options.dataDir), path)) {
        throw new ProviderFileNotFoundError("provider file is outside the Mihomo data directory");
      }
      return {
        fileName,
        referencePath: `./${referencePath.split("\\").join("/")}`,
        category,
        source,
        writable: category !== "unknown" && ordinaryWritable,
        sha256: hash(content),
        size: metadata.size,
        updatedAt: metadata.mtime.toISOString(),
        filterSettings: subscription
          ? this.state.filters[filterKey(subscription.id)] ?? { version: 0, enabled: false, rules: [] }
          : local?.filterSettings ?? null,
        extractionId: local?.id ?? null,
        ownerId: manual ? null : subscription?.id ?? local?.id ?? null,
        content: content.toString("utf8"),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProviderFileNotFoundError("provider file not found");
      }
      throw error;
    }
  }

  private async assertManual(category: ProviderCategory, fileName: string) {
    const record = await this.record(fileName, category);
    if (record.category !== category || record.source !== "manual") {
      throw new ProviderFileReadOnlyError("provider file is read-only");
    }
    return record;
  }

  private assertSubscriptionReservation(identity: SubscriptionProviderIdentity, requireExtract = true) {
    const owner = (this.options.subscriptions?.() ?? []).find((item) => item.id === identity.subscriptionId);
    if (
      !owner || (requireExtract ? !owner.extractProvider : !reservesProviderIdentity(owner)) || !owner.providerName ||
      providerFileNameKey(`${owner.providerName}.yaml`) !== providerFileNameKey(identity.fileName)
    ) {
      throw new ProviderFileReadOnlyError("subscription provider ownership is unavailable");
    }
    return owner;
  }

  private async verifiedSubscriptionForFile(fileName: string, actualSha256: string) {
    const reservations = subscriptionReservations(this.options.subscriptions?.() ?? [], fileName);
    if (manualEntries(this.state.manual, fileName).length > 0 || reservations.length !== 1) return null;
    const owner = reservations[0]!;
    return owner.providerSha256 && owner.providerSha256 === actualSha256 ? owner : null;
  }

  private isJournalAliasHidden(fileName: string, category: ProviderCategory = "proxy") {
    const journal = this.state.operationJournal;
    if (!journal || this.operationCategory(journal) !== category) return false;
    if (journal.operation === "rename") {
      if (journal.phase === "aborting") return false;
      const committed = renameStateCommitted(this.renameContext(category), journal);
      return committed
        ? fileName === journal.sourceFileName
        : fileName === journal.targetFileName;
    }
    if (journal.operation === "create") {
      return (journal.restoreManual ? journal.phase !== "committed" : manualEntries(this.state.manual, journal.fileName, journal.category).length === 0) &&
        providerFileNameKey(fileName) === providerFileNameKey(journal.fileName);
    }
    if (journal.operation === "delete") {
      return (journal.selected ? journal.phase === "committed" : manualEntries(this.state.manual, journal.fileName, journal.category).length === 0) &&
        providerFileNameKey(fileName) === providerFileNameKey(journal.fileName);
    }
    const owner = publishOwner(this.publishContext(), journal);
    if (!owner) return providerFileNameKey(fileName) === providerFileNameKey(journal.fileName);
    return owner.providerSha256 === journal.beforeSha256 && journal.phase === "published" &&
      providerFileNameKey(fileName) === providerFileNameKey(journal.fileName);
  }

  private localContext(): LocalExtractionContext {
    const service = this;
    return {
      ...this.publishContext(),
      dataDir: this.options.dataDir,
      store: this.options.store,
      get subscriptions() { return service.options.subscriptions?.() ?? []; },
      rename: this.renameContext("proxy"),
      ensureRecovered: () => this.ensureProviderOperationRecovered(),
      assertUnreferenced: (fileName) => this.assertUnreferenced(fileName),
      assertMissingExtractionUnreferenced: async (fileName) => {
        const { configReferences, runtime } = await this.inspectFileReferences(fileName);
        if (configReferences.length) throw new ProviderFileReferencedError(
          [...new Set(configReferences.map((reference) => reference.configName))], configReferences,
        );
        if (runtime.references.length) throw new ProviderRuntimeReferenceError("runtime_reference");
        if (!runtime.scanComplete) throw new ProviderRuntimeReferenceError("runtime_unknown");
        // Only an inactive, absent-output definition is removed; no runtime file is changed.
      },
      snapshotLocalExtractions: () => this.localExtractions(),
    };
  }

  private httpContext(): HttpCollectionContext {
    const service = this;
    return {
      dataDir: this.options.dataDir,
      store: this.options.store,
      owner: {
        get current() { return service.state; },
        commit: async (update, invokeHook = true) => {
          const next = { ...this.state, ...update };
          await this.writeState(next, invokeHook);
          this.state = next;
        },
      },
    };
  }

  private operationContext(category: ProviderCategory): ProviderOperationContext {
    const service = this;
    return {
      directory: this.directoryFor(category),
      maxContentBytes: this.options.maxContentBytes,
      owner: {
        get current() { return service.state; },
        get journal() { return service.state.operationJournal; },
        commit: async (update) => {
          const next = { ...this.state, ...update };
          await this.writeState(next);
          this.state = next;
        },
        writeJournal: (journal) => this.writeOperationJournal(journal),
        clearJournal: () => this.clearOperationJournal(),
        recover: () => this.recoverProviderOperation(),
      },
      hooks: {
        beforeFileRename: this.options.beforeFileRename,
        beforeOperationCleanup: this.options.beforeOperationCleanup,
        afterOperationPhase: this.options.afterOperationPhase,
      },
    };
  }

  private renameContext(category: ProviderCategory): ProviderRenameContext {
    const context = this.operationContext(category);
    const service = this;
    return {
      ...context,
      get subscriptions() { return service.options.subscriptions?.() ?? []; },
      hooks: {
        ...context.hooks,
        beforeRenameCleanup: this.options.beforeRenameCleanup,
        afterRenamePhase: this.options.afterRenamePhase,
        afterCaseAliasRemoval: this.options.afterCaseAliasRemoval,
      },
    };
  }

  private publishContext(): ProviderPublishContext {
    const context = this.operationContext("proxy");
    const service = this;
    return {
      ...context,
      get subscriptions() { return service.options.subscriptions?.() ?? []; },
      hooks: {
        ...context.hooks,
        afterProviderFilePublish: this.options.afterProviderFilePublish,
      },
    };
  }

  private async recoverProviderOperation() {
    const journal = this.state.operationJournal;
    if (!journal) return;
    await this.reconcileManagedConfigJournal(journal);
    if (journal.operation === "create") return recoverCreate(this.operationContext(journal.category), journal);
    if (journal.operation === "delete") return recoverDelete(this.operationContext(journal.category), journal, this.options.clearSubscriptionProviderUnqueued);
    if (journal.operation === "publish") return recoverPublish(this.publishContext(), journal);
    return recoverRename(this.renameContext(this.operationCategory(journal)), journal);
  }

  private async reconcileManagedConfigJournal(journal: ProviderOperationJournal) {
    if (journal.operation !== "rename" && journal.operation !== "delete" && journal.operation !== "create") return;
    if (journal.operation === "rename" && journal.configs) {
      const snapshots = await Promise.all(journal.configs.map((entry) => this.options.store.read(entry.name)));
      if (snapshots.some((snapshot, index) => snapshot.sha256 !== journal.configs![index]!.beforeSha256 &&
        snapshot.sha256 !== journal.configs![index]!.afterSha256)) {
        throw new ProviderFileReferencedError(journal.configs.map((entry) => entry.name));
      }
      const committed = snapshots.every((snapshot, index) => snapshot.sha256 === journal.configs![index]!.afterSha256) &&
        (journal.phase === "committed" || journal.configs.some((entry) => entry.beforeSha256 !== entry.afterSha256));
      if (!committed) {
        for (const [index, snapshot] of snapshots.entries()) {
          const entry = journal.configs[index]!;
          if (snapshot.sha256 !== entry.beforeSha256) {
            await this.options.store.restoreFileUnqueued(entry.name, entry.before, snapshot.sha256);
          }
        }
      }
      const category = journal.category ?? "proxy";
      const manual = journal.kind === "manual" ? [
        ...this.state.manual.filter((entry) => entry.category !== category ||
          (entry.fileName !== journal.sourceFileName && entry.fileName !== journal.targetFileName)),
        ...(!committed || journal.retainedSource ? [{ category, fileName: journal.sourceFileName }] : []),
        ...(committed ? [{ category, fileName: journal.targetFileName }] : []),
      ] : this.state.manual;
      const next = { ...this.state, manual,
        operationJournal: { ...journal, phase: committed ? "committed" as const : journal.phase === "committed" ? "linked" as const : journal.phase },
      };
      await this.writeState(next);
      this.state = next;
      return;
    }
    if (!journal.configName || !journal.configBeforeSha256 || !journal.configAfterSha256) return;
    const snapshot = await this.options.store.read(journal.configName);
    const after = snapshot.sha256 === journal.configAfterSha256;
    const before = snapshot.sha256 === journal.configBeforeSha256;
    if (!after && !before) {
      throw new ProviderFileRecoveryError("provider configuration transaction is ambiguous; recovery is incomplete");
    }
    if (journal.operation === "create") {
      const matches = manualEntries(this.state.manual, journal.fileName, journal.category);
      if (matches.length > 1) throw new ProviderFileRecoveryError("provider create ownership is ambiguous");
      if ((after && !matches.length) || (before && matches.length)) {
        const next = { ...this.state, manual: after
          ? [...this.state.manual, { fileName: journal.fileName, category: journal.category }]
          : this.state.manual.filter((entry) => entry.category !== journal.category || entry.fileName !== journal.fileName) };
        await this.writeState(next);
        this.state = next;
      }
      return;
    }
    if (journal.operation === "rename" && journal.kind === "manual") {
      const category = journal.category ?? "proxy";
      const source = this.state.manual.filter((entry) => entry.category === category && entry.fileName === journal.sourceFileName);
      const target = this.state.manual.filter((entry) => entry.category === category && entry.fileName === journal.targetFileName);
      if (source.length + target.length !== 1) {
        throw new ProviderFileRecoveryError("provider rename ownership is ambiguous; recovery is incomplete");
      }
      if (after && source.length === 1) {
        const next = {
          ...this.state,
          manual: this.state.manual.map((entry) => entry.category === category && entry.fileName === journal.sourceFileName
            ? { ...entry, fileName: journal.targetFileName }
            : entry),
        };
        await this.writeState(next);
        this.state = next;
      } else if (before && target.length === 1) {
        const next = {
          ...this.state,
          manual: this.state.manual.map((entry) => entry.category === category && entry.fileName === journal.targetFileName
            ? { ...entry, fileName: journal.sourceFileName }
            : entry),
        };
        await this.writeState(next);
        this.state = next;
      }
    }
    if (journal.operation === "delete") {
      const matches = manualEntries(this.state.manual, journal.fileName, journal.category);
      if (matches.length > 1) {
        throw new ProviderFileRecoveryError("provider delete ownership is ambiguous; recovery is incomplete");
      }
      if (after && matches.length === 1) {
        const next = {
          ...this.state,
          manual: this.state.manual.filter((entry) =>
            entry.category !== journal.category || providerFileNameKey(entry.fileName) !== providerFileNameKey(journal.fileName)),
        };
        await this.writeState(next);
        this.state = next;
      } else if (before && matches.length === 0) {
        const next = {
          ...this.state,
          manual: [...this.state.manual, { fileName: journal.fileName, category: journal.category }],
        };
        await this.writeState(next);
        this.state = next;
      }
    }
  }

  private async recoverProviderOperationSafely() {
    try {
      await this.recoverProviderOperation();
    } catch (error) {
      if (error instanceof ProviderFileRecoveryError) throw error;
      throw new ProviderFileRecoveryError("provider operation recovery is incomplete", { cause: error });
    }
  }

  private async writeOperationJournal(operationJournal: ProviderOperationJournal) {
    const next = { ...this.state, operationJournal, renameJournal: null };
    await this.writeState(next, false);
    this.state = next;
  }

  private async clearOperationJournal() {
    const next = { ...this.state, operationJournal: null, renameJournal: null };
    await this.writeState(next, false);
    this.state = next;
  }

  private async assertUnreferenced(fileName: string, ignoredConfigName?: string, category: ProviderCategory = "proxy",
    configSources?: Map<string, ConfigReferenceSource>) {
    const evidence = await this.inspectFileReferences(fileName, ignoredConfigName, category, configSources);
    assertReferencesUnreferenced(evidence.configReferences, evidence.runtime);
  }

  private async inspectFileReferences(fileName: string, ignoredConfigName?: string, category: ProviderCategory = "proxy",
    configSources?: Map<string, ConfigReferenceSource>) {
    const target = this.pathForName(fileName, category);
    const targetIdentity = await readControlledFile(target, this.options.maxContentBytes);
    const sources = configSources ?? new Map<string, ConfigReferenceSource>();
    if (!configSources) {
      for (const file of await this.options.store.list()) sources.set(file.name, await readConfigReferenceSource(file.name, this.options.store));
    }
    const references: ProviderConfigReference[] = [];
    const addReference = (configName: string, kind: ProviderConfigReference["kind"], path?: string) => {
      if (!references.some((entry) => entry.configName === configName && entry.kind === kind && entry.path === path)) {
        references.push({ configName, kind, ...(path ? { path } : {}) });
      }
    };
    for (const [configName, source] of sources) {
      if (configName === ignoredConfigName) continue;
      try {
        if (source.unreadable) addReference(configName, "unreadable");
        const scan = await configReferencesFile(source.config, target, targetIdentity, this.options.dataDir, this.options.maxContentBytes);
        if (!scan.complete) addReference(configName, "unreadable");
        for (const entry of scan.references) {
          addReference(configName, entry.kind, entry.path);
        }
        for (const owner of this.state.manualHttp ?? []) {
          if (owner.configName !== configName || !owner.declaration) continue;
          const ownerScan = await configReferencesFile({ [`${owner.category}-providers`]: { [owner.name]: owner.declaration } }, target, targetIdentity, this.options.dataDir, this.options.maxContentBytes);
          if (!ownerScan.complete) addReference(configName, "unreadable");
          for (const entry of ownerScan.references) {
            addReference(configName, entry.kind, entry.path);
          }
        }
      } catch {
        addReference(configName, "unreadable");
      }
    }
    // Recorded versions protect dependencies; even a successful application
    // does not continuously prove which files Core currently uses.
    let runtime: ProviderRuntimeReferences;
    try {
      runtime = await runtimeReferences(this.cleanupRuntime ?? await this.options.readRuntimeDependencies?.(), target, targetIdentity, this.options.dataDir, this.options.maxContentBytes);
    } catch {
      runtime = { references: [], uncertain: true, scanComplete: false, unknownReason: "record_unreadable" };
    }
    const finalTargetIdentity = await readControlledFile(target, this.options.maxContentBytes);
    if (
      targetIdentity
        ? !finalTargetIdentity || !sameFileIdentity(targetIdentity, finalTargetIdentity)
        : Boolean(finalTargetIdentity)
    ) {
      throw new ProviderFileConflictError("provider file changed");
    }
    return { configReferences: references.sort((left, right) => left.configName.localeCompare(right.configName) || left.kind.localeCompare(right.kind) || (left.path ?? "").localeCompare(right.path ?? "")), runtime };
  }

  private async assertConfigCandidateReferences(
    content: string,
    sourceFileName: string,
    targetFileName: string | null,
    category: ProviderCategory = "proxy",
  ) {
    let config: Record<string, unknown> | null = null;
    try {
      config = recordValue(parse(content));
    } catch {
      throw new ProviderFileValidationError("configuration candidate is invalid");
    }
    if (!config) throw new ProviderFileValidationError("configuration candidate is invalid");
    if (configReferencesLexicalPath(config, this.pathForName(sourceFileName, category), this.options.dataDir)) {
      throw new ProviderFileReferencedError(["configuration candidate"]);
    }
    if (targetFileName) {
      if (!configReferencesLexicalPath(config, this.pathForName(targetFileName, category), this.options.dataDir)) {
        throw new ProviderFileValidationError("renamed provider is not referenced by the configuration candidate");
      }
    }
  }

  private async writeState(state: ProviderFileState, invokeHook = true) {
    await mkdir(dirname(this.options.statePath), { recursive: true });
    const temporary = `${this.options.statePath}.tmp-${randomBytes(8).toString("hex")}`;
    try {
      await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", flag: "wx", mode: 0o600 });
      if (invokeHook) await this.options.beforeStateRename?.();
      await rename(temporary, this.options.statePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
