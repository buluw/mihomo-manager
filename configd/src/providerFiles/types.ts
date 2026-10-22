import type { ProviderCategory } from "./collectionYaml.js";
import type { ProviderConfigReference } from "./errors.js";

export type ProviderFileSource = "manual" | "subscription" | "local" | "external";

export type ProviderPathReference = { kind: "path" | "identity"; path: string };
export type RuntimeUnknownReason = "no_record" | "load_pending" | "load_unknown" | "load_failed" | "record_unreadable" | "core_unverified";
export type ProviderRuntimeDependencies = { content: string | null; uncertain: boolean; unknownReason?: RuntimeUnknownReason; hasSuccessfulRecord?: boolean };
export type ProviderRuntimeReferences = { references: ProviderPathReference[]; uncertain: boolean; unknownReason?: RuntimeUnknownReason; hasSuccessfulRecord?: boolean; scanComplete: boolean };

export interface ProviderFileRecord {
  httpCache?: boolean;
  fileName: string;
  referencePath: string;
  category: ProviderCategory | "unknown";
  source: ProviderFileSource;
  writable: boolean;
  sha256: string;
  size: number;
  updatedAt: string;
  filterSettings: ProviderFilterSettings | null;
  extractionId: string | null;
  ownerId: string | null;
}

export interface LocalProviderExtraction {
  id: string;
  configName: string;
  sourceSha256: string;
  fileName: string;
  providerSha256: string | null;
  nodeCount: number;
  enabled: boolean;
  filterSettings: ProviderFilterSettings;
}

export interface ProviderFilterSettings {
  version: number;
  enabled: boolean;
  rules: string[];
}

export type LocalExtractionDeleteInput = Pick<LocalProviderExtraction, "id" | "configName" | "sourceSha256" | "fileName"> & {
  filterVersion: number;
};

export type RetainedProviderFile = {
  fileName: string;
  reason: "referenced" | "runtime_reference" | "runtime_unknown";
  configNames?: string[];
  configReferences?: ProviderConfigReference[];
  runtime?: ProviderRuntimeReferences;
};

export interface SubscriptionProviderIdentity {
  subscriptionId: string;
  fileName: string;
  expectedSha256: string | null;
}

export interface SubscriptionProviderPublish extends SubscriptionProviderIdentity {
  content: string;
}

export interface ManagedHttpProviderRecord {
  configName: string;
  category: ProviderCategory;
  name: string;
  declaration?: Record<string, unknown>;
}

export type ProviderHttpConfigIntent = {
  version: 1;
  configName: string;
  beforeSha256: string;
  afterSha256: string;
  before: Array<{ category: ProviderCategory; name: string; declaration?: Record<string, unknown> }>;
  after: Array<{ category: ProviderCategory; name: string; declaration?: Record<string, unknown> }>;
} | null;

export type SaveManualHttpConfigInput = {
  configName: string;
  content: string;
  expectedSha256: string;
  providers: Array<{ category: ProviderCategory; name: string }>;
};

export type LocalExtractionUpdateInput = {
  id: string;
  currentFileName: string;
  fileName: string;
  providerSha256: string | null;
  currentEnabled: boolean;
  enabled: boolean;
  filterSettings: ProviderFilterSettings;
};

export type LocalExtractionFilterInput = {
  expectedVersion: number;
  enabled: boolean;
  rules: string[];
};

export type LocalExtractionCreateInput = {
  configName: string;
  sourceSha256: string;
  fileName: string;
  enabled?: boolean;
  filterSettings?: { enabled: boolean; rules: string[] };
};
