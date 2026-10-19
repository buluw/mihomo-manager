import assert from "node:assert/strict";
import test from "node:test";
import { ControllerDelayError, PROXY_DELAY_TIMEOUT_MS, readControllerProxyDelay } from "../src/api/controllerClient.ts";
import { ProxyDelayScheduler } from "../src/features/proxies/proxyDelayScheduler.ts";
import { proxyDelayIdentity, proxyNodeDelayRequest, runProxyCardDelayTests, uniqueProxyDelayTargets } from "../src/features/proxies/proxyLogic.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("delay scheduling caps all entry points at four and promotes shared queued manual work", async () => {
  let active = 0, peak = 0;
  const starts: string[] = [];
  const finishes = new Map<string, (value: number) => void>();
  const scheduler = new ProxyDelayScheduler();
  const run = (name: string) => async () => {
    starts.push(name); peak = Math.max(peak, ++active);
    try { return await new Promise<number>(resolve => finishes.set(name, resolve)); }
    finally { active--; }
  };
  const batch = Array.from({ length: 8 }, (_, i) => scheduler.request(String(i), "batch", run(String(i))));
  assert.equal(scheduler.request("0", "manual", run("duplicate")), batch[0]);
  assert.equal(scheduler.request("6", "manual", run("duplicate")), batch[6]);
  const manual = scheduler.request("manual", "manual", run("manual"));
  const results = Promise.all([...batch, manual]);
  await flush();
  assert.deepEqual(starts, ["0", "1", "2", "3"]);
  finishes.get("0")!(10); await flush();
  assert.equal(starts[4], "6");
  finishes.get("1")!(11); await flush();
  assert.equal(starts[5], "manual");
  for (const name of ["2", "3", "6", "manual"]) finishes.get(name)!(20);
  await flush();
  assert.deepEqual(starts.slice(6), ["4", "5", "7"]);
  for (const name of ["4", "5", "7"]) finishes.get(name)!(30);
  assert.equal((await results).length, 9);
  assert.equal(peak, 4);
  assert.equal(new Set(starts).size, starts.length);
});

test("queued delay work creates its transport deadline only when a slot starts", async () => {
  const scheduler = new ProxyDelayScheduler();
  const gates: Array<(value: number) => void> = [];
  const blockers = Array.from({ length: 4 }, (_, i) => scheduler.request("block-" + i, "batch", () => new Promise<number>(resolve => gates.push(resolve))));
  const originalFetch = globalThis.fetch, originalTimeout = AbortSignal.timeout;
  const deadlines: number[] = [];
  let now = 0;
  AbortSignal.timeout = ((duration: number) => { deadlines.push(now + duration); return new AbortController().signal; }) as typeof AbortSignal.timeout;
  globalThis.fetch = async input => {
    const url = new URL(String(input), "http://fixture");
    assert.equal(url.searchParams.get("timeout"), "5000");
    return Response.json({ delay: 37 });
  };
  try {
    const queued = scheduler.request("target", "batch", signal => readControllerProxyDelay(proxyNodeDelayRequest("target", "default", { type: "Vless" }), signal));
    await flush(); now = 20_000;
    assert.deepEqual(deadlines, []);
    gates[0](1);
    assert.equal(await queued, 37);
    assert.deepEqual(deadlines, [20_000 + PROXY_DELAY_TIMEOUT_MS]);
    assert.ok(PROXY_DELAY_TIMEOUT_MS > 5000);
    gates.slice(1).forEach(resolve => resolve(1));
    await Promise.all(blockers);
  } finally { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout; scheduler.dispose(); }
});

test("disposing delay scheduling aborts in-flight work and settles queued callers without starting them", async () => {
  let states: Record<string, string> = {};
  const scheduler = new ProxyDelayScheduler(value => { states = value; });
  const signals: AbortSignal[] = [];
  const starts: number[] = [];
  const tasks = Array.from({ length: 7 }, (_, i) => scheduler.request(String(i), "batch", signal => {
    starts.push(i); signals.push(signal);
    return new Promise<number>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }));
  const all = Promise.allSettled(tasks);
  await flush(); scheduler.dispose();
  assert.deepEqual(starts, [0, 1, 2, 3]);
  assert.ok(signals.every(signal => signal.aborted));
  assert.ok((await all).every(result => result.status === "rejected" && result.reason.name === "AbortError"));
  await flush(); assert.deepEqual(states, {});
  await assert.rejects(scheduler.request("later", "manual", async () => 1), { name: "AbortError" });
});

test("delay client classifies native proxy and Provider responses, cancellation and transport timeouts", async () => {
  const originalFetch = globalThis.fetch;
  const signal = new AbortController().signal;
  try {
    for (const provider of ["default", "fixture/provider"]) {
      const path = proxyNodeDelayRequest("test/node", provider, { type: "Vless" });
      for (const [status, body, kind] of [
        [200, { delay: 0 }, "unreachable"],
        [503, { message: "An error occurred in the delay test" }, "unreachable"],
        [504, { message: "Timeout" }, provider === "default" ? "api" : "timeout"],
        [504, { message: "sensitive-fixture-token" }, "api"],
        [504, { error: "Timeout" }, "api"],
        [502, { message: "Timeout" }, "api"],
        [503, { message: "sensitive-fixture-token" }, "api"],
        [401, { error: "sensitive-fixture-token" }, "api"],
        [200, { delay: "invalid" }, "api"],
        [200, { delay: -1 }, "api"],
        [200, { delay: null }, "api"],
      ] as const) {
        globalThis.fetch = async () => Response.json(body, { status });
        await assert.rejects(readControllerProxyDelay(path, signal), error => {
          assert.ok(error instanceof ControllerDelayError); assert.equal(error.kind, kind);
          assert.equal(error.message.includes("sensitive-fixture-token"), false); return true;
        });
      }
      globalThis.fetch = async () => Response.json({ delay: 42 });
      assert.equal(await readControllerProxyDelay(path, signal), 42);
      globalThis.fetch = async () => { throw new DOMException("fixture timeout", "TimeoutError"); };
      await assert.rejects(readControllerProxyDelay(path, signal), { kind: "timeout", message: "请求超时" });
      globalThis.fetch = async () => { throw new TypeError("sensitive-fixture-token"); };
      await assert.rejects(readControllerProxyDelay(path, signal), { kind: "api", message: "测速接口错误" });
      const cancelled = new AbortController(); cancelled.abort();
      await assert.rejects(readControllerProxyDelay(path, cancelled.signal), { name: "AbortError" });
    }
  } finally { globalThis.fetch = originalFetch; }
});
test("delay batches retain actual success, classified failure and cancellation totals", async () => {
  const result = await runProxyCardDelayTests(["ok", "timeout", "api", "unreachable", "cancel"].map(name => ({ name })), async ({ name }) => {
    if (name === "ok") return 42;
    if (name === "cancel") throw new DOMException("cancelled", "AbortError");
    throw new ControllerDelayError(name as "timeout" | "api" | "unreachable");
  });
  assert.deepEqual(result, { succeeded: 1, failed: 3, failures: { timeout: 1, api: 1, unreachable: 1 }, cancelled: 1 });
  assert.deepEqual(await runProxyCardDelayTests([], async () => 42), { succeeded: 0, failed: 0, failures: { timeout: 0, api: 0, unreachable: 0 }, cancelled: 0 });
});

test("group delay totals deduplicate aliases by Provider and resolved real node", () => {
  const data = { Group: { now: "Nested" }, Nested: { now: "A" }, A: { type: "Vless" }, B: { type: "Trojan" } };
  const providers = { A: "one", B: "two" };
  assert.deepEqual(uniqueProxyDelayTargets(["Group", "Nested", "A", "B"], data, providers), [{ name: "A" }, { name: "B" }]);
  assert.equal(proxyDelayIdentity("Group", data, providers), proxyDelayIdentity("A", data, providers));
  assert.notEqual(proxyDelayIdentity("A", data, providers), proxyDelayIdentity("A", data, { A: "other" }));
});
