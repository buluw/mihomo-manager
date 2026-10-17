import { chmod, chown, link, lstat, rename, unlink, writeFile } from "node:fs/promises";
import type { PublicSubscription } from "../subscriptions/types.js";
import { hash, hiddenFileName, hiddenProviderPath, providerFileNameKey, providerFilePath, readControlledFile, removeCapturedHiddenAfterJournalClear, sameFileIdentity } from "./controlledFiles.js";
import { ProviderFileConflictError, ProviderFileReadOnlyError, ProviderFileRecoveryError } from "./errors.js";
import { matchesJournalProof, type ProviderOperationContext, type ProviderOperationJournal } from "./operationJournal.js";
import { reservesProviderIdentity } from "./ownership.js";
import type { LocalProviderExtraction, SubscriptionProviderPublish } from "./types.js";

type PublishJournal = Extract<ProviderOperationJournal, { operation: "publish" }>;

export interface ProviderPublishContext extends ProviderOperationContext {
  readonly subscriptions: ReadonlyArray<Pick<PublicSubscription, "id" | "extractProvider" | "providerName" | "providerSha256">>;
  hooks: ProviderOperationContext["hooks"] & {
    afterProviderFilePublish: (() => Promise<void>) | undefined;
  };
}

export async function publishProvider(context: ProviderPublishContext,
  input: SubscriptionProviderPublish,
  commitState: (sha256: string) => Promise<void>,
  ownerKind: "subscription" | "local",
  localIntent?: (intendedSha256: string) => {
    before: LocalProviderExtraction | null;
    after: LocalProviderExtraction;
    source?: { fileName: string; sha256: string; device: string; inode: string };
  },
) {
  const intendedSha256 = hash(input.content);
  const resolvedLocalIntent = localIntent?.(intendedSha256);
  if (intendedSha256 === input.expectedSha256) {
    await commitState(intendedSha256);
    return intendedSha256;
  }
  const stageFileName = hiddenFileName("stage");
  const anchorFileName = input.expectedSha256 ? hiddenFileName("anchor") : stageFileName;
  const backupFileName = input.expectedSha256 ? hiddenFileName("backup") : null;
  let journal: PublishJournal = {
    version: 1,
    operation: "publish",
    subscriptionId: input.subscriptionId,
    ownerKind,
    fileName: input.fileName,
    beforeSha256: input.expectedSha256,
    intendedSha256,
    stageFileName,
    anchorFileName,
    backupFileName,
    ...(resolvedLocalIntent ? {
      localBefore: resolvedLocalIntent.before,
      localAfter: resolvedLocalIntent.after,
      ...(resolvedLocalIntent.source ? {
        localSourceFileName: resolvedLocalIntent.source.fileName,
        localSourceSha256: resolvedLocalIntent.source.sha256,
        localSourceDevice: resolvedLocalIntent.source.device,
        localSourceInode: resolvedLocalIntent.source.inode,
      } : {}),
    } : {}),
    phase: "prepared",
  };
  await context.owner.writeJournal(journal);
  await context.hooks.afterOperationPhase?.(journal.operation, journal.phase);
  const targetPath = providerFilePath(context.directory, input.fileName);
  const stagePath = hiddenProviderPath(context.directory, stageFileName);
  const backupPath = backupFileName ? hiddenProviderPath(context.directory, backupFileName) : null;
  let metadata: Awaited<ReturnType<typeof lstat>> | null = null;
  if (input.expectedSha256) metadata = await lstat(targetPath);
  await writeFile(stagePath, input.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const publishedProof = await readControlledFile(stagePath, context.maxContentBytes);
  if (!publishedProof || publishedProof.sha256 !== intendedSha256) {
    throw new ProviderFileConflictError("subscription provider file changed");
  }
  if (metadata) {
    await chmod(stagePath, metadata.mode);
    if (process.platform !== "win32") await chown(stagePath, metadata.uid, metadata.gid);
    await link(targetPath, backupPath!);
    await link(stagePath, hiddenProviderPath(context.directory, anchorFileName));
    const current = await readControlledFile(targetPath, context.maxContentBytes);
    const backup = await readControlledFile(backupPath!, context.maxContentBytes);
    if (
      !current || !backup || current.sha256 !== input.expectedSha256 ||
      backup.sha256 !== input.expectedSha256 || !sameFileIdentity(current, backup)
    ) throw new ProviderFileConflictError("subscription provider file changed");
  }
  const stageAfterPermissions = await readControlledFile(stagePath, context.maxContentBytes);
  const anchorAfterStaging = await readControlledFile(hiddenProviderPath(context.directory, anchorFileName), context.maxContentBytes);
  if (
    !stageAfterPermissions || !anchorAfterStaging ||
    stageAfterPermissions.sha256 !== intendedSha256 || anchorAfterStaging.sha256 !== intendedSha256 ||
    !sameFileIdentity(publishedProof, stageAfterPermissions) ||
    !sameFileIdentity(stageAfterPermissions, anchorAfterStaging)
  ) throw new ProviderFileConflictError("subscription provider file changed");
  journal = {
    ...journal,
    proofDevice: String(stageAfterPermissions.device),
    proofInode: String(stageAfterPermissions.inode),
    phase: "staged",
  };
  await context.owner.writeJournal(journal);
  await context.hooks.afterOperationPhase?.(journal.operation, journal.phase);
  await context.hooks.beforeFileRename?.();
  const abortChangedCandidate = async () => {
    const conflict = new ProviderFileConflictError("subscription provider file changed");
    journal = { ...journal, phase: "aborting" };
    try {
      await context.owner.writeJournal(journal);
      await context.hooks.afterOperationPhase?.(journal.operation, journal.phase);
      await context.owner.recover();
    } catch (cleanupError) {
      throw new ProviderFileRecoveryError("provider publish recovery is incomplete", {
        cause: new AggregateError([conflict, cleanupError], "provider publish recovery failed"),
      });
    }
    throw conflict;
  };
  if (input.expectedSha256) {
    const targetBeforePublish = await readControlledFile(targetPath, context.maxContentBytes);
    const backupBeforePublish = await readControlledFile(backupPath!, context.maxContentBytes);
    if (
      !targetBeforePublish || !backupBeforePublish ||
      targetBeforePublish.sha256 !== input.expectedSha256 ||
      backupBeforePublish.sha256 !== input.expectedSha256 ||
      !sameFileIdentity(targetBeforePublish, backupBeforePublish)
    ) throw new ProviderFileConflictError("subscription provider file changed");
    let anchorBeforePublish: Awaited<ReturnType<typeof readControlledFile>> = null;
    let stageBeforePublish: Awaited<ReturnType<typeof readControlledFile>> = null;
    try {
      anchorBeforePublish = await readControlledFile(hiddenProviderPath(context.directory, anchorFileName), context.maxContentBytes);
      stageBeforePublish = await readControlledFile(stagePath, context.maxContentBytes);
    } catch {
      // The durable proof below decides whether the hidden candidate is still trusted.
    }
    if (
      !stageBeforePublish || !anchorBeforePublish ||
      stageBeforePublish.sha256 !== intendedSha256 || anchorBeforePublish.sha256 !== intendedSha256 ||
      !matchesJournalProof(stageBeforePublish, journal) ||
      !matchesJournalProof(anchorBeforePublish, journal) ||
      !sameFileIdentity(stageBeforePublish, anchorBeforePublish)
    ) await abortChangedCandidate();
    await rename(stagePath, targetPath);
  } else {
    let anchorBeforePublish: Awaited<ReturnType<typeof readControlledFile>> = null;
    let stageBeforePublish: Awaited<ReturnType<typeof readControlledFile>> = null;
    try {
      anchorBeforePublish = await readControlledFile(hiddenProviderPath(context.directory, anchorFileName), context.maxContentBytes);
      stageBeforePublish = await readControlledFile(stagePath, context.maxContentBytes);
    } catch {
      // The durable proof below decides whether the hidden candidate is still trusted.
    }
    if (
      !stageBeforePublish || !anchorBeforePublish ||
      stageBeforePublish.sha256 !== intendedSha256 || anchorBeforePublish.sha256 !== intendedSha256 ||
      !matchesJournalProof(stageBeforePublish, journal) ||
      !matchesJournalProof(anchorBeforePublish, journal) ||
      !sameFileIdentity(stageBeforePublish, anchorBeforePublish)
    ) await abortChangedCandidate();
    try {
      await link(stagePath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const collision = new ProviderFileReadOnlyError("subscription provider ownership is unavailable");
        journal = { ...journal, phase: "aborting" };
        try {
          await context.owner.writeJournal(journal);
          await context.hooks.afterOperationPhase?.(journal.operation, journal.phase);
          await context.owner.recover();
        } catch (cleanupError) {
          throw new ProviderFileRecoveryError("provider publish collision recovery is incomplete", {
            cause: new AggregateError([collision, cleanupError], "provider publish collision cleanup failed"),
          });
        }
        throw collision;
      }
      throw error;
    }
  }
  await context.hooks.afterProviderFilePublish?.();
  journal = { ...journal, phase: "published" };
  await context.owner.writeJournal(journal);
  await context.hooks.afterOperationPhase?.(journal.operation, journal.phase);
  const targetBeforeCommit = await readControlledFile(targetPath, context.maxContentBytes);
  const anchorBeforeCommit = await readControlledFile(hiddenProviderPath(context.directory, anchorFileName), context.maxContentBytes);
  if (
    !targetBeforeCommit || !anchorBeforeCommit ||
    targetBeforeCommit.sha256 !== intendedSha256 || anchorBeforeCommit.sha256 !== intendedSha256 ||
    !sameFileIdentity(targetBeforeCommit, anchorBeforeCommit)
  ) throw new ProviderFileConflictError("subscription provider file changed");
  try {
    await commitState(intendedSha256);
  } catch (error) {
    try {
      await context.owner.recover();
    } catch (recoveryError) {
      throw new ProviderFileRecoveryError("provider publish failed; recovery is incomplete", {
        cause: new AggregateError([error, recoveryError], "provider publish recovery failed"),
      });
    }
    throw error;
  }
  journal = { ...journal, phase: "committed" };
  try {
    await context.owner.writeJournal(journal);
    await context.hooks.afterOperationPhase?.(journal.operation, journal.phase);
    await context.owner.recover();
  } catch (error) {
    throw new ProviderFileRecoveryError("provider publish committed; recovery is incomplete", { cause: error });
  }
  return intendedSha256;
}

export async function recoverPublish(context: ProviderPublishContext, journal: PublishJournal) {
  if (journal.phase === "aborting") {
    return finishPublishAbort(context, journal);
  }
  const owner = publishOwner(context, journal);
  let committed: boolean;
  if (journal.ownerKind === "local") {
    const localOwner = owner as LocalProviderExtraction | null;
    if (!journal.localAfter || journal.localBefore === undefined) {
      throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    }
    if (sameLocalExtraction(localOwner, journal.localAfter)) committed = true;
    else if (sameLocalExtraction(localOwner, journal.localBefore)) committed = false;
    else throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
  } else {
    if (!owner || (owner.providerSha256 !== journal.beforeSha256 && owner.providerSha256 !== journal.intendedSha256)) {
      throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    }
    committed = owner.providerSha256 === journal.intendedSha256;
  }
  const targetPath = providerFilePath(context.directory, journal.fileName);
  let target = await readControlledFile(targetPath, context.maxContentBytes);
  if (journal.phase === "prepared") {
    if (committed) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    let backup: Awaited<ReturnType<typeof readControlledFile>> = null;
    if (journal.beforeSha256 === null) {
      if (target) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    } else {
      if (!target || target.sha256 !== journal.beforeSha256) {
        throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
      }
      if (journal.backupFileName) {
        backup = await readControlledFile(hiddenProviderPath(context.directory, journal.backupFileName), context.maxContentBytes);
        if (backup && (
          backup.sha256 !== journal.beforeSha256 || !sameFileIdentity(target, backup)
        )) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
      }
    }
    await context.hooks.beforeOperationCleanup?.(journal.operation, "clear-journal");
    const finalTarget = await readControlledFile(targetPath, context.maxContentBytes);
    const finalBackup = journal.backupFileName
      ? await readControlledFile(hiddenProviderPath(context.directory, journal.backupFileName), context.maxContentBytes)
      : null;
    if (journal.beforeSha256 === null) {
      if (finalTarget || finalBackup) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    } else if (
      !finalTarget || finalTarget.sha256 !== journal.beforeSha256 ||
      (backup
        ? !finalBackup || !sameFileIdentity(backup, finalBackup) ||
          !sameFileIdentity(finalTarget, finalBackup)
        : Boolean(finalBackup))
    ) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    await context.owner.clearJournal();
    if (backup && journal.backupFileName) {
      await removeCapturedHiddenAfterJournalClear(context.directory, journal.backupFileName, backup, context.maxContentBytes);
    }
    return;
  }
  if (journal.phase === "staged") {
    let stage: Awaited<ReturnType<typeof readControlledFile>> = null;
    let anchor: Awaited<ReturnType<typeof readControlledFile>> = null;
    try {
      stage = await readControlledFile(hiddenProviderPath(context.directory, journal.stageFileName), context.maxContentBytes);
      anchor = await readControlledFile(hiddenProviderPath(context.directory, journal.anchorFileName), context.maxContentBytes);
    } catch {
      // Public-state checks below determine whether this can safely become a pre-publish abort.
    }
    const candidateValid = Boolean(
      stage && anchor && stage.sha256 === journal.intendedSha256 &&
      anchor.sha256 === journal.intendedSha256 && matchesJournalProof(stage, journal) &&
      matchesJournalProof(anchor, journal) && sameFileIdentity(stage, anchor),
    );
    let publicUntouched = !target && journal.beforeSha256 === null;
    if (target && journal.beforeSha256 && journal.backupFileName) {
      const backup = await readControlledFile(hiddenProviderPath(context.directory, journal.backupFileName), context.maxContentBytes);
      publicUntouched = Boolean(
        backup && target.sha256 === journal.beforeSha256 && backup.sha256 === journal.beforeSha256 &&
        sameFileIdentity(target, backup),
      );
    }
    if (!candidateValid && publicUntouched) {
      const abortingJournal: PublishJournal = {
        ...journal,
        phase: "aborting",
      };
      await context.owner.writeJournal(abortingJournal);
      await context.hooks.afterOperationPhase?.(abortingJournal.operation, abortingJournal.phase);
      return finishPublishAbort(context, abortingJournal);
    }
    if (!candidateValid) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
  }
  if (journal.phase === "cleanup-only") {
    return finishPublishCleanupOnly(context, journal, committed);
  }
  if (journal.phase === "cleaning") {
    return enterPublishCleanupOnly(context, journal, committed);
  }
  const anchor = await readControlledFile(hiddenProviderPath(context.directory, journal.anchorFileName), context.maxContentBytes);
  if (committed) {
    if (
      !target || !anchor || target.sha256 !== journal.intendedSha256 ||
      anchor.sha256 !== journal.intendedSha256 || !sameFileIdentity(target, anchor)
    ) {
      throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    }
  } else if (journal.beforeSha256 === null) {
    if (target) {
      if (target.sha256 !== journal.intendedSha256) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
      if (!anchor || anchor.sha256 !== journal.intendedSha256 || !sameFileIdentity(target, anchor)) {
        throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
      }
      await context.hooks.beforeOperationCleanup?.(journal.operation, "rollback-target");
      const targetBeforeRemoval = await readControlledFile(targetPath, context.maxContentBytes);
      const anchorBeforeRemoval = await readControlledFile(hiddenProviderPath(context.directory, journal.anchorFileName), context.maxContentBytes);
      if (
        !targetBeforeRemoval || !anchorBeforeRemoval ||
        targetBeforeRemoval.sha256 !== journal.intendedSha256 ||
        anchorBeforeRemoval.sha256 !== journal.intendedSha256 ||
        !sameFileIdentity(targetBeforeRemoval, anchorBeforeRemoval)
      ) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
      await unlink(targetPath);
    }
  } else if (!target || target.sha256 !== journal.beforeSha256) {
    if (target && target.sha256 !== journal.intendedSha256) {
      throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    }
    if (target && (!anchor || anchor.sha256 !== journal.intendedSha256 || !sameFileIdentity(target, anchor))) {
      throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    }
    if (!journal.backupFileName) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    const backupPath = hiddenProviderPath(context.directory, journal.backupFileName);
    const backup = await readControlledFile(backupPath, context.maxContentBytes);
    if (!backup || backup.sha256 !== journal.beforeSha256) {
      throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    }
    const restorePath = hiddenProviderPath(context.directory, hiddenFileName("restore"));
    await link(backupPath, restorePath);
    const publishedTargetExisted = Boolean(target);
    try {
      await context.hooks.beforeOperationCleanup?.(journal.operation, "rollback-target");
      const targetBeforeRestore = await readControlledFile(targetPath, context.maxContentBytes);
      const anchorBeforeRestore = await readControlledFile(hiddenProviderPath(context.directory, journal.anchorFileName), context.maxContentBytes);
      if (publishedTargetExisted) {
        if (
          !targetBeforeRestore || !anchorBeforeRestore ||
          targetBeforeRestore.sha256 !== journal.intendedSha256 ||
          anchorBeforeRestore.sha256 !== journal.intendedSha256 ||
          !sameFileIdentity(targetBeforeRestore, anchorBeforeRestore)
        ) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
      } else if (targetBeforeRestore) {
        throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
      }
      await rename(restorePath, targetPath);
    } finally {
      await unlink(restorePath).catch(() => undefined);
    }
    target = await readControlledFile(targetPath, context.maxContentBytes);
    if (!target || target.sha256 !== journal.beforeSha256) {
      throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    }
  } else {
    if (!journal.backupFileName) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    const backup = await readControlledFile(hiddenProviderPath(context.directory, journal.backupFileName), context.maxContentBytes);
    if (!backup ||
      backup.sha256 !== journal.beforeSha256 || !target ||
      target.sha256 !== journal.beforeSha256 || !sameFileIdentity(target, backup)
    ) {
      throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    }
  }
  await cleanupPublishNonProof(context, journal, committed);
  await assertPublishFinalState(context, journal, committed);
  const cleaningJournal: PublishJournal = {
    ...journal,
    phase: "cleaning",
  };
  await context.owner.writeJournal(cleaningJournal);
  await context.hooks.afterOperationPhase?.(cleaningJournal.operation, cleaningJournal.phase);
  await enterPublishCleanupOnly(context, cleaningJournal, committed);
}

async function enterPublishCleanupOnly(context: ProviderPublishContext,
  journal: PublishJournal,
  committed: boolean,
) {
  await cleanupPublishNonProof(context, journal, committed);
  await assertPublishFinalState(context, journal, committed);
  const cleanupOnlyJournal: PublishJournal = {
    ...journal,
    phase: "cleanup-only",
  };
  await context.owner.writeJournal(cleanupOnlyJournal);
  await context.hooks.afterOperationPhase?.(cleanupOnlyJournal.operation, cleanupOnlyJournal.phase);
  await finishPublishCleanupOnly(context, cleanupOnlyJournal, committed);
}

async function finishPublishCleanupOnly(context: ProviderPublishContext,
  journal: PublishJournal,
  committed: boolean,
) {
  const proof = await assertPublishFinalState(context, journal, committed);
  if (!proof) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
  if (committed && journal.localSourceFileName) {
    const oldPath = providerFilePath(context.directory, journal.localSourceFileName);
    const old = await readControlledFile(oldPath, context.maxContentBytes);
    if (old) {
      if (old.sha256 !== journal.localSourceSha256 || String(old.device) !== journal.localSourceDevice || String(old.inode) !== journal.localSourceInode) {
        throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
      }
      await context.hooks.beforeOperationCleanup?.(journal.operation, "cleanup-local-source");
      const confirm = await readControlledFile(oldPath, context.maxContentBytes);
      if (!confirm || confirm.sha256 !== journal.localSourceSha256 || String(confirm.device) !== journal.localSourceDevice || String(confirm.inode) !== journal.localSourceInode) {
        throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
      }
      await unlink(oldPath);
    }
    if (await readControlledFile(oldPath, context.maxContentBytes)) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
  }
  await context.hooks.beforeOperationCleanup?.(journal.operation, "clear-journal");
  await context.owner.clearJournal();
  try {
    const currentProof = await readControlledFile(hiddenProviderPath(context.directory, proof.fileName), context.maxContentBytes);
    if (currentProof && sameFileIdentity(proof, currentProof)) {
      await unlink(hiddenProviderPath(context.directory, proof.fileName));
    }
  } catch {
    // The journal is already clear; an unexpected hidden entry is safer left untouched.
  }
}

async function cleanupPublishNonProof(context: ProviderPublishContext,
  journal: PublishJournal,
  committed: boolean,
) {
  const proofFileName = committed
    ? journal.anchorFileName
    : journal.beforeSha256
      ? journal.backupFileName
      : journal.anchorFileName;
  for (const [fileName, sha256, phase] of [
    [journal.anchorFileName, journal.intendedSha256, "cleanup-anchor"],
    [journal.stageFileName, journal.intendedSha256, "cleanup-stage"],
    [journal.backupFileName, journal.beforeSha256, "cleanup-backup"],
  ] as const) {
    if (!fileName || !sha256 || fileName === proofFileName) continue;
    await removeHiddenExact(context, journal, fileName, sha256, phase);
  }
}

async function assertPublishFinalState(context: ProviderPublishContext,
  journal: PublishJournal,
  committed: boolean,
) {
  const target = await readControlledFile(providerFilePath(context.directory, journal.fileName), context.maxContentBytes);
  const proofFileName = committed
    ? journal.anchorFileName
    : journal.beforeSha256
      ? journal.backupFileName
      : journal.anchorFileName;
  if (!proofFileName) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
  const expectedSha256 = committed ? journal.intendedSha256 : journal.beforeSha256 ?? journal.intendedSha256;
  const proof = await readControlledFile(hiddenProviderPath(context.directory, proofFileName), context.maxContentBytes);
  if (committed || journal.beforeSha256) {
    if (!target || target.sha256 !== expectedSha256) {
      throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    }
    if (proof && (proof.sha256 !== expectedSha256 || !sameFileIdentity(target, proof))) {
      throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
    }
  } else if (target) {
    throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
  } else if (proof && proof.sha256 !== expectedSha256) {
    throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
  }
  if (!proof) {
    throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
  }
  return proof ? { ...proof, fileName: proofFileName } : null;
}

async function finishPublishAbort(context: ProviderPublishContext, journal: PublishJournal) {
  const captured = new Map<string, NonNullable<Awaited<ReturnType<typeof readControlledFile>>>>();
  for (const fileName of new Set([journal.stageFileName, journal.anchorFileName])) {
    try {
      const file = await readControlledFile(hiddenProviderPath(context.directory, fileName), context.maxContentBytes);
      if (
        file?.sha256 === journal.intendedSha256 && matchesJournalProof(file, journal)
      ) captured.set(fileName, file);
    } catch {
      // Unknown hidden replacements are not transaction proof and remain isolated.
    }
  }
  if (journal.backupFileName && journal.beforeSha256) {
    const target = await readControlledFile(providerFilePath(context.directory, journal.fileName), context.maxContentBytes);
    const backup = await readControlledFile(hiddenProviderPath(context.directory, journal.backupFileName), context.maxContentBytes);
    if (
      target && backup && target.sha256 === journal.beforeSha256 &&
      backup.sha256 === journal.beforeSha256 && sameFileIdentity(target, backup)
    ) captured.set(journal.backupFileName, backup);
    else if (backup) throw new ProviderFileRecoveryError("provider publish recovery is incomplete");
  }
  for (const fileName of captured.keys()) {
    await context.hooks.beforeOperationCleanup?.(journal.operation, fileName === journal.backupFileName
      ? "cleanup-backup"
      : fileName === journal.anchorFileName ? "cleanup-anchor" : "cleanup-stage");
  }
  await context.owner.clearJournal();
  for (const [fileName, file] of captured) await removeCapturedHiddenAfterJournalClear(context.directory, fileName, file, context.maxContentBytes);
}

export function publishOwner(context: ProviderPublishContext, journal: PublishJournal) {
  if (journal.ownerKind === "local") {
    const owner = context.owner.current.local.find((item) => item.id === journal.subscriptionId);
    return owner && (
      owner.fileName === journal.fileName ||
      owner.fileName === journal.localBefore?.fileName ||
      owner.fileName === journal.localAfter?.fileName
    )
      ? owner
      : null;
  }
  const owner = context.subscriptions.find((item) => item.id === journal.subscriptionId);
  return owner && reservesProviderIdentity(owner) &&
    providerFileNameKey(`${owner.providerName}.yaml`) === providerFileNameKey(journal.fileName)
    ? owner
    : null;
}

function sameLocalExtraction(
  left: LocalProviderExtraction | null | undefined,
  right: LocalProviderExtraction | null | undefined,
) {
  if (left == null || right == null) return left === right;
  return left.id === right.id && left.configName === right.configName &&
    left.sourceSha256 === right.sourceSha256 && left.fileName === right.fileName &&
    left.providerSha256 === right.providerSha256 && left.nodeCount === right.nodeCount &&
    left.enabled === right.enabled &&
    left.filterSettings.version === right.filterSettings.version &&
    left.filterSettings.enabled === right.filterSettings.enabled &&
    left.filterSettings.rules.length === right.filterSettings.rules.length &&
    left.filterSettings.rules.every((rule, index) => rule === right.filterSettings.rules[index]);
}

async function removeHiddenExact(context: ProviderPublishContext,
  journal: PublishJournal,
  fileName: string,
  expectedSha256: string,
  phase: string,
) {
  const path = hiddenProviderPath(context.directory, fileName);
  const file = await readControlledFile(path, context.maxContentBytes);
  if (!file) return;
  if (file.sha256 !== expectedSha256) throw new ProviderFileRecoveryError("provider operation recovery is incomplete");
  await context.hooks.beforeOperationCleanup?.(journal.operation, phase);
  const latest = await readControlledFile(path, context.maxContentBytes);
  if (!latest) return;
  if (latest.sha256 !== expectedSha256 || !sameFileIdentity(file, latest)) {
    throw new ProviderFileRecoveryError("provider operation recovery is incomplete");
  }
  await unlink(path);
}
