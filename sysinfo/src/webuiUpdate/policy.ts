import { join } from "node:path";
import { sources, UpdateError, type Route } from "../updates/transport.js";
import type { CoreUpdates } from "../coreUpdate.js";
import { compareWebUiVersions } from "./release.js";
import type { WebUiUpdates } from "./service.js";
import { UpdateStore } from "./store.js";

export interface UpdatePolicy {
  autoCheck: boolean; intervalHours: number; autoDownload: boolean; scheduledInstall: boolean; installTime: string;
  mode: "direct" | "core"; source: keyof typeof sources;
}
interface PolicyState { version: 1; revision: number; settings: UpdatePolicy; nextCheckAt: number | null; nextInstallAt: number | null;
  lastCheckAt: string | null; lastInstallAt: string | null; error: string | null }
export const defaultUpdatePolicy = (): UpdatePolicy => ({ autoCheck: false, intervalHours: 24, autoDownload: false,
  scheduledInstall: false, installTime: "03:00", mode: "direct", source: "github" });

export function validatePolicy(value: unknown): UpdatePolicy {
  const policy = value as UpdatePolicy;
  if (!policy || Object.keys(policy).sort().join(',') !== ['autoCheck', 'intervalHours', 'autoDownload', 'scheduledInstall', 'installTime', 'mode', 'source'].sort().join(',')
    || typeof policy.autoCheck !== "boolean" || typeof policy.autoDownload !== "boolean" || typeof policy.scheduledInstall !== "boolean"
    || !Number.isInteger(policy.intervalHours) || policy.intervalHours < 1 || policy.intervalHours > 168
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.installTime) || !["direct", "core"].includes(policy.mode)
    || !Object.hasOwn(sources, policy.source) || (policy.autoDownload && !policy.autoCheck)) throw new UpdateError("webui_invalid_policy");
  return { autoCheck: policy.autoCheck, intervalHours: policy.intervalHours, autoDownload: policy.autoDownload,
    scheduledInstall: policy.scheduledInstall, installTime: policy.installTime, mode: policy.mode, source: policy.source };
}

export function nextInstallTime(now: number, time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date(now); date.setHours(hours!, minutes!, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}

export class AutomaticUpdates {
  private state: PolicyState = { version: 1, revision: 0, settings: defaultUpdatePolicy(), nextCheckAt: null, nextInstallAt: null,
    lastCheckAt: null, lastInstallAt: null, error: null };
  private readonly store: UpdateStore;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private unavailable = false;
  private generation = 0;
  private saving = false;
  constructor(private readonly webui: WebUiUpdates, private readonly core: Pick<CoreUpdates, "busy" | "checkAutomatically">,
    directory = webui.directory, private readonly now = Date.now, private readonly tickInterval = 30000) {
    this.store = new UpdateStore(join(directory, "policy.json"));
  }
  async initialize() {
    try {
      this.state = await this.store.read(this.state);
      if (this.state.version !== 1 || !Number.isInteger(this.state.revision) || this.state.revision < 0) throw new Error();
      this.state.settings = validatePolicy(this.state.settings);
      for (const time of [this.state.nextCheckAt, this.state.nextInstallAt]) if (time !== null && (!Number.isSafeInteger(time) || time < 0)) throw new Error();
    } catch { this.unavailable = true; this.state.error = "webui_policy_unavailable"; }
  }
  status() {
    return { revision: this.state.revision, settings: { ...this.state.settings }, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      serverTime: new Date(this.now()).toISOString(), nextCheckAt: this.state.nextCheckAt === null ? null : new Date(this.state.nextCheckAt).toISOString(),
      nextInstallAt: this.state.nextInstallAt === null ? null : new Date(this.state.nextInstallAt).toISOString(),
      lastCheckAt: this.state.lastCheckAt, lastInstallAt: this.state.lastInstallAt, error: this.state.error, running: this.running, available: !this.unavailable };
  }
  async save(settings: unknown, expectedRevision: unknown) {
    if (this.unavailable) throw new UpdateError("webui_policy_unavailable");
    if (this.saving || expectedRevision !== this.state.revision) throw new UpdateError("webui_policy_changed");
    const next = validatePolicy(settings); this.saving = true;
    try {
      this.generation++;
      const previous = this.state.settings, now = this.now();
      this.state.settings = next; this.state.revision++; this.state.error = null;
      if (!next.autoCheck) this.state.nextCheckAt = null;
      else if (!previous.autoCheck || next.intervalHours !== previous.intervalHours || next.mode !== previous.mode || next.source !== previous.source) this.state.nextCheckAt = now;
      if (!next.scheduledInstall) this.state.nextInstallAt = null;
      else if (!previous.scheduledInstall || next.installTime !== previous.installTime) this.state.nextInstallAt = nextInstallTime(now, next.installTime);
      await this.store.write(this.state);
      return this.status();
    } catch (error) { this.unavailable = true; throw error; }
    finally { this.saving = false; }
  }
  start() {
    this.stopped = false;
    const schedule = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => { void this.tick().finally(schedule); }, this.tickInterval);
      this.timer.unref();
    };
    if (this.timer === null) schedule();
  }
  dispose() { this.stopped = true; this.generation++; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  async tick() {
    if (this.running || this.unavailable || this.stopped || this.saving || this.core.busy) return;
    this.running = true;
    const generation = this.generation;
    const before = JSON.stringify(this.state);
    try {
      await this.webui.assertIdle();
      const settings = this.state.settings, route: Route = { mode: settings.mode };
      if (settings.autoCheck && this.state.nextCheckAt !== null && this.now() >= this.state.nextCheckAt) {
        this.state.nextCheckAt = this.now() + settings.intervalHours * 60 * 60 * 1000;
        await this.store.write(this.state);
        await this.core.checkAutomatically(route);
        if (generation !== this.generation || this.stopped) return;
        await this.webui.assertIdle(); await this.webui.startCheck(route);
        this.state.lastCheckAt = new Date(this.now()).toISOString();
        const status = await this.webui.status();
        if (generation !== this.generation || this.stopped) return;
        if (settings.autoDownload && status.checkState === "succeeded" && status.latest
          && compareWebUiVersions(status.latest.version, status.current.version) === 1
          && (!status.candidate || status.candidate.version !== status.latest.version || status.candidate.verification !== "official")) {
          await this.webui.assertIdle(); await this.webui.startDownload({ ...route, source: settings.source });
        }
        this.state.error = (await this.webui.status()).error;
      }
      if (generation !== this.generation || this.stopped) return;
      if (settings.scheduledInstall && this.state.nextInstallAt !== null && this.now() >= this.state.nextInstallAt) {
        const canInstall = () => generation === this.generation && !this.stopped && this.state.settings.scheduledInstall;
        this.state.nextInstallAt = nextInstallTime(this.now(), settings.installTime);
        await this.store.write(this.state);
        if (!canInstall()) return;
        const status = await this.webui.status();
        if (!canInstall()) return;
        if (status.candidate?.verification === "official" && compareWebUiVersions(status.candidate.version, status.current.version) === 1) {
          await this.webui.assertIdle();
          if (!canInstall()) return;
          const previousInstallAt = this.state.lastInstallAt;
          this.state.lastInstallAt = new Date(this.now()).toISOString(); await this.store.write(this.state);
          if (!canInstall()) { this.state.lastInstallAt = previousInstallAt; return; }
          await this.webui.startInstall(status.candidate.sha256, true);
        }
      }
    } catch (error) {
      if (!(error instanceof UpdateError && ["webui_action_busy", "core_action_busy"].includes(error.code))) {
        this.state.error = error instanceof UpdateError ? error.code : "webui_schedule_failed";
      }
    } finally {
      if (JSON.stringify(this.state) !== before) await this.store.write(this.state).catch(() => { this.unavailable = true; });
      this.running = false;
    }
  }
}
