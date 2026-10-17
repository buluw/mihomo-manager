import type {
  ProxyNodeIdentity,
  ProxyNodeSettings,
} from "../../api/configClient.ts";
import { isMap, isScalar, isSeq, parseDocument, visit } from "yaml";

import { proxyIdentityKey } from "./proxyMergeSettings.ts";

export type ProxyNodeRenameAnalysis = {
  status: "unique" | "missing" | "ambiguous" | "invalid" | "provider";
  conflict: boolean;
};

export const EMPTY_PROXY_NODE_SETTINGS: ProxyNodeSettings = {
  schemaVersion: 1,
  version: 0,
  regions: [],
};

function proxyNames(content: string) {
  const document = parseDocument(content);
  if (document.errors.length) return null;
  const proxies = document.get("proxies", true);
  if (!isSeq(proxies)) return [];
  return proxies.items.flatMap((node) => {
    if (!isMap(node)) return [];
    const name = node.get("name");
    return typeof name === "string" ? [name] : [];
  });
}

export function analyzeProxyNodeRename(
  content: string,
  identity: ProxyNodeIdentity,
  nextName = identity.name,
): ProxyNodeRenameAnalysis {
  if (identity.provider) return { status: "provider", conflict: false };
  const names = proxyNames(content);
  if (!names) return { status: "invalid", conflict: false };
  const matches = names.filter((name) => name === identity.name).length;
  return {
    status: matches === 1 ? "unique" : matches === 0 ? "missing" : "ambiguous",
    conflict: nextName !== identity.name && names.includes(nextName),
  };
}

function topLevelRuleFields(rule: string) {
  const fields: Array<{ start: number; end: number }> = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < rule.length; index += 1) {
    const character = rule[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth < 0) throw new Error("规则括号不平衡，无法安全修改节点引用");
    } else if (character === "," && depth === 0) {
      fields.push({ start, end: index });
      start = index + 1;
    }
  }
  if (depth !== 0) throw new Error("规则括号不平衡，无法安全修改节点引用");
  fields.push({ start, end: rule.length });
  return fields;
}

function renamedRule(rule: string, oldName: string, newName: string) {
  const fields = topLevelRuleFields(rule);
  const type = rule.slice(fields[0]!.start, fields[0]!.end).trim().toUpperCase();
  if (type === "SUB-RULE") return rule;
  const policyIndex = type === "MATCH" ? 1 : 2;
  const policy = fields[policyIndex];
  if (!policy) throw new Error("规则字段不完整，无法安全修改节点引用");
  const original = rule.slice(policy.start, policy.end);
  if (original.trim() !== oldName) return rule;
  const leading = original.match(/^\s*/)?.[0] ?? "";
  const trailing = original.match(/\s*$/)?.[0] ?? "";
  return `${rule.slice(0, policy.start)}${leading}${newName}${trailing}${rule.slice(policy.end)}`;
}

export function renameInlineProxyNode(
  content: string,
  oldName: string,
  newName: string,
) {
  const normalized = newName.trim();
  if (!normalized || normalized.length > 256) throw new Error("节点名称不能为空且不能超过 256 个字符");
  const identity = { provider: "", name: oldName };
  const analysis = analyzeProxyNodeRename(content, identity, normalized);
  if (analysis.status !== "unique") throw new Error("所选配置无法唯一定位该节点");
  if (analysis.conflict) throw new Error("所选配置中已存在同名节点");
  if (normalized === oldName) return content;

  const document = parseDocument(content);
  const proxies = document.get("proxies", true);
  if (!isSeq(proxies)) throw new Error("所选配置无法唯一定位该节点");
  const target = proxies.items.find((node) => isMap(node) && node.get("name") === oldName);
  if (!isMap(target)) throw new Error("所选配置无法唯一定位该节点");
  target.set("name", normalized);

  visit(document, {
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") return;
      const field = pair.key.value;
      if (field === "dialer-proxy" && isScalar(pair.value) && pair.value.value === oldName) {
        pair.value.value = normalized;
      }
      if (field === "proxies" && isSeq(pair.value)) {
        pair.value.items.forEach((item) => {
          if (isScalar(item) && item.value === oldName) item.value = normalized;
        });
      }
      if (field === "rules" && isSeq(pair.value)) {
        pair.value.items.forEach((item) => {
          if (isScalar(item) && typeof item.value === "string") {
            item.value = renamedRule(item.value, oldName, normalized);
          }
        });
      }
      if (field === "sub-rules" && isMap(pair.value)) {
        pair.value.items.forEach((subRule) => {
          if (!isSeq(subRule.value)) return;
          subRule.value.items.forEach((item) => {
            if (isScalar(item) && typeof item.value === "string") {
              item.value = renamedRule(item.value, oldName, normalized);
            }
          });
        });
      }
    },
  });
  return document.toString({ lineWidth: 0 });
}

export function manualProxyRegion(
  settings: ProxyNodeSettings,
  identity: ProxyNodeIdentity,
) {
  return settings.regions.find((entry) => proxyIdentityKey(entry) === proxyIdentityKey(identity))?.label ?? null;
}

export function setManualProxyRegion(
  settings: ProxyNodeSettings,
  identity: ProxyNodeIdentity,
  label: string,
) {
  const key = proxyIdentityKey(identity);
  const regions = settings.regions.filter((entry) => proxyIdentityKey(entry) !== key);
  if (label.trim()) regions.push({ ...identity, label: label.trim() });
  return { ...settings, regions };
}

export function migrateManualProxyRegion(
  settings: ProxyNodeSettings,
  from: ProxyNodeIdentity,
  to: ProxyNodeIdentity,
  label = manualProxyRegion(settings, from) ?? "",
) {
  return setManualProxyRegion(setManualProxyRegion(settings, from, ""), to, label);
}

export function displayedProxyRegion(
  automatic: string | null,
  settings: ProxyNodeSettings,
  identity: ProxyNodeIdentity,
) {
  return manualProxyRegion(settings, identity) ?? automatic;
}

export type ProxyRegionDrafts = Record<string, string | null>;
export type ProxyRegionDraftRevisions = Record<string, number>;

export function previewAutomaticProxyRegion(drafts: ProxyRegionDrafts, identityKey: string): ProxyRegionDrafts {
  return { ...drafts, [identityKey]: null };
}

export class ProxyNodeInfoSaveGuard {
  private locked = false;

  acquire() {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  release() {
    this.locked = false;
  }

  edit(action: () => void) {
    if (this.locked) return false;
    action();
    return true;
  }
}

export function proxyRegionDraftValue(
  drafts: ProxyRegionDrafts,
  settings: ProxyNodeSettings,
  identity: ProxyNodeIdentity,
  automatic: string | null,
) {
  const key = proxyIdentityKey(identity);
  return Object.hasOwn(drafts, key)
    ? drafts[key] ?? automatic ?? ""
    : displayedProxyRegion(automatic, settings, identity) ?? "";
}

export function commitProxyRegionDrafts(
  settings: ProxyNodeSettings,
  identities: ProxyNodeIdentity[],
  drafts: ProxyRegionDrafts,
) {
  const byKey = new Map(identities.map((identity) => [proxyIdentityKey(identity), identity]));
  return Object.entries(drafts).reduce((current, [key, label]) => {
    const identity = byKey.get(key);
    return identity ? setManualProxyRegion(current, identity, label ?? "") : current;
  }, settings);
}
