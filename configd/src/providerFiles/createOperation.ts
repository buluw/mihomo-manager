import { link, lstat, unlink, writeFile } from "node:fs/promises";
import type { ConfigSnapshot, ConfigStore } from "../config/store.js";
import type { ProviderCategory } from "./collectionYaml.js";
import { hash, hiddenFileName, hiddenProviderPath, providerFilePath, providerFileNameKey, readControlledFile, removeCapturedHiddenAfterJournalClear, sameFileIdentity } from "./controlledFiles.js";
import { ProviderFileConflictError, ProviderFileExistsError, ProviderFileRecoveryError } from "./errors.js";
import { matchesJournalProof, type ProviderOperationContext, type ProviderOperationJournal } from "./operationJournal.js";

export async function createProviderFile(
  context: ProviderOperationContext,
  input: {
    category: ProviderCategory;
    fileName: string;
    path: string;
    content: string;
    restoreManual: boolean;
    configCommit: { previous: ConfigSnapshot; content: string } | undefined;
  },
  store: Pick<ConfigStore, "saveFileUnqueued">,
) {
  const { directory, maxContentBytes, owner, hooks } = context;
  const { category, fileName, path, content, restoreManual, configCommit } = input;
  try {
    await lstat(path);
    throw new ProviderFileExistsError("provider file already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stageFileName = hiddenFileName("create");
  const stagePath = hiddenProviderPath(directory, stageFileName);
  let journal: ProviderOperationJournal = {
    version: 1,
    operation: "create",
    ...(restoreManual ? { restoreManual: true } : {}),
    category,
    fileName,
    sha256: hash(content),
    stageFileName,
    ...(configCommit ? {
      configName: configCommit.previous.name,
      configBeforeSha256: configCommit.previous.sha256,
      configAfterSha256: hash(configCommit.content),
    } : {}),
    phase: "prepared",
  };
  await owner.writeJournal(journal);
  await hooks.afterOperationPhase?.(journal.operation, journal.phase);
  let publishedProof: Awaited<ReturnType<typeof readControlledFile>> = null;
  try {
    await writeFile(stagePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    publishedProof = await readControlledFile(stagePath, maxContentBytes);
    if (!publishedProof || publishedProof.sha256 !== journal.sha256) {
      throw new ProviderFileConflictError("provider file changed");
    }
    journal = {
      ...journal,
      proofDevice: String(publishedProof.device),
      proofInode: String(publishedProof.inode),
      phase: "staged",
    };
    await owner.writeJournal(journal);
    await hooks.afterOperationPhase?.(journal.operation, journal.phase);
    await hooks.beforeFileRename?.();
    let stageBeforeLink: Awaited<ReturnType<typeof readControlledFile>> = null;
    try {
      stageBeforeLink = await readControlledFile(stagePath, maxContentBytes);
    } catch {
      // The durable proof below decides whether the hidden candidate is still trusted.
    }
    if (
      !stageBeforeLink || stageBeforeLink.sha256 !== journal.sha256 ||
      !matchesJournalProof(stageBeforeLink, journal)
    ) {
      const conflict = new ProviderFileConflictError("provider file changed");
      journal = { ...journal, phase: "aborting" };
      try {
        await owner.writeJournal(journal);
        await hooks.afterOperationPhase?.(journal.operation, journal.phase);
        await owner.recover();
      } catch (cleanupError) {
        throw new ProviderFileRecoveryError("provider create recovery is incomplete", {
          cause: new AggregateError([conflict, cleanupError], "provider create recovery failed"),
        });
      }
      throw conflict;
    }
    try {
      await link(stagePath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const collision = new ProviderFileExistsError("provider file already exists");
        journal = { ...journal, phase: "aborting" };
        try {
          await owner.writeJournal(journal);
          await hooks.afterOperationPhase?.(journal.operation, journal.phase);
          await owner.recover();
        } catch (cleanupError) {
          throw new ProviderFileRecoveryError("provider create collision recovery is incomplete", {
            cause: new AggregateError([collision, cleanupError], "provider create collision cleanup failed"),
          });
        }
        throw collision;
      }
      throw error;
    }
    const linkedTarget = await readControlledFile(path, maxContentBytes);
    const linkedStage = await readControlledFile(stagePath, maxContentBytes);
    if (
      !linkedTarget || !linkedStage || linkedTarget.sha256 !== journal.sha256 ||
      linkedStage.sha256 !== journal.sha256 || !sameFileIdentity(linkedTarget, linkedStage)
    ) throw new ProviderFileConflictError("provider file changed");
    if (!matchesJournalProof(linkedTarget, journal) || !matchesJournalProof(linkedStage, journal)) {
      throw new ProviderFileConflictError("provider file changed");
    }
    journal = { ...journal, phase: "published" };
    await owner.writeJournal(journal);
  } catch (error) {
    try {
      await owner.recover();
    } catch (recoveryError) {
      throw new ProviderFileRecoveryError("provider create failed; recovery is incomplete", {
        cause: new AggregateError([error, recoveryError], "provider create recovery failed"),
      });
    }
    throw error;
  }
  await hooks.afterOperationPhase?.(journal.operation, journal.phase);
  try {
    const targetBeforeCommit = await readControlledFile(path, maxContentBytes);
    const stageBeforeCommit = await readControlledFile(stagePath, maxContentBytes);
    if (
      !publishedProof || !targetBeforeCommit || !stageBeforeCommit ||
      targetBeforeCommit.sha256 !== journal.sha256 || stageBeforeCommit.sha256 !== journal.sha256 ||
      !sameFileIdentity(targetBeforeCommit, stageBeforeCommit) ||
      !sameFileIdentity(publishedProof, targetBeforeCommit) ||
      !sameFileIdentity(publishedProof, stageBeforeCommit)
    ) throw new ProviderFileConflictError("provider file changed");
    if (configCommit) await store.saveFileUnqueued(
      configCommit.previous.name, configCommit.content, configCommit.previous.sha256);
    if (!restoreManual) {
      const next = {
        manual: [...owner.current.manual, { fileName, category }],
      };
      await owner.commit(next);
    }
    journal = { ...journal, phase: "committed" };
    await owner.writeJournal(journal);
  } catch (error) {
    try {
      await owner.recover();
    } catch (recoveryError) {
      throw new ProviderFileRecoveryError("provider create failed; recovery is incomplete", {
        cause: new AggregateError([error, recoveryError], "provider create recovery failed"),
      });
    }
    throw error;
  }
  await hooks.afterOperationPhase?.(journal.operation, journal.phase);
  try {
    await owner.recover();
  } catch (error) {
    throw new ProviderFileRecoveryError("provider create committed; recovery is incomplete", { cause: error });
  }
}

export async function recoverCreate(context: ProviderOperationContext, journal: Extract<ProviderOperationJournal, { operation: "create" }>) {
  const { directory, maxContentBytes, owner, hooks } = context;
  const category = journal.category;
  if (journal.phase === "aborting") {
    let stage: Awaited<ReturnType<typeof readControlledFile>> = null;
    try {
      const candidate = await readControlledFile(hiddenProviderPath(directory, journal.stageFileName), maxContentBytes);
      if (candidate?.sha256 === journal.sha256 && matchesJournalProof(candidate, journal)) stage = candidate;
    } catch {
      // An untrusted hidden replacement is left isolated after the journal is cleared.
    }
    await hooks.beforeOperationCleanup?.(journal.operation, "cleanup-stage");
    await owner.clearJournal();
    if (stage) await removeCapturedHiddenAfterJournalClear(directory, journal.stageFileName, stage, maxContentBytes);
    return;
  }
  const manual = owner.current.manual.filter((entry) => providerFileNameKey(entry.fileName) === providerFileNameKey(journal.fileName) && entry.category === category);
  if (manual.length > 1 || (manual.length === 1 && manual[0]?.category !== journal.category) ||
    (journal.restoreManual && (manual.length !== 1 || manual[0]?.fileName !== journal.fileName))) {
    throw new ProviderFileRecoveryError("provider create recovery is incomplete");
  }
  // A pre-existing owner is not proof that this missing-body repair committed.
  const committed = journal.restoreManual ? journal.phase === "committed" : manual.length === 1;
  const targetPath = providerFilePath(directory, journal.fileName);
  const target = await readControlledFile(targetPath, maxContentBytes);
  const stage = await readControlledFile(hiddenProviderPath(directory, journal.stageFileName), maxContentBytes);
  if (journal.phase === "prepared") {
    if (committed || target) throw new ProviderFileRecoveryError("provider create recovery is incomplete");
    await owner.clearJournal();
    return;
  }
  if (!stage || !matchesJournalProof(stage, journal)) {
    throw new ProviderFileRecoveryError("provider create recovery is incomplete");
  }
  if (committed) {
    if (
      !target || !stage || target.sha256 !== journal.sha256 || stage.sha256 !== journal.sha256 ||
      !sameFileIdentity(target, stage)
    ) {
      throw new ProviderFileRecoveryError("provider create recovery is incomplete");
    }
  } else if (target) {
    if (target.sha256 !== journal.sha256) throw new ProviderFileRecoveryError("provider create recovery is incomplete");
    if (!stage || stage.sha256 !== journal.sha256 || !sameFileIdentity(target, stage)) {
      throw new ProviderFileRecoveryError("provider create recovery is incomplete");
    }
    await hooks.beforeOperationCleanup?.(journal.operation, "rollback-target");
    const targetBeforeRemoval = await readControlledFile(targetPath, maxContentBytes);
    const stageBeforeRemoval = await readControlledFile(hiddenProviderPath(directory, journal.stageFileName), maxContentBytes);
    if (
      !targetBeforeRemoval || !stageBeforeRemoval ||
      targetBeforeRemoval.sha256 !== journal.sha256 || stageBeforeRemoval.sha256 !== journal.sha256 ||
      !sameFileIdentity(targetBeforeRemoval, stageBeforeRemoval) ||
      !sameFileIdentity(target, targetBeforeRemoval) ||
      !sameFileIdentity(stage, stageBeforeRemoval)
    ) throw new ProviderFileRecoveryError("provider create recovery is incomplete");
    await unlink(targetPath);
  } else if (!stage) {
    throw new ProviderFileRecoveryError("provider create recovery is incomplete");
  }
  await hooks.beforeOperationCleanup?.(journal.operation, "clear-journal");
  const finalTarget = await readControlledFile(targetPath, maxContentBytes);
  const finalStage = await readControlledFile(hiddenProviderPath(directory, journal.stageFileName), maxContentBytes);
  if (committed) {
    if (
      !finalTarget || !finalStage || !stage ||
      finalTarget.sha256 !== journal.sha256 || finalStage.sha256 !== journal.sha256 ||
      !sameFileIdentity(finalTarget, finalStage) || !sameFileIdentity(stage, finalStage)
    ) throw new ProviderFileRecoveryError("provider create recovery is incomplete");
  } else if (
    finalTarget ||
    (stage && (!finalStage || !sameFileIdentity(stage, finalStage))) ||
    (!stage && finalStage)
  ) {
    throw new ProviderFileRecoveryError("provider create recovery is incomplete");
  }
  await owner.clearJournal();
  if (stage) await removeCapturedHiddenAfterJournalClear(directory, journal.stageFileName, stage, maxContentBytes);
}
