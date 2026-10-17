import { SystemError } from "../src/api/systemClient.ts";
import { systemErrorMessage } from "../src/shared/systemMessages.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { operateCoreService, readCoreServiceStatus, readNetworkInterfaces } from "../src/api/systemClient.ts";
import { checkCoreUpdate, prepareCoreDownload, installCoreUpdate, rollbackCoreUpdate, uploadCore, readCoreUpdate } from "../src/api/systemClient.ts";
import { readProjectResources } from "../src/api/systemClient.ts";

test("network interfaces use the fixed read-only namespace and support cancellation", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const request = new AbortController();
  const listed = [{ name: "eth0", state: "unknown", addresses: [{ address: "192.0.2.2", family: "IPv4", cidr: "192.0.2.2/24" }] }];
  globalThis.fetch = async (input, options) => {
    assert.equal(input, "/api/system/interfaces");
    assert.equal(options?.method ?? "GET", "GET");
    assert.equal(new Headers(options?.headers).has("Authorization"), false);
    assert.ok(options?.signal);
    request.abort();
    assert.equal(options.signal.aborted, true);
    return new Response(JSON.stringify({ interfaces: listed }));
  };
  assert.deepEqual(await readNetworkInterfaces(request.signal), listed);
});

test("Core recovery uses bodyless fixed endpoints and does not expose host errors", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests: unknown[] = [];
  const state = { state: "inactive", running: false, failure: null, exitStatus: 0, busy: false };
  globalThis.fetch = async (input, options) => {
    requests.push([input, options?.method, options?.body]);
    assert.equal(new Headers(options?.headers).has("Authorization"), false);
    return new Response(JSON.stringify(state));
  };
  assert.deepEqual(await readCoreServiceStatus(), state);
  await operateCoreService("start"); await operateCoreService("restart");
  assert.deepEqual(requests, [["/api/system/core", "GET", undefined], ["/api/system/core/start", "POST", undefined], ["/api/system/core/restart", "POST", undefined]]);
  globalThis.fetch = async () => new Response("secret stderr", { status: 409 });
  await rejectsWithMessage(operateCoreService("start"), /正在执行操作/);
  globalThis.fetch = async () => new Response("secret stderr", { status: 503 });
  await rejectsWithMessage(operateCoreService("restart"), /核心服务操作失败/);
});

test("network failures and invalid responses expose safe errors with manual entry available", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("private host error", { status: 503 });
  await rejectsWithMessage(readNetworkInterfaces(), { message: "网卡列表读取失败 (503)，仍可手动填写网卡名称" });
  globalThis.fetch = async () => { throw new Error("private network error"); };
  await rejectsWithMessage(readNetworkInterfaces(), { message: "网卡列表暂不可用，仍可手动填写网卡名称" });
  globalThis.fetch = async () => new Response("{}");
  await rejectsWithMessage(readNetworkInterfaces(), { message: "网卡列表响应无效，仍可手动填写网卡名称" });
});

test("Core update keeps route/source explicit, uploads raw bytes and installs only the selected digest", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<[unknown, RequestInit | undefined]> = [];
  globalThis.fetch = async (input, options) => { calls.push([input, options]); return new Response("{}"); };
  const abort = new AbortController();
  await checkCoreUpdate({ mode: "external", proxy: "http://example.invalid:2080" }, abort.signal);
  await prepareCoreDownload({ mode: "core", source: "ghfast" });
  await installCoreUpdate("candidate-sha");
  await rollbackCoreUpdate("previous-sha");
  const file = new File(["core-bytes"], "mihomo");
  await uploadCore(file);
  await readCoreUpdate();
  assert.deepEqual(calls.map(([path]) => path), ["/api/system/core/update/check", "/api/system/core/update/download", "/api/system/core/update/install", "/api/system/core/update/rollback", "/api/system/core/update/upload", "/api/system/core/update"]);
  assert.deepEqual(JSON.parse(calls[0]![1]!.body as string), { mode: "external", proxy: "http://example.invalid:2080" });
  assert.deepEqual(JSON.parse(calls[1]![1]!.body as string), { mode: "core", source: "ghfast" });
  assert.deepEqual(JSON.parse(calls[2]![1]!.body as string), { sha256: "candidate-sha" });
  assert.deepEqual(JSON.parse(calls[3]![1]!.body as string), { sha256: "previous-sha" });
  assert.equal(calls[4]![1]!.body, file);
  assert.equal(new Headers(calls[4]![1]!.headers).get("Content-Type"), "application/octet-stream");
  abort.abort(); assert.equal(calls[0]![1]!.signal!.aborted, true);
});

test("Core update errors do not reveal downloaded server or proxy details", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "private credential url" }), { status: 400 });
  await rejectsWithMessage(checkCoreUpdate({ mode: "direct" }), error => error instanceof Error && !error.message.includes("private"));
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "checksum_mismatch" }), { status: 400 });
  await rejectsWithMessage(installCoreUpdate("sha"), /SHA256.*不一致/);
});

test("project resources use fixed GET with cancellation and retain unknown values", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const value = {
    sampledAt: "2026-09-18T00:00:00Z",
    containerMemory: { source: null, usedBytes: null, limitBytes: null, usagePercent: null },
    services: ["core", "configd", "logd", "sysinfo", "web"].map(id => ({ id, available: false, state: "unknown", running: false, failure: null, exitStatus: null, memoryBytes: null, memoryUnavailable: "service-unavailable" })),
    disks: ["program", "data", "logs"].map(id => ({ id, bytes: null })),
  };
  const request = new AbortController();
  globalThis.fetch = async (input, options) => {
    assert.equal(input, "/api/system/resources"); assert.equal(options?.method ?? "GET", "GET");
    assert.equal(options?.body, undefined); assert.ok(options?.signal);
    request.abort(); assert.equal(options.signal.aborted, true);
    return new Response(JSON.stringify(value));
  };
  assert.deepEqual(await readProjectResources(request.signal), value);
  const known = { ...value, containerMemory: { source: "lxcfs", usedBytes: 1024, limitBytes: 4096, usagePercent: 25 } };
  globalThis.fetch = async (_input, options) => {
    assert.equal(new Headers(options?.headers).get("Cache-Control"), "no-cache");
    return Response.json(known);
  };
  await readProjectResources(undefined, true);
  globalThis.fetch = async () => Response.json(known);
  assert.deepEqual((await readProjectResources()).containerMemory, known.containerMemory);
  globalThis.fetch = async () => Response.json({ ...known, containerMemory: { ...known.containerMemory, limitBytes: null } });
  await rejectsWithMessage(readProjectResources(), /响应无效/);
  globalThis.fetch = async () => Response.json({ ...known, containerMemory: { ...known.containerMemory, source: null } });
  await rejectsWithMessage(readProjectResources(), /响应无效/);
  globalThis.fetch = async () => new Response(JSON.stringify({ ...value, services: [] }));
  await rejectsWithMessage(readProjectResources(), /响应无效/);
  globalThis.fetch = async () => new Response(JSON.stringify({ ...value, disks: [{ id: "program", bytes: -1 }, ...value.disks.slice(1)] }));
  await rejectsWithMessage(readProjectResources(), /响应无效/);
  globalThis.fetch = async () => new Response("private host error", { status: 503 });
  await rejectsWithMessage(readProjectResources(), { message: "服务资源暂不可用，将自动重试" });
  globalThis.fetch = async () => { throw new Error("secret stderr"); };
  await rejectsWithMessage(readProjectResources(), { message: "服务资源读取失败，将自动重试" });
});

async function rejectsWithMessage(promise: Promise<unknown>, expected: RegExp | { message: string } | ((error: unknown) => boolean)) {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SystemError);
    assert.equal(typeof error.code, "string");
    assert.equal(Number.isInteger(error.status), true);
    if (typeof expected === "function") return expected(error);
    const message = systemErrorMessage(error);
    if (expected instanceof RegExp) assert.match(message, expected);
    else assert.equal(message, expected.message);
    return true;
  });
}

test("system requests preserve timeout budgets and caller cancellation", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const delays: number[] = [];
  t.mock.method(AbortSignal, "timeout", (delay: number) => { delays.push(delay); return new AbortController().signal; });
  const cancelled = new DOMException("fixture cancelled", "AbortError");
  for (const request of [
    (signal: AbortSignal) => readProjectResources(signal), (signal: AbortSignal) => readCoreServiceStatus(signal),
    (signal: AbortSignal) => operateCoreService("start", signal), (signal: AbortSignal) => readNetworkInterfaces(signal),
    (signal: AbortSignal) => readCoreUpdate(signal), (signal: AbortSignal) => uploadCore(new File(["fixture"], "core"), signal),
  ]) {
    const controller = new AbortController();
    globalThis.fetch = async () => { controller.abort(); throw cancelled; };
    await assert.rejects(request(controller.signal), error => error === cancelled);
  }
  assert.deepEqual(delays, [8000, 6000, 35000, 6000, 20000, 180000]);
});
