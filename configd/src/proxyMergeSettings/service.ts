import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  ProxyMergeSettingsConflictError,
  ProxyMergeSettingsValidationError,
} from "../config/errors.js";
import { WriteQueue } from "../writeQueue.js";

export type ProxyNodeIdentity = {
  provider: string;
  name: string;
};

export type ProxyMergeGroup = {
  id: string;
  displayName: string;
  source: "manual" | "automatic";
  members: ProxyNodeIdentity[];
};

export type ProxyMergeSettings = {
  schemaVersion: 1;
  version: number;
  groups: ProxyMergeGroup[];
  exclusions: ProxyNodeIdentity[];
};

export type ProxyMergeSettingsInput = Pick<ProxyMergeSettings, "groups" | "exclusions"> & {
  expectedVersion: number;
};

export type ProxyMergeSettingsServiceOptions = {
  statePath: string;
  writeQueue?: WriteQueue;
  beforeRename?: () => Promise<void>;
};

const EMPTY_SETTINGS: ProxyMergeSettings = {
  schemaVersion: 1,
  version: 0,
  groups: [],
  exclusions: [],
};

function invalid(): never {
  throw new ProxyMergeSettingsValidationError("invalid proxy merge settings");
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

function validateGroups(value: unknown): ProxyMergeGroup[] {
  if (!Array.isArray(value) || value.length > 512) invalid();
  const ids = new Set<string>();
  const assigned = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid();
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== "string"
      || !record.id
      || record.id.length > 128
      || ids.has(record.id)
      || typeof record.displayName !== "string"
      || record.displayName.length > 120
      || (record.source !== "manual" && record.source !== "automatic")
      || !Array.isArray(record.members)
      || record.members.length < 2
      || record.members.length > 256
    ) invalid();
    ids.add(record.id);
    const members = record.members.map(identity);
    for (const member of members) {
      const key = identityKey(member);
      if (assigned.has(key)) invalid();
      assigned.add(key);
    }
    return {
      id: record.id,
      displayName: record.displayName,
      source: record.source,
      members,
    };
  });
}

function validateExclusions(value: unknown): ProxyNodeIdentity[] {
  if (!Array.isArray(value) || value.length > 4096) invalid();
  const seen = new Set<string>();
  return value.map((entry) => {
    const parsed = identity(entry);
    const key = identityKey(parsed);
    if (seen.has(key)) invalid();
    seen.add(key);
    return parsed;
  });
}

function parseSettings(value: unknown): ProxyMergeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1
    || !Number.isSafeInteger(record.version)
    || (record.version as number) < 0
  ) invalid();
  const groups = validateGroups(record.groups);
  const exclusions = validateExclusions(record.exclusions);
  const assigned = new Set(groups.flatMap((group) => group.members.map(identityKey)));
  if (exclusions.some((entry) => assigned.has(identityKey(entry)))) invalid();
  return {
    schemaVersion: 1,
    version: record.version as number,
    groups,
    exclusions,
  };
}

export class ProxyMergeSettingsService {
  private readonly options: ProxyMergeSettingsServiceOptions;
  private readonly writeQueue: WriteQueue;

  constructor(options: ProxyMergeSettingsServiceOptions) {
    this.options = options;
    this.writeQueue = options.writeQueue ?? new WriteQueue();
  }

  async read(): Promise<ProxyMergeSettings> {
    try {
      return parseSettings(JSON.parse(await readFile(this.options.statePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_SETTINGS);
      if (error instanceof ProxyMergeSettingsValidationError) throw error;
      if (error instanceof SyntaxError) invalid();
      throw error;
    }
  }

  save(input: ProxyMergeSettingsInput): Promise<ProxyMergeSettings> {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) invalid();
    const validated = parseSettings({
      schemaVersion: 1,
      version: input.expectedVersion,
      groups: input.groups,
      exclusions: input.exclusions,
    });
    return this.writeQueue.enqueue(async () => {
      const current = await this.read();
      if (current.version !== input.expectedVersion) {
        throw new ProxyMergeSettingsConflictError("proxy merge settings version conflict");
      }
      const next: ProxyMergeSettings = { ...validated, version: current.version + 1 };
      const directory = dirname(this.options.statePath);
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `.${basename(this.options.statePath)}.${randomBytes(8).toString("hex")}.tmp`);
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await this.options.beforeRename?.();
        await rename(temporary, this.options.statePath);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      return next;
    });
  }
}
