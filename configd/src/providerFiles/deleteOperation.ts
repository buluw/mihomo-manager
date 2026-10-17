import { link, unlink } from "node:fs/promises";
import type { ProviderCategory } from "./collectionYaml.js";
import { hash, hiddenFileName, hiddenProviderPath, providerFilePath, providerFileNameKey, readControlledFile, removeCapturedHiddenAfterJournalClear, sameFileIdentity } from "./controlledFiles.js";
import { ProviderFileConflictError, ProviderFileRecoveryError } from "./errors.js";
import { matchesJournalProof, type ProviderOperationContext, type ProviderOperationJournal } from "./operationJournal.js";
import type { ProviderFileRecord, SubscriptionProviderIdentity } from "./types.js";

export async function deleteProviderFile(
  context: ProviderOperationContext,
  input: {
    category: ProviderCategory;
    fileName: string;
    path: string;
    expectedSha256: string;
    current: Pick<ProviderFileRecord, "sha256" | "source" | "ownerId">;
    httpCache: boolean;
    selected: boolean;
    maintainedOwner: Extract<ProviderOperationJournal, { operation: "delete" }>["maintainedOwner"];
    configTransaction: { name: string; beforeSha256: string; afterSha256: string } | undefined;
    cleanupIdentity: string | undefined;
  },
  commitState?: () => Promise<void>,
) {
  const { directory, maxContentBytes, owner, hooks } = context;
  const { category, fileName, path, expectedSha256, current, httpCache, selected, maintainedOwner, configTransaction, cleanupIdentity } = input;
  const backupFileName = hiddenFileName("delete");
  const backupPath = hiddenProviderPath(directory, backupFileName);
  let journal: ProviderOperationJournal = {
    version: 1,
    operation: "delete",
    ...(httpCache ? { httpCache: true } : {}),
    ...(selected ? { selected: true } : {}),
    ...(maintainedOwner ? { maintainedOwner } : {}),
    category,
    fileName,
    sha256: expectedSha256,
    backupFileName,
    ...(configTransaction ? {
      configName: configTransaction.name,
      configBeforeSha256: configTransaction.beforeSha256,
      configAfterSha256: configTransaction.afterSha256,
    } : {}),
    phase: "prepared",
  };
  await owner.writeJournal(journal);
  await hooks.afterOperationPhase?.(journal.operation, journal.phase);
  let backedUpProof: Awaited<ReturnType<typeof readControlledFile>> = null;
  try {
    backedUpProof = await readControlledFile(path, maxContentBytes);
    if (!backedUpProof || backedUpProof.sha256 !== journal.sha256) {
      throw new ProviderFileConflictError("provider file changed");
    }
    if (cleanupIdentity && hash(JSON.stringify([String(backedUpProof.device), String(backedUpProof.inode), current.sha256,
      current.source, current.ownerId, (owner.current.httpCachePaths ?? []).includes(providerFilePath(directory, fileName))])) !== cleanupIdentity) throw new ProviderFileConflictError("provider file changed");
    journal = {
      ...journal,
      proofDevice: String(backedUpProof.device),
      proofInode: String(backedUpProof.inode),
      phase: "staged",
    };
    await owner.writeJournal(journal);
    await hooks.afterOperationPhase?.(journal.operation, journal.phase);
    await link(path, backupPath);
    const source = await readControlledFile(path, maxContentBytes);
    const backup = await readControlledFile(backupPath, maxContentBytes);
    if (
      !source || !backup || source.sha256 !== expectedSha256 || backup.sha256 !== expectedSha256 ||
      !sameFileIdentity(source, backup)
    ) throw new ProviderFileConflictError("provider file changed");
    if (!matchesJournalProof(source, journal) || !matchesJournalProof(backup, journal)) {
      throw new ProviderFileConflictError("provider file changed");
    }
    journal = { ...journal, phase: "backed-up" };
    await owner.writeJournal(journal);
  } catch (error) {
    try {
      await owner.recover();
    } catch (recoveryError) {
      throw new ProviderFileRecoveryError("provider delete failed; recovery is incomplete", {
        cause: new AggregateError([error, recoveryError], "provider delete recovery failed"),
      });
    }
    throw error;
  }
  await hooks.afterOperationPhase?.(journal.operation, journal.phase);
  try {
    const sourceBeforeCommit = await readControlledFile(path, maxContentBytes);
    const backupBeforeCommit = await readControlledFile(backupPath, maxContentBytes);
    if (
      !backedUpProof || !sourceBeforeCommit || !backupBeforeCommit ||
      sourceBeforeCommit.sha256 !== journal.sha256 || backupBeforeCommit.sha256 !== journal.sha256 ||
      !sameFileIdentity(sourceBeforeCommit, backupBeforeCommit) ||
      !sameFileIdentity(backedUpProof, sourceBeforeCommit) ||
      !sameFileIdentity(backedUpProof, backupBeforeCommit)
    ) throw new ProviderFileConflictError("provider file changed");
    if (commitState) await commitState();
    else {
      const next = {
        ...(selected ? { operationJournal: { ...journal, phase: "committed" as const } } : {}),
        ...(httpCache ? { httpCachePaths: (owner.current.httpCachePaths ?? []).filter((entry) => entry !== path) } : {}),
        manual: owner.current.manual.filter(
          (entry) => entry.category !== category || providerFileNameKey(entry.fileName) !== providerFileNameKey(fileName),
        ),
      };
      await owner.commit(next);
    }
    journal = { ...journal, phase: "committed" };
    await owner.writeJournal(journal);
  } catch (error) {
    try {
      await owner.recover();
    } catch (recoveryError) {
      throw new ProviderFileRecoveryError("provider delete failed; recovery is incomplete", {
        cause: new AggregateError([error, recoveryError], "provider delete recovery failed"),
      });
    }
    throw error;
  }
  await hooks.afterOperationPhase?.(journal.operation, journal.phase);
  try {
    await owner.recover();
  } catch (error) {
    throw new ProviderFileRecoveryError("provider delete committed; recovery is incomplete", { cause: error });
  }
}

export async function recoverDelete(
  context: ProviderOperationContext,
  journal: Extract<ProviderOperationJournal, { operation: "delete" }>,
  clearSubscriptionProviderUnqueued: ((identity: SubscriptionProviderIdentity) => Promise<void>) | undefined,
) {
  const { directory, maxContentBytes, owner, hooks } = context;
  const category = journal.category;
  const manual = owner.current.manual.filter((entry) => providerFileNameKey(entry.fileName) === providerFileNameKey(journal.fileName) && entry.category === category);
  if (!journal.selected && (manual.length > 1 || (manual.length === 1 && manual[0]?.category !== journal.category))) {
    throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
  }
  const committed = journal.selected ? journal.phase === "committed"
    : journal.httpCache ? !(owner.current.httpCachePaths ?? []).includes(providerFilePath(directory, journal.fileName)) : manual.length === 0;
  const sourcePath = providerFilePath(directory, journal.fileName);
  const backupPath = hiddenProviderPath(directory, journal.backupFileName);
  let source = await readControlledFile(sourcePath, maxContentBytes);
  const backup = await readControlledFile(backupPath, maxContentBytes);
  if (journal.phase === "prepared") {
    if (committed || backup) throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
    await owner.clearJournal();
    return;
  }
  if (journal.phase === "staged" && !backup) {
    if (committed) throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
    await hooks.beforeOperationCleanup?.(journal.operation, "clear-journal");
    if (await readControlledFile(backupPath, maxContentBytes)) {
      throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
    }
    await owner.clearJournal();
    return;
  }
  if (!backup || !matchesJournalProof(backup, journal)) {
    throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
  }
  if (source && source.sha256 !== journal.sha256) throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
  if (backup && backup.sha256 !== journal.sha256) throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
  if (!committed && !source) {
    if (!backup) throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
    await link(backupPath, sourcePath);
    source = await readControlledFile(sourcePath, maxContentBytes);
  }
  if (!source && !backup && !committed) throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
  if (committed && source) {
    if (!backup || !sameFileIdentity(source, backup)) {
      throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
    }
    await hooks.beforeOperationCleanup?.(journal.operation, "commit-source");
    const sourceBeforeRemoval = await readControlledFile(sourcePath, maxContentBytes);
    const backupBeforeRemoval = await readControlledFile(backupPath, maxContentBytes);
    if (
      !sourceBeforeRemoval || !backupBeforeRemoval ||
      sourceBeforeRemoval.sha256 !== journal.sha256 || backupBeforeRemoval.sha256 !== journal.sha256 ||
      !sameFileIdentity(sourceBeforeRemoval, backupBeforeRemoval) ||
      !sameFileIdentity(source, sourceBeforeRemoval) ||
      !sameFileIdentity(backup, backupBeforeRemoval)
    ) throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
    await unlink(sourcePath);
  }
  if (!committed && source && backup && !sameFileIdentity(source, backup)) {
    throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
  }
  if (!backup) {
    throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
  }
  await hooks.beforeOperationCleanup?.(journal.operation, "clear-journal");
  const finalSource = await readControlledFile(sourcePath, maxContentBytes);
  const finalBackup = await readControlledFile(backupPath, maxContentBytes);
  if (committed) {
    if (
      finalSource || !finalBackup || !backup ||
      finalBackup.sha256 !== journal.sha256 || !sameFileIdentity(backup, finalBackup)
    ) throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
  } else if (backup) {
    if (
      !finalSource || !finalBackup || finalSource.sha256 !== journal.sha256 ||
      finalBackup.sha256 !== journal.sha256 || !sameFileIdentity(finalSource, finalBackup) ||
      !sameFileIdentity(backup, finalBackup)
    ) throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
  } else if (!finalSource || finalSource.sha256 !== journal.sha256 || finalBackup) {
    throw new ProviderFileRecoveryError("provider delete recovery is incomplete");
  }
  if (committed && journal.maintainedOwner) {
    const maintainedOwner = journal.maintainedOwner;
    if (maintainedOwner.kind === "subscription") {
      if (!clearSubscriptionProviderUnqueued) throw new ProviderFileRecoveryError("subscription state writer is unavailable");
      await clearSubscriptionProviderUnqueued({
        subscriptionId: maintainedOwner.id, fileName: journal.fileName, expectedSha256: journal.sha256,
      });
    } else {
      const relation = owner.current.local.find((entry) => entry.id === maintainedOwner.id);
      if (!relation || relation.fileName !== journal.fileName ||
        (relation.providerSha256 !== null && relation.providerSha256 !== journal.sha256)) {
        throw new ProviderFileRecoveryError("local provider deletion state changed");
      }
      if (relation.providerSha256 !== null) {
        const next = { local: owner.current.local.map((entry) => entry.id === maintainedOwner.id
          ? { ...entry, providerSha256: null, nodeCount: 0 } : entry) };
        await owner.commit(next);
      }
    }
  }
  await owner.clearJournal();
  if (backup) await removeCapturedHiddenAfterJournalClear(directory, journal.backupFileName, backup, maxContentBytes);
}
