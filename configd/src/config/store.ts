// 管理主配置读取、Mihomo 候选校验及保留元数据的原子替换。
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  chown,
  link,
  lstat,
  readdir,
  realpath,
  open,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse, parseDocument } from "yaml";
import { coreDiagnostics } from "./diagnostics.js";
import {
  ConfigConflictError,
  ConfigFileExistsError,
  ConfigFileNameError,
  ConfigFileNotFoundError,
  ConfigTooLargeError,
  ConfigValidationError,
  ConfigValidationTimeoutError,
  ProviderSourceNotFoundError,
  ConfigProviderFilesError,
  type ProviderFileIssue,
} from "./errors.js";
import { WriteQueue } from "../writeQueue.js";

export interface ConfigStoreOptions {
  configPath: string;
  mihomoBinary: string;
  dataDir: string;
  validationTimeoutMs: number;
  maxContentBytes: number;
  maxProviderSourceBytes?: number;
  validatorArgsPrefix?: string[];
  onChild?: (child: ChildProcess) => void;
  writeQueue?: WriteQueue;
  assertSourceDeletableUnqueued?: (name: string) => Promise<void>;
}

export interface ConfigSnapshot {
  name: string;
  path: string;
  content: string;
  sha256: string;
  providerIssues?: ProviderFileIssue[];
}

export interface ConfigFileRecord {
  name: string;
  path: string;
  sha256: string;
  size: number;
  updatedAt: string;
}

function sha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function privateName(configPath: string) {
  const token = randomBytes(8).toString("hex");
  return `.${basename(configPath)}.candidate-${Date.now()}-${token}`;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isWithin(root: string, target: string) {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

const CONFIG_NAME_PATTERN = /^(?!\.)[\p{L}\p{N}][\p{L}\p{N}._ -]{0,118}\.ya?ml$/iu;

export class ConfigStore {
  readonly options: ConfigStoreOptions;
  private readonly writeQueue: WriteQueue;

  constructor(options: ConfigStoreOptions) {
    this.options = options;
    this.writeQueue = options.writeQueue ?? new WriteQueue();
  }

  get defaultName() {
    return basename(this.options.configPath);
  }

  get configDir() {
    return dirname(this.options.configPath);
  }

  pathForName(name: string) {
    const normalized = name.trim();
    if (
      normalized !== name ||
      !CONFIG_NAME_PATTERN.test(normalized) ||
      ![".yaml", ".yml"].includes(extname(normalized).toLowerCase()) ||
      basename(normalized) !== normalized
    ) throw new ConfigFileNameError("invalid configuration file name");
    const path = resolve(this.configDir, normalized);
    if (!isWithin(this.configDir, path)) throw new ConfigFileNameError("configuration path is outside the controlled directory");
    return path;
  }

  private async readSnapshot(name: string) {
    const path = this.pathForName(name);
    try {
      const { content, metadata } = await this.readStableBounded(
        path,
        this.configDir,
        this.options.maxContentBytes,
        () => new ConfigFileNotFoundError("configuration file not found"),
        () => new ConfigTooLargeError("configuration exceeds the size limit"),
      );
      return {
        name,
        path,
        content,
        sha256: sha256(content),
        size: metadata.size,
        updatedAt: metadata.mtime.toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigFileNotFoundError("configuration file not found");
      throw error;
    }
  }

  async read(name = this.defaultName): Promise<ConfigSnapshot> {
    const { size: _size, updatedAt: _updatedAt, ...snapshot } = await this.readSnapshot(name);
    return this.withProviderIssues(snapshot);
  }

  // File dependencies are checked independently of Core validation so incomplete
  // imports can be saved and repaired, while HTTP caches remain Core's concern.
  async providerIssues(content: string): Promise<ProviderFileIssue[]> {
    const document = parseDocument(content);
    if (document.errors.length) return [];
    let root: Record<string, unknown> | null;
    try { root = recordValue(document.toJS()); }
    catch { return []; } // Unfinished drafts remain readable; validation rejects them separately.
    const issues: ProviderFileIssue[] = [];
    for (const category of ["proxy", "rule"] as const) {
      const providers = recordValue(root?.[`${category}-providers`]);
      for (const [name, declaration] of Object.entries(providers ?? {})) {
        const provider = recordValue(declaration);
        if (provider?.type !== "file") continue;
        const status = await this.providerFileStatus(provider.path);
        if (status) issues.push({ category, name, status });
      }
    }
    return issues;
  }

  private async providerFileStatus(configuredPath: unknown): Promise<ProviderFileIssue["status"] | null> {
    if (typeof configuredPath !== "string" || !configuredPath.trim()) return "unreadable";
    const root = resolve(this.options.dataDir);
    const target = resolve(root, configuredPath);
    if (!isWithin(root, target)) return "outside_scope";
    try { await realpath(root); } catch { return "unreadable"; }
    // Inspect every existing component, including the parent of a missing leaf:
    // a missing file below a symlink must not be classified as repairable.
    let cursor = root;
    try {
      for (const part of relative(root, target).split(sep)) {
        cursor = join(cursor, part);
        const metadata = await lstat(cursor);
        if (metadata.isSymbolicLink()) return "outside_scope";
        if (cursor !== target && !metadata.isDirectory()) return "unreadable";
        if (cursor === target && !metadata.isFile()) return "unreadable";
      }
      await this.readStableBounded(target, root,
        this.options.maxProviderSourceBytes ?? this.options.maxContentBytes,
        () => new Error("provider unreadable"), () => new ConfigTooLargeError("provider exceeds read limit"));
      return null;
    } catch (error) {
      if (error instanceof ConfigTooLargeError) return null;
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    }
  }

  private async withProviderIssues(snapshot: ConfigSnapshot): Promise<ConfigSnapshot> {
    const issues = await this.providerIssues(snapshot.content);
    return issues.length ? { ...snapshot, providerIssues: issues } : snapshot;
  }

  private async sourceNeedsCoreValidation(content: string) {
    const issues = await this.providerIssues(content);
    if (!issues.length) return true;
    if (issues.some((issue) => issue.status !== "missing")) throw new ConfigProviderFilesError(issues);
    const document = parseDocument(content);
    if (document.errors.length || !recordValue(document.toJS())) throw new ConfigValidationError("configuration YAML is invalid");
    return false;
  }

  async list(): Promise<ConfigFileRecord[]> {
    const entries = await readdir(this.configDir, { withFileTypes: true });
    const files: ConfigFileRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !CONFIG_NAME_PATTERN.test(entry.name)) continue;
      try {
        const snapshot = await this.readSnapshot(entry.name);
        files.push({
          name: entry.name,
          path: snapshot.path,
          sha256: snapshot.sha256,
          size: snapshot.size,
          updatedAt: snapshot.updatedAt,
        });
      } catch (error) {
        if (!(error instanceof ConfigFileNotFoundError)) throw error;
      }
    }
    return files.sort((left, right) => left.name.localeCompare(right.name, "en"));
  }

  private async createFileUnqueued(
    name: string,
    content: string,
    validateCandidate: boolean,
  ): Promise<ConfigSnapshot> {
    this.checkSize(content);
    const path = this.pathForName(name);
    try {
      await lstat(path);
      throw new ConfigFileExistsError("configuration file already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const defaultMetadata = await stat(this.options.configPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return { mode: 0o600, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
    });
    const publishCandidate = async (candidatePath: string) => {
      await chmod(candidatePath, defaultMetadata.mode);
      if (process.platform !== "win32") await chown(candidatePath, defaultMetadata.uid, defaultMetadata.gid);
      try {
        // 同目录硬链接以原子方式发布已校验候选；EEXIST 保证并发新建也不会覆盖。
        await link(candidatePath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ConfigFileExistsError("configuration file already exists");
        }
        throw error;
      }
      return { name: basename(path), path, content, sha256: sha256(content) };
    };
    if (validateCandidate) return this.withCandidate(content, publishCandidate);

    // 零字节草稿和订阅专属正文均通过同目录候选原子发布。
    const candidatePath = await this.createCandidate(content);
    try {
      return await publishCandidate(candidatePath);
    } finally {
      await unlink(candidatePath).catch(() => undefined);
    }
  }

  async createUnqueued(name: string, content = ""): Promise<ConfigSnapshot> {
    return this.withProviderIssues(await this.createFileUnqueued(name, content,
      content !== "" && await this.sourceNeedsCoreValidation(content)));
  }

  // 仅由已持有共享 WriteQueue 的 SubscriptionService wiring 调用。
  async createSubscriptionFileUnqueued(name: string, content: string): Promise<ConfigSnapshot> {
    return this.createFileUnqueued(name, content, false);
  }

  create(name: string, content = ""): Promise<ConfigSnapshot> {
    return this.writeQueue.enqueue(async () => this.withProviderIssues(await this.createFileUnqueued(name, content, false)));
  }

  private async providerSource(category: "proxy" | "rule", name: string, configName: string, expectedSha256?: string) {
    const snapshot = await this.read(configName);
    if (expectedSha256 && snapshot.sha256 !== expectedSha256) throw new ConfigConflictError("configuration changed");
    const configContent = snapshot.content;
    const providerSection = category === "proxy" ? "proxy-providers" : "rule-providers";
    const config = recordValue(parse(configContent));
    const providers = recordValue(config?.[providerSection]);
    const provider = recordValue(providers?.[name]);
    if (!provider) throw new ProviderSourceNotFoundError("provider is not declared in the main configuration");
    const sectionNode = parseDocument(configContent).getIn([providerSection], true) as {
      items?: Array<{
        key?: { value?: unknown; range?: [number, number, number] | null };
        value?: {
          range?: [number, number, number] | null;
          items?: Array<{
            key?: { value?: unknown; range?: [number, number, number] | null };
            value?: { range?: [number, number, number] | null } | null;
          }>;
        } | null;
      }>;
    } | undefined;
    const pair = sectionNode?.items?.find((item) => item.key?.value === name);
    return { configContent, provider, pair };
  }

  async readProviderDeclaration(category: "proxy" | "rule", name: string, configName = this.defaultName, expectedSha256?: string): Promise<string> {
    const { configContent, pair } = await this.providerSource(category, name, configName, expectedSha256);
    const start = pair?.key?.range?.[0];
    const end = pair?.value?.range?.[2];
    if (start == null || end == null) {
      throw new ProviderSourceNotFoundError("provider declaration is unavailable");
    }
    return configContent.slice(start, end);
  }

  async readProviderPayload(category: "proxy" | "rule", name: string, configName = this.defaultName, expectedSha256?: string): Promise<string> {
    const { configContent, provider, pair } = await this.providerSource(category, name, configName, expectedSha256);
    const configuredPath = provider.path;
    if (provider.type === "file") {
      const status = await this.providerFileStatus(configuredPath);
      if (status) throw new ConfigProviderFilesError([{ category, name, status }]);
    }
    if (typeof configuredPath !== "string" || !configuredPath.trim()) {
      const payloadPair = pair?.value?.items?.find((item) => item.key?.value === "payload");
      const start = payloadPair?.key?.range?.[0];
      const end = payloadPair?.value?.range?.[2];
      if (start == null || end == null) {
        throw new ProviderSourceNotFoundError("inline provider payload is unavailable");
      }
      return configContent.slice(start, end);
    }

    const dataDir = resolve(this.options.dataDir);
    const sourcePath = resolve(dataDir, configuredPath);
    if (!isWithin(dataDir, sourcePath)) {
      throw new ProviderSourceNotFoundError("provider source is outside the data directory");
    }

    try {
      const [realDataDir, realSourcePath] = await Promise.all([
        realpath(dataDir),
        realpath(sourcePath),
      ]);
      if (!isWithin(realDataDir, realSourcePath)) {
        throw new ProviderSourceNotFoundError("provider source is outside the data directory");
      }
      const { content } = await this.readStableBounded(
        sourcePath,
        dataDir,
        this.options.maxProviderSourceBytes ?? this.options.maxContentBytes,
        () => new ProviderSourceNotFoundError("provider source is unavailable"),
        () => new ConfigTooLargeError("provider source exceeds the size limit"),
      );
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProviderSourceNotFoundError("provider source was not found");
      }
      throw error;
    }
  }

  private async readStableBounded(
    path: string,
    root: string,
    maxBytes: number,
    unavailable: () => Error,
    tooLarge: () => Error,
  ) {
    const unavailableError = unavailable();
    const tooLargeError = tooLarge();
    const resolvedRoot = resolve(root);
    const resolvedPath = resolve(path);
    try {
      if (!isWithin(resolvedRoot, resolvedPath)) throw unavailableError;
      const realRoot = await realpath(resolvedRoot);
      const initialPathMetadata = await lstat(resolvedPath);
      if (!initialPathMetadata.isFile() || initialPathMetadata.isSymbolicLink()) throw unavailableError;
      const initialCanonicalPath = await realpath(resolvedPath);
      if (!isWithin(realRoot, initialCanonicalPath)) throw unavailableError;
      const flags = fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_NONBLOCK ?? 0);
      const handle = await open(resolvedPath, flags);
      try {
        const metadata = await handle.stat();
        if (
          !metadata.isFile() || metadata.dev !== initialPathMetadata.dev ||
          metadata.ino === 0 || initialPathMetadata.ino === 0 || metadata.ino !== initialPathMetadata.ino
        ) throw unavailableError;
        if (metadata.size > maxBytes) throw tooLargeError;
        const chunks: Buffer[] = [];
        const hardLimit = maxBytes + 1;
        let size = 0;
        while (size < hardLimit) {
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, hardLimit - size));
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
          if (bytesRead === 0) break;
          chunks.push(buffer.subarray(0, bytesRead));
          size += bytesRead;
        }
        if (size > maxBytes) throw tooLargeError;
        const finalMetadata = await handle.stat();
        if (
          !finalMetadata.isFile() || finalMetadata.size !== size ||
          finalMetadata.dev !== metadata.dev || finalMetadata.ino !== metadata.ino
        ) throw unavailableError;
        const finalCanonicalPath = await realpath(resolvedPath);
        if (!isWithin(realRoot, finalCanonicalPath)) throw unavailableError;
        const finalPathMetadata = await lstat(resolvedPath);
        if (
          !finalPathMetadata.isFile() || finalPathMetadata.isSymbolicLink() ||
          finalPathMetadata.dev !== finalMetadata.dev || finalPathMetadata.ino !== finalMetadata.ino
        ) throw unavailableError;
        return { content: Buffer.concat(chunks, size).toString("utf8"), metadata: finalMetadata };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error === unavailableError || error === tooLargeError) throw error;
      throw unavailableError;
    }
  }

  private checkSize(content: string) {
    if (Buffer.byteLength(content, "utf8") > this.options.maxContentBytes) {
      throw new ConfigTooLargeError("configuration exceeds the size limit");
    }
  }

  private async createCandidate(content: string) {
    this.checkSize(content);
    const path = join(
      dirname(this.options.configPath),
      privateName(this.options.configPath),
    );
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return path;
  }

  private async runValidation(candidatePath: string, content: string) {
    // Capture a bounded tail only for allowlisted diagnostics; never log raw output.
    const args = [
      ...(this.options.validatorArgsPrefix ?? []),
      "-t",
      "-f",
      candidatePath,
      "-d",
      this.options.dataDir,
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.mihomoBinary, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.options.onChild?.(child);
      let output = Buffer.alloc(0);
      const capture = (chunk: Buffer) => { output = Buffer.concat([output, chunk]).subarray(-32 * 1024); };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      let timedOut = false;
      let settled = false;
      let forceTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        forceTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      }, this.options.validationTimeoutMs);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        error ? reject(error) : resolve();
      };
      child.once("error", () => finish(new ConfigValidationError("validation could not start")));
      child.once("close", (code) => {
        if (timedOut) {
          finish(new ConfigValidationTimeoutError("validation timed out"));
        } else if (code === 0) {
          finish();
        } else {
          finish(new ConfigValidationError("configuration is invalid", coreDiagnostics(output.toString("utf8"), content)));
        }
      });
    });
  }

  private async withCandidate<T>(content: string, action: (path: string) => Promise<T>) {
    // 候选文件位于正式配置同目录，确保后续 rename 仍是同文件系统原子操作。
    const candidatePath = await this.createCandidate(content);
    try {
      await this.runValidation(candidatePath, content);
      return await action(candidatePath);
    } finally {
      await unlink(candidatePath).catch(() => undefined);
    }
  }

  async validate(content: string) {
    await this.writeQueue.enqueue(async () => {
      const issues = await this.providerIssues(content);
      if (issues.length) throw new ConfigProviderFilesError(issues);
      await this.withCandidate(content, async () => undefined);
    });
  }

  // Used only by the runtime-file store, whose configured path is outside editable files.
  async publishGeneratedUnqueued(content: string): Promise<ConfigSnapshot> {
    const issues = await this.providerIssues(content);
    if (issues.length) throw new ConfigProviderFilesError(issues);
    return this.withCandidate(content, async (candidatePath) => {
      await rename(candidatePath, this.options.configPath);
      return {
        name: basename(this.options.configPath),
        path: this.options.configPath,
        content,
        sha256: sha256(content),
      };
    });
  }

  async replaceValidatedFileUnqueued(
    name: string,
    content: string,
  ): Promise<ConfigSnapshot> {
    return this.replaceFileUnqueued(name, content, true);
  }

  private async replaceFileUnqueued(
    name: string,
    content: string,
    validateCandidate: boolean,
  ): Promise<ConfigSnapshot> {
    // 此方法由已持有 WriteQueue 的保存/恢复/订阅流程调用，不能在内部再次入队。
    const replace = async (candidatePath: string) => {
      const path = this.pathForName(name);
      const metadata = await stat(path);
      // 把原权限和所有者应用到同目录候选文件后原子替换。
      await chmod(candidatePath, metadata.mode);
      if (process.platform !== "win32") {
        await chown(candidatePath, metadata.uid, metadata.gid);
      }
      await rename(candidatePath, path);
      return { name, path, content, sha256: sha256(content) };
    };
    if (validateCandidate) return this.withCandidate(content, replace);
    const candidatePath = await this.createCandidate(content);
    try {
      return await replace(candidatePath);
    } finally {
      await unlink(candidatePath).catch(() => undefined);
    }
  }

  async saveFileUnqueued(name: string, content: string, expectedSha256: string, draft = false): Promise<ConfigSnapshot> {
    const current = await this.read(name);
    if (current.sha256 !== expectedSha256) {
      throw new ConfigConflictError("configuration changed");
    }
    return this.withProviderIssues(await this.replaceFileUnqueued(name, content, !draft && await this.sourceNeedsCoreValidation(content)));
  }

  // 仅由已持有共享 WriteQueue 的 SubscriptionService wiring 调用。
  async saveSubscriptionFileUnqueued(
    name: string,
    content: string,
    expectedSha256: string,
  ): Promise<ConfigSnapshot> {
    const current = await this.read(name);
    if (current.sha256 !== expectedSha256) {
      throw new ConfigConflictError("configuration changed");
    }
    return this.replaceFileUnqueued(name, content, false);
  }

  // 仅用于回滚本次订阅发布；要求磁盘仍是刚发布的 SHA，不校验且不再创建备份。
  async restoreSubscriptionFileUnqueued(
    name: string,
    content: string,
    expectedPublishedSha256: string,
  ): Promise<ConfigSnapshot> {
    return this.restoreFileUnqueued(name, content, expectedPublishedSha256);
  }

  // 仅供已持有共享 WriteQueue 的跨资源补偿事务调用；不校验且不创建第二份备份。
  async restoreFileUnqueued(
    name: string,
    content: string,
    expectedPublishedSha256: string,
  ): Promise<ConfigSnapshot> {
    const current = await this.read(name);
    if (current.sha256 !== expectedPublishedSha256) {
      throw new ConfigConflictError("configuration changed during rollback");
    }
    return this.replaceFileUnqueued(name, content, false);
  }

  saveFile(name: string, content: string, expectedSha256: string): Promise<ConfigSnapshot> {
    return this.writeQueue.enqueue(() => this.saveFileUnqueued(name, content, expectedSha256, true));
  }

  save(content: string, expectedSha256: string) {
    return this.saveFile(this.defaultName, content, expectedSha256);
  }

  async deleteUnqueued(name: string, expectedSha256: string): Promise<ConfigSnapshot> {
    const current = await this.read(name);
    if (current.sha256 !== expectedSha256) throw new ConfigConflictError("configuration changed");
    await this.options.assertSourceDeletableUnqueued?.(name);
    await unlink(current.path);
    return current;
  }

  delete(name: string, expectedSha256: string): Promise<ConfigSnapshot> {
    return this.writeQueue.enqueue(() => this.deleteUnqueued(name, expectedSha256));
  }

  async renameUnqueued(
    oldName: string,
    newName: string,
    expectedSha256: string,
  ): Promise<ConfigSnapshot> {
    const current = await this.read(oldName);
    if (current.sha256 !== expectedSha256) {
      throw new ConfigConflictError("configuration changed");
    }
    const targetPath = this.pathForName(newName);
    if (current.path === targetPath) return { ...current, name: basename(targetPath), path: targetPath };
    await this.options.assertSourceDeletableUnqueued?.(oldName);
    try {
      await link(current.path, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ConfigFileExistsError("configuration file already exists");
      }
      throw error;
    }
    try {
      await unlink(current.path);
    } catch (error) {
      await unlink(targetPath).catch(() => undefined);
      throw error;
    }
    return { name: basename(targetPath), path: targetPath, content: current.content, sha256: current.sha256 };
  }

  rename(oldName: string, newName: string, expectedSha256: string) {
    return this.writeQueue.enqueue(() => this.renameUnqueued(oldName, newName, expectedSha256));
  }
}
