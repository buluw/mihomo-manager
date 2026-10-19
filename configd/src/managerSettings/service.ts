import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isMap, parseDocument } from "yaml";
import { ConfigConflictError, ConfigSourceInUseError, ConfigSourceUsageUnknownError, ConfigValidationError } from "../config/errors.js";
import { ConfigStore } from "../config/store.js";
import { WriteQueue } from "../writeQueue.js";

export class ManagerSettingsValidationError extends Error {}
export class ManagerSettingsConflictError extends Error {}

export interface ManagerOverrides {
  ipv6?: boolean;
  "allow-lan"?: boolean;
  "tcp-concurrent"?: boolean;
  mode?: "rule" | "global" | "direct";
  "log-level"?: "silent" | "error" | "warning" | "info" | "debug";
  dns?: {
    enable?: boolean;
    listen?: string;
    nameserver?: string[];
    "enhanced-mode"?: "fake-ip" | "redir-host";
    "fake-ip-filter"?: string[];
    ipv6?: boolean;
  };
  tun?: {
    enable?: boolean;
    stack?: "system" | "gvisor" | "mixed";
    "auto-route"?: boolean;
    "auto-detect-interface"?: boolean;
    "dns-hijack"?: string[];
  };
  "interface-name"?: string;
  sniffer?: {
    enable?: boolean;
    sniff?: { HTTP?: { ports?: (string | number)[] }; TLS?: { ports?: (string | number)[] }; QUIC?: { ports?: (string | number)[] } };
    "skip-domain"?: string[];
  };
}

export interface ManagerSettings {
  schemaVersion: 1;
  version: number;
  overrides: ManagerOverrides;
  directDelayTest?: DirectDelayTestSettings;
}

export interface DirectDelayTestSettings {
  version: number;
  preset: "huawei" | "xiaomi" | "vivo" | "custom";
  url?: string;
}

export interface GeneratedRuntime {
  schemaVersion: 1;
  version: string;
  sourceName: string;
  sourceSha256: string;
  settingsVersion: number;
  contentSha256: string;
  generatedAt: string;
  path: string;
  appliedOverrides?: ManagerOverrides;
  mode?: "rule" | "global" | "direct";
}

export type RuntimeLoadResult = "succeeded" | "failed" | "unknown";
export interface RuntimeLoadState {
  schemaVersion: 1;
  version: number;
  lastAttempt: {
    kind?: "mode";
    id: string;
    generated: GeneratedRuntime;
    status: "pending" | RuntimeLoadResult;
    startedAt: string;
    finishedAt: string | null;
  } | null;
  lastSuccessful: { generated: GeneratedRuntime; loadedAt: string; modeUpdatedAt?: string } | null;
}

type Validator = (value: unknown) => boolean;
type Schema = { [key: string]: Validator | Schema };
const boolean: Validator = (value) => typeof value === "boolean";
const text: Validator = (value) => typeof value === "string" && value.length <= 2048;
const strings: Validator = (value) => Array.isArray(value) && value.length <= 512 && value.every(text);
const choice = (...values: string[]): Validator => (value) => typeof value === "string" && values.includes(value);
const ports: Validator = (value) => Array.isArray(value) && value.length <= 128 && value.every((port) => {
  if (typeof port === "number") return Number.isInteger(port) && port >= 0 && port <= 65535;
  if (typeof port !== "string") return false;
  const match = port.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return start <= end && end <= 65535;
});
const schema: Schema = {
  ipv6: boolean, "allow-lan": boolean, "tcp-concurrent": boolean,
  mode: choice("rule", "global", "direct"),
  "log-level": choice("silent", "error", "warning", "info", "debug"),
  dns: {
    enable: boolean, listen: text, nameserver: strings, ipv6: boolean,
    "enhanced-mode": choice("fake-ip", "redir-host"), "fake-ip-filter": strings,
  },
  tun: {
    enable: boolean, stack: choice("system", "gvisor", "mixed"),
    "auto-route": boolean, "auto-detect-interface": boolean, "dns-hijack": strings,
  },
  "interface-name": text,
  sniffer: {
    enable: boolean, "skip-domain": strings,
    sniff: { HTTP: { ports }, TLS: { ports }, QUIC: { ports } },
  },
};

function invalid(): never { throw new ManagerSettingsValidationError("invalid manager settings"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}
function directDelayTest(value: unknown): DirectDelayTestSettings {
  const saved = object(value);
  if (!choice("huawei", "xiaomi", "vivo", "custom")(saved.preset)) invalid();
  const result: DirectDelayTestSettings = { version: version(saved.version), preset: saved.preset as DirectDelayTestSettings["preset"] };
  if (saved.preset === "custom") {
    if (typeof saved.url !== "string" || !saved.url.trim() || saved.url.length > 2048 || /\s/.test(saved.url.trim())) invalid();
    try {
      const url = new URL(saved.url.trim());
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname) invalid();
    } catch { invalid(); }
    result.url = saved.url.trim();
  }
  return result;
}
function overrides(value: unknown, fields = schema, path: string[] = []): ManagerOverrides {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object(value))) {
    if (!Object.hasOwn(fields, key)) invalid();
    const validate = fields[key]!;
    if (typeof validate === "function") {
      if (!validate(item)) invalid();
      result[key] = structuredClone(item);
    } else {
      const nested = overrides(item, validate, [...path, key]);
      // An empty protocol selection is an override, not a request to inherit.
      if (Object.keys(nested).length || (path.length === 1 && path[0] === "sniffer" && key === "sniff")) result[key] = nested;
    }
  }
  return result;
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function generateRuntimeContent(source: string, settings: ManagerOverrides) {
  const validated = overrides(settings);
  const document = parseDocument(source);
  if (document.errors.length || !isMap(document.contents)) throw new ConfigValidationError("configuration is invalid");
  try { document.toJS(); }
  catch { throw new ConfigValidationError("configuration YAML references are invalid", [
    { code: "yaml_reference", message: "YAML 引用无法解析；请检查锚点、别名及引用数量。" },
  ]); }
  const apply = (values: Record<string, unknown>, path: string[] = []) => {
    for (const [key, value] of Object.entries(values)) {
      const nextPath = [...path, key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const existing = document.getIn(nextPath, true);
        if (existing != null && !isMap(existing)) throw new ConfigValidationError("configuration setting is not a mapping");
        if (nextPath.length === 2 && nextPath[0] === "sniffer" && nextPath[1] === "sniff") {
          const selected = value as Record<string, unknown>;
          if (Object.keys(selected).length === 0) {
            document.setIn(nextPath, document.createNode({}));
            continue;
          }
          if (isMap(existing)) {
            for (const item of [...existing.items]) {
              const protocol = String(item.key);
              if (!Object.hasOwn(selected, protocol)) document.deleteIn([...nextPath, protocol]);
            }
          }
          apply(selected, nextPath);
        } else apply(value as Record<string, unknown>, nextPath);
      } else document.setIn(nextPath, document.createNode(value));
    }
  };
  apply(validated as Record<string, unknown>);
  return Object.keys(validated).length ? document.toString({ lineWidth: 0 }) : source;
}

export interface ManagerSettingsOptions {
  statePath: string;
  runtimeDir: string;
  store: ConfigStore;
  writeQueue: WriteQueue;
}

export class ManagerSettingsService {
  constructor(readonly options: ManagerSettingsOptions) {
    if (resolve(options.runtimeDir) === resolve(options.store.configDir)) {
      throw new ManagerSettingsValidationError("runtime directory must be separate from editable configurations");
    }
    options.store.options.assertSourceDeletableUnqueued = (name) => this.assertSourceDeletableUnqueued(name);
  }

  private async readJson(path: string): Promise<unknown> {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) invalid();
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error instanceof SyntaxError) invalid(); throw error; }
  }

  async read(): Promise<ManagerSettings> {
    try {
      const saved = object(await this.readJson(this.options.statePath));
      if (saved.schemaVersion !== 1) invalid();
      return { schemaVersion: 1, version: version(saved.version), overrides: overrides(saved.overrides),
        ...(saved.directDelayTest === undefined ? {} : { directDelayTest: directDelayTest(saved.directDelayTest) }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, version: 0, overrides: {} };
      throw error;
    }
  }

  private async publishJson(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  save(input: { expectedVersion: number; overrides: ManagerOverrides }) {
    const expected = version(input.expectedVersion);
    const values = overrides(input.overrides);
    return this.options.writeQueue.enqueue(async () => {
      const current = await this.read();
      if (current.version !== expected) throw new ManagerSettingsConflictError("manager settings changed");
      const next: ManagerSettings = { ...current, version: expected + 1, overrides: values };
      await this.publishJson(this.options.statePath, next);
      return next;
    });
  }

  saveDirectDelayTest(input: { expectedVersion: number; preset: DirectDelayTestSettings["preset"]; url?: string }) {
    const expected = version(input.expectedVersion);
    const value = directDelayTest({ version: expected + 1, preset: input.preset, url: input.url });
    return this.options.writeQueue.enqueue(async () => {
      const current = await this.read();
      if ((current.directDelayTest?.version ?? 0) !== expected) throw new ManagerSettingsConflictError("direct delay settings changed");
      const next = { ...current, directDelayTest: value };
      await this.publishJson(this.options.statePath, next);
      return next;
    });
  }

  generate(input: { sourceName: string; expectedSourceSha256: string; expectedSettingsVersion: number },
    prepareSource?: (name: string, sha256: string) => Promise<void>) {
    const expected = version(input.expectedSettingsVersion);
    return this.options.writeQueue.enqueue(async () => {
      const source = await this.options.store.read(input.sourceName);
      if (source.sha256 !== input.expectedSourceSha256) throw new ConfigConflictError("source configuration changed");
      const settings = await this.read();
      if (settings.version !== expected) throw new ManagerSettingsConflictError("manager settings changed");
      const content = generateRuntimeContent(await this.options.store.mapProviderContent(source.name, source.content), settings.overrides);
      await prepareSource?.(source.name, source.sha256);
      const contentSha256 = sha256(content);
      const generationVersion = sha256(JSON.stringify([source.name, source.sha256, settings.version, contentSha256]));
      await this.readCandidateUnqueued();
      await mkdir(this.options.runtimeDir, { recursive: true });
      const metadata = await lstat(this.options.runtimeDir);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid();
      const path = join(this.options.runtimeDir, `${generationVersion}.yaml`);
      const existed = await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      const runtimeStore = new ConfigStore({ ...this.options.store.options, configPath: path });
      await runtimeStore.publishGeneratedUnqueued(content);
      const generated: GeneratedRuntime = {
        schemaVersion: 1, version: generationVersion,
        sourceName: source.name, sourceSha256: source.sha256,
        settingsVersion: settings.version, contentSha256, generatedAt: new Date().toISOString(), path,
        appliedOverrides: settings.overrides,
        ...this.runtimeMode(content),
      };
      try {
        await this.publishJson(join(this.options.runtimeDir, "candidate.json"), generated);
      } catch (error) {
        if (!existed) await unlink(path).catch(() => undefined);
        throw error;
      }
      await this.cleanupRuntimeFiles(generated, await this.readLoadStateUnqueued());
      return generated;
    });
  }

  readCandidate() {
    return this.options.writeQueue.enqueue(() => this.readCandidateUnqueued());
  }

  private runtimeMode(content: string): { mode?: NonNullable<ManagerOverrides["mode"]> } {
    const mode: unknown = parseDocument(content).get("mode");
    return mode === "rule" || mode === "global" || mode === "direct" ? { mode } : {};
  }

  prepareMode(input: { mode: ManagerOverrides["mode"]; expectedSettingsVersion: number; expectedVersion: number }) {
    if (!choice("rule", "global", "direct")(input.mode)) invalid();
    const mode = input.mode!;
    const expectedSettings = version(input.expectedSettingsVersion);
    const expectedState = version(input.expectedVersion);
    return this.options.writeQueue.enqueue(async () => {
      const [settings, state] = await Promise.all([this.read(), this.readLoadStateUnqueued()]);
      if (settings.version !== expectedSettings || state.version !== expectedState) {
        throw new ManagerSettingsConflictError("mode preparation was superseded");
      }
      if (state.lastAttempt?.kind === "mode" && state.lastAttempt.status === "pending") {
        if (state.lastAttempt.generated.mode !== mode || settings.overrides.mode !== mode) {
          throw new ManagerSettingsConflictError("retry the unconfirmed mode first");
        }
        // A refreshed client must explicitly PATCH this same mode again before confirming it.
        // Keep the original identity and version so late results cannot confirm a newer action.
        await this.readGenerated(state.lastAttempt.generated);
        return { settings, state };
      }
      if (!state.lastSuccessful || state.lastAttempt?.status === "pending"
        || (state.lastAttempt?.status === "unknown" && state.lastAttempt.kind !== "mode")) {
        throw new ManagerSettingsConflictError("confirmed runtime is required");
      }
      const base = await this.readGenerated(state.lastSuccessful.generated);
      const content = generateRuntimeContent(base.content, { mode });
      const nextSettings: ManagerSettings = { ...settings, version: settings.version + 1, overrides: { ...settings.overrides, mode } };
      const knownOverrides = base.appliedOverrides ?? (base.settingsVersion === settings.version ? settings.overrides : undefined);
      const appliedOverrides = knownOverrides ? { ...knownOverrides, mode } : undefined;
      const sameValues = (left: unknown, right: unknown): boolean => {
        if (Object.is(left, right)) return true;
        if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
        const a = Object.entries(left), b = Object.entries(right);
        return a.length === b.length && a.every(([key, value]) => Object.hasOwn(right, key) && sameValues(value, (right as Record<string, unknown>)[key]));
      };
      const settingsVersion = appliedOverrides && sameValues(appliedOverrides, nextSettings.overrides)
        ? nextSettings.version : base.settingsVersion;
      const contentSha256 = sha256(content);
      const generationVersion = sha256(JSON.stringify([base.sourceName, base.sourceSha256, settingsVersion, contentSha256]));
      const path = join(this.options.runtimeDir, `${generationVersion}.yaml`);
      const metadata = await lstat(this.options.runtimeDir);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid();
      // Only a validated enum on the verified runtime is changed. No source or other overrides are applied.
      const temporary = join(this.options.runtimeDir, `.mode-${randomBytes(8).toString("hex")}.tmp`);
      try {
        await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => undefined); }
      const { content: _content, ...baseMetadata } = base;
      const generated: GeneratedRuntime = {
        ...baseMetadata, version: generationVersion, contentSha256, settingsVersion,
        path, generatedAt: new Date().toISOString(), mode,
        ...(appliedOverrides ? { appliedOverrides } : {}),
      };
      const next: RuntimeLoadState = {
        ...state, version: state.version + 1,
        lastAttempt: { kind: "mode", id: randomUUID(), generated, status: "pending", startedAt: new Date().toISOString(), finishedAt: null },
      };
      await this.publishJson(this.options.statePath, nextSettings);
      await this.publishJson(join(this.options.runtimeDir, "load-state.json"), next);
      return { settings: nextSettings, state: next };
    });
  }

  private async readCandidateUnqueued(): Promise<(GeneratedRuntime & { content: string }) | null> {
    let saved: Record<string, unknown>;
    try { saved = object(await this.readJson(join(this.options.runtimeDir, "candidate.json"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    return this.readGenerated(this.generatedMetadata(saved));
  }

  private generatedMetadata(value: unknown): GeneratedRuntime {
    const saved = object(value);
    if (saved.schemaVersion !== 1 || typeof saved.version !== "string" || !/^[a-f0-9]{64}$/.test(saved.version)
      || typeof saved.sourceName !== "string" || typeof saved.sourceSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(saved.sourceSha256) || typeof saved.contentSha256 !== "string"
      || typeof saved.generatedAt !== "string" || !Number.isFinite(Date.parse(saved.generatedAt))) invalid();
    this.options.store.pathForName(saved.sourceName);
    version(saved.settingsVersion);
    if (saved.appliedOverrides !== undefined) overrides(saved.appliedOverrides);
    if (saved.mode !== undefined && !choice("rule", "global", "direct")(saved.mode)) invalid();
    if (saved.version !== sha256(JSON.stringify([saved.sourceName, saved.sourceSha256, saved.settingsVersion, saved.contentSha256]))) invalid();
    return { ...saved, path: join(this.options.runtimeDir, `${saved.version}.yaml`) } as unknown as GeneratedRuntime;
  }

  private async readGenerated(generated: GeneratedRuntime) {
    const path = generated.path;
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) invalid();
    const content = await readFile(path, "utf8");
    if (sha256(content) !== generated.contentSha256) throw new ConfigConflictError("runtime file changed");
    return { ...generated, content };
  }

  private async readLoadStateUnqueued(): Promise<RuntimeLoadState> {
    let saved: Record<string, unknown>;
    try { saved = object(await this.readJson(join(this.options.runtimeDir, "load-state.json"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, version: 0, lastAttempt: null, lastSuccessful: null };
      throw error;
    }
    if (saved.schemaVersion !== 1) invalid();
    const result: RuntimeLoadState = { schemaVersion: 1, version: version(saved.version), lastAttempt: null, lastSuccessful: null };
    if (saved.lastAttempt != null) {
      const attempt = object(saved.lastAttempt);
      if (typeof attempt.id !== "string" || typeof attempt.startedAt !== "string"
        || !["pending", "succeeded", "failed", "unknown"].includes(attempt.status as string)
        || (attempt.finishedAt !== null && typeof attempt.finishedAt !== "string")) invalid();
      result.lastAttempt = {
        ...(attempt.kind === "mode" ? { kind: "mode" as const } : {}),
        id: attempt.id, generated: this.generatedMetadata(attempt.generated),
        status: attempt.status as "pending" | RuntimeLoadResult,
        startedAt: attempt.startedAt, finishedAt: attempt.finishedAt as string | null,
      };
    }
    if (saved.lastSuccessful != null) {
      const successful = object(saved.lastSuccessful);
      if (typeof successful.loadedAt !== "string") invalid();
      if (successful.modeUpdatedAt !== undefined && typeof successful.modeUpdatedAt !== "string") invalid();
      result.lastSuccessful = { generated: this.generatedMetadata(successful.generated), loadedAt: successful.loadedAt,
        ...(typeof successful.modeUpdatedAt === "string" ? { modeUpdatedAt: successful.modeUpdatedAt } : {}),
      };
    }
    return result;
  }

  readLoadState() {
    return this.options.writeQueue.enqueue(() => this.readLoadStateUnqueued());
  }

  // Protect deletion and renaming using shared operations, not a claim about Core identity.
  async assertSourceDeletableUnqueued(name: string) {
    let state: RuntimeLoadState;
    try { state = await this.readLoadStateUnqueued(); }
    catch { throw new ConfigSourceUsageUnknownError("configuration usage is unknown"); }
    if (state.lastSuccessful?.generated.sourceName === name) throw new ConfigSourceInUseError("configuration source is in use");
    if ((state.lastAttempt?.status === "pending" || state.lastAttempt?.status === "unknown") &&
      state.lastAttempt.generated.sourceName === name) throw new ConfigSourceUsageUnknownError("configuration load result is unknown");
  }

  readApplied() {
    return this.options.writeQueue.enqueue(() => this.readAppliedUnqueued());
  }

  // For callers already holding the shared write queue.
  async readAppliedUnqueued() {
    const state = await this.readLoadStateUnqueued();
    const applied = state.lastSuccessful ? await this.readGenerated(state.lastSuccessful.generated) : null;
    return { state, content: applied?.content ?? null };
  }

  beginLoad(input: { generatedVersion: string; expectedVersion: number }) {
    const expected = version(input.expectedVersion);
    return this.options.writeQueue.enqueue(async () => {
      const current = await this.readLoadStateUnqueued();
      if (current.version !== expected) throw new ManagerSettingsConflictError("runtime load record changed");
      const candidate = await this.readCandidateUnqueued();
      if (!candidate || candidate.version !== input.generatedVersion) throw new ConfigConflictError("runtime candidate changed");
      const source = await this.options.store.read(candidate.sourceName);
      if (source.sha256 !== candidate.sourceSha256) throw new ConfigConflictError("source configuration changed");
      if ((await this.read()).version !== candidate.settingsVersion) throw new ManagerSettingsConflictError("manager settings changed");
      const { content: _content, ...generated } = candidate;
      const next: RuntimeLoadState = {
        ...current, version: current.version + 1,
        lastAttempt: { id: randomUUID(), generated, status: "pending", startedAt: new Date().toISOString(), finishedAt: null },
      };
      await this.publishJson(join(this.options.runtimeDir, "load-state.json"), next);
      return next;
    });
  }

  finishLoad(input: { attemptId: string; expectedVersion: number; result: RuntimeLoadResult }) {
    const expected = version(input.expectedVersion);
    if (!["succeeded", "failed", "unknown"].includes(input.result)) invalid();
    return this.options.writeQueue.enqueue(async () => {
      const current = await this.readLoadStateUnqueued();
      if (current.version !== expected || current.lastAttempt?.id !== input.attemptId || current.lastAttempt.status !== "pending") {
        throw new ManagerSettingsConflictError("runtime load result was superseded");
      }
      const now = new Date().toISOString();
      if (input.result === "succeeded") await this.readGenerated(current.lastAttempt.generated);
      const next: RuntimeLoadState = {
        ...current, version: current.version + 1,
        lastAttempt: { ...current.lastAttempt, status: input.result, finishedAt: now },
        lastSuccessful: input.result === "succeeded"
          ? { generated: current.lastAttempt.generated,
            loadedAt: current.lastAttempt.kind === "mode" ? current.lastSuccessful!.loadedAt : now,
            ...(current.lastAttempt.kind === "mode" ? { modeUpdatedAt: now } : {}),
          } : current.lastSuccessful,
      };
      await this.publishJson(join(this.options.runtimeDir, "load-state.json"), next);
      await this.cleanupRuntimeFiles(await this.readCandidateUnqueued(), next).catch(() => undefined);
      return next;
    });
  }

  private async cleanupRuntimeFiles(candidate: GeneratedRuntime | null, state: RuntimeLoadState) {
    const retained = new Set([
      candidate?.version, state.lastSuccessful?.generated.version,
      state.lastAttempt?.status === "pending" ? state.lastAttempt.generated.version : undefined,
    ]);
    // This dedicated directory owns only generated files; keep candidate, in-flight and last success.
    for (const name of await readdir(this.options.runtimeDir)) {
      if (/^[a-f0-9]{64}\.yaml$/.test(name) && !retained.has(name.slice(0, -5))) {
        await unlink(join(this.options.runtimeDir, name)).catch(() => undefined);
      }
    }
  }
}
