import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type { ProviderFileIssue } from "../config/errors.js";
import { FILE_NAME_PATTERN, collectionScope, validProviderKey, isWithin, providerFileNameKey } from "./controlledFiles.js";
import { recordValue, type ProviderCategory } from "./collectionYaml.js";

export interface CollectionPath {
  category: ProviderCategory;
  name: string;
  sourcePath: string;
  fileName: string | null;
  referencePath: string | null;
  writable?: boolean;
  status?: ProviderFileIssue["status"] | undefined;
}

type PathOptions = { dataDir: string; providerDir: string; ruleProviderDir?: string };

export async function controlledPathStatus(root: string, target: string): Promise<ProviderFileIssue["status"] | undefined> {
  if (!isWithin(root, target)) return "outside_scope";
  try {
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return "outside_scope";
    await realpath(root);
    let cursor = root;
    for (const part of relative(root, target).split(sep)) {
      cursor = resolve(cursor, part);
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) return "outside_scope";
      if (cursor === target ? !metadata.isFile() : !metadata.isDirectory()) return "unreadable";
    }
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable"; }
}

export async function resolveCollectionPaths(options: PathOptions, configName: string, content: string, scope = collectionScope(configName), legacyPaths?: ReadonlySet<string>, legacySource = false) {
  const document = parseDocument(content);
  if (document.errors.length) return [];
  let root: Record<string, unknown> | null;
  try { root = recordValue(document.toJS()); } catch { return []; }
  const paths: CollectionPath[] = [];
  for (const category of ["proxy", "rule"] as const) {
    const directory = resolve(category === "proxy" ? options.providerDir : options.ruleProviderDir ?? resolve(options.dataDir, "ruleset"));
    for (const [name, raw] of Object.entries(recordValue(root?.[`${category}-providers`]) ?? {})) {
      const declaration = recordValue(raw);
      if (declaration?.type !== "file") continue;
      const sourcePath = typeof declaration.path === "string" ? declaration.path : "";
      const item: CollectionPath = { category, name, sourcePath, fileName: null, referencePath: null };
      paths.push(item);
      const normalized = sourcePath.replaceAll("\\", "/").replace(/^\.\//, "");
      const absolute = resolve(options.dataDir, sourcePath);
      const leaf = basename(normalized);
      const prefix = relative(resolve(options.dataDir), directory).split(sep).join("/");
      const local = normalized.startsWith(`${prefix}/`) ? normalized.slice(prefix.length + 1) : normalized;
      if (!sourcePath || sourcePath !== sourcePath.trim() || normalized.split("/").includes("..") ||
        !FILE_NAME_PATTERN.test(leaf) || !isWithin(resolve(options.dataDir), directory)) { item.status = "outside_scope"; continue; }
      // Existing explicit controlled paths retain their meaning. Bare names and
      // the category's ordinary prefix share one new scoped destination.
      const explicitKey = relative(directory, absolute).split(sep).join("/");
      const explicit = isWithin(directory, absolute) && validProviderKey(explicitKey);
      if ((isAbsolute(sourcePath) || /^[a-z]:/i.test(sourcePath)) && !explicit) { item.status = "outside_scope"; continue; }
      if (!explicit && local !== leaf) { item.status = "outside_scope"; continue; }
      const scopedKey = `${scope}/${leaf}`;
      let key = scopedKey;
      if (explicit && (explicitKey.includes("/") || legacySource)) key = explicitKey;
      else if (explicit && (legacyPaths === undefined || legacyPaths.has(absolute))) {
        const legacyStatus = await controlledPathStatus(directory, absolute);
        if (legacyStatus !== "missing") key = explicitKey;
      }
      const target = resolve(directory, key);
      item.fileName = key;
      item.referencePath = `./${relative(resolve(options.dataDir), target).split(sep).join("/")}`;
      item.status = await controlledPathStatus(directory, target);
      // A bare legacy data-root file is outside the managed collection roots.
      // Its existence cannot authorize copying or silently replacing its body.
      if (!explicit && await controlledPathStatus(resolve(options.dataDir), absolute) !== "missing" && item.status === "missing") item.status = "ownership_unknown";
    }
  }
  const byPath = new Map<string, CollectionPath[]>();
  for (const item of paths) {
    if (!item.referencePath) continue;
    const key = providerFileNameKey(item.referencePath);
    const peers = byPath.get(key) ?? [];
    peers.push(item); byPath.set(key, peers);
  }
  for (const peers of byPath.values()) if (peers.length > 1) for (const item of peers) item.status = "conflict";
  return paths;
}

export function mappedCollectionContent(content: string, paths: CollectionPath[]) {
  if (!paths.length) return content;
  const document = parseDocument(content);
  if (document.errors.length) return content;
  for (const item of paths) if (item.referencePath) document.setIn([`${item.category}-providers`, item.name, "path"], item.referencePath);
  return document.toString({ lineWidth: 0 });
}
