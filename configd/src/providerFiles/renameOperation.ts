import { reservesProviderIdentity } from "./ownership.js";
import { link, readdir, unlink } from "node:fs/promises";
import type { PublicSubscription } from "../subscriptions/types.js";
import { hiddenFileName, hiddenProviderPath, providerFileNameKey, providerFilePath, readControlledFile, removeCapturedHiddenAfterJournalClear, sameFileIdentity } from "./controlledFiles.js";
import { ProviderFileConflictError, ProviderFileExistsError, ProviderFileRecoveryError, ProviderFileReferencedError } from "./errors.js";
import { matchesJournalProof, type ProviderOperationContext, type ProviderOperationJournal, type ProviderRenameJournal } from "./operationJournal.js";

type RenameJournal = Extract<ProviderOperationJournal, { operation: "rename" }>;

export interface ProviderRenameContext extends ProviderOperationContext {
  readonly subscriptions: ReadonlyArray<Pick<PublicSubscription, "id" | "extractProvider" | "providerName" | "providerSha256">>;
  hooks: ProviderOperationContext["hooks"] & {
    beforeRenameCleanup: ((phase: "rollback-target" | "commit-source") => Promise<void>) | undefined;
    afterRenamePhase: ((phase: ProviderRenameJournal["phase"]) => Promise<void>) | undefined;
    afterCaseAliasRemoval: (() => Promise<void>) | undefined;
  };
}

export async function renameProviderFile(
  context: ProviderRenameContext,
  input: Omit<ProviderRenameJournal, "version" | "phase">,
  commitState: () => Promise<void>,
) {
  const { directory, maxContentBytes, owner: stateOwner } = context;
  if (stateOwner.journal) {
    throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
  }
  const sourcePath = providerFilePath(directory, input.sourceFileName);
  const targetPath = providerFilePath(directory, input.targetFileName);
  const baseline = await readControlledFile(sourcePath, maxContentBytes);
  if (!baseline || baseline.sha256 !== input.sha256 || (input.proofDevice !== undefined && !matchesJournalProof(baseline, input))) {
    throw new ProviderFileConflictError("provider file changed");
  }
  const samePlatformKey = input.sourceFileName !== input.targetFileName &&
    providerFileNameKey(input.sourceFileName) === providerFileNameKey(input.targetFileName);
  let caseOnly = false;
  if (samePlatformKey) {
    const entries = await providerDirectoryEntries(directory, input.sourceFileName);
    const targetAtStart = await readControlledFile(targetPath, maxContentBytes);
    if (targetAtStart) {
      if (!sameFileIdentity(baseline, targetAtStart)) {
        throw new ProviderFileExistsError("provider file already exists");
      }
      caseOnly = entries.length === 1 && entries[0] === input.sourceFileName;
    }
  }
  const caseProofFileName = caseOnly ? hiddenFileName("case-rename") : null;
  if (caseOnly && input.retainedSource) throw new ProviderFileReferencedError(input.retainedSource.configNames ?? []);
  let journal: ProviderOperationJournal = {
    version: 1,
    operation: "rename",
    ...input,
    ...(caseOnly ? {
      caseOnly: true as const,
      caseProofFileName: caseProofFileName!,
      proofDevice: String(baseline.device),
      proofInode: String(baseline.inode),
    } : {}),
    phase: "prepared",
  };
  await stateOwner.writeJournal(journal);
  await afterRenamePhase(context, journal);
  if (caseOnly) {
    const proofPath = hiddenProviderPath(directory, caseProofFileName!);
    await link(sourcePath, proofPath);
    const sourceAfterProof = await readControlledFile(sourcePath, maxContentBytes);
    const proofAfterLink = await readControlledFile(proofPath, maxContentBytes);
    if (
      !sourceAfterProof || !proofAfterLink || sourceAfterProof.sha256 !== input.sha256 ||
      proofAfterLink.sha256 !== input.sha256 || !sameFileIdentity(sourceAfterProof, proofAfterLink) ||
      !matchesJournalProof(sourceAfterProof, journal) || !matchesJournalProof(proofAfterLink, journal)
    ) throw new ProviderFileConflictError("provider file changed");
    journal = { ...journal, phase: "linked" };
    await stateOwner.writeJournal(journal);
    await afterRenamePhase(context, journal);
    const proofBeforePublish = await readControlledFile(proofPath, maxContentBytes);
    const sourceBeforeRemoval = await readControlledFile(sourcePath, maxContentBytes);
    if (
      !sourceBeforeRemoval || !proofBeforePublish || sourceBeforeRemoval.sha256 !== input.sha256 ||
      proofBeforePublish.sha256 !== input.sha256 || !sameFileIdentity(sourceBeforeRemoval, proofBeforePublish) ||
      !matchesJournalProof(sourceBeforeRemoval, journal) || !matchesJournalProof(proofBeforePublish, journal)
    ) throw new ProviderFileConflictError("provider file changed");
    await unlink(sourcePath);
    const proofAfterRemoval = await readControlledFile(proofPath, maxContentBytes);
    if (
      !proofAfterRemoval || proofAfterRemoval.sha256 !== input.sha256 ||
      !matchesJournalProof(proofAfterRemoval, journal)
    ) throw new ProviderFileRecoveryError("provider case-only rename recovery is incomplete");
    try {
      await link(proofPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const collision = new ProviderFileExistsError("provider file already exists");
        try {
          await stateOwner.recover();
        } catch (cleanupError) {
          throw new ProviderFileRecoveryError("provider case-only rename recovery is incomplete", {
            cause: new AggregateError([collision, cleanupError], "provider case-only rename collision failed"),
          });
        }
        throw collision;
      }
      throw error;
    }
    const exactTargetBeforeCommit = await providerDirectoryEntry(directory, input.targetFileName);
    const proofBeforeCommit = await readControlledFile(proofPath, maxContentBytes);
    const targetBeforeCommit = await readControlledFile(targetPath, maxContentBytes);
    if (
      !targetBeforeCommit || !proofBeforeCommit || targetBeforeCommit.sha256 !== input.sha256 ||
      proofBeforeCommit.sha256 !== input.sha256 || !sameFileIdentity(targetBeforeCommit, proofBeforeCommit) ||
      !matchesJournalProof(targetBeforeCommit, journal) ||
      !matchesJournalProof(proofBeforeCommit, journal) ||
      exactTargetBeforeCommit !== input.targetFileName
    ) throw new ProviderFileConflictError("provider file changed");
    try {
      await commitState();
    } catch (error) {
      try {
        await stateOwner.recover();
      } catch (recoveryError) {
        throw new ProviderFileRecoveryError("provider rename failed; recovery is incomplete", {
          cause: new AggregateError([error, recoveryError], "provider rename recovery failed"),
        });
      }
      throw error;
    }
    journal = { ...journal, phase: "committed" };
    try {
      await stateOwner.writeJournal(journal);
      await afterRenamePhase(context, journal);
      await stateOwner.recover();
    } catch (error) {
      throw new ProviderFileRecoveryError("provider rename committed; recovery is incomplete", { cause: error });
    }
    return;
  }
  try {
    await link(sourcePath, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const collision = new ProviderFileExistsError("provider file already exists");
      journal = { ...journal, phase: "aborting" };
      try {
        await stateOwner.writeJournal(journal);
        await afterRenamePhase(context, journal);
        await stateOwner.recover();
      } catch (cleanupError) {
        throw new ProviderFileRecoveryError("provider rename collision recovery is incomplete", {
          cause: new AggregateError([collision, cleanupError], "provider rename collision cleanup failed"),
        });
      }
      throw collision;
    }
    throw error;
  }
  journal = { ...journal, phase: "linked" };
  await stateOwner.writeJournal(journal);
  await afterRenamePhase(context, journal);
  const linkedSource = await readControlledFile(sourcePath, maxContentBytes);
  const linkedTarget = await readControlledFile(targetPath, maxContentBytes);
  if (
    !linkedSource || !linkedTarget || linkedSource.sha256 !== input.sha256 ||
    linkedTarget.sha256 !== input.sha256 || !sameFileIdentity(linkedSource, linkedTarget) ||
    !sameFileIdentity(baseline, linkedTarget)
  ) {
    try {
      if (
        !linkedSource || !linkedTarget || linkedSource.sha256 !== linkedTarget.sha256 ||
        !sameFileIdentity(linkedSource, linkedTarget)
      ) {
        throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
      }
      await beforeRenameCleanup(context, journal, "rollback-target");
      const sourceBeforeRemoval = await readControlledFile(sourcePath, maxContentBytes);
      const targetBeforeRemoval = await readControlledFile(targetPath, maxContentBytes);
      if (
        !sourceBeforeRemoval || !targetBeforeRemoval ||
        sourceBeforeRemoval.sha256 !== targetBeforeRemoval.sha256 ||
        !sameFileIdentity(sourceBeforeRemoval, targetBeforeRemoval)
      ) {
        throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
      }
      await unlink(targetPath);
      await beforeRenameCleanup(context, journal, "clear-journal");
      await stateOwner.clearJournal();
    } catch (error) {
      throw new ProviderFileRecoveryError("provider rename recovery is incomplete", { cause: error });
    }
    throw new ProviderFileConflictError("provider file changed");
  }
  try {
    await commitState();
  } catch (error) {
    try {
      await stateOwner.recover();
    } catch (recoveryError) {
      throw new ProviderFileRecoveryError("provider rename failed; recovery is incomplete", {
        cause: new AggregateError([error, recoveryError], "provider rename recovery failed"),
      });
    }
    throw error;
  }
  journal = { ...journal, phase: "committed" };
  try {
    await stateOwner.writeJournal(journal);
    await afterRenamePhase(context, journal);
    await stateOwner.recover();
  } catch (error) {
    throw new ProviderFileRecoveryError("provider rename committed; recovery is incomplete", { cause: error });
  }
}

export async function recoverRename(context: ProviderRenameContext, journal: RenameJournal) {
  const { directory, maxContentBytes, owner: stateOwner } = context;
  if (journal.caseOnly) return recoverCaseOnlyRename(context,
    journal as Extract<ProviderOperationJournal, { operation: "rename" }> & { caseOnly: true },
  );
  if (journal.phase === "aborting") {
    if (renameStateCommitted(context, journal)) {
      throw new ProviderFileRecoveryError("provider rename collision recovery is incomplete");
    }
    const source = await readControlledFile(providerFilePath(directory, journal.sourceFileName), maxContentBytes);
    if (!source || source.sha256 !== journal.sha256) {
      throw new ProviderFileRecoveryError("provider rename collision recovery is incomplete");
    }
    await stateOwner.clearJournal();
    return;
  }
  const committed = renameStateCommitted(context, journal);
  const keepPath = providerFilePath(directory, committed ? journal.targetFileName : journal.sourceFileName);
  const removePath = providerFilePath(directory, committed ? journal.sourceFileName : journal.targetFileName);
  const keep = await readControlledFile(keepPath, maxContentBytes);
  if (!committed && journal.phase === "linked" && keep && keep.sha256 !== journal.sha256) {
    const remove = await readControlledFile(removePath, maxContentBytes);
    if (remove) {
      if (keep.sha256 !== remove.sha256 || !sameFileIdentity(keep, remove)) {
        throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
      }
      await beforeRenameCleanup(context, journal, "rollback-target");
      const keepBeforeRemoval = await readControlledFile(keepPath, maxContentBytes);
      const removeBeforeRemoval = await readControlledFile(removePath, maxContentBytes);
      if (
        !keepBeforeRemoval || !removeBeforeRemoval || keepBeforeRemoval.sha256 !== removeBeforeRemoval.sha256 ||
        !sameFileIdentity(keepBeforeRemoval, removeBeforeRemoval)
      ) {
        throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
      }
      await unlink(removePath);
    }
    await beforeRenameCleanup(context, journal, "clear-journal");
    await stateOwner.clearJournal();
    return;
  }
  if (!keep || keep.sha256 !== journal.sha256) {
    throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
  }
  const remove = await readControlledFile(removePath, maxContentBytes);
  if (remove) {
    if (remove.sha256 !== journal.sha256) {
      throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
    }
    try {
      if (!sameFileIdentity(keep, remove)) {
        throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
      }
      if (!committed || !journal.retainedSource) {
        await beforeRenameCleanup(context, journal, committed ? "commit-source" : "rollback-target");
        const keepBeforeRemoval = await readControlledFile(keepPath, maxContentBytes);
        const removeBeforeRemoval = await readControlledFile(removePath, maxContentBytes);
        if (!keepBeforeRemoval || !removeBeforeRemoval || keepBeforeRemoval.sha256 !== journal.sha256 ||
          removeBeforeRemoval.sha256 !== journal.sha256 || !sameFileIdentity(keep, keepBeforeRemoval) ||
          !sameFileIdentity(keepBeforeRemoval, removeBeforeRemoval)) {
          throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
        }
        await unlink(removePath);
      }
    } catch (error) {
      throw new ProviderFileRecoveryError("provider rename recovery is incomplete", { cause: error });
    }
  }
  await stateOwner.clearJournal();
}

async function recoverCaseOnlyRename(
  context: ProviderRenameContext,
  journal: RenameJournal & { caseOnly: true },
) {
  const { directory, maxContentBytes, owner: stateOwner } = context;
  const committed = renameStateCommitted(context, journal);
  const desiredFileName = committed ? journal.targetFileName : journal.sourceFileName;
  if (!journal.caseProofFileName) {
    throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
  }
  const proofPath = hiddenProviderPath(directory, journal.caseProofFileName);
  const proof = await readControlledFile(proofPath, maxContentBytes);
  const initialEntries = await providerDirectoryEntries(directory, desiredFileName);
  if (!proof) {
    if (journal.phase !== "prepared" || committed || initialEntries.length !== 1 ||
      initialEntries[0] !== journal.sourceFileName) {
      throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
    }
    const source = await readControlledFile(providerFilePath(directory, journal.sourceFileName), maxContentBytes);
    if (
      !source || source.sha256 !== journal.sha256 || !matchesJournalProof(source, journal)
    ) throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
    await stateOwner.clearJournal();
    return;
  }
  if (
    proof.sha256 !== journal.sha256 || !matchesJournalProof(proof, journal) ||
    initialEntries.length > 1
  ) throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
  await beforeRenameCleanup(context, journal, committed ? "commit-source" : "rollback-target");
  const entriesBeforePublish = await providerDirectoryEntries(directory, desiredFileName);
  if (entriesBeforePublish.length > 1) {
    throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
  }
  const currentFileName = entriesBeforePublish[0] ?? null;
  const proofBeforePublish = await readControlledFile(proofPath, maxContentBytes);
  const current = currentFileName
    ? await readControlledFile(providerFilePath(directory, currentFileName), maxContentBytes)
    : null;
  if (
    !proofBeforePublish || proofBeforePublish.sha256 !== journal.sha256 ||
    !matchesJournalProof(proofBeforePublish, journal) ||
    (current && (
      current.sha256 !== journal.sha256 || !sameFileIdentity(current, proofBeforePublish) ||
      !matchesJournalProof(current, journal)
    ))
  ) throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
  if (currentFileName && currentFileName !== desiredFileName) {
    await unlink(providerFilePath(directory, currentFileName));
  }
  if (currentFileName !== desiredFileName) {
    await context.hooks.afterCaseAliasRemoval?.();
    const proofAfterRemoval = await readControlledFile(proofPath, maxContentBytes);
    if (
      !proofAfterRemoval || proofAfterRemoval.sha256 !== journal.sha256 ||
      !matchesJournalProof(proofAfterRemoval, journal) ||
      !sameFileIdentity(proofBeforePublish, proofAfterRemoval)
    ) throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
    try {
      await link(proofPath, providerFilePath(directory, desiredFileName));
    } catch (error) {
      throw new ProviderFileRecoveryError("provider rename recovery is incomplete", { cause: error });
    }
  }
  const finalFileName = await providerDirectoryEntry(directory, desiredFileName);
  const finalProof = await readControlledFile(proofPath, maxContentBytes);
  const finalFile = await readControlledFile(providerFilePath(directory, finalFileName), maxContentBytes);
  if (
    finalFileName !== desiredFileName || !finalFile || !finalProof ||
    finalFile.sha256 !== journal.sha256 || finalProof.sha256 !== journal.sha256 ||
    !sameFileIdentity(finalFile, finalProof) || !matchesJournalProof(finalFile, journal) ||
    !matchesJournalProof(finalProof, journal)
  ) throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
  await stateOwner.clearJournal();
  await removeCapturedHiddenAfterJournalClear(directory, journal.caseProofFileName, finalProof, maxContentBytes);
}

export function renameStateCommitted(context: ProviderRenameContext, journal: ProviderRenameJournal) {
  const stateOwner = context.owner;
  if (journal.configs) return stateOwner.journal?.phase === "committed";
  if (journal.kind === "manual") {
    const category = journal.category ?? "proxy";
    const source = stateOwner.current.manual.filter((entry) => entry.category === category && entry.fileName === journal.sourceFileName).length;
    const target = stateOwner.current.manual.filter((entry) => entry.category === category && entry.fileName === journal.targetFileName).length;
    if (source === 1 && target === 0) return false;
    if (source === 0 && target === 1) return true;
    throw new ProviderFileRecoveryError("provider rename ownership is ambiguous; recovery is incomplete");
  }
  if (journal.kind === "local") {
    const owner = stateOwner.current.local.find((item) => item.id === journal.subscriptionId);
    if (!owner || owner.providerSha256 !== journal.sha256) {
      throw new ProviderFileRecoveryError("provider rename ownership is ambiguous; recovery is incomplete");
    }
    if (owner.fileName === journal.sourceFileName) return false;
    if (owner.fileName === journal.targetFileName) return true;
    throw new ProviderFileRecoveryError("provider rename ownership is ambiguous; recovery is incomplete");
  }
  const owner = context.subscriptions.find((item) => item.id === journal.subscriptionId);
  if (!owner || !reservesProviderIdentity(owner) || owner.providerSha256 !== journal.sha256) {
    throw new ProviderFileRecoveryError("provider rename ownership is ambiguous; recovery is incomplete");
  }
  if (`${owner.providerName}.yaml` === journal.sourceFileName) return false;
  if (`${owner.providerName}.yaml` === journal.targetFileName) return true;
  throw new ProviderFileRecoveryError("provider rename ownership is ambiguous; recovery is incomplete");
}

async function providerDirectoryEntry(directory: string, fileName: string) {
  const matches = await providerDirectoryEntries(directory, fileName);
  if (matches.length !== 1) throw new ProviderFileRecoveryError("provider rename recovery is incomplete");
  return matches[0]!;
}

async function providerDirectoryEntries(directory: string, fileName: string) {
  const key = providerFileNameKey(fileName);
  return (await readdir(directory)).filter((entry) => providerFileNameKey(entry) === key);
}

async function beforeRenameCleanup(context: ProviderRenameContext, journal: RenameJournal, phase: string) {
  await context.hooks.beforeOperationCleanup?.(journal.operation, phase);
  if (phase === "rollback-target" || phase === "commit-source") {
    await context.hooks.beforeRenameCleanup?.(phase);
  }
}

async function afterRenamePhase(context: ProviderRenameContext, journal: RenameJournal) {
  await context.hooks.afterOperationPhase?.(journal.operation, journal.phase);
  await context.hooks.afterRenamePhase?.(journal.phase);
}
