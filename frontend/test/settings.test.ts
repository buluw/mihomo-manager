import assert from "node:assert/strict";
import test from "node:test";

import {
  restartCoreAndRefresh,
  recoverCoreAndRefresh,
} from "../src/features/system/settingsActions.ts";
import type { CoreServiceStatus } from "../src/api/systemClient.ts";
import type { HostNetworkInterface } from "../src/api/systemClient.ts";
import type { RuntimeLoadState } from "../src/api/configClient.ts";
import { observeTun, outboundInterfaces, recoverTunAndRefresh, tunStartupKey } from "../src/features/system/tunRecovery.ts";

test("restart waits for Controller recovery before refreshing", async () => {
  const calls: string[] = [];
  let probes = 0;
  const completed = await restartCoreAndRefresh(
    new AbortController().signal,
    async () => { calls.push("refresh"); },
    {
      restart: async () => { calls.push("restart"); },
      wait: async () => { calls.push("wait"); },
      probe: async () => {
        calls.push("probe");
        probes += 1;
        if (probes === 1) throw new Error("offline");
      },
    },
  );
  assert.equal(completed, true);
  assert.deepEqual(calls, ["restart", "wait", "probe", "wait", "probe", "refresh"]);
});

test("restart cancellation and recovery failure never refresh", async () => {
  const cancelled = new AbortController();
  let cancelledRefresh = false;
  assert.equal(await restartCoreAndRefresh(
    cancelled.signal,
    async () => { cancelledRefresh = true; },
    {
      restart: async () => {},
      wait: async () => { cancelled.abort(); },
      probe: async () => { throw new Error("unexpected probe"); },
    },
  ), false);
  assert.equal(cancelledRefresh, false);

  let failedRefresh = false;
  await assert.rejects(
    restartCoreAndRefresh(
      new AbortController().signal,
      async () => { failedRefresh = true; },
      {
        restart: async () => {},
        wait: async () => {},
        probe: async () => { throw new Error("offline"); },
      },
    ),
    /核心重启后 Controller 未恢复/,
  );
  assert.equal(failedRefresh, false);
});

const running: CoreServiceStatus = { state: "active", running: true, failure: null, exitStatus: 0, busy: false };
test("offline recovery waits for both real service state and Controller, while online restart stays native", async () => {
  const calls: string[] = [];
  let probes = 0;
  const deps = {
    connection: async () => (++probes >= 3 ? "online" as const : "unavailable" as const),
    service: async () => { calls.push("service"); return running; },
    control: async (action: "start" | "restart") => { calls.push(action); return running; },
    restart: async () => { calls.push("native"); }, wait: async () => {},
  };
  assert.equal(await recoverCoreAndRefresh("start", new AbortController().signal, async () => { calls.push("refresh"); }, deps), true);
  assert.deepEqual(calls, ["service", "start", "service", "service", "refresh"]);
  calls.length = 0;
  assert.equal(await recoverCoreAndRefresh("restart", new AbortController().signal, async () => { calls.push("refresh"); }, deps), true);
  assert.deepEqual(calls, ["native", "refresh"]);
});

test("authentication failure never triggers service control; accepted operation without recovery is not success", async () => {
  let mutations = 0, refreshed = false;
  const dependencies = {
    connection: async () => "authentication-failed" as const, service: async () => running,
    control: async () => { mutations++; return running; }, restart: async () => { mutations++; }, wait: async () => {},
  };
  await assert.rejects(recoverCoreAndRefresh("restart", new AbortController().signal, async () => {}, dependencies), /认证失败/);
  assert.equal(mutations, 0);
  await assert.rejects(recoverCoreAndRefresh("start", new AbortController().signal, async () => { refreshed = true; }, {
    ...dependencies, connection: async () => "unavailable" as const,
  }), /Controller 尚未恢复/);
  assert.equal(mutations, 1); assert.equal(refreshed, false);
  await assert.rejects(recoverCoreAndRefresh("start", new AbortController().signal, async () => {}, {
    ...dependencies, connection: async () => "unavailable" as const,
    service: async () => ({ ...running, running: false, state: "failed", failure: "exit-code", exitStatus: 1 }),
  }), /退出码 1/);
});

const network: HostNetworkInterface[] = [
  { name: "lo", kind: "loopback", state: "unknown", addresses: [] },
  { name: "eth0", kind: "other", state: "up", addresses: [] },
  { name: "eth1", kind: "other", state: "down", addresses: [] },
  { name: "renamed-core", kind: "tun", state: "unknown", addresses: [] },
];

test("outbound list excludes TUN, loopback and unknown types while preserving LXC exits", () => {
  assert.deepEqual(outboundInterfaces(network).map(item => item.name), ["eth0", "eth1"]);
  assert.deepEqual(outboundInterfaces([{ name: "custom-tun", state: "up", addresses: [] }]), []);
  assert.deepEqual(outboundInterfaces([{ name: "unclassified", kind: "unknown", state: "up", addresses: [] }]), []);
  assert.equal(network.length, 4);
  assert.equal(observeTun({ enabled: true, device: "renamed-core" }, network).state, "enabled");
  assert.equal(observeTun({ enabled: false, device: "renamed-core" }, network).state, "residual");
  assert.equal(observeTun({ enabled: false, device: "renamed-core" }, [{ name: "renamed-core", kind: "unknown", state: "unknown", addresses: [] }]).state, "residual");
  assert.equal(observeTun({ enabled: false, device: "renamed-core" }, network.slice(0, 3)).state, "clear");
  assert.deepEqual(observeTun({ enabled: false, device: "" }, network).remainingDevices, ["renamed-core"]);
  assert.equal(observeTun({ enabled: false, device: "" }, network.slice(0, 3)).state, "clear");
  assert.equal(observeTun({ enabled: false, device: "" }, [{ name: "renamed-core", kind: "unknown", state: "unknown", addresses: [] }]).state, "unconfirmed");
  assert.equal(observeTun({ enabled: false, device: "" }, [{ name: "renamed-core", state: "unknown", addresses: [] }]).state, "unconfirmed");
  assert.equal(observeTun({ enabled: false, device: "" }, [{ name: "eth0", kind: "other", state: "up", addresses: [] }]).state, "clear");
});

function tunFixture() {
  const generated = { schemaVersion: 1 as const, version: "runtime-1", sourceName: "fixture.yaml", sourceSha256: "source-1",
    settingsVersion: 7, contentSha256: "runtime-sha", generatedAt: "2026-09-22T00:00:00Z", path: "/fixture/runtime.yaml" };
  const state: RuntimeLoadState = { schemaVersion: 1, version: 8, lastAttempt: { id: "load-1", generated, status: "succeeded", startedAt: "", finishedAt: "" }, lastSuccessful: { generated, loadedAt: "" } };
  const applied = { state, content: "tun:\n  enable: false\n" };
  const calls: string[] = [];
  let restarted = false;
  const deps = {
    tun: async () => ({ enabled: false, device: "" }),
    interfaces: async () => restarted ? network.slice(0, 3) : network,
    applied: async () => structuredClone(applied),
    service: async () => running,
    connection: async () => "online" as const,
    control: async (action: "start" | "restart") => { calls.push(action); restarted = true; return running; },
    wait: async () => {},
  };
  return { applied, calls, deps };
}

test("TUN recovery uses one service restart even online and checks service, switch, target disappearance and startup version", async () => {
  const f = tunFixture(); let refreshed = 0, probes = 0;
  const result = await recoverTunAndRefresh(["renamed-core"], new AbortController().signal, async () => { refreshed++; }, {
    ...f.deps, service: async () => ++probes < 3 ? { ...running, running: false, state: "activating" } : running,
  });
  assert.equal(result?.state, "clear"); assert.equal(refreshed, 1);
  assert.deepEqual(f.calls, ["restart"]); assert.ok(probes >= 3);
});

test("TUN recovery refuses unsafe or changed startup state and never applies a draft", async () => {
  for (const scenario of ["enabled", "startup-enabled", "unknown", "changed", "unreadable", "busy"] as const) {
    const f = tunFixture(); let reads = 0;
    if (scenario === "startup-enabled") f.applied.content = "tun:\n  enable: true\n";
    if (scenario === "unknown") f.applied.state.lastAttempt!.status = "unknown";
    const deps = { ...f.deps,
      tun: async () => ({ enabled: scenario === "enabled", device: "renamed-core" }),
      applied: async () => { const value = await f.deps.applied(); if (scenario === "changed" && ++reads > 1) value.state.version++; return value; },
      interfaces: async () => { if (scenario === "unreadable") throw new Error("read unavailable"); return network; },
      service: async () => ({ ...running, busy: scenario === "busy" }),
    };
    await assert.rejects(recoverTunAndRefresh(["renamed-core"], new AbortController().signal, async () => { throw new Error("unexpected refresh"); }, deps));
    assert.deepEqual(f.calls, [], scenario);
  }
  assert.throws(() => tunStartupKey({ ...tunFixture().applied, content: "tun: {}" }), /未明确关闭/);
});

test("unknown interface types stay unconfirmed and never trigger Core restart", async () => {
  const f = tunFixture();
  const unknown = [{ name: "renamed-core", kind: "unknown" as const, state: "unknown" as const, addresses: [] }];
  assert.equal(observeTun({ enabled: false, device: "" }, unknown).state, "unconfirmed");
  await assert.rejects(recoverTunAndRefresh([], new AbortController().signal, async () => {
    throw new Error("unexpected refresh");
  }, { ...f.deps, interfaces: async () => unknown }), /网卡类型未知.*未执行恢复/);
  assert.deepEqual(f.calls, []);

  const explicit = observeTun({ enabled: false, device: "" }, network);
  assert.equal(explicit.state, "residual");
  assert.deepEqual(explicit.remainingDevices, ["renamed-core"]);
});

test("TUN recovery read failures, device residue and changed post-restart state are never successful or retried automatically", async () => {
  for (const scenario of ["residual", "enabled", "changed", "unreadable", "offline"] as const) {
    const f = tunFixture(); let reads = 0;
    await assert.rejects(recoverTunAndRefresh(["renamed-core"], new AbortController().signal, async () => { throw new Error("unexpected refresh"); }, {
      ...f.deps,
      tun: async () => ({ enabled: scenario === "enabled" && f.calls.length > 0, device: "renamed-core" }),
      interfaces: async () => { if (scenario === "unreadable" && f.calls.length) throw new Error("read unavailable"); return scenario === "residual" ? network : f.deps.interfaces(); },
      applied: async () => { const value = await f.deps.applied(); if (scenario === "changed" && ++reads > 2) value.state.version++; return value; },
      connection: async () => scenario === "offline" ? "unavailable" : "online",
    }));
    assert.deepEqual(f.calls, ["restart"], scenario);
  }
  const f = tunFixture(), abort = new AbortController(); abort.abort();
  assert.equal(await recoverTunAndRefresh(["renamed-core"], abort.signal, async () => {}, f.deps), null);
  assert.deepEqual(f.calls, []);
});
