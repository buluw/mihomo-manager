import { isMap, isSeq, parse, parseDocument } from "yaml";
import type { ConfigSnapshot } from "../config/store.js";
import { extractProxyProvider } from "./extraction.js";
import { ProviderFileValidationError } from "./errors.js";

export type ProviderCategory = "proxy" | "rule";

export interface CollectionSettingsInput {
  configName: string;
  expectedConfigSha256: string;
  category: ProviderCategory;
  name: string;
  snippet: string;
  loaded: boolean;
  selectedGroups: string[];
  expectedFileSha256?: string;
}

export type CollectionPathChange = {
  configName: string;
  category: ProviderCategory;
  name: string;
  fromPath: string;
  toPath: string;
  beforeConfigSha256: string;
  configSha256: string;
  fileSha256: string;
  device: string;
  inode: string;
};

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function extractProvider(content: string,
  settings?: { enabled: boolean; rules: string[] }) {
  try {
    return extractProxyProvider(content, settings);
  } catch (error) {
    throw new ProviderFileValidationError("source configuration cannot be extracted", { cause: error });
  }
}

export function httpDeclaration(config: Record<string, unknown> | null,
  category: ProviderCategory,
  name: string) {
  const section = recordValue(config?.[category === "proxy" ? "proxy-providers" : "rule-providers"]);
  const declaration = recordValue(section?.[name]);
  const explicitType = typeof declaration?.type === "string" ? declaration.type : null;
  const http = explicitType === "http" || (declaration?.type === undefined && typeof declaration?.url === "string");
  return http && typeof declaration?.url === "string" && typeof declaration?.path === "string"
    ? structuredClone(declaration)
    : null;
}

export function collectionDeclarations(content: string) {
  try { return recordValue(parse(content)); } catch { return null; }
}

export function pathChangeMatches(change: CollectionPathChange,
  snapshot: ConfigSnapshot) {
  const root = collectionDeclarations(snapshot.content);
  const declaration = recordValue(recordValue(root?.[change.category + "-providers"])?.[change.name]);
  return change.configName === snapshot.name && change.configSha256 === snapshot.sha256 &&
    declaration?.type === "file" && declaration.path === change.toPath;
}

export function inferCategory(content: string): ProviderCategory | "unknown" {
  try {
    const value = recordValue(parse(content));
    if (value && "proxies" in value && !("payload" in value)) return "proxy";
    if (value && "payload" in value && !("proxies" in value)) return "rule";
  } catch {
    // Invalid external files remain visible but cannot be claimed or edited.
  }
  return "unknown";
}

export function assertContent(category: ProviderCategory,
  content: string,
  maxContentBytes: number) {
  if (Buffer.byteLength(content, "utf8") > maxContentBytes) {
    throw new ProviderFileValidationError("provider file exceeds the size limit");
  }
  const document = parseDocument(content);
  if (document.errors.length > 0) throw new ProviderFileValidationError("provider file YAML is invalid");
  const value = recordValue(document.toJS());
  const key = category === "proxy" ? "proxies" : "payload";
  const other = category === "proxy" ? "payload" : "proxies";
  if (!value || !(key in value) || other in value || (value[key] !== null && !Array.isArray(value[key]))) {
    throw new ProviderFileValidationError("provider file has an invalid top-level structure");
  }
  if (category === "proxy" && Array.isArray(value[key]) && value[key].some((entry) => {
    const proxy = recordValue(entry);
    return !proxy || typeof proxy.name !== "string" || !proxy.name.trim() ||
      typeof proxy.type !== "string" || !proxy.type.trim();
  })) throw new ProviderFileValidationError("provider file contains an invalid proxy entry");
  if (category === "rule" && Array.isArray(value[key]) && value[key].some(
    (entry) => typeof entry !== "string" || !entry.trim(),
  )) throw new ProviderFileValidationError("provider file contains an invalid rule entry");
}

export function applyCollectionDeclaration(
  document: ReturnType<typeof parseDocument>,
  input: Pick<CollectionSettingsInput, "category" | "name" | "loaded" | "selectedGroups">,
  nextName: string,
  declaration: Record<string, unknown>,
) {
  const sectionName = input.category + "-providers";
  document.deleteIn([sectionName, input.name]);
  if (input.loaded) document.setIn([sectionName, nextName], declaration);
  const groups = document.get("proxy-groups", true);
  if (input.category === "proxy" && isSeq(groups)) {
    const available = new Set<string>();
    let referenced = false;
    for (const group of groups.items) {
      if (!isMap(group)) continue;
      const name = String(group.get("name"));
      available.add(name);
      const use = group.get("use", true);
      const current = isSeq(use) ? use.toJSON() as string[] : [];
      const next = current.filter((name) => name !== input.name);
      const implicit = group.get("include-all") === true || group.get("include-all-providers") === true;
      if (input.loaded && (implicit || input.selectedGroups.includes(name))) {
        referenced = true;
        if (!implicit) next.push(nextName);
      }
      if (next.length) group.set("use", [...new Set(next)]);
      else group.delete("use");
    }
    if (input.selectedGroups.some((name) => !available.has(name)) || (input.loaded && !referenced)) {
      throw new ProviderFileValidationError("a collection must belong to an available proxy group");
    }
  }
  if (input.category === "rule") {
    const rules = document.get("rules", true);
    if (isSeq(rules)) {
      const replaceRule = (rule: unknown) => typeof rule === "string" && rule.split(",")[0] === "RULE-SET" && rule.split(",")[1] === input.name;
      const current = rules.toJSON() as unknown[];
      document.set("rules", current.flatMap((rule) => replaceRule(rule)
        ? input.loaded ? [(rule as string).replace(`RULE-SET,${input.name},`, `RULE-SET,${nextName},`)] : []
        : [rule]));
    }
  }
  return document.toString({ lineWidth: 0 });
}
