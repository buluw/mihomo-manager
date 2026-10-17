import { randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parse, stringify } from "yaml";
import type { ConfigStore } from "../config/store.js";
import type { PublicSubscription } from "../subscriptions/types.js";
import { extractProvider, recordValue } from "./collectionYaml.js";
import { isWithin, providerFileNameKey, providerFilePath, readControlledFile, readControlledIdentity, readProviderSource, sameFileIdentity } from "./controlledFiles.js";
import { ProviderFileConflictError, ProviderFileExistsError, ProviderFileNotFoundError, ProviderFileReadOnlyError, ProviderFileValidationError, ProviderFilterConflictError } from "./errors.js";
import { validateProviderFilterRules } from "./extraction.js";
import { manualEntries, subscriptionReservations, localReservations, assertRenameTargetAvailable } from "./ownership.js";
import { publishProvider, type ProviderPublishContext } from "./publishOperation.js";
import { renameProviderFile, type ProviderRenameContext } from "./renameOperation.js";
import type { LocalProviderExtraction, LocalExtractionUpdateInput, LocalExtractionFilterInput, LocalExtractionCreateInput, LocalExtractionDeleteInput } from "./types.js";
export interface LocalExtractionContext extends ProviderPublishContext {
  dataDir: string;
  store: Pick<ConfigStore, "read" | "list">;
  readonly subscriptions: readonly PublicSubscription[];
  rename: ProviderRenameContext;
  ensureRecovered(): Promise<void>;
  assertUnreferenced(fileName: string): Promise<void>;
  assertMissingExtractionUnreferenced(fileName: string): Promise<void>;
  snapshotLocalExtractions(): LocalProviderExtraction[];
}
export async function deleteLocalExtraction(context: LocalExtractionContext, input: LocalExtractionDeleteInput) {
  const relation = context.owner.current.local.find((entry) => entry.id === input.id);
  if (!relation) throw new ProviderFileNotFoundError("local provider extraction not found");
  if (relation.configName !== input.configName || relation.sourceSha256 !== input.sourceSha256 ||
    relation.fileName !== input.fileName || relation.filterSettings.version !== input.filterVersion) {
    throw new ProviderFileConflictError("local extraction changed");
  }
  if (relation.enabled || relation.providerSha256 !== null || relation.nodeCount !== 0 ||
    (await context.store.list()).some((file) => file.name === relation.configName)) {
    throw new ProviderFileConflictError("local extraction source or output is still present");
  }
  if (manualEntries(context.owner.current.manual, relation.fileName).length ||
    subscriptionReservations(context.subscriptions, relation.fileName).length ||
    localReservations(context.owner.current.local, relation.fileName).length !== 1) {
    throw new ProviderFileConflictError("local extraction ownership changed");
  }
  const path = providerFilePath(context.directory, relation.fileName);
  if (await readControlledIdentity(path)) throw new ProviderFileConflictError("local provider file is still present");
  await context.assertMissingExtractionUnreferenced(relation.fileName);
  if (await readControlledIdentity(path)) throw new ProviderFileConflictError("local provider file changed");
  await context.owner.commit({ local: context.owner.current.local.filter((entry) => entry.id !== relation.id) });
}
export async function setLocalExtractionEnabled(context: LocalExtractionContext, id: string, enabled: boolean) {
  const relation = context.owner.current.local.find((entry) => entry.id === id);
  if (!relation)
    throw new ProviderFileNotFoundError("local provider extraction not found");
  if (relation.enabled === enabled)
    return { ...relation, filterSettings: { ...relation.filterSettings } };
  const updated = { ...relation, enabled };
  if (enabled) {
    await regenerateLocalExtraction(context, id, undefined, undefined, updated, relation);
    return context.snapshotLocalExtractions().find((entry) => entry.id === id)!;
  }
  const next = { local: context.owner.current.local.map((entry) => entry.id === id ? updated : entry) };
  await context.owner.commit(next);
  return { ...updated, filterSettings: { ...updated.filterSettings } };
}
export async function renameLocalExtraction(context: LocalExtractionContext, id: string, fileName: string) {
  const relation = context.owner.current.local.find((entry) => entry.id === id);
  if (!relation)
    throw new ProviderFileNotFoundError("local provider extraction not found");
  if (!relation.providerSha256)
    throw new ProviderFileConflictError("local provider is unavailable");
  if (relation.fileName === fileName)
    return { ...relation, filterSettings: { ...relation.filterSettings } };
  await context.assertUnreferenced(relation.fileName);
  await assertRenameTargetAvailable(context.rename, relation.id, fileName, relation.fileName);
  await renameProviderFile(context.rename, {
    kind: "local",
    subscriptionId: relation.id,
    sourceFileName: relation.fileName,
    targetFileName: fileName,
    sha256: relation.providerSha256,
  }, async () => {
    const current = context.owner.current.local.find((entry) => entry.id === id);
    if (current !== relation)
      throw new ProviderFileConflictError("local extraction was superseded");
    const updated = { ...current, fileName };
    const next = { local: context.owner.current.local.map((entry) => entry.id === id ? updated : entry) };
    await context.owner.commit(next);
  });
  return context.snapshotLocalExtractions().find((entry) => entry.id === id)!;
}
export async function updateLocalExtraction(context: LocalExtractionContext, input: LocalExtractionUpdateInput) {
  const relation = context.owner.current.local.find((entry) => entry.id === input.id);
  if (!relation)
    throw new ProviderFileNotFoundError("local provider extraction not found");
  if (relation.fileName !== input.currentFileName || relation.providerSha256 !== input.providerSha256 ||
    relation.enabled !== input.currentEnabled || relation.filterSettings.version !== input.filterSettings.version) {
    throw new ProviderFileConflictError("local extraction changed");
  }
  if (!Array.isArray(input.filterSettings.rules) || input.filterSettings.rules.length > 100 ||
    input.filterSettings.rules.some((rule) => typeof rule !== "string" || rule.length > 200)) {
    throw new ProviderFileValidationError("invalid provider filter settings");
  }
  try {
    validateProviderFilterRules(input.filterSettings.rules);
  }
  catch {
    throw new ProviderFileValidationError("invalid provider filter settings");
  }
  const nextFileName = input.fileName;
  if (nextFileName !== relation.fileName) {
    if (!relation.providerSha256)
      throw new ProviderFileConflictError("local provider is unavailable");
    await context.assertUnreferenced(relation.fileName);
    await assertRenameTargetAvailable(context.rename, relation.id, nextFileName, relation.fileName);
  }
  const nextSettings = {
    version: relation.filterSettings.version + 1,
    enabled: input.filterSettings.enabled,
    rules: input.filterSettings.rules.map((rule) => rule.trim()).filter(Boolean),
  };
  const candidate = { ...relation, fileName: nextFileName, enabled: input.enabled, filterSettings: nextSettings };
  if (input.enabled && nextFileName !== relation.fileName) {
    const source = await context.store.read(relation.configName);
    if (source.sha256 !== relation.sourceSha256)
      throw new ProviderFileConflictError("configuration changed");
    const oldPublished = await readControlledFile(providerFilePath(context.directory, relation.fileName), context.maxContentBytes);
    if (!oldPublished || oldPublished.sha256 !== relation.providerSha256)
      throw new ProviderFileConflictError("local provider file changed");
    const provider = await extractProviderSources(context, source.content, nextFileName);
    const committedRelation = (providerSha256: string): LocalProviderExtraction => ({
      ...candidate, sourceSha256: source.sha256, providerSha256, nodeCount: provider.nodeCount,
    });
    await publishProvider(context, {
      subscriptionId: relation.id, fileName: nextFileName, expectedSha256: null, content: provider.content,
    }, async (providerSha256) => {
      const current = context.owner.current.local.find((entry) => entry.id === relation.id);
      if (current !== relation)
        throw new ProviderFileConflictError("local extraction was superseded");
      const next = { local: context.owner.current.local.map((entry) => entry.id === relation.id ? committedRelation(providerSha256) : entry) };
      await context.owner.commit(next);
    }, "local", (intendedSha256) => ({
      before: relation,
      after: committedRelation(intendedSha256),
      source: {
        fileName: relation.fileName,
        sha256: oldPublished.sha256,
        device: String(oldPublished.device),
        inode: String(oldPublished.inode),
      },
    }));
    return context.snapshotLocalExtractions().find((entry) => entry.id === relation.id)!;
  }
  if (nextFileName !== relation.fileName) {
    await renameProviderFile(context.rename, {
      kind: "local", subscriptionId: relation.id, sourceFileName: relation.fileName,
      targetFileName: nextFileName, sha256: relation.providerSha256!,
    }, async () => {
      const next = { local: context.owner.current.local.map((entry) => entry.id === relation.id ? candidate : entry) };
      await context.owner.commit(next);
    });
  }
  if (input.enabled) {
    await regenerateLocalExtraction(context, relation.id, undefined, undefined, candidate, nextFileName !== relation.fileName ? candidate : relation);
  }
  else {
    const next = { local: context.owner.current.local.map((entry) => entry.id === relation.id ? candidate : entry) };
    await context.owner.commit(next);
  }
  return context.snapshotLocalExtractions().find((entry) => entry.id === relation.id)!;
}
export async function previewLocalExtraction(context: LocalExtractionContext, id: string, rules: string[]) {
  const relation = context.owner.current.local.find((entry) => entry.id === id);
  if (!relation)
    throw new ProviderFileNotFoundError("local provider extraction not found");
  const source = await context.store.read(relation.configName);
  const provider = await extractProviderSources(context, source.content, relation.fileName, { enabled: true, rules });
  return {
    totalCount: provider.totalCount,
    remainingCount: provider.nodeCount,
    matchedNames: provider.matchedNames,
  };
}
export async function saveLocalExtractionSettings(context: LocalExtractionContext, id: string, input: LocalExtractionFilterInput) {
  const relation = context.owner.current.local.find((entry) => entry.id === id);
  if (!relation)
    throw new ProviderFileNotFoundError("local provider extraction not found");
  if (relation.filterSettings.version !== input.expectedVersion) {
    throw new ProviderFilterConflictError("provider filter settings changed");
  }
  if (!Array.isArray(input.rules) || input.rules.length > 100 || input.rules.some((rule) => typeof rule !== "string" || rule.length > 200))
    throw new ProviderFileValidationError("invalid provider filter settings");
  try {
    validateProviderFilterRules(input.rules);
  }
  catch {
    throw new ProviderFileValidationError("invalid provider filter settings");
  }
  const previous = relation;
  const updated = {
    ...relation,
    filterSettings: {
      version: relation.filterSettings.version + 1,
      enabled: input.enabled,
      rules: input.rules.map((rule) => rule.trim()).filter(Boolean),
    },
  };
  if (!relation.enabled) {
    const next = { local: context.owner.current.local.map((entry) => entry.id === id ? updated : entry) };
    await context.owner.commit(next);
    return {
      settings: updated.filterSettings,
      provider: {
        category: "proxy" as const,
        name: relation.fileName.replace(/\.ya?ml$/i, ""),
        nodeCount: relation.nodeCount,
      },
    };
  }
  let committed = false;
  try {
    const provider = await regenerateLocalExtraction(context, id, undefined, () => { committed = true; }, updated, previous);
    return { settings: updated.filterSettings, provider };
  }
  catch (error) {
    if (!committed)
      await context.ensureRecovered();
    throw error;
  }
}
export async function createLocalExtraction(context: LocalExtractionContext, input: LocalExtractionCreateInput) {
  const snapshot = await context.store.read(input.configName);
  if (snapshot.sha256 !== input.sourceSha256)
    throw new ProviderFileConflictError("configuration changed");
  if (context.subscriptions.some((item) => item.configFileName === input.configName)) {
    throw new ProviderFileReadOnlyError("subscription configurations already own extraction");
  }
  if (context.owner.current.local.some((relation) => relation.configName === input.configName)) {
    throw new ProviderFileConflictError("configuration already has a local extraction");
  }
  if (manualEntries(context.owner.current.manual, input.fileName).length > 0 || subscriptionReservations(context.subscriptions, input.fileName).length > 0 ||
    localReservations(context.owner.current.local, input.fileName).length > 0)
    throw new ProviderFileExistsError("provider file name is unavailable");
  const existing = await readControlledFile(providerFilePath(context.directory, input.fileName), context.maxContentBytes);
  if (existing)
    throw new ProviderFileExistsError("provider file already exists");
  const relation: LocalProviderExtraction = {
    id: randomBytes(16).toString("hex"),
    configName: input.configName,
    sourceSha256: input.sourceSha256,
    fileName: input.fileName,
    providerSha256: null,
    nodeCount: 0,
    enabled: input.enabled ?? true,
    filterSettings: {
      version: 0,
      enabled: false,
      rules: [],
    },
  };
  if (!relation.enabled) {
    const next = { local: [...context.owner.current.local, relation] };
    await context.owner.commit(next);
    return { category: "proxy" as const, name: relation.fileName.replace(/\.ya?ml$/i, ""), nodeCount: 0 };
  }
  let committed = false;
  try {
    return await regenerateLocalExtraction(context, relation.id, snapshot, () => { committed = true; }, relation, null);
  }
  catch (error) {
    if (!committed)
      await context.ensureRecovered();
    throw error;
  }
}
async function extractProviderSources(context: LocalExtractionContext, content: string, outputFileName: string, settings?: {
  enabled: boolean;
  rules: string[];
}) {
  const providerRoot = resolve(context.directory);
  const canonicalProviderRoot = await realpath(providerRoot);
  const fileIdentity = (value: {
    dev: number | bigint;
    ino: number | bigint;
  }) => `${String(value.dev)}:${String(value.ino)}`;
  const generatedPaths = new Set<string>();
  const generatedFiles = new Set<string>();
  const generatedNames = new Set([
    outputFileName,
    ...context.owner.current.local.map((entry) => entry.fileName),
  ]);
  for (const fileName of generatedNames) {
    const outputPath = providerFilePath(context.directory, fileName);
    const identity = await readControlledIdentity(outputPath);
    if (!identity) {
      const canonicalParent = await realpath(dirname(outputPath));
      generatedPaths.add(providerFileNameKey(resolve(canonicalParent, basename(outputPath))));
      continue;
    }
    const canonical = await realpath(outputPath);
    const canonicalMetadata = await lstat(canonical);
    if (!canonicalMetadata.isFile() || !sameFileIdentity({ device: identity.device, inode: identity.inode }, { device: canonicalMetadata.dev, inode: canonicalMetadata.ino }))
      throw new ProviderFileConflictError("local provider file changed");
    generatedPaths.add(providerFileNameKey(canonical));
    generatedFiles.add(fileIdentity({ dev: identity.device, ino: identity.inode }));
  }
  const visited = new Set<string>();
  const parseSources = async (sourceContent: string, chain: ReadonlySet<string>): Promise<unknown[]> => {
    let parsed: Record<string, unknown> | null;
    try {
      parsed = recordValue(parse(sourceContent));
    }
    catch {
      throw new ProviderFileValidationError("provider source is invalid");
    }
    if (!parsed)
      throw new ProviderFileValidationError("provider source is invalid");
    const collected: unknown[] = [];
    if (parsed.proxies !== undefined) {
      const extracted = extractProvider(sourceContent);
      const normalized = recordValue(parse(extracted.content));
      collected.push(...((normalized?.proxies as unknown[]) ?? []));
    }
    const declarations = recordValue(parsed["proxy-providers"]);
    for (const declarationValue of Object.values(declarations ?? {})) {
      const declaration = recordValue(declarationValue);
      const type = typeof declaration?.type === "string" ? declaration.type.toLowerCase() : "";
      if (type === "inline") {
        const inline = extractProvider(stringify({ proxies: declaration?.payload }, { lineWidth: 0 }));
        collected.push(...((recordValue(parse(inline.content))?.proxies as unknown[]) ?? []));
        continue;
      }
      if (type !== "file" && type !== "http") {
        throw new ProviderFileValidationError("provider source type is unsupported");
      }
      if (typeof declaration?.path !== "string" || !declaration.path.trim()) {
        throw new ProviderFileValidationError("provider source path is invalid");
      }
      const configured = resolve(context.dataDir, declaration.path);
      if (!isWithin(providerRoot, configured)) {
        throw new ProviderFileValidationError("provider source is outside the controlled directory");
      }
      let canonical: string;
      let nestedContent: string;
      try {
        const stable = await readProviderSource(configured, canonicalProviderRoot, generatedPaths, generatedFiles, context.maxContentBytes);
        canonical = stable.canonical;
        nestedContent = new TextDecoder("utf-8", { fatal: true }).decode(stable.content);
      }
      catch {
        throw new ProviderFileValidationError("provider source cache is unavailable");
      }
      const identity = providerFileNameKey(canonical);
      if (chain.has(identity) || visited.has(identity)) {
        throw new ProviderFileValidationError("provider source cycle is not allowed");
      }
      visited.add(identity);
      collected.push(...await parseSources(nestedContent, new Set([...chain, identity])));
    }
    if (collected.length === 0)
      throw new ProviderFileValidationError("configuration does not contain proxies");
    return collected;
  };
  try {
    const proxies = await parseSources(content, new Set());
    return extractProvider(stringify({ proxies }, { lineWidth: 0 }), settings);
  }
  catch (error) {
    if (error instanceof ProviderFileValidationError)
      throw error;
    throw new ProviderFileValidationError("source configuration cannot be extracted", { cause: error });
  }
}
export async function regenerateLocalExtraction(context: LocalExtractionContext, id: string, snapshot?: Awaited<ReturnType<LocalExtractionContext["store"]["read"]>>, markCommitted?: () => void, candidate?: LocalProviderExtraction, before?: LocalProviderExtraction | null) {
  const relation = candidate ?? context.owner.current.local.find((entry) => entry.id === id);
  if (!relation)
    throw new ProviderFileNotFoundError("local provider extraction not found");
  if (!relation.enabled)
    throw new ProviderFileReadOnlyError("local extraction is disabled");
  const persisted = before === undefined ? relation : before;
  const source = snapshot ?? await context.store.read(relation.configName);
  if (source.name !== relation.configName)
    throw new ProviderFileConflictError("configuration changed");
  await assertLocalPublish(context, relation, persisted);
  const provider = await extractProviderSources(context, source.content, relation.fileName);
  const committedRelation = (providerSha256: string): LocalProviderExtraction => ({
    ...relation,
    sourceSha256: source.sha256,
    providerSha256,
    nodeCount: provider.nodeCount,
  });
  await publishProvider(context, {
    subscriptionId: relation.id,
    fileName: relation.fileName,
    expectedSha256: relation.providerSha256,
    content: provider.content,
  }, async (providerSha256) => {
    const current = context.owner.current.local.find((entry) => entry.id === relation.id);
    if (persisted === null ? current !== undefined : current !== persisted) {
      throw new ProviderFileConflictError("local extraction was superseded");
    }
    const updated = committedRelation(providerSha256);
    const next = persisted === null
      ? { local: [...context.owner.current.local, updated] }
      : { local: context.owner.current.local.map((entry) => entry.id === id ? updated : entry) };
    await context.owner.commit(next);
    markCommitted?.();
  }, "local", (intendedSha256) => ({
    before: persisted,
    after: committedRelation(intendedSha256),
  }));
  return { category: "proxy" as const, name: relation.fileName.replace(/\.ya?ml$/i, ""), nodeCount: provider.nodeCount };
}
async function assertLocalPublish(context: LocalExtractionContext, relation: LocalProviderExtraction, persisted: LocalProviderExtraction | null) {
  const current = context.owner.current.local.find((entry) => entry.id === relation.id);
  if ((persisted === null ? current !== undefined : current !== persisted) ||
    manualEntries(context.owner.current.manual, relation.fileName).length > 0 ||
    subscriptionReservations(context.subscriptions, relation.fileName).length > 0 ||
    localReservations(context.owner.current.local, relation.fileName).some((entry) => entry.id !== relation.id)) {
    throw new ProviderFileReadOnlyError("local provider ownership is unavailable");
  }
  const published = await readControlledFile(providerFilePath(context.directory, relation.fileName), context.maxContentBytes);
  if (persisted?.providerSha256 == null ? Boolean(published) : published?.sha256 !== persisted.providerSha256) {
    throw new ProviderFileConflictError("local provider file changed");
  }
}
export async function regenerateLocalExtractionsForConfig(context: LocalExtractionContext, configName: string, expectedSha256: string) {
  const snapshot = await context.store.read(configName);
  if (snapshot.sha256 !== expectedSha256)
    throw new ProviderFileConflictError("configuration update was superseded");
  const results = [];
  for (const relation of context.owner.current.local.filter((entry) => entry.enabled && entry.configName === configName)) {
    results.push(await regenerateLocalExtraction(context, relation.id, snapshot));
  }
  return results;
}
