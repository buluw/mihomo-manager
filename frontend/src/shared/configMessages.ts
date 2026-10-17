import { ConfigError, configDiagnostics, type ProviderFileIssue, type RetainedProviderFile } from "../api/configClient.ts";
import { providerReferenceMessage } from "./collectionCleanup.ts";

export function configErrorMessage(error: Error) {
  if (error instanceof ConfigError) {
    if (error.code === "config_source_in_use") return "此配置是最近成功加载来源，请先成功应用其他配置，再重命名或删除。";
    if (error.code === "config_source_usage_unknown") return "配置使用状态未知，请先成功应用其他配置再重命名或删除";
  }
  return error.message;
}

export function subscriptionUpdateErrorMessage(error: unknown) {
  if (error instanceof ConfigError && error.code === "validation_failed") {
    return "Mihomo 校验未通过，磁盘配置未更新"
  }
  if (error instanceof ConfigError && error.code === "subscription_update_failed") {
    return "订阅下载或内容处理失败，磁盘配置未更新"
  }
  return error instanceof Error ? error.message : "订阅更新失败"
}

export function retainedProviderMessage(retained?: RetainedProviderFile) {
  if (!retained) return "";
  const reason = providerReferenceMessage(retained.configReferences, retained.runtime) || (retained.reason === "referenced"
    ? "其他声明或配置仍引用：" + (retained.configNames ?? []).join("、")
    : retained.reason === "runtime_reference" ? "已记录的运行版本仍引用" : "运行依赖尚无法确认");
  return "原文件 " + retained.fileName + " 已保留（" + reason + "）；相关配置改用新路径并成功应用后，可在“清理集合文件”中重新检查并勾选旧文件";
}

export function configValidationErrorMessage(error: unknown) {
  if (error instanceof ConfigError && error.code === "invalid_provider_file") return "集合正文校验失败，请检查代理或规则集合内容";
  const diagnostics = configDiagnostics(error);
  return diagnostics.length ? diagnostics.map((item) => item.message).join("；") : null;
}

export function providerFileIssueLabel(status: ProviderFileIssue["status"]) {
  return status === "missing" ? "缺少文件" : status === "outside_scope" ? "超出可读取范围" : "文件不可读";
}

export function providerFilesErrorMessage(error: unknown) {
  if (!(error instanceof ConfigError) || error.code !== "provider_files_unavailable") return null;
  const issues = error.details.issues as ProviderFileIssue[] | undefined;
  return issues?.length ? issues.map((issue) => `${issue.name}：${providerFileIssueLabel(issue.status)}`).join("；") : "本地集合文件不可用";
}
