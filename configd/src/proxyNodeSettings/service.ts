import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  ProxyNodeInfoTransactionError,
  ProxyNodeSettingsConflictError,
  ProxyNodeSettingsValidationError,
} from "../config/errors.js";
import type { ConfigStore } from "../config/store.js";
import { WriteQueue } from "../writeQueue.js";

export type ProxyNodeIdentity = {
  provider: string;
  name: string;
};

export type ProxyNodeRegion = ProxyNodeIdentity & {
  label: string;
};

export type ProxyNodeSettings = {
  schemaVersion: 1;
  version: number;
  regions: ProxyNodeRegion[];
};

export type ProxyNodeSettingsInput = {
  expectedVersion: number;
  regions: ProxyNodeRegion[];
};

export type ProxyNodeRegionMigration = {
  expectedVersion: number;
  from: ProxyNodeIdentity;
  to: ProxyNodeIdentity;
  region: string | null;
};

export type ProxyNodeSettingsServiceOptions = {
  statePath: string;
  writeQueue?: WriteQueue;
  beforeRename?: () => Promise<void>;
};

const EMPTY_SETTINGS: ProxyNodeSettings = {
  schemaVersion: 1,
  version: 0,
  regions: [],
};

function invalid(): never {
  throw new ProxyNodeSettingsValidationError("invalid proxy node settings");
}

function identity(value: unknown): ProxyNodeIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    typeof record.provider !== "string"
    || record.provider.length > 256
    || typeof record.name !== "string"
    || !record.name
    || record.name.length > 256
  ) invalid();
  return { provider: record.provider, name: record.name };
}

function identityKey(value: ProxyNodeIdentity) {
  return `${value.provider}\u0000${value.name}`;
}

function region(value: unknown): ProxyNodeRegion {
  const parsed = identity(value);
  const label = (value as Record<string, unknown>).label;
  if (typeof label !== "string" || !label.trim() || label.length > 160) invalid();
  return { ...parsed, label: label.trim() };
}

function parseSettings(value: unknown): ProxyNodeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1
    || !Number.isSafeInteger(record.version)
    || (record.version as number) < 0
    || !Array.isArray(record.regions)
    || record.regions.length > 4096
  ) invalid();
  const seen = new Set<string>();
  const regions = record.regions.map((entry) => {
    const parsed = region(entry);
    const key = identityKey(parsed);
    if (seen.has(key)) invalid();
    seen.add(key);
    return parsed;
  });
  return { schemaVersion: 1, version: record.version as number, regions };
}

function expectedVersion(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

export class ProxyNodeSettingsService {
  private readonly options: ProxyNodeSettingsServiceOptions;
  private readonly writeQueue: WriteQueue;

  constructor(options: ProxyNodeSettingsServiceOptions) {
    this.options = options;
    this.writeQueue = options.writeQueue ?? new WriteQueue();
  }

  async read(): Promise<ProxyNodeSettings> {
    try {
      return parseSettings(JSON.parse(await readFile(this.options.statePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_SETTINGS);
      if (error instanceof ProxyNodeSettingsValidationError) throw error;
      if (error instanceof SyntaxError) invalid();
      throw error;
    }
  }

  private async publish(next: ProxyNodeSettings) {
    const directory = dirname(this.options.statePath);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.${basename(this.options.statePath)}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await this.options.beforeRename?.();
      await rename(temporary, this.options.statePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return next;
  }

  async saveUnqueued(input: ProxyNodeSettingsInput): Promise<ProxyNodeSettings> {
    const version = expectedVersion(input.expectedVersion);
    const validated = parseSettings({ schemaVersion: 1, version, regions: input.regions });
    const current = await this.read();
    if (current.version !== version) {
      throw new ProxyNodeSettingsConflictError("proxy node settings version conflict");
    }
    return this.publish({ ...validated, version: current.version + 1 });
  }

  save(input: ProxyNodeSettingsInput) {
    return this.writeQueue.enqueue(() => this.saveUnqueued(input));
  }

  async migrateRegionUnqueued(input: ProxyNodeRegionMigration) {
    const version = expectedVersion(input.expectedVersion);
    const from = identity(input.from);
    const to = identity(input.to);
    if (input.region !== null && typeof input.region !== "string") invalid();
    const current = await this.read();
    if (current.version !== version) {
      throw new ProxyNodeSettingsConflictError("proxy node settings version conflict");
    }
    const regions = new Map(current.regions.map((entry) => [identityKey(entry), entry]));
    regions.delete(identityKey(from));
    regions.delete(identityKey(to));
    if (input.region?.trim()) {
      const nextRegion = region({ ...to, label: input.region });
      regions.set(identityKey(nextRegion), nextRegion);
    }
    return this.publish({
      schemaVersion: 1,
      version: current.version + 1,
      regions: [...regions.values()],
    });
  }
}

export async function saveProxyNodeInfoUnqueued(input: {
  store: ConfigStore;
  settingsService: ProxyNodeSettingsService;
  configName: string;
  content: string;
  expectedSha256: string;
  expectedVersion: number;
  from: ProxyNodeIdentity;
  to: ProxyNodeIdentity;
  region: string | null;
}) {
  const [previousConfig, currentSettings] = await Promise.all([
    input.store.read(input.configName),
    input.settingsService.read(),
  ]);
  if (currentSettings.version !== input.expectedVersion) {
    throw new ProxyNodeSettingsConflictError("proxy node settings version conflict");
  }
  const savedConfig = await input.store.saveFileUnqueued(input.configName, input.content, input.expectedSha256);
  try {
    const settings = await input.settingsService.migrateRegionUnqueued(input);
    return { config: savedConfig, settings };
  } catch (error) {
    try {
      await input.store.restoreFileUnqueued(previousConfig.name, previousConfig.content, savedConfig.sha256);
    } catch {
      throw new ProxyNodeInfoTransactionError("proxy node info rollback failed");
    }
    throw error;
  }
}
