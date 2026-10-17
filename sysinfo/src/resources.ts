import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { parseCoreService, type CoreServiceState } from "./coreService.js";

const execute = promisify(execFile);
export const serviceIds = ["core", "configd", "logd", "sysinfo", "web"] as const;
export const diskGroups = [
  { id: "program", paths: ["/opt/mihomo-manager"], excludes: [] },
  { id: "data", paths: ["/var/lib/mihomo-manager", "/etc/mihomo-manager"], excludes: ["/var/lib/mihomo-manager/logs"] },
  { id: "logs", paths: ["/var/lib/mihomo-manager/logs"], excludes: [] },
] as const;
export interface ServiceResource extends CoreServiceState {
  id: typeof serviceIds[number];
  available: boolean;
  memoryBytes: number | null;
  memoryUnavailable: "service-unavailable" | "not-running" | "not-accounted" | "not-reported" | null;
}
export interface ProjectResources {
  sampledAt: string;
  containerMemory: ContainerMemory;
  services: ServiceResource[];
  disks: Array<{ id: typeof diskGroups[number]["id"]; bytes: number | null }>;
}

export interface ContainerMemory {
  source: "lxcfs" | null;
  usedBytes: number | null;
  limitBytes: number | null;
  usagePercent: number | null;
}

export function parseContainerMemory(mountinfo: string, meminfo: string): ContainerMemory {
  // LXCFS projects the enclosing container's allowance and available memory.
  // Unvirtualized /proc/meminfo could describe the PVE host; never use it.
  const virtualized = mountinfo.split("\n").some(line => {
    const [mount, filesystem] = line.split(" - ");
    return mount?.split(" ")[4] === "/proc/meminfo" && filesystem?.split(" ")[0] === "fuse.lxcfs";
  });
  if (!virtualized) return { source: null, usedBytes: null, limitBytes: null, usagePercent: null };
  const fields = new Map([...meminfo.matchAll(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB\s*$/gm)].map(match => [match[1], Number(match[2]) * 1024]));
  const total = fields.get("MemTotal");
  const available = fields.get("MemAvailable");
  const limitBytes = total !== undefined && Number.isSafeInteger(total) && total > 0 ? total : null;
  const usedBytes = limitBytes !== null && available !== undefined && Number.isSafeInteger(available) && available >= 0 && available <= limitBytes
    ? limitBytes - available : null;
  return { source: "lxcfs", usedBytes, limitBytes, usagePercent: usedBytes !== null && limitBytes !== null ? usedBytes / limitBytes * 100 : null };
}

const number = (value: string | undefined) => {
  if (!value || !/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
};

export function parseServiceResources(output: string): ServiceResource[] {
  const units = new Map(output.trim().split(/\n\s*\n/).map(block => {
    const fields = Object.fromEntries(block.split("\n").filter(line => line.includes("=")).map(line => {
      const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
    }));
    return [fields.Id, { block, fields }];
  }));
  return serviceIds.map(id => {
    const item = units.get(`mihomo-manager-${id}.service`);
    if (!item) return { id, available: false, state: "unknown", running: false, failure: null, exitStatus: null, memoryBytes: null, memoryUnavailable: "service-unavailable" };
    const { fields, block } = item;
    const state = parseCoreService(block);
    if (fields.Result === "oom-kill") state.failure = "oom-kill";
    if (fields.LoadState === "error" || fields.LoadState === "bad-setting") state.failure = "unit-invalid";
    const available = Boolean(fields.LoadState && fields.ActiveState);
    const unavailable = !available || fields.LoadState !== "loaded" ? "service-unavailable"
      : state.state === "inactive" || state.state === "failed" ? "not-running"
        : fields.MemoryAccounting !== "yes" ? "not-accounted"
          : number(fields.MemoryCurrent) === null ? "not-reported" : null;
    return { ...state, id, available, exitStatus: number(fields.ExecMainStatus),
      memoryBytes: unavailable ? null : number(fields.MemoryCurrent), memoryUnavailable: unavailable };
  });
}

export function parseDiskUsage(output: string, paths: readonly string[]): number | null {
  const sizes = new Map<string, number>();
  for (const line of output.trim().split("\n")) {
    const index = line.indexOf("\t");
    const size = number(line.slice(0, index));
    const path = line.slice(index + 1);
    if (index < 1 || size === null || !paths.includes(path) || sizes.has(path)) return null;
    sizes.set(path, size);
  }
  const total = [...sizes.values()].reduce((sum, value) => sum + value, 0);
  return sizes.size === paths.length && Number.isSafeInteger(total) ? total : null;
}

type Run = (file: string, args: string[]) => Promise<string>;
const run: Run = async (file, args) => {
  const { stdout } = await execute(file, args, { timeout: 5000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: "C" } });
  return stdout;
};
const defaultRead = (path: string) => readFile(path, "utf8");
type DiskSnapshot = ProjectResources["disks"];

async function readDisks(invoke: Run): Promise<DiskSnapshot> {
  return Promise.all(diskGroups.map(async group => {
    try {
      const output = await invoke("/usr/bin/du", ["--block-size=1", "--summarize", "--no-dereference",
        ...group.excludes.map(path => `--exclude=${path}`), "--", ...group.paths]);
      return { id: group.id, bytes: parseDiskUsage(output, group.paths) };
    } catch { return { id: group.id, bytes: null }; }
  }));
}

export function createProjectResourceReader(invoke: Run = run, read: (path: string) => Promise<string> = defaultRead, now = Date.now) {
  let diskCache: { expiresAt: number; value: DiskSnapshot } | null = null;
  let diskInFlight: Promise<DiskSnapshot> | null = null;
  let liveInFlight: Promise<Omit<ProjectResources, "disks">> | null = null;
  const disks = (force: boolean) => {
    if (diskInFlight) return diskInFlight;
    if (!force && diskCache && diskCache.expiresAt > now()) return Promise.resolve(diskCache.value);
    diskInFlight = readDisks(invoke).then(value => {
      diskCache = { value, expiresAt: now() + 30_000 };
      return value;
    }).finally(() => { diskInFlight = null; });
    return diskInFlight;
  };
  const live = () => {
    if (liveInFlight) return liveInFlight;
    liveInFlight = Promise.all([
      invoke("/usr/bin/systemctl", ["show", ...serviceIds.map(id => `mihomo-manager-${id}.service`),
        "--property=Id,LoadState,ActiveState,SubState,Result,ExecMainStatus,MemoryCurrent,MemoryAccounting"])
        .then(parseServiceResources, () => parseServiceResources("")),
      Promise.all([read("/proc/self/mountinfo"), read("/proc/meminfo")])
        .then(([mountinfo, meminfo]) => parseContainerMemory(mountinfo, meminfo), () => parseContainerMemory("", "")),
    ]).then(([services, containerMemory]) => ({ sampledAt: new Date(now()).toISOString(), services, containerMemory }))
      .finally(() => { liveInFlight = null; });
    return liveInFlight;
  };
  return async (refreshDisks = false): Promise<ProjectResources> => {
    const [snapshot, diskSnapshot] = await Promise.all([live(), disks(refreshDisks)]);
    return { ...snapshot, disks: diskSnapshot };
  };
}

export const readProjectResources = createProjectResourceReader();
