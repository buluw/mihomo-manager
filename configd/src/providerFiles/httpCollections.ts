import { resolve } from "node:path";
import { parse } from "yaml";
import type { ConfigStore } from "../config/store.js";
import { httpDeclaration, recordValue, type ProviderCategory } from "./collectionYaml.js";
import { hash, isWithin } from "./controlledFiles.js";
import { ProviderFileConflictError, ProviderFileRecoveryError, ProviderFileValidationError } from "./errors.js";
import { readConfigReferenceSource, type ConfigReferenceSource } from "./references.js";
import type { ManagedHttpProviderRecord, ProviderHttpConfigIntent, SaveManualHttpConfigInput } from "./types.js";
type HttpCollectionState = {
  manualHttp?: ManagedHttpProviderRecord[];
  httpConfigIntent?: ProviderHttpConfigIntent;
  httpCachePaths?: string[];
};
export interface HttpCollectionContext {
  dataDir: string;
  store: Pick<ConfigStore, "list" | "read" | "saveFileUnqueued">;
  owner: {
    readonly current: Readonly<HttpCollectionState>;
    commit(update: Partial<HttpCollectionState>, invokeHook?: boolean): Promise<void>;
  };
}
export async function saveConfigWithManualHttp(context: HttpCollectionContext, input: SaveManualHttpConfigInput) {
  if (input.providers.some((entry) => !entry.name || (entry.category !== "proxy" && entry.category !== "rule"))) {
    throw new ProviderFileValidationError("manual http ownership is invalid");
  }
  const parsed = parse(input.content) as Record<string, unknown> | null;
  const previous = await context.store.read(input.configName);
  if (previous.sha256 !== input.expectedSha256)
    throw new ProviderFileConflictError("configuration changed");
  const previousParsed = recordValue(parse(previous.content));
  const actualBeforeCatalogByKey = new Map<string, ManagedHttpProviderRecord>((context.owner.current.manualHttp ?? []).filter((entry) => entry.configName === input.configName)
    .map((entry) => {
      const declaration = httpDeclaration(previousParsed, entry.category, entry.name) ??
        (entry.declaration ? structuredClone(entry.declaration) : null);
      const refreshed = { ...entry, ...(declaration ? { declaration: structuredClone(declaration) } : {}) };
      return [`${entry.category}\0${entry.name}`, refreshed] as const;
    }));
  const actualBeforeCatalog = [...actualBeforeCatalogByKey.values()];
  const afterCatalog = input.providers.map((entry) => {
    const key = `${entry.category}\0${entry.name}`;
    const declaration = httpDeclaration(recordValue(parsed), entry.category, entry.name) ??
      actualBeforeCatalogByKey.get(key)?.declaration;
    if (!declaration)
      throw new ProviderFileValidationError("manual http declaration is invalid");
    return {
      ...entry,
      configName: input.configName,
      declaration: structuredClone(declaration),
    };
  });
  const before = actualBeforeCatalog.map(({ category, name, declaration }) => ({ category, name, ...(declaration ? { declaration } : {}) }));
  const intent = {
    version: 1 as const,
    configName: input.configName,
    beforeSha256: previous.sha256,
    afterSha256: hash(input.content),
    before,
    after: afterCatalog.map(({ category, name, declaration }) => ({ category, name, ...(declaration ? { declaration } : {}) })),
  };
  const prepared = { httpConfigIntent: intent };
  await context.owner.commit(prepared);
  let saved: Awaited<ReturnType<ConfigStore["saveFileUnqueued"]>>;
  try {
    saved = await context.store.saveFileUnqueued(input.configName, input.content, input.expectedSha256, true);
  }
  catch (error) {
    await recoverHttpConfigIntent(context);
    throw error;
  }
  const next = {
    manualHttp: [...(context.owner.current.manualHttp ?? []).filter((entry) => entry.configName !== input.configName), ...afterCatalog],
    httpConfigIntent: null,
  };
  await context.owner.commit(next);
  return saved;
}
export async function recoverHttpConfigIntent(context: HttpCollectionContext) {
  const intent = context.owner.current.httpConfigIntent;
  if (!intent)
    return;
  const snapshot = await context.store.read(intent.configName);
  const selected = snapshot.sha256 === intent.beforeSha256 ? intent.before
    : snapshot.sha256 === intent.afterSha256 ? intent.after
      : null;
  if (!selected)
    throw new ProviderFileRecoveryError("manual http configuration recovery is incomplete");
  const manualHttp = [
    ...(context.owner.current.manualHttp ?? []).filter((entry) => entry.configName !== intent.configName),
    ...selected.map((entry) => ({ ...entry, configName: intent.configName })),
  ];
  const next = { manualHttp, httpConfigIntent: null };
  await context.owner.commit(next, false);
}
export async function rememberHttpCachePaths(context: HttpCollectionContext, configSources?: Map<string, ConfigReferenceSource>) {
  const paths = new Set(context.owner.current.httpCachePaths ?? []);
  const references = new Map<string, Set<ProviderCategory> | null>();
  const collect = (value: unknown, category: ProviderCategory) => {
    const declaration = recordValue(value);
    if (typeof declaration?.path !== "string")
      return;
    const path = resolve(context.dataDir, declaration.path);
    if (declaration.type === "http" && isWithin(context.dataDir, path))
      paths.add(path);
    if (declaration.type !== "file")
      references.set(path, null);
    else if (references.get(path) !== null) {
      const categories = references.get(path) ?? new Set<ProviderCategory>();
      categories.add(category);
      references.set(path, categories);
    }
  };
  for (const file of await context.store.list()) {
    const source = configSources?.get(file.name) ?? await readConfigReferenceSource(file.name, context.store);
    configSources?.set(file.name, source);
    for (const category of ["proxy", "rule"] as const) {
      Object.values(recordValue(source.config?.[`${category}-providers`]) ?? {}).forEach((value) => collect(value, category));
    }
  }
  (context.owner.current.manualHttp ?? []).forEach((owner) => collect(owner.declaration, owner.category));
  if (paths.size !== (context.owner.current.httpCachePaths ?? []).length) {
    const next = { httpCachePaths: [...paths] };
    await context.owner.commit(next);
  }
  return references;
}
export function parseHttpCollections(value: Record<string, unknown>) {
  const manualHttp = Array.isArray(value.manualHttp) ? value.manualHttp.filter((entry): entry is ManagedHttpProviderRecord => Boolean(entry) && typeof entry.configName === "string" && Boolean(entry.configName) &&
    (entry.category === "proxy" || entry.category === "rule") && typeof entry.name === "string" && Boolean(entry.name) &&
    (entry.declaration === undefined || Boolean(recordValue(entry.declaration)))) : [];
  const intentValue = recordValue(value.httpConfigIntent);
  const parseHttpEntries = (entries: unknown) => Array.isArray(entries) && entries.every((entry) => Boolean(entry) && (entry.category === "proxy" || entry.category === "rule") && typeof entry.name === "string" && Boolean(entry.name) &&
    (entry.declaration === undefined || Boolean(recordValue(entry.declaration))))
    ? entries as Array<{
      category: ProviderCategory;
      name: string;
      declaration?: Record<string, unknown>;
    }>
    : null;
  const beforeHttp = parseHttpEntries(intentValue?.before);
  const afterHttp = parseHttpEntries(intentValue?.after);
  const httpConfigIntent = intentValue?.version === 1 && typeof intentValue.configName === "string" &&
    /^[a-f0-9]{64}$/.test(String(intentValue.beforeSha256)) && /^[a-f0-9]{64}$/.test(String(intentValue.afterSha256)) &&
    beforeHttp && afterHttp
    ? { version: 1 as const, configName: intentValue.configName, beforeSha256: String(intentValue.beforeSha256), afterSha256: String(intentValue.afterSha256), before: beforeHttp, after: afterHttp }
    : null;
  if (value.httpConfigIntent && !httpConfigIntent)
    throw new Error();
  return { manualHttp, httpConfigIntent };
}
