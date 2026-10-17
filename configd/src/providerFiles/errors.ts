export type ProviderConfigReference = { configName: string; kind: "path" | "identity" | "unreadable"; path?: string };

export class ProviderFileNameError extends Error {}

export class ProviderFileNotFoundError extends Error {}

export class ProviderFileExistsError extends Error {}

export class ProviderFileReadOnlyError extends Error {}

export class ProviderFileConflictError extends Error {}

export class ProviderFileValidationError extends Error {}

export class ProviderFilterConflictError extends Error {}

export class ProviderFileReferencedError extends Error {
  constructor(readonly configNames: string[], readonly configReferences?: ProviderConfigReference[]) {
    super("provider file is referenced by managed configurations");
  }
}

export class ProviderFileRecoveryError extends Error {}

export class ProviderRuntimeReferenceError extends Error {
  constructor(readonly reason: "runtime_reference" | "runtime_unknown") { super(reason); }
}
