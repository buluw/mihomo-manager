import { ConfigError, type ConfigSnapshot, type ProviderFileIssue } from "../../api/configClient.ts"

export function configProviderIssues(error: unknown): ProviderFileIssue[] {
  if (!(error instanceof ConfigError) || error.code !== "provider_files_unavailable" || !Array.isArray(error.details.issues)) return []
  return error.details.issues.filter((issue): issue is ProviderFileIssue => issue &&
    (issue.category === "proxy" || issue.category === "rule") && typeof issue.name === "string" &&
    ["missing", "outside_scope", "unreadable"].includes(issue.status))
}

export function matchesCollectionImportSource(source: ConfigSnapshot, current: {
  name: string | null; content: string; sha256: string; view: string
}) {
  return current.view === "edit" && source.name === current.name && source.content === current.content && source.sha256 === current.sha256
}
