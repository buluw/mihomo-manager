import { basename } from "node:path";
import { recordValue, type ProviderCategory } from "./collectionYaml.js";
import { FILE_NAME_PATTERN, hash } from "./controlledFiles.js";
import type { LocalProviderExtraction, RetainedProviderFile } from "./types.js";

export type ProviderRenameJournal = {
  version: 1;
  category?: ProviderCategory;
  kind: "manual" | "subscription" | "local" | "external";
  subscriptionId: string | null;
  sourceFileName: string;
  targetFileName: string;
  sha256: string;
  caseOnly?: true;
  caseProofFileName?: string;
  proofDevice?: string;
  proofInode?: string;
  configName?: string;
  configBeforeSha256?: string;
  configAfterSha256?: string;
  configs?: Array<{ name: string; before: string; beforeSha256: string; afterSha256: string }>;
  retainedSource?: RetainedProviderFile;
  phase: "prepared" | "linked" | "committed" | "aborting";
};

export type ProviderOperationJournal =
  | ({ operation: "rename" } & ProviderRenameJournal)
  | {
      version: 1;
      operation: "create";
      restoreManual?: true;
      category: ProviderCategory;
      fileName: string;
      sha256: string;
      stageFileName: string;
      proofDevice?: string;
      proofInode?: string;
      configName?: string;
      configBeforeSha256?: string;
      configAfterSha256?: string;
      phase: "prepared" | "staged" | "published" | "committed" | "aborting";
    }
  | {
      version: 1;
      operation: "delete";
      httpCache?: boolean;
      selected?: boolean;
      maintainedOwner?: { kind: "local" | "subscription"; id: string };
      category: ProviderCategory;
      fileName: string;
      sha256: string;
      backupFileName: string;
      proofDevice?: string;
      proofInode?: string;
      configName?: string;
      configBeforeSha256?: string;
      configAfterSha256?: string;
      phase: "prepared" | "staged" | "backed-up" | "committed";
    }
  | {
      version: 1;
      operation: "publish";
      subscriptionId: string;
      ownerKind?: "subscription" | "local";
      fileName: string;
      beforeSha256: string | null;
      intendedSha256: string;
      stageFileName: string;
      anchorFileName: string;
      backupFileName: string | null;
      proofDevice?: string;
      proofInode?: string;
      localBefore?: LocalProviderExtraction | null;
      localAfter?: LocalProviderExtraction;
      localSourceFileName?: string;
      localSourceSha256?: string;
      localSourceDevice?: string;
      localSourceInode?: string;
      phase: "prepared" | "staged" | "published" | "committed" | "aborting" | "cleaning" | "cleanup-only";
    };

export function parseLegacyRenameJournal(value: unknown): ProviderOperationJournal | null {
  if (value == null) return null;
  const journal = recordValue(value);
  const retainedSource = recordValue(journal?.retainedSource);
  if (
    !journal || journal.version !== 1 ||
    (journal.category !== undefined && journal.category !== "proxy" && journal.category !== "rule") ||
    (journal.kind !== "manual" && journal.kind !== "subscription" && journal.kind !== "local" && journal.kind !== "external") ||
    (journal.subscriptionId !== null && typeof journal.subscriptionId !== "string") ||
    typeof journal.sourceFileName !== "string" || !FILE_NAME_PATTERN.test(journal.sourceFileName) ||
    typeof journal.targetFileName !== "string" || !FILE_NAME_PATTERN.test(journal.targetFileName) ||
    typeof journal.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(journal.sha256) ||
    (journal.caseOnly !== undefined && journal.caseOnly !== true) ||
    (journal.caseProofFileName !== undefined &&
      (typeof journal.caseProofFileName !== "string" ||
        basename(journal.caseProofFileName) !== journal.caseProofFileName ||
        !journal.caseProofFileName.startsWith(".provider-op-"))) ||
    !((journal.proofDevice === undefined && journal.proofInode === undefined) ||
      (typeof journal.proofDevice === "string" && /^\d+$/.test(journal.proofDevice) &&
        typeof journal.proofInode === "string" && /^[1-9]\d*$/.test(journal.proofInode))) ||
    (journal.caseOnly === true && (
      journal.caseProofFileName === undefined || journal.proofDevice === undefined || journal.proofInode === undefined
    )) ||
    !validConfigTransactionFields(journal) ||
    (journal.configs !== undefined && (!Array.isArray(journal.configs) || !journal.configs.length ||
      journal.configs.some((entry) => !entry || typeof entry.name !== "string" || typeof entry.before !== "string" ||
        hash(entry.before) !== entry.beforeSha256 || !/^[a-f0-9]{64}$/.test(entry.afterSha256)))) ||
    (journal.kind === "external" && !journal.configs) ||
    (journal.retainedSource !== undefined && (!retainedSource ||
      retainedSource.fileName !== journal.sourceFileName ||
      !["referenced", "runtime_reference", "runtime_unknown"].includes(String(retainedSource.reason)) ||
      (retainedSource.configNames !== undefined && (!Array.isArray(retainedSource.configNames) ||
        retainedSource.configNames.some((name: unknown) => typeof name !== "string"))))) ||
    !["prepared", "linked", "committed", "aborting"].includes(String(journal.phase))
  ) throw new Error("provider file rename journal is invalid");
  return { operation: "rename", ...(journal as unknown as ProviderRenameJournal) };
}

export function parseOperationJournal(value: unknown): ProviderOperationJournal {
  const journal = recordValue(value);
  const validSha = (candidate: unknown) => typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate);
  const validHidden = (candidate: unknown) =>
    typeof candidate === "string" && basename(candidate) === candidate && candidate.startsWith(".provider-op-");
  const hasValidProof = (device: unknown, inode: unknown) =>
    typeof device === "string" && /^\d+$/.test(device) &&
    typeof inode === "string" && /^[1-9]\d*$/.test(inode);
  const validOptionalProof = (device: unknown, inode: unknown) =>
    (device === undefined && inode === undefined) || hasValidProof(device, inode);
  const validLocal = (candidate: unknown): candidate is LocalProviderExtraction => {
    const entry = recordValue(candidate);
    const settings = recordValue(entry?.filterSettings);
    return Boolean(entry) && typeof entry!.id === "string" && typeof entry!.configName === "string" &&
      validSha(entry!.sourceSha256) && typeof entry!.fileName === "string" && FILE_NAME_PATTERN.test(entry!.fileName) &&
      (entry!.providerSha256 === null || validSha(entry!.providerSha256)) &&
      Number.isSafeInteger(entry!.nodeCount) && (entry!.nodeCount as number) >= 0 &&
      typeof entry!.enabled === "boolean" && Boolean(settings) &&
      Number.isSafeInteger(settings!.version) && (settings!.version as number) >= 0 &&
      typeof settings!.enabled === "boolean" && Array.isArray(settings!.rules) &&
      settings!.rules.every((rule) => typeof rule === "string");
  };
  if (!journal || journal.version !== 1 || typeof journal.operation !== "string") {
    throw new Error("provider file operation journal is invalid");
  }
  if (journal.operation === "rename") {
    const legacy = parseLegacyRenameJournal(journal);
    if (!legacy) throw new Error("provider file operation journal is invalid");
    return legacy;
  }
  if (journal.operation === "create" &&
    (journal.restoreManual === undefined || (journal.restoreManual === true &&
      journal.configName === undefined && journal.configBeforeSha256 === undefined && journal.configAfterSha256 === undefined)) &&
    (journal.category === "proxy" || journal.category === "rule") &&
    typeof journal.fileName === "string" && FILE_NAME_PATTERN.test(journal.fileName) &&
    validSha(journal.sha256) && validHidden(journal.stageFileName) &&
    validOptionalProof(journal.proofDevice, journal.proofInode) &&
    journal.localSourceFileName === undefined && journal.localSourceSha256 === undefined &&
    journal.localSourceDevice === undefined && journal.localSourceInode === undefined &&
    ["prepared", "staged", "published", "committed", "aborting"].includes(String(journal.phase)) &&
    (!["staged", "published", "committed"].includes(String(journal.phase)) ||
      hasValidProof(journal.proofDevice, journal.proofInode))) {
    return journal as unknown as ProviderOperationJournal;
  }
  if (journal.operation === "delete" &&
    (journal.httpCache === undefined || journal.httpCache === true) &&
    (journal.selected === undefined || journal.selected === true) &&
    (journal.maintainedOwner === undefined || (journal.selected === true && journal.category === "proxy" &&
      (recordValue(journal.maintainedOwner)?.kind === "local" || recordValue(journal.maintainedOwner)?.kind === "subscription") &&
      typeof recordValue(journal.maintainedOwner)?.id === "string" && Boolean(recordValue(journal.maintainedOwner)?.id))) &&
    (journal.category === "proxy" || journal.category === "rule") &&
    typeof journal.fileName === "string" && FILE_NAME_PATTERN.test(journal.fileName) &&
    validSha(journal.sha256) && validHidden(journal.backupFileName) &&
    validOptionalProof(journal.proofDevice, journal.proofInode) &&
    validConfigTransactionFields(journal) &&
    ["prepared", "staged", "backed-up", "committed"].includes(String(journal.phase)) &&
    (journal.phase === "prepared" || hasValidProof(journal.proofDevice, journal.proofInode))) {
    return journal as unknown as ProviderOperationJournal;
  }
  const localSourceValues = [journal.localSourceFileName, journal.localSourceSha256,
    journal.localSourceDevice, journal.localSourceInode];
  const hasNoLocalSource = localSourceValues.every((value) => value === undefined);
  const hasLocalSource = localSourceValues.every((value) => value !== undefined) &&
    typeof journal.localSourceFileName === "string" && FILE_NAME_PATTERN.test(journal.localSourceFileName) &&
    validSha(journal.localSourceSha256) && typeof journal.localSourceDevice === "string" &&
    /^\d+$/.test(journal.localSourceDevice) && typeof journal.localSourceInode === "string" &&
    /^[1-9]\d*$/.test(journal.localSourceInode);
  if (journal.operation === "publish" && typeof journal.subscriptionId === "string" &&
    (journal.ownerKind === undefined || journal.ownerKind === "subscription" || journal.ownerKind === "local") &&
    typeof journal.fileName === "string" && FILE_NAME_PATTERN.test(journal.fileName) &&
    (journal.beforeSha256 === null || validSha(journal.beforeSha256)) && validSha(journal.intendedSha256) &&
    validHidden(journal.stageFileName) &&
    (journal.anchorFileName === undefined || validHidden(journal.anchorFileName)) &&
    (journal.backupFileName === null || validHidden(journal.backupFileName)) &&
    validOptionalProof(journal.proofDevice, journal.proofInode) &&
    (journal.ownerKind !== "local" || (
      (journal.localBefore === null || validLocal(journal.localBefore)) && validLocal(journal.localAfter) &&
      journal.localAfter.id === journal.subscriptionId && journal.localAfter.fileName === journal.fileName &&
      journal.localAfter.providerSha256 === journal.intendedSha256 &&
      (journal.localBefore === null ? hasNoLocalSource : (
        journal.localBefore.id === journal.subscriptionId &&
        (hasLocalSource ? (
          journal.beforeSha256 === null && journal.localSourceFileName === journal.localBefore.fileName &&
          journal.localSourceFileName !== journal.fileName &&
          journal.localSourceSha256 === journal.localBefore.providerSha256 &&
          journal.localBefore.providerSha256 !== null
        ) : (
          hasNoLocalSource && journal.localBefore.fileName === journal.fileName &&
          journal.localBefore.providerSha256 === journal.beforeSha256
        ))
      ))
    )) &&
    (journal.ownerKind === "local" || (
      journal.localBefore === undefined && journal.localAfter === undefined && hasNoLocalSource
    )) &&
    ["prepared", "staged", "published", "committed", "aborting", "cleaning", "cleanup-only"].includes(
      String(journal.phase),
    )) {
    return {
      ...journal,
      anchorFileName: journal.anchorFileName ?? journal.stageFileName,
    } as unknown as ProviderOperationJournal;
  }
  throw new Error("provider file operation journal is invalid");
}

export function validConfigTransactionFields(journal: Record<string, unknown>) {
  const values = [journal.configName, journal.configBeforeSha256, journal.configAfterSha256];
  if (values.every((value) => value === undefined)) return true;
  return typeof journal.configName === "string" && journal.configName.length > 0 &&
    typeof journal.configBeforeSha256 === "string" && /^[a-f0-9]{64}$/.test(journal.configBeforeSha256) &&
    typeof journal.configAfterSha256 === "string" && /^[a-f0-9]{64}$/.test(journal.configAfterSha256);
}

export function matchesJournalProof(
  file: { device: number | bigint; inode: number | bigint },
  journal: { proofDevice?: string; proofInode?: string },
) {
  return journal.proofDevice !== undefined && journal.proofInode !== undefined &&
    String(file.device) === journal.proofDevice && String(file.inode) === journal.proofInode;
}

// The service owns the live state and durability. Operations commit only their fields.
type ProviderOperationState = {
  manual: Array<{ fileName: string; category: ProviderCategory }>;
  local: LocalProviderExtraction[];
  httpCachePaths?: string[];
};

export interface ProviderOperationOwner {
  readonly current: Readonly<ProviderOperationState>;
  readonly journal: ProviderOperationJournal | null | undefined;
  commit(update: Partial<ProviderOperationState> & { operationJournal?: ProviderOperationJournal | null }): Promise<void>;
  writeJournal(journal: ProviderOperationJournal): Promise<void>;
  clearJournal(): Promise<void>;
  recover(): Promise<void>;
}

export interface ProviderOperationContext {
  directory: string;
  maxContentBytes: number;
  owner: ProviderOperationOwner;
  hooks: {
    beforeFileRename: (() => Promise<void>) | undefined;
    beforeOperationCleanup: ((operation: ProviderOperationJournal["operation"], phase: string) => Promise<void>) | undefined;
    afterOperationPhase: ((operation: ProviderOperationJournal["operation"], phase: string) => Promise<void>) | undefined;
  };
}
