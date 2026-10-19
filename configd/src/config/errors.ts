// 以错误类型区分稳定 HTTP 状态，消息本身不携带敏感正文或路径。
export class ConfigConflictError extends Error {}
export class ConfigSourceInUseError extends Error {}
export class ConfigSourceUsageUnknownError extends Error {}
export class ConfigFileExistsError extends Error {}
export class ConfigFileNameError extends Error {}
export class ConfigFileNotFoundError extends Error {}
import type { ConfigDiagnostic } from "./diagnostics.js";

export class ConfigValidationError extends Error {
  constructor(message: string, readonly diagnostics: ConfigDiagnostic[] = []) { super(message); }
}
export class ConfigValidationTimeoutError extends ConfigValidationError {}
export class ConfigTooLargeError extends Error {}
export class ProviderSourceNotFoundError extends Error {}
export interface ProviderFileIssue {
  category: "proxy" | "rule";
  name: string;
  status: "missing" | "outside_scope" | "unreadable" | "conflict" | "ownership_unknown";
}
export class ConfigProviderFilesError extends Error {
  constructor(readonly issues: ProviderFileIssue[]) {
    super("local provider files are unavailable");
  }
}
export class SubscriptionNotFoundError extends Error {}
export class SubscriptionValidationError extends Error {}
export class SubscriptionDownloadError extends Error {}
export class SubscriptionTimeoutError extends SubscriptionDownloadError {}
export class SubscriptionTooLargeError extends SubscriptionDownloadError {}
export class ProxyMergeSettingsValidationError extends Error {}
export class ProxyMergeSettingsConflictError extends Error {}
export class ProxyNodeSettingsValidationError extends Error {}
export class ProxyNodeSettingsConflictError extends Error {}
export class ProxyNodeInfoTransactionError extends Error {}
