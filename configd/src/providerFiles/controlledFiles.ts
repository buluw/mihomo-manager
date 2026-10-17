import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ProviderFileConflictError, ProviderFileNameError, ProviderFileReadOnlyError, ProviderFileRecoveryError, ProviderFileValidationError } from "./errors.js";

export function hash(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

export function isWithin(root: string, target: string) {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export function isWithinOrSame(root: string, target: string) {
  return resolve(root) === resolve(target) || isWithin(root, target);
}

export function providerFileNameKey(fileName: string) {
  return process.platform === "win32" ? fileName.toLocaleLowerCase("en-US") : fileName;
}

export async function ensureProviderDirectoryControlled(dataDirectory: string,
  providerDirectory: string,
  ruleProviderDirectory?: string) {
  const dataDir = resolve(dataDirectory);
  try {
    const dataMetadata = await lstat(dataDir);
    if (!dataMetadata.isDirectory() || dataMetadata.isSymbolicLink()) throw new Error();
    const realDataDir = await realpath(dataDir);
    for (const providerDir of [resolve(providerDirectory), resolve(ruleProviderDirectory ?? join(dataDirectory, "ruleset"))]) {
      if (!isWithinOrSame(dataDir, providerDir)) {
        throw new ProviderFileNameError("provider directory is outside the Mihomo data directory");
      }
      let current = dataDir;
      const child = relative(dataDir, providerDir);
      for (const segment of child ? child.split(sep) : []) {
        current = join(current, segment);
        let metadata;
        try {
          metadata = await lstat(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          try {
            await mkdir(current);
          } catch (mkdirError) {
            if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
          }
          metadata = await lstat(current);
        }
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error();
        if (!isWithinOrSame(realDataDir, await realpath(current))) throw new Error();
      }
      const providerMetadata = await lstat(providerDir);
      if (!providerMetadata.isDirectory() || providerMetadata.isSymbolicLink()) throw new Error();
      if (!isWithinOrSame(realDataDir, await realpath(providerDir))) throw new Error();
    }
  } catch (error) {
    if (error instanceof ProviderFileNameError) throw error;
    throw new ProviderFileNameError("provider directory is unavailable");
  }
}

export async function readControlledFile(path: string,
  maxContentBytes: number) {
  try {
    const { metadata, content } = await readStableFile(path, maxContentBytes);
    return { content, sha256: hash(content), device: metadata.dev, inode: metadata.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readControlledIdentity(path: string) {
  try {
    const pathMetadata = await lstat(path);
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
      throw new ProviderFileReadOnlyError("provider file is unavailable");
    }
    const handle = await open(path, "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || !sameFileIdentity(
        { device: pathMetadata.dev, inode: pathMetadata.ino },
        { device: metadata.dev, inode: metadata.ino },
      )) {
        throw new ProviderFileConflictError("provider file changed");
      }
      return { device: metadata.dev, inode: metadata.ino };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readProviderSource(configured: string,
  canonicalProviderRoot: string,
  generatedPaths: ReadonlySet<string>,
  generatedFiles: ReadonlySet<string>,
  maxContentBytes: number) {
  const canonical = await realpath(configured);
  const canonicalKey = providerFileNameKey(canonical);
  if (!isWithin(canonicalProviderRoot, canonical)) {
    throw new ProviderFileValidationError("provider source is outside the controlled directory");
  }
  if (generatedPaths.has(canonicalKey)) {
    throw new ProviderFileValidationError("generated provider output cannot be used as a source");
  }

  const pathMetadata = await lstat(canonical);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    throw new ProviderFileReadOnlyError("provider source is unavailable");
  }
  const handle = await open(canonical, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !sameFileIdentity(
      { device: pathMetadata.dev, inode: pathMetadata.ino },
      { device: metadata.dev, inode: metadata.ino },
    )) throw new ProviderFileConflictError("provider source changed");
    const identity = `${String(metadata.dev)}:${String(metadata.ino)}`;
    if (generatedFiles.has(identity)) {
      throw new ProviderFileValidationError("generated provider output cannot be used as a source");
    }
    if (metadata.size > maxContentBytes) {
      throw new ProviderFileValidationError("provider source exceeds the size limit");
    }

    const chunks: Buffer[] = [];
    let size = 0;
    const hardLimit = maxContentBytes + 1;
    while (size < hardLimit) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, hardLimit - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    if (size > maxContentBytes) {
      throw new ProviderFileValidationError("provider source exceeds the size limit");
    }

    const finalMetadata = await handle.stat();
    if (
      !finalMetadata.isFile() || finalMetadata.size !== size ||
      finalMetadata.size > maxContentBytes ||
      !sameFileIdentity(
        { device: metadata.dev, inode: metadata.ino },
        { device: finalMetadata.dev, inode: finalMetadata.ino },
      )
    ) throw new ProviderFileConflictError("provider source changed");

    const finalCanonical = await realpath(configured);
    if (
      !isWithin(canonicalProviderRoot, finalCanonical) ||
      providerFileNameKey(finalCanonical) !== canonicalKey
    ) throw new ProviderFileConflictError("provider source changed");
    const finalPathMetadata = await lstat(finalCanonical);
    if (!finalPathMetadata.isFile() || finalPathMetadata.isSymbolicLink() || !sameFileIdentity(
      { device: finalMetadata.dev, inode: finalMetadata.ino },
      { device: finalPathMetadata.dev, inode: finalPathMetadata.ino },
    )) throw new ProviderFileConflictError("provider source changed");

    return { canonical, metadata: finalMetadata, content: Buffer.concat(chunks, size) };
  } finally {
    await handle.close();
  }
}

export async function readStableFile(path: string,
  maxContentBytes: number) {
  const pathMetadata = await lstat(path);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    throw new ProviderFileReadOnlyError("provider file is unavailable");
  }
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !sameFileIdentity(
      { device: pathMetadata.dev, inode: pathMetadata.ino },
      { device: metadata.dev, inode: metadata.ino },
    )) throw new ProviderFileConflictError("provider file changed");
    if (metadata.size > maxContentBytes) {
      throw new ProviderFileValidationError("provider file exceeds the size limit");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const hardLimit = maxContentBytes + 1;
    while (size < hardLimit) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, hardLimit - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    if (size > maxContentBytes) {
      throw new ProviderFileValidationError("provider file exceeds the size limit");
    }
    const finalMetadata = await handle.stat();
    if (
      !finalMetadata.isFile() || finalMetadata.size !== size ||
      finalMetadata.size > maxContentBytes ||
      !sameFileIdentity(
        { device: metadata.dev, inode: metadata.ino },
        { device: finalMetadata.dev, inode: finalMetadata.ino },
      )
    ) throw new ProviderFileConflictError("provider file changed");
    return { metadata: finalMetadata, content: Buffer.concat(chunks, size) };
  } finally {
    await handle.close();
  }
}

export function sameFileIdentity(left: { device: number | bigint; inode: number | bigint },
  right: { device: number | bigint; inode: number | bigint }) {
  const leftInodeKnown = left.inode !== 0 && left.inode !== 0n;
  const rightInodeKnown = right.inode !== 0 && right.inode !== 0n;
  return leftInodeKnown && rightInodeKnown && left.device === right.device && left.inode === right.inode;
}

export const FILE_NAME_PATTERN = /^(?!\.)[\p{L}\p{N}][\p{L}\p{N}._ -]{0,118}\.ya?ml$/iu;

export function providerFilePath(root: string, fileName: string) {
  if (
    fileName.trim() !== fileName || !FILE_NAME_PATTERN.test(fileName) ||
    ![".yaml", ".yml"].includes(extname(fileName).toLowerCase()) || basename(fileName) !== fileName
  ) throw new ProviderFileNameError("invalid provider file name");
  const path = resolve(root, fileName);
  if (!isWithin(root, path)) throw new ProviderFileNameError("provider path is outside the controlled directory");
  return path;
}

export function hiddenProviderPath(root: string, fileName: string) {
  if (basename(fileName) !== fileName || !fileName.startsWith(".provider-op-")) {
    throw new ProviderFileRecoveryError("provider operation recovery is incomplete");
  }
  const path = resolve(root, fileName);
  if (!isWithin(root, path)) throw new ProviderFileRecoveryError("provider operation recovery is incomplete");
  return path;
}

export function hiddenFileName(kind: string) {
  return `.provider-op-${randomBytes(12).toString("hex")}.${kind}`;
}

export async function removeCapturedHiddenAfterJournalClear(
  directory: string,
  fileName: string,
  captured: { device: number | bigint; inode: number | bigint },
  maxContentBytes: number,
) {
  try {
    const latest = await readControlledFile(hiddenProviderPath(directory, fileName), maxContentBytes);
    if (latest && sameFileIdentity(captured, latest)) await unlink(hiddenProviderPath(directory, fileName));
  } catch {
    // The journal is clear; an unexpected hidden entry is safer left untouched.
  }
}
