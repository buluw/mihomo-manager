import { readAppliedRuntime, readConfigFile, readRuntimeLoadState } from "../../api/configClient.ts";
import { readControllerRules } from "../../api/controllerClient.ts";
import { confirmedRuntimeSource } from "../../shared/runtimeApplication.ts";
import { configProxyGroupNames, configRuleItems, configRuleProviderNames, ruleItems, type RuleItem } from "./ruleViewModel.ts";

export type RuleSource = { name: string; generatedVersion: string };
export type RuleRuntimeCache = { version: string; sha256: string; rules: RuleItem[]; proxyGroups: string[]; ruleProviders: string[] };

export function matchingRuntimeRules(runtime: RuleItem[], generated: RuleItem[]) {
  const type = (value: string) => {
    const normalized = value.replace(/[^a-z0-9]/gi, "").toUpperCase();
    if (normalized === "IPCIDR6") return "IPCIDR";
    return normalized === "FINAL" ? "MATCH" : normalized;
  };
  return runtime.length === generated.length && runtime.every((rule, index) => {
    const expected = generated[index]!;
    return type(rule.type) === type(expected.type) && rule.payload === expected.payload && rule.policy === expected.policy;
  });
}

// The record proposes an editing source; Core rules remain the display authority.
export async function readRuleSource(
  runtime: RuleItem[],
  signal: AbortSignal,
  cached: RuleRuntimeCache | null,
  readers = { state: readRuntimeLoadState, applied: readAppliedRuntime },
): Promise<{ source: RuleSource | null; cache: RuleRuntimeCache | null }> {
  try {
    const state = await readers.state(signal);
    const source = confirmedRuntimeSource(state);
    const generated = state.lastSuccessful?.generated;
    if (!source || !generated || signal.aborted) return { source: null, cache: cached };
    let cache = cached;
    if (cache?.version !== generated.version || cache.sha256 !== generated.contentSha256) {
      const applied = await readers.applied(signal);
      const loaded = confirmedRuntimeSource(applied.state) && applied.state.lastSuccessful?.generated;
      if (!loaded || applied.content === null || loaded.version !== generated.version || loaded.contentSha256 !== generated.contentSha256) return { source: null, cache: cached };
      cache = { version: generated.version, sha256: generated.contentSha256, rules: configRuleItems(applied.content), proxyGroups: configProxyGroupNames(applied.content), ruleProviders: configRuleProviderNames(applied.content) };
    }
    if (signal.aborted || !matchingRuntimeRules(runtime, cache.rules)) return { source: null, cache };
    return { source: { name: source.name, generatedVersion: generated.version }, cache };
  } catch { return { source: null, cache: cached }; }
}

export async function readRuleEditSnapshot(
  displayed: RuleItem[],
  expectedSource: RuleSource | null,
  signal: AbortSignal,
  cached: RuleRuntimeCache | null,
  readers = { rules: readControllerRules, state: readRuntimeLoadState, applied: readAppliedRuntime, disk: readConfigFile },
) {
  const current = ruleItems((await readers.rules(signal)).rules);
  if (!matchingRuntimeRules(displayed, current)) throw new Error("运行规则已变化，请刷新后重新操作；本次操作未写入源文件");
  const association = await readRuleSource(current, signal, cached, readers);
  const source = association.source;
  if (!source || !expectedSource || source.name !== expectedSource.name || source.generatedVersion !== expectedSource.generatedVersion) {
    throw new Error("运行来源已变化或无法确认，请刷新后重新操作");
  }
  const disk = await readers.disk(source.name, signal);
  const state = await readers.state(signal);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (confirmedRuntimeSource(state)?.name !== disk.name || state.lastSuccessful?.generated.version !== source.generatedVersion) {
    throw new Error("运行来源已变化，请刷新后重新操作");
  }
  if (disk.sha256 !== state.lastSuccessful.generated.sourceSha256) {
    throw new Error("源配置有已保存待应用的修改，请先在配置中心处理并应用；当前运行规则保持不变");
  }
  const rules = configRuleItems(disk.content);
  if (!matchingRuntimeRules(displayed, rules)) throw new Error("源规则与运行列表无法逐项对应，请在配置中心核对后操作");
  return { source, disk, cache: association.cache, rules: rules.map((rule, index) => ({ ...rule, type: displayed[index]!.type })) };
}
