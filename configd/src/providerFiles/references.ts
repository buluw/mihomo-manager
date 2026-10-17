import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { ConfigStore } from "../config/store.js";
import { recordValue } from "./collectionYaml.js";
import { isWithin, providerFileNameKey, readControlledFile, sameFileIdentity } from "./controlledFiles.js";
import { ProviderFileReferencedError, ProviderFileValidationError, ProviderRuntimeReferenceError, type ProviderConfigReference } from "./errors.js";
import type { ProviderPathReference, ProviderRuntimeDependencies, ProviderRuntimeReferences } from "./types.js";

export type ConfigReferenceSource = { config: Record<string, unknown> | null; unreadable: boolean };

export async function readConfigReferenceSource(name: string,
  store: Pick<ConfigStore, "read">): Promise<ConfigReferenceSource> {
  try {
    const content = (await store.read(name)).content;
    const config = recordValue(parse(content));
    return { config, unreadable: !config && Boolean(content.trim()) };
  } catch {
    return { config: null, unreadable: true };
  }
}

export function configReferencesLexicalPath(config: Record<string, unknown>,
  targetPath: string,
  dataDirectory: string) {
  const dataDir = resolve(dataDirectory);
  for (const section of ["proxy-providers", "rule-providers"]) {
    const providers = recordValue(config[section]);
    if (!providers) continue;
    for (const declaration of Object.values(providers)) {
      const provider = recordValue(declaration);
      if (typeof provider?.path !== "string") continue;
      const configured = resolve(dataDir, provider.path);
      if (!isWithin(dataDir, configured)) throw new ProviderFileValidationError("provider reference is outside the data directory");
      if (providerFileNameKey(configured) === providerFileNameKey(targetPath)) return true;
    }
  }
  return false;
}

export async function configReferencesFile(config: Record<string, unknown> | null,
  targetPath: string,
  target: { device: number | bigint; inode: number | bigint } | null,
  dataDirectory: string,
  maxContentBytes: number): Promise<{ references: ProviderPathReference[]; complete: boolean }> {
  if (!config) return { references: [], complete: true };
  const dataDir = resolve(dataDirectory);
  let complete = true;
  let canonicalDataDir: string | undefined;
  let canonicalTarget: string | undefined;
  try {
    canonicalDataDir = await realpath(dataDir);
    canonicalTarget = target ? await realpath(targetPath) : targetPath;
  } catch {
    complete = false;
  }
  const references: ProviderPathReference[] = [];
  const add = (kind: ProviderPathReference["kind"], path: string) => {
    if (!references.some((entry) => entry.kind === kind && entry.path === path)) references.push({ kind, path });
  };
  for (const section of ["proxy-providers", "rule-providers"]) {
    const providers = recordValue(config[section]);
    if (!providers) continue;
    for (const declaration of Object.values(providers)) {
      const provider = recordValue(declaration);
      if (typeof provider?.path !== "string") continue;
      try {
        const configured = resolve(dataDir, provider.path);
        if (!isWithin(dataDir, configured)) throw new Error("provider reference is outside the data directory");
        if (providerFileNameKey(configured) === providerFileNameKey(targetPath)) {
          add("path", provider.path);
          continue;
        }
        if (!canonicalDataDir || !canonicalTarget) { complete = false; continue; }
        let canonicalConfigured: string;
        try {
          canonicalConfigured = await realpath(configured);
        } catch (error) {
          // A different missing file cannot reference this existing inode.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (!isWithin(canonicalDataDir, canonicalConfigured)) {
          throw new Error("provider reference is outside the data directory");
        }
        // A directory alias still needs this directory entry; a hard link at a
        // different canonical path survives removal of the old name.
        if (providerFileNameKey(canonicalConfigured) === providerFileNameKey(canonicalTarget)) {
          add("path", provider.path);
          continue;
        }
        const configuredIdentity = await readControlledFile(configured, maxContentBytes);
        if (!configuredIdentity) throw new Error("provider reference is unavailable");
        if (target && sameFileIdentity(target, configuredIdentity)) add("identity", provider.path);
      } catch {
        // Keep known evidence and inspect later declarations independently.
        complete = false;
      }
    }
  }
  return { references, complete };
}

export async function runtimeReferences(
  runtime: ProviderRuntimeDependencies | undefined,
  target: string,
  targetIdentity: { device: number | bigint; inode: number | bigint } | null,
  dataDirectory: string,
  maxContentBytes: number,
): Promise<ProviderRuntimeReferences> {
  let references: ProviderPathReference[] = [];
  let scanComplete = false;
  if (runtime?.content) {
    try {
      const config = recordValue(parse(runtime.content));
      if (!config) throw new Error("runtime is not a mapping");
      const scan = await configReferencesFile(config, target, targetIdentity, dataDirectory, maxContentBytes);
      references = scan.references;
      scanComplete = scan.complete;
    } catch {
      scanComplete = false;
    }
  }
  const uncertain = !scanComplete || runtime?.uncertain !== false;
  const fallbackReason = scanComplete ? "core_unverified" : runtime?.content || runtime?.hasSuccessfulRecord ? "record_unreadable" : "no_record";
  return { references, uncertain, scanComplete,
    ...(runtime?.hasSuccessfulRecord !== undefined ? { hasSuccessfulRecord: runtime.hasSuccessfulRecord } : {}),
    ...(uncertain ? { unknownReason: runtime?.unknownReason ?? fallbackReason } : {}) };
}

export function assertReferencesUnreferenced(configReferences: ProviderConfigReference[], runtime: ProviderRuntimeReferences, pathOnly = false) {
  const blocking = configReferences.filter((entry) => entry.kind !== "identity");
  if (blocking.length) throw new ProviderFileReferencedError([...new Set(configReferences.map((entry) => entry.configName))].sort(), configReferences);
  if (runtime.references.some((entry) => entry.kind === "path")) throw new ProviderRuntimeReferenceError("runtime_reference");
  if (runtime.uncertain) throw new ProviderRuntimeReferenceError("runtime_unknown");
  // Ordinary deletion retains its identity guard. Renaming only removes one
  // path, so another hard link alone does not require keeping the old name.
  if (!pathOnly && configReferences.length) throw new ProviderFileReferencedError([...new Set(configReferences.map((entry) => entry.configName))].sort(), configReferences);
  if (!pathOnly && runtime.references.length) throw new ProviderRuntimeReferenceError("runtime_reference");
}
