import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import { controlCoreUpdate } from "./coreService.js";
import { sources, proxyFor, transfer, receiveFile, validateUrl, UpdateError, type Route } from "./updates/transport.js";

const execute = promisify(execFile);
export const MAX_CORE_BYTES = 128 * 1024 * 1024;
type Source = keyof typeof sources | "custom" | "upload";
type Binary = { version: string; sha256: string };
type Candidate = Binary & { verification: "official" | "local"; source: Source; route: Route["mode"] | null };
type Release = { version: string; url: string; sha256: string; size: number; releaseNotes: string | null };
type Phase = "idle" | "checking" | "downloading" | "uploading" | "validating" | "ready" | "installing" | "rolling-back" | "succeeded" | "rolled-back" | "failed";
const fail = (code: string): never => { throw new UpdateError(code); };

export function assetName(version: string, architecture = process.arch) {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) return fail("invalid_release");
  const arch = architecture === "x64" ? "amd64-compatible" : architecture === "arm64" ? "arm64" : fail("unsupported_architecture");
  return `mihomo-linux-${arch}-${version}.gz`;
}

export function officialRelease(data: unknown, architecture = process.arch): Release {
  const release = data as { tag_name?: string; prerelease?: boolean; draft?: boolean; body?: unknown; assets?: Array<{ name: string; digest?: string; size: number; browser_download_url: string }> };
  if (!release || release.draft || release.prerelease || typeof release.tag_name !== "string") return fail("invalid_release");
  const name = assetName(release.tag_name, architecture);
  const asset = release.assets?.find(item => item.name === name);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")) return fail("official_checksum_unavailable");
  const url = `https://github.com/MetaCubeX/mihomo/releases/download/${release.tag_name}/${name}`;
  if (asset.browser_download_url !== url) return fail("invalid_release");
  return { version: release.tag_name, url, sha256: asset.digest!.slice(7), size: asset.size,
    releaseNotes: typeof release.body === "string" && release.body.trim() ? release.body : null };
}

export function downloadUrl(source: keyof typeof sources, release: Release) {
  if (!Object.hasOwn(sources, source)) return fail("invalid_source");
  return sources[source] + release.url;
}

function validateHeader(binary: Buffer, architecture = process.arch) {
  const machine = architecture === "x64" ? 62 : architecture === "arm64" ? 183 : fail("unsupported_architecture");
  if (binary.length < 64 || binary.subarray(0, 4).toString("hex") !== "7f454c46"
      || binary[4] !== 2 || binary[5] !== 1 || ![0, 3].includes(binary[7]!) || binary.readUInt16LE(18) !== machine) return fail("invalid_binary");
}

async function fileSignature(path: string) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_CORE_BYTES) return null;
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`;
  } catch { return null; }
}

async function hashFile(path: string): Promise<string> {
  const before = await fileSignature(path);
  if (!before) return fail("invalid_binary");
  const file = await open(path, "r");
  try {
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_CORE_BYTES) return fail("invalid_binary");
      digest.update(buffer.subarray(0, bytesRead));
    }
    if (before !== await fileSignature(path)) return fail("invalid_binary");
    return digest.digest("hex");
  } finally { await file.close(); }
}

export async function probeBinary(path: string): Promise<Binary> {
  try {
    const before = await fileSignature(path);
    if (!before) return fail("invalid_binary");
    const { stdout } = await execute(path, ["-v"], { timeout: 8000, maxBuffer: 4096 });
    const match = /^Mihomo Meta (v?[^\s]+) linux (amd64|arm64)\b/.exec(stdout.trim());
    if (!match || match[2] !== (process.arch === "x64" ? "amd64" : process.arch)) return fail("invalid_binary");
    const sha256 = await hashFile(path);
    if (before !== await fileSignature(path)) return fail("invalid_binary");
    return { version: match[1]!, sha256 };
  } catch { return fail("invalid_binary"); }
}

export async function unpackCore(path: string, candidatePath: string, architecture = process.arch, limit = MAX_CORE_BYTES, expectedSha256?: string) {
  const before = await fileSignature(path);
  if (!before) return fail("invalid_binary");
  const file = await open(path, "r");
  const magic = Buffer.alloc(2);
  try { await file.read(magic, 0, 2, 0); } finally { await file.close(); }
  let size = 0;
  let inputSize = 0;
  const inputDigest = createHash("sha256");
  const input = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    inputSize += chunk.length;
    if (inputSize > MAX_CORE_BYTES) { callback(new UpdateError("file_too_large")); return; }
    inputDigest.update(chunk);
    callback(null, chunk);
  } });
  let headerSize = 0;
  const header = Buffer.alloc(64);
  const validate = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        size += chunk.length;
        if (size > limit) fail("invalid_binary");
        if (headerSize < header.length) {
          headerSize += chunk.copy(header, headerSize, 0, Math.min(chunk.length, header.length - headerSize));
          if (headerSize === header.length) validateHeader(header, architecture);
        }
        callback(null, chunk);
      } catch (error) { callback(error as Error); }
    },
    flush(callback) { callback(headerSize < header.length ? new UpdateError("invalid_binary") : null); },
  });
  try {
    await pipeline(createReadStream(path, { highWaterMark: 64 * 1024 }), input,
      magic[0] === 0x1f && magic[1] === 0x8b ? createGunzip() : new PassThrough(),
      validate, createWriteStream(candidatePath, { mode: 0o700 }));
    if (before !== await fileSignature(path)) fail("invalid_binary");
    if (expectedSha256 && inputDigest.digest("hex") !== expectedSha256) fail("checksum_mismatch");
  } catch (error) {
    await rm(candidatePath, { force: true });
    if (error instanceof UpdateError) throw error;
    return fail("invalid_binary");
  }
}

export class CoreUpdates {
  busy = false;
  private uploadOwner: symbol | null = null;
  private phase: Phase = "idle";
  private error: string | null = null;
  private candidate: Candidate | null = null;
  private latest: Release | null = null;
  private checkState: "unchecked" | "checking" | "succeeded" | "failed" = "unchecked";
  private checkedAt: string | null = null;
  private bytes = 0;
  private total: number | null = null;
  private source: Source | null = null;
  private route: Route["mode"] | null = null;
  private readonly probeCache = new Map<string, { signature: string; value: Promise<Binary | null> }>();
  constructor(private readonly directory = process.env.CORE_UPDATE_DIR ?? "/var/lib/mihomo-manager/core-update",
    private readonly binary = process.env.MIHOMO_BINARY_PATH ?? "/opt/mihomo-manager/bin/mihomo",
    private readonly dependencies = { transfer, proxyFor, probeBinary, controlCoreUpdate }) {}

  async status() {
    const [current, previous] = await Promise.all([this.probeStatus(this.binary), this.probeStatus(this.binary + ".previous")]);
    return { phase: this.phase, busy: this.busy, error: this.error, candidate: this.candidate,
      latest: this.latest ? { version: this.latest.version, releaseNotes: this.latest.releaseNotes } : null,
      checkState: this.checkState, checkedAt: this.checkedAt, bytes: this.bytes, total: this.total, source: this.source, route: this.route, current, previous };
  }
  private async probeStatus(path: string) {
    const signature = await fileSignature(path);
    if (!signature) { this.probeCache.delete(path); return null; }
    const cached = this.probeCache.get(path);
    if (cached?.signature === signature) return cached.value;
    const entry = { signature, value: Promise.resolve<Binary | null>(null) };
    entry.value = this.dependencies.probeBinary(path).then(async value => {
      if (signature !== await fileSignature(path)) return null;
      return value;
    }).catch(() => null).then(value => {
      if (!value && this.probeCache.get(path) === entry) this.probeCache.delete(path);
      return value;
    });
    this.probeCache.set(path, entry);
    return entry.value;
  }
  private invalidateProbeCache() { this.probeCache.clear(); }
  private async clearCandidate() {
    this.candidate = null;
    await Promise.all(["download", "candidate", "candidate.json", "candidate.json.tmp"].map(name => rm(join(this.directory, name), { force: true })));
  }
  private start(phase: Phase, operation: () => Promise<void>) {
    if (this.busy) return fail("core_action_busy");
    this.busy = true; this.phase = phase; this.error = null;
    return operation().catch(async error => {
      this.error = error instanceof UpdateError ? error.code : "update_failed";
      this.phase = "failed";
      await this.clearCandidate().catch(() => {});
    }).finally(() => { this.busy = false; });
  }
  private async check(route: Route) {
    this.checkState = "checking";
    try {
      const data = await this.dependencies.transfer("https://api.github.com/repos/MetaCubeX/mihomo/releases/latest", await this.dependencies.proxyFor(route));
      this.latest = officialRelease(JSON.parse(data.toString("utf8")));
      this.checkState = "succeeded";
      return this.latest;
    } catch (error) {
      this.checkState = "failed";
      throw error;
    } finally {
      this.checkedAt = new Date().toISOString();
    }
  }
  checkAutomatically(route: Route) {
    if (this.busy) return fail("core_action_busy");
    this.route = route.mode; this.source = null; this.bytes = 0; this.total = null;
    return this.start("checking", async () => { await this.check(route); this.phase = this.candidate ? "ready" : "idle"; });
  }
  private async validate(source: Source, release?: Release, uploadedSha256?: string) {
    this.phase = "validating";
    const download = join(this.directory, "download");
    this.bytes = (await stat(download)).size;
    if (this.bytes > MAX_CORE_BYTES) return fail("file_too_large");
    const inputSha256 = uploadedSha256 ?? await hashFile(download);
    if (release && inputSha256 !== release.sha256) return fail("checksum_mismatch");
    const candidatePath = join(this.directory, "candidate");
    await unpackCore(download, candidatePath, process.arch, MAX_CORE_BYTES, inputSha256);
    await chmod(candidatePath, 0o700);
    const info = await this.dependencies.probeBinary(candidatePath);
    if (release && info.version !== release.version) return fail("version_mismatch");
    this.candidate = { ...info, source, route: this.route, verification: release ? "official" : "local" };
    await writeFile(join(this.directory, "candidate.json.tmp"), JSON.stringify(this.candidate), { mode: 0o600 });
    await rename(join(this.directory, "candidate.json.tmp"), join(this.directory, "candidate.json"));
    await rm(join(this.directory, "download"), { force: true });
    this.phase = "ready";
  }
  async handle(request: IncomingMessage, response: ServerResponse, serviceBusy: boolean | (() => Promise<boolean>)) {
    const blocked = () => typeof serviceBusy === "function" ? serviceBusy() : Promise.resolve(serviceBusy);
    const send = (status: number, body: unknown) => response.writeHead(status).end(JSON.stringify(body));
    try {
      const path = request.url;
      if (path === "/core/update" && request.method === "GET") { send(200, await this.status()); return; }
      if (request.method !== "POST") { send(405, { error: "method_not_allowed" }); return; }
      // The external query yields; recheck local ownership before changing task state.
      if (this.busy || await blocked() || this.busy) { request.resume(); send(409, { error: "core_action_busy" }); return; }
      if (path === "/core/update/upload") {
        const owner = this.uploadOwner = Symbol();
        this.busy = true; this.phase = "uploading"; this.error = null; this.source = "upload"; this.route = null; this.bytes = 0;
        this.total = Number(request.headers["content-length"]) || null;
        let digest: string;
        try {
          await mkdir(this.directory, { recursive: true, mode: 0o700 });
          await this.clearCandidate();
          if (this.total && this.total > MAX_CORE_BYTES) fail("file_too_large");
          digest = await receiveFile(request.iterator({ destroyOnReturn: false }), join(this.directory, "download"), bytes => { this.bytes = bytes; });
        } catch (error) {
          if (this.uploadOwner === owner) {
            this.phase = "failed";
            this.error = error instanceof UpdateError ? error.code : "upload_failed";
            await this.clearCandidate();
          }
          request.resume();
          send(400, { error: this.error });
          return;
        } finally {
          if (this.uploadOwner === owner) { this.uploadOwner = null; this.busy = false; }
        }
        // Hand ownership to validation synchronously, after upload cleanup can no longer run.
        this.start("validating", () => this.validate("upload", undefined, digest));
        send(202, { accepted: true });
        return;
      }
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 16384) fail("invalid_request"); chunks.push(chunk); }
      const body = bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (this.busy || await blocked() || this.busy) fail("core_action_busy");
      if (path === "/core/update/check") {
        this.route = body.mode; this.source = null; this.bytes = 0; this.total = null;
        this.start("checking", async () => { await this.check(body); this.phase = this.candidate ? "ready" : "idle"; });
      } else if (path === "/core/update/download") {
        if (body.source !== "custom" && !Object.hasOwn(sources, body.source)) fail("invalid_source");
        this.source = body.source; this.route = body.mode; this.bytes = 0; this.total = null;
        this.start("downloading", async () => {
          await mkdir(this.directory, { recursive: true, mode: 0o700 });
          await this.clearCandidate();
          const proxy = await this.dependencies.proxyFor(body);
          const release = body.source === "custom" ? undefined : await this.check(body);
          this.total = release?.size ?? null;
          await this.dependencies.transfer(release ? downloadUrl(body.source, release) : validateUrl(body.url), proxy, join(this.directory, "download"), bytes => { this.bytes = bytes; });
          await this.validate(body.source, release);
        });
      } else if (path === "/core/update/install") {
        if (!this.candidate || body.sha256 !== this.candidate.sha256) fail("candidate_changed");
        this.source = this.candidate!.source; this.route = this.candidate!.route;
        this.start("installing", async () => {
          const outcome = await this.dependencies.controlCoreUpdate("install").finally(() => this.invalidateProbeCache());
          await this.clearCandidate();
          this.phase = outcome === "rolled_back" ? "rolled-back" : "succeeded";
          if (outcome === "rolled_back") this.error = "startup_failed_restored";
        });
      } else if (path === "/core/update/rollback") {
        const previous = await this.dependencies.probeBinary(this.binary + ".previous").catch(() => null);
        if (!previous || previous.sha256 !== body.sha256) fail("previous_unavailable");
        this.source = null; this.route = null; this.bytes = 0; this.total = null;
        this.start("rolling-back", async () => {
          const outcome = await this.dependencies.controlCoreUpdate("rollback").finally(() => this.invalidateProbeCache());
          this.phase = outcome === "rolled_back" ? "rolled-back" : "succeeded";
          if (outcome === "rolled_back") this.error = "startup_failed_restored";
          await this.clearCandidate();
        });
      } else { send(404, { error: "not_found" }); return; }
      send(202, { accepted: true });
    } catch (error) {
      const code = error instanceof UpdateError ? error.code : "invalid_request";
      send(code === "core_action_busy" ? 409 : 400, { error: code });
    }
  }
}
