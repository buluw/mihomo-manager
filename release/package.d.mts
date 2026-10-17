export const MAX_RUNTIME_BYTES: number;
export class PackageError extends Error { readonly code: string; constructor(code: string); }
export interface RuntimePackage {
  version: string; sha256: string; sourceSha256: string; revision: string; dirty: boolean;
  protocol: number; fileCount: number; node: string; arch: string; platform: string;
}
export function runtimeArchiveHash(path: string): Promise<string>;
export function validateRuntimePackage(archive: string, directory: string, options?: {
  expectedSha256?: string; expectedVersion?: string; node?: string; arch?: string; platform?: string;
}): Promise<RuntimePackage>;
