import { isAlias, isMap, isNode, isScalar, isSeq, parse, parseDocument, stringify, visit, type Alias } from "yaml";

export interface ExtractionFilterSettings {
  enabled: boolean;
  rules: string[];
}

function filterTerms(rule: string) {
  return rule.split("&").map((term) => term.trim().toLocaleLowerCase()).filter(Boolean);
}

export function providerFilterRuleError(rule: string) {
  const trimmed = rule.trim();
  if (!trimmed.startsWith("/")) return null;
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) return "regular expression is missing a closing slash";
  try {
    new RegExp(trimmed.slice(1, lastSlash), trimmed.slice(lastSlash + 1));
    return null;
  } catch {
    return "regular expression is invalid";
  }
}

export function validateProviderFilterRules(rules: string[]) {
  if (rules.some((rule) => providerFilterRuleError(rule))) throw new Error("provider filter regular expression is invalid");
}

export function matchesProviderFilter(name: string, rules: string[]) {
  const normalizedName = name.toLocaleLowerCase();
  return rules.some((rule) => {
    const trimmed = rule.trim();
    if (trimmed.startsWith("/")) {
      const lastSlash = trimmed.lastIndexOf("/");
      if (lastSlash <= 0) return false;
      try {
        return new RegExp(trimmed.slice(1, lastSlash), trimmed.slice(lastSlash + 1)).test(name);
      } catch {
        return false;
      }
    }
    const terms = filterTerms(rule);
    return terms.length > 0 && terms.every((term) => normalizedName.includes(term));
  });
}

export function extractProxyProvider(content: string, settings?: ExtractionFilterSettings) {
  validateProviderFilterRules(settings?.rules ?? []);
  const parsed = parse(content) as { proxies?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.proxies)) throw new Error("configuration does not contain proxies");
  const proxies = parsed.proxies;
  if (proxies.some((proxy) => {
    if (!proxy || typeof proxy !== "object" || Array.isArray(proxy)) return true;
    const value = proxy as { name?: unknown; type?: unknown };
    return typeof value.name !== "string" || !value.name.trim() ||
      typeof value.type !== "string" || !value.type.trim();
  })) throw new Error("configuration proxies are invalid");
  const matchedNames = settings?.enabled
    ? proxies.flatMap((proxy) => {
      const name = (proxy as { name: string }).name;
      return matchesProviderFilter(name, settings.rules) ? [name] : [];
    })
    : [];
  const matched = new Set(matchedNames);
  const filtered = settings?.enabled
    ? proxies.filter((proxy) => !matched.has((proxy as { name: string }).name))
    : proxies;
  return {
    content: stringify({ proxies: filtered }, { lineWidth: 0 }),
    nodeCount: filtered.length,
    totalCount: proxies.length,
    matchedNames,
  };
}

export function filterSubscriptionConfig(content: string, matchedNames: string[]) {
  if (!matchedNames.length) return content;
  const removed = new Set(matchedNames);
  const document = parseDocument(content);
  if (document.errors.length) throw new Error("subscription YAML is invalid");
  const resolveAlias = (node: unknown) => isAlias(node) ? node.resolve(document) : node;
  const proxies = document.get("proxies", true);
  if (!isSeq(proxies)) throw new Error("configuration does not contain proxies");
  const keptProxies = proxies.items.filter((node) => {
    const proxy = resolveAlias(node);
    const name = isMap(proxy) ? resolveAlias(proxy.get("name", true)) : null;
    return !isScalar(name) || !removed.has(String(name.value));
  });
  const groups = document.get("proxy-groups", true);
  const memberUpdates = isSeq(groups) ? groups.items.flatMap((group) => {
    const members = isMap(group) ? group.get("proxies", true) : null;
    return isSeq(members) ? [{ members, kept: members.items.filter((node) => {
        const member = resolveAlias(node);
        return !isScalar(member) || !removed.has(String(member.value));
      }) }] : [];
  }) : [];
  const removedRoots = [
    ...proxies.items.filter((node) => !keptProxies.includes(node)),
    ...memberUpdates.flatMap(({ members, kept }) => members.items.filter((node) => !kept.includes(node))),
  ];
  const removedNodes = new Set<unknown>();
  for (const node of removedRoots) {
    if (isNode(node)) visit(node, { Node: (_key, child) => { removedNodes.add(child); } });
  }
  const displacedAliases = new Map<Alias, unknown>();
  visit(document, {
    Alias: (_key, alias) => {
      if (removedNodes.has(alias.resolve(document))) displacedAliases.set(alias, alias.toJS(document));
    },
  });
  // Resolve shared fields before deleting their anchors; expand only surviving references.
  proxies.items = keptProxies;
  for (const { members, kept } of memberUpdates) members.items = kept;
  visit(document, {
    Alias: (_key, alias) => {
      if (displacedAliases.has(alias)) return document.createNode(displacedAliases.get(alias));
    },
  });
  return document.toString({ lineWidth: 0 });
}
