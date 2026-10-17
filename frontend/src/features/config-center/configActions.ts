// 保存阶段只负责落盘；调用方接续统一运行配置加载流程。
import { saveConfigFile, type CollectionPathChange, type ProviderFileIssue } from "../../api/configClient.ts";
import { parse } from "yaml";

export interface SaveConfigToDiskResult {
  name: string;
  path: string;
  sha256: string;
  providerIssues?: ProviderFileIssue[];
  collectionPathChanges?: CollectionPathChange[];
  providerRefreshFailed?: boolean;
  providerRefreshes?: Array<{ category: "proxy" | "rule"; name: string }>;
}

export function isConfigDirty(content: string, original: string) {
  return content !== original;
}

export function declaredProxyProviderNames(content: string) {
  try {
    const value = parse(content) as { "proxy-providers"?: unknown } | null;
    const section = value?.["proxy-providers"];
    return new Set(section && typeof section === "object" && !Array.isArray(section)
      ? Object.keys(section)
      : []);
  } catch {
    return new Set<string>();
  }
}

export async function saveConfigToDisk(
  name: string,
  content: string,
  expectedSha256: string,
  dependencies = { save: saveConfigFile },
): Promise<SaveConfigToDiskResult> {
  // configd 按版本原子保存编辑内容，完整校验由明确应用流程执行。
  const saved = await dependencies.save(name, content, expectedSha256);
  return {
    name: saved.name,
    path: saved.path,
    sha256: saved.sha256,
    ...(saved.providerIssues?.length ? { providerIssues: saved.providerIssues } : {}),
    ...(saved.collectionPathChanges?.length ? { collectionPathChanges: saved.collectionPathChanges } : {}),
    ...(saved.providerRefreshFailed ? { providerRefreshFailed: true } : {}),
    ...(saved.providerRefreshes?.length ? { providerRefreshes: saved.providerRefreshes } : {}),
  };
}
