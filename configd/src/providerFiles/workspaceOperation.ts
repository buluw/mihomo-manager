import { chmod, chown, link, lstat, rename, unlink, writeFile } from "node:fs/promises";
import type { ConfigStore, ConfigSnapshot } from "../config/store.js";
import { hash, hiddenFileName, hiddenProviderPath, providerFilePath, readControlledFile, sameFileIdentity, validProviderKey } from "./controlledFiles.js";
import { ProviderFileConflictError, ProviderFileRecoveryError } from "./errors.js";
import type { ProviderCategory } from "./collectionYaml.js";
import type { ManagedHttpProviderRecord } from "./types.js";

export type CollectionBodyDraft = { category: ProviderCategory; name: string; content: string; expectedSha256: string | null };
export type CollectionRemoval = { category: ProviderCategory; name: string; fileName: string; sha256: string; identity: string };
type FileProof = { sha256: string; device: string; inode: string };
type WorkspaceFile = { category: ProviderCategory; fileName: string; stage: string; backup: string | null; before: FileProof | null; after: FileProof };
export type WorkspaceJournal = {
  version: 1; configName: string; beforeSha256: string; afterSha256: string;
  phase: "prepared" | "published" | "committed"; files: WorkspaceFile[]; removals: CollectionRemoval[];
  httpProviders?: ManagedHttpProviderRecord[];
};
export type PendingCollectionRemoval = CollectionRemoval & { configName: string };

export interface WorkspaceOperationContext {
  store: Pick<ConfigStore, "read" | "saveFileUnqueued">;
  maxContentBytes: number;
  directory: (category: ProviderCategory) => string;
  journal: WorkspaceJournal | null;
  writeJournal: (journal: WorkspaceJournal | null) => Promise<void>;
  commit: (journal: WorkspaceJournal) => Promise<void>;
  beforePublish?: (() => Promise<void>) | undefined;
}

function proof(value: NonNullable<Awaited<ReturnType<typeof readControlledFile>>>): FileProof {
  return { sha256: value.sha256, device: String(value.device), inode: String(value.inode) };
}
function matches(actual: Awaited<ReturnType<typeof readControlledFile>>, expected: FileProof | null) {
  return expected ? Boolean(actual && actual.sha256 === expected.sha256 && String(actual.device) === expected.device && String(actual.inode) === expected.inode) : actual === null;
}

export function parseWorkspaceJournal(value: unknown): WorkspaceJournal | null {
  if (value == null) return null;
  const journal = value as WorkspaceJournal;
  const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const validProof = (value: FileProof) => value && sha(value.sha256) && /^\d+$/.test(value.device) && /^[1-9]\d*$/.test(value.inode);
  if (journal.version !== 1 || typeof journal.configName !== "string" || !sha(journal.beforeSha256) || !sha(journal.afterSha256) ||
    !["prepared", "published", "committed"].includes(journal.phase) || !Array.isArray(journal.files) || !Array.isArray(journal.removals) ||
    journal.files.some((file) => !["proxy", "rule"].includes(file.category) || !validProviderKey(file.fileName) ||
      !/^\.provider-op-[a-f0-9]{24}\.workspace$/.test(file.stage) || (file.backup !== null && !/^\.provider-op-[a-f0-9]{24}\.workspace$/.test(file.backup)) ||
      (file.before !== null && !validProof(file.before)) || !validProof(file.after))) {
    throw new ProviderFileRecoveryError("collection workspace recovery is incomplete");
  }
  return journal;
}

export async function recoverWorkspace(context: WorkspaceOperationContext) {
  const journal = context.journal;
  if (!journal) return;
  const source = await context.store.read(journal.configName);
  const committed = journal.phase === "committed" ||
    (source.sha256 === journal.afterSha256 && (journal.beforeSha256 !== journal.afterSha256 || journal.phase === "published"));
  if (source.sha256 !== journal.beforeSha256 && source.sha256 !== journal.afterSha256) throw new ProviderFileRecoveryError("collection source changed during recovery");
  for (const file of journal.files) {
    const root = context.directory(file.category);
    const path = providerFilePath(root, file.fileName);
    const current = await readControlledFile(path, context.maxContentBytes);
    if (committed) {
      if (!matches(current, file.after)) throw new ProviderFileRecoveryError("collection body changed during recovery");
    } else if (matches(current, file.after)) {
      if (file.before && file.backup) {
        const backup = hiddenProviderPath(root, file.backup);
        if (!matches(await readControlledFile(backup, context.maxContentBytes), file.before)) throw new ProviderFileRecoveryError("collection backup changed");
        await rename(backup, path);
      } else await unlink(path);
    } else if (!matches(current, file.before)) throw new ProviderFileRecoveryError("collection body changed during recovery");
  }
  if (committed && journal.phase !== "committed") await context.commit({ ...journal, phase: "committed" });
  // Proofs remain durable until all private files are cleaned. Missing private
  // files are harmless when recovery resumes after a completed rename/unlink.
  for (const file of journal.files) {
    for (const [name, expected] of [[file.stage, file.after], [file.backup, file.before]] as const) {
      if (!name || !expected) continue;
      const path = hiddenProviderPath(context.directory(file.category), name);
      const current = await readControlledFile(path, context.maxContentBytes);
      if (current && !matches(current, expected)) throw new ProviderFileRecoveryError("collection private file changed");
      if (current) await unlink(path);
    }
  }
  await context.writeJournal(null);
  return committed;
}

export async function saveWorkspace(context: WorkspaceOperationContext, source: ConfigSnapshot, content: string,
  bodies: Array<CollectionBodyDraft & { fileName: string }>, removals: CollectionRemoval[], httpProviders?: ManagedHttpProviderRecord[]) {
  const files: WorkspaceFile[] = [];
  let durable = false;
  let journal: WorkspaceJournal = { version: 1, configName: source.name, beforeSha256: source.sha256, afterSha256: hash(content), phase: "prepared", files, removals, ...(httpProviders ? { httpProviders } : {}) };
  try {
    for (const body of bodies) {
      const root = context.directory(body.category);
      const path = providerFilePath(root, body.fileName);
      const before = await readControlledFile(path, context.maxContentBytes);
      if ((before?.sha256 ?? null) !== body.expectedSha256) throw new ProviderFileConflictError("provider file changed");
      const stage = hiddenFileName("workspace");
      const stagePath = hiddenProviderPath(root, stage);
      await writeFile(stagePath, body.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const after = await readControlledFile(stagePath, context.maxContentBytes);
      if (!after) throw new ProviderFileConflictError("provider stage unavailable");
      const file: WorkspaceFile = { category: body.category, fileName: body.fileName, stage, backup: before ? hiddenFileName("workspace") : null, before: before ? proof(before) : null, after: proof(after) };
      files.push(file);
      if (before && file.backup) {
        const metadata = await lstat(path);
        await chmod(stagePath, metadata.mode);
        if (process.platform !== "win32") await chown(stagePath, metadata.uid, metadata.gid);
        await link(path, hiddenProviderPath(root, file.backup));
        const backup = await readControlledFile(hiddenProviderPath(root, file.backup), context.maxContentBytes);
        if (!backup || !sameFileIdentity(before, backup) || backup.sha256 !== before.sha256) throw new ProviderFileConflictError("provider file changed");
      }
    }
    await context.writeJournal(journal); durable = true;
    await context.beforePublish?.();
    if ((await context.store.read(source.name)).sha256 !== source.sha256) throw new ProviderFileConflictError("configuration changed");
    for (const file of files) {
      const root = context.directory(file.category);
      const path = providerFilePath(root, file.fileName);
      const stage = hiddenProviderPath(root, file.stage);
      if (!matches(await readControlledFile(path, context.maxContentBytes), file.before) || !matches(await readControlledFile(stage, context.maxContentBytes), file.after)) throw new ProviderFileConflictError("provider file changed");
      if (file.before) await rename(stage, path);
      else await link(stage, path);
    }
    journal = { ...journal, phase: "published" };
    await context.writeJournal(journal);
    if (content !== source.content) await context.store.saveFileUnqueued(source.name, content, source.sha256, true);
    journal = { ...journal, phase: "committed" };
    await context.commit(journal);
    await recoverWorkspace(context);
    return context.store.read(source.name);
  } catch (error) {
    if (durable) {
      if (await recoverWorkspace(context)) return context.store.read(source.name);
    }
    else {
      for (const file of files) for (const name of [file.stage, file.backup]) {
        if (name) await unlink(hiddenProviderPath(context.directory(file.category), name)).catch(() => undefined);
      }
    }
    throw error;
  }
}
