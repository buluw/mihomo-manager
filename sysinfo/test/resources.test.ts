import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseServiceResources, parseDiskUsage, parseContainerMemory, createProjectResourceReader } from "../src/resources.js";
import { createSysinfoServer } from "../src/server.js";

const unit = (id: string, fields = "") => `Id=mihomo-manager-${id}.service\nLoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nExecMainStatus=0\nMemoryAccounting=yes\nMemoryCurrent=4096\n${fields}`;

test("service snapshot distinguishes stopped, failed, missing and unreported memory without fabricated zero", () => {
  const values = parseServiceResources([
    unit("core"), unit("configd", "ActiveState=inactive\nSubState=dead\nMemoryCurrent=[not set]"),
    unit("logd", "ActiveState=failed\nSubState=failed\nResult=exit-code\nExecMainStatus=1"),
    unit("sysinfo", "MemoryAccounting=no\nMemoryCurrent=18446744073709551615"),
    unit("web", "MemoryCurrent=secret host detail"),
  ].join("\n\n"));
  assert.equal(values[0]?.running, true); assert.equal(values[0]?.memoryBytes, 4096);
  assert.equal(values[1]?.state, "inactive"); assert.equal(values[1]?.memoryBytes, null); assert.equal(values[1]?.memoryUnavailable, "not-running");
  assert.equal(values[2]?.failure, "exit-code"); assert.equal(values[2]?.exitStatus, 1); assert.equal(values[2]?.memoryBytes, null);
  assert.equal(values[3]?.memoryUnavailable, "not-accounted"); assert.equal(values[4]?.memoryUnavailable, "not-reported");
  const missing = parseServiceResources("Id=mihomo-manager-core.service\nLoadState=not-found\nActiveState=inactive");
  assert.equal(missing[0]?.failure, "not-found"); assert.equal(missing[0]?.memoryBytes, null);
  assert.equal(missing[1]?.available, false); assert.equal(missing[1]?.state, "unknown"); assert.equal(missing[1]?.exitStatus, null);
  assert.equal(parseServiceResources(unit("core", "Result=oom-kill\nActiveState=failed"))[0]?.failure, "oom-kill");
  assert.equal(parseServiceResources(unit("core", "LoadState=bad-setting"))[0]?.failure, "unit-invalid");
  assert.equal(parseServiceResources(unit("core", "MemoryCurrent=0"))[0]?.memoryBytes, 0);
  assert.equal(parseServiceResources(unit("core", "MemoryCurrent=18446744073709551615"))[0]?.memoryBytes, null);
  assert.equal(JSON.stringify(values).includes("secret"), false);
});

test("fixed resource reads preserve partial availability and never expose command errors", async () => {
  const calls: Array<[string, string[]]> = [];
  const snapshot = await createProjectResourceReader(async (file, args) => {
    calls.push([file, args]);
    if (file === "/usr/bin/systemctl") throw new Error("private host failure");
    if (args.includes("/opt/mihomo-manager")) return "8192\t/opt/mihomo-manager\n";
    if (args.includes("/etc/mihomo-manager")) return "4096\t/var/lib/mihomo-manager\n2048\t/etc/mihomo-manager\n";
    throw new Error("private permission denied");
  })();
  assert.equal(snapshot.services.length, 5); assert.ok(snapshot.services.every(service => !service.available && service.memoryBytes === null));
  assert.deepEqual(snapshot.disks, [{ id: "program", bytes: 8192 }, { id: "data", bytes: 6144 }, { id: "logs", bytes: null }]);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0]?.[1].slice(0, 6), ["show", "mihomo-manager-core.service", "mihomo-manager-configd.service", "mihomo-manager-logd.service", "mihomo-manager-sysinfo.service", "mihomo-manager-web.service"]);
  assert.ok(calls.find(([, args]) => args.includes("/etc/mihomo-manager"))?.[1].includes("--exclude=/var/lib/mihomo-manager/logs"));
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
  assert.equal(parseDiskUsage("0\t/missing", ["/expected"]), null);
  assert.equal(parseDiskUsage("4096\t/one", ["/one", "/two"]), null);
  assert.equal(parseDiskUsage("secret\t/one", ["/one"]), null);
});

test("allocated directory sizes exclude separately counted logs and do not follow symlink targets", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mihomo-resource-size-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, "data"), logs = join(data, "logs");
  await mkdir(logs, { recursive: true });
  await writeFile(join(data, "settings.json"), "{}");
  await writeFile(join(logs, "log"), Buffer.alloc(32768, 1));
  const outside = join(directory, "external-file");
  await writeFile(outside, Buffer.alloc(1024 * 1024, 1));
  await symlink(outside, join(data, "linked-file"));
  const execute = promisify(execFile);
  const read = async (paths: string[], excludes: string[] = []) => {
    const { stdout } = await execute("/usr/bin/du", ["--block-size=1", "--summarize", "--no-dereference", ...excludes.map(path => `--exclude=${path}`), "--", ...paths]);
    const value = parseDiskUsage(stdout, paths); assert.notEqual(value, null); return value!;
  };
  const all = await read([data]), dataOnly = await read([data], [logs]), logOnly = await read([logs]);
  assert.equal(dataOnly + logOnly, all);
  assert.ok(logOnly >= 32768);
  assert.ok(all < 1024 * 1024);
});

test("HTTP resources is read-only and fixed, returns safe failures, and recovers", async t => {
  let fail = true; let reads = 0;
  const snapshot = await createProjectResourceReader(async () => { throw new Error("unavailable"); })();
  const forced: boolean[] = [];
  const server = createSysinfoServer(async () => [], undefined, undefined, async refresh => { forced.push(Boolean(refresh)); reads++; if (fail) throw new Error("private"); return snapshot; });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const failure = await fetch(base + "/resources");
  assert.equal(failure.status, 503); assert.deepEqual(await failure.json(), { error: "resources_unavailable" });
  assert.equal((await fetch(base + "/interfaces")).status, 200);
  const forbidden = await fetch(base + "/resources", { method: "POST" });
  assert.equal(forbidden.status, 405); assert.equal(forbidden.headers.get("allow"), "GET");
  assert.equal((await fetch(base + "/resources?service=ssh&path=/etc")).status, 404); assert.equal(reads, 1);
  fail = false;
  const recovered = await fetch(base + "/resources");
  assert.equal(recovered.status, 200); assert.equal(recovered.headers.get("cache-control"), "no-store");
  assert.deepEqual(await recovered.json(), snapshot);
  await fetch(base + "/resources", { headers: { "Cache-Control": "no-cache" } });
  assert.deepEqual(forced, [false, false, true]);
});

test("container memory uses LXCFS allowance and available memory, never host or service totals", () => {
  const mount = "814 801 0:45 /proc/meminfo /proc/meminfo rw - fuse.lxcfs lxcfs rw";
  const info = "MemTotal: 4194304 kB\nMemFree: 1000000 kB\nMemAvailable: 3145728 kB\nCached: 2000000 kB\n";
  assert.deepEqual(parseContainerMemory(mount, info), { source: "lxcfs", usedBytes: 1073741824, limitBytes: 4294967296, usagePercent: 25 });
  assert.deepEqual(parseContainerMemory("800 799 0:3 / /proc rw - proc proc rw", info), { source: null, usedBytes: null, limitBytes: null, usagePercent: null });
  assert.deepEqual(parseContainerMemory(mount, "MemAvailable: 100 kB\n"), { source: "lxcfs", usedBytes: null, limitBytes: null, usagePercent: null });
  assert.equal(parseContainerMemory(mount, "MemTotal: 1024 kB\nMemAvailable: 2048 kB\n").usedBytes, null);
  assert.equal(parseContainerMemory(mount, "MemTotal: 1024 kB\n").usagePercent, null);
});

test("container read failures remain partial and read only fixed process files", async () => {
  const paths: string[] = [];
  const snapshot = await createProjectResourceReader(async () => { throw new Error("service unavailable"); }, async path => {
    paths.push(path);
    throw new Error("private failure");
  })();
  assert.deepEqual(paths, ["/proc/self/mountinfo", "/proc/meminfo"]);
  assert.deepEqual(snapshot.containerMemory, { source: null, usedBytes: null, limitBytes: null, usagePercent: null });
  assert.equal(snapshot.services.length, 5);
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
});

test("resource calls share in-flight statistics, cache only disk for 30 seconds, and manual refresh retries unavailable disk", async () => {
  let now = 0, serviceCalls = 0, diskCalls = 0, fileCalls = 0, unavailable = false;
  const reader = createProjectResourceReader(async file => {
    await new Promise(resolve => setTimeout(resolve, 5));
    if (file === "/usr/bin/systemctl") { serviceCalls++; return unit("core"); }
    diskCalls++;
    if (unavailable) throw new Error("unavailable");
    return "4096\t/opt/mihomo-manager\n";
  }, async () => { fileCalls++; return ""; }, () => now);
  await Promise.all(Array.from({ length: 10 }, () => reader()));
  assert.deepEqual([serviceCalls, diskCalls, fileCalls], [1, 3, 2]);
  await reader();
  assert.deepEqual([serviceCalls, diskCalls, fileCalls], [2, 3, 4]);
  now = 30_000; unavailable = true;
  assert.ok((await reader()).disks.every(item => item.bytes === null));
  assert.equal(diskCalls, 6);
  unavailable = false;
  await reader(); assert.equal(diskCalls, 6);
  const fresh = await reader(true);
  assert.equal(fresh.disks[0]?.bytes, 4096);
  assert.equal(diskCalls, 9);
});
