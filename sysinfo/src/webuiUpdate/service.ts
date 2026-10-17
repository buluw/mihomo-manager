import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { PackageError, MAX_RUNTIME_BYTES, runtimeArchiveHash, validateRuntimePackage, type RuntimePackage } from "../../../release/package.mjs";
import { proxyFor, receiveFile, sources, transfer, UpdateError, validateUrl, type Route } from "../updates/transport.js";
import { readInstallState, requestWebUiInstall, type InstallState } from "./control.js";
import { compareWebUiVersions, queryWebUiRelease, type WebUiRelease } from "./release.js";
import { UpdateStore } from "./store.js";

export type WebUiSource = keyof typeof sources | "custom" | "upload";
type Phase = "idle" | "checking" | "downloading" | "uploading" | "validating" | "ready" | InstallState["phase"];
type Candidate = RuntimePackage & { verification: "official" | "local"; source: WebUiSource; route: Route["mode"] | null };
type State = { version: 1; phase: Phase; error: string | null; checkState: "unchecked" | "checking" | "succeeded" | "unpublished" | "unavailable" | "failed";
  checkedAt: string | null; latest: WebUiRelease | null; candidate: Candidate | null; bytes: number; total: number | null;
  source: WebUiSource | null; route: Route["mode"] | null; installerId: string | null };
const initialState = (): State => ({ version: 1, phase: "idle", error: null, checkState: "unchecked", checkedAt: null,
  latest: null, candidate: null, bytes: 0, total: null, source: null, route: null, installerId: null });
const errorCode = (error: unknown) => error instanceof UpdateError || error instanceof PackageError ? error.code : "webui_update_failed";
type Dependencies = { transfer: typeof transfer; proxyFor: typeof proxyFor; query: typeof queryWebUiRelease;
  validate: typeof validateRuntimePackage; readInstaller: typeof readInstallState; control: typeof requestWebUiInstall; coreBusy: () => boolean };

export class WebUiUpdates {
  private state = initialState();
  private running = false;
  private unavailable = false;
  private current = { version: "unknown", sourceSha256: null as string | null };
  private readonly store: UpdateStore;
  private readonly dependencies: Dependencies;
  constructor(readonly directory = process.env.WEBUI_UPDATE_DIR ?? "/var/lib/mihomo-manager/webui-update", dependencies: Partial<Dependencies> = {}) {
    this.store = new UpdateStore(join(directory, "state.json"));
    this.dependencies = { transfer, proxyFor, query: queryWebUiRelease, validate: validateRuntimePackage,
      readInstaller: readInstallState, control: requestWebUiInstall, coreBusy: () => false, ...dependencies };
  }
  async initialize(current?: { version: string; sourceSha256: string | null }) {
    try {
      if (current) this.current = current;
      else {
        const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
        const proof = await readFile(new URL("../../../BUILD_PROVENANCE.json", import.meta.url), "utf8").then(text => JSON.parse(text) as {
          sourceManifestSha256: string; artifacts: Array<{ path: string; sha256: string }>
        }, () => null);
        const moduleHash = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
        const recorded = proof?.artifacts?.some(item => item.path === "sysinfo/dist/webuiUpdate/service.js" && item.sha256 === moduleHash);
        this.current = { version: pkg.version, sourceSha256: recorded ? proof!.sourceManifestSha256 : null };
      }
      this.state = await this.store.read(initialState());
      if (this.state.version !== 1 || !["idle", "checking", "downloading", "uploading", "validating", "ready", "installing", "rolling-back", "succeeded", "rolled-back", "failed"].includes(this.state.phase)) throw new Error();
      if (["checking", "downloading", "uploading", "validating"].includes(this.state.phase)) {
        this.state.phase = "failed"; this.state.error = "webui_task_interrupted";
        if (this.state.checkState === "checking") this.state.checkState = "failed";
        await rm(join(this.directory, "download.part"), { force: true });
        await this.store.write(this.state);
      }
    } catch { this.unavailable = true; this.state = { ...initialState(), phase: "failed", error: "webui_state_unavailable" }; }
  }
  async isBusy() { return this.running || (await this.dependencies.readInstaller()).busy; }
  setCoreBusy(read: () => boolean) { this.dependencies.coreBusy = read; }
  async assertIdle() {
    if (this.unavailable) throw new UpdateError("webui_state_unavailable");
    if (this.dependencies.coreBusy() || (await this.status()).busy) throw new UpdateError("webui_action_busy");
  }
  async status() {
    const installer = await this.dependencies.readInstaller();
    if (!this.running && ["installing", "rolling-back"].includes(this.state.phase) && installer.id !== this.state.installerId) {
      this.state.phase = "failed"; this.state.error = "webui_install_unconfirmed"; await this.persist();
    }
    const owned = installer.id !== null && (installer.id === this.state.installerId || installer.busy);
    if (owned && !installer.busy && this.state.candidate) {
      this.state.candidate = null;
      await rm(join(this.directory, "candidate.tar.gz"), { force: true });
      await this.store.write(this.state);
    }
    return { ...this.state, phase: owned ? installer.phase : this.state.phase, error: owned ? installer.error : this.state.error,
      latest: this.state.latest ? { version: this.state.latest.version, releaseNotes: this.state.latest.releaseNotes, assetName: this.state.latest.assetName } : null,
      current: this.current, previous: installer.previous, busy: this.running || installer.busy, available: !this.unavailable,
      install: owned ? { id: installer.id, startedAt: installer.startedAt, finishedAt: installer.finishedAt, services: installer.services } : null };
  }
  private persist() { return this.store.write(this.state); }
  private assertStart(route?: Route) {
    if (this.unavailable) throw new UpdateError("webui_state_unavailable");
    if (this.running || this.dependencies.coreBusy()) throw new UpdateError("webui_action_busy");
    if (route && !["direct", "core", "external"].includes(route.mode)) throw new UpdateError("invalid_route");
    if (route?.mode === "external") validateUrl(route.proxy, true);
  }
  private start(phase: Phase, operation: () => Promise<void>) {
    this.assertStart();
    this.running = true; this.state.phase = phase; this.state.error = null;
    return (async () => { await this.persist(); await operation(); await this.persist(); })().catch(async error => {
      this.state.phase = "failed"; this.state.error = errorCode(error);
      await this.persist().catch(() => { this.unavailable = true; });
    }).finally(() => { this.running = false; });
  }
  private async check(route: Route) {
    this.state.checkState = "checking";
    try {
      this.state.latest = await this.dependencies.query(await this.dependencies.proxyFor(route));
      this.state.checkState = this.state.latest ? "succeeded" : "unpublished";
      return this.state.latest;
    } catch (error) {
      this.state.checkState = error instanceof UpdateError && error.code === "webui_asset_unavailable" ? "unavailable" : "failed";
      throw error;
    } finally { this.state.checkedAt = new Date().toISOString(); }
  }
  startCheck(route: Route) {
    this.assertStart(route);
    this.state.installerId = null; this.state.route = route.mode; this.state.source = null; this.state.bytes = 0; this.state.total = null;
    return this.start("checking", async () => { await this.check(route); this.state.phase = this.state.candidate ? "ready" : "idle"; });
  }
  private async clearCandidate() {
    this.state.candidate = null;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await rm(join(this.directory, "candidate.tar.gz"), { force: true });
    await rm(join(this.directory, "download.part"), { force: true });
  }
  private async validate(source: WebUiSource, expected?: WebUiRelease) {
    this.state.phase = "validating"; await this.persist();
    const archive = join(this.directory, "download.part"), inspection = join(this.directory, "inspect-" + randomUUID());
    try {
      this.state.bytes = (await stat(archive)).size;
      const info = await this.dependencies.validate(archive, inspection, expected ? { expectedSha256: expected.sha256, expectedVersion: expected.version } : {});
      await rename(archive, join(this.directory, "candidate.tar.gz"));
      this.state.candidate = { ...info, source, route: this.state.route, verification: expected ? "official" : "local" };
      this.state.phase = "ready";
    } finally { await rm(inspection, { recursive: true, force: true }); }
  }
  startDownload(request: Route & { source: Exclude<WebUiSource, "upload">; url?: string }) {
    this.assertStart(request);
    if (request.source !== "custom" && !Object.hasOwn(sources, request.source)) throw new UpdateError("invalid_source");
    this.state.installerId = null; this.state.source = request.source; this.state.route = request.mode; this.state.bytes = 0; this.state.total = null;
    return this.start("downloading", async () => {
      await this.clearCandidate();
      const proxy = await this.dependencies.proxyFor(request);
      const release = request.source === "custom" ? undefined : await this.check(request);
      if (release === null) throw new UpdateError("webui_unpublished");
      this.state.total = release?.size ?? null;
      const url = release ? sources[request.source as keyof typeof sources] + release.url : validateUrl(request.url);
      await this.dependencies.transfer(url, proxy, join(this.directory, "download.part"), bytes => { this.state.bytes = bytes; });
      await this.validate(request.source, release);
    });
  }
  receiveUpload(input: AsyncIterable<Buffer>, total: number | null) {
    this.assertStart();
    if (total && total > MAX_RUNTIME_BYTES) throw new UpdateError("file_too_large");
    this.state.installerId = null; this.state.source = "upload"; this.state.route = null; this.state.bytes = 0; this.state.total = total;
    return this.start("uploading", async () => {
      await this.clearCandidate();
      await receiveFile(input, join(this.directory, "download.part"), bytes => { this.state.bytes = bytes; }, MAX_RUNTIME_BYTES);
      await this.validate("upload");
    });
  }
  startInstall(sha256: string, automatic = false) {
    this.assertStart();
    const candidate = this.state.candidate;
    if (!candidate || sha256 !== candidate.sha256) throw new UpdateError("candidate_changed");
    if (automatic && (candidate.verification !== "official" || this.state.latest?.sha256 !== sha256
      || compareWebUiVersions(candidate.version, this.current.version) !== 1)) throw new UpdateError("webui_auto_candidate_unavailable");
    return this.start("installing", async () => {
      if (await runtimeArchiveHash(join(this.directory, "candidate.tar.gz")) !== sha256) throw new UpdateError("candidate_changed");
      const id = randomUUID(); this.state.installerId = id; await this.persist();
      await this.dependencies.control("install", sha256, id);
    });
  }
  async startRollback(sha256: string) {
    const installer = await this.dependencies.readInstaller();
    if (!installer.previous || installer.previous.sha256 !== sha256) throw new UpdateError("previous_unavailable");
    return this.start("rolling-back", async () => {
      const id = randomUUID(); this.state.installerId = id; await this.persist();
      await this.dependencies.control("rollback", sha256, id);
    });
  }
}
