import assert from "node:assert/strict";
import test from "node:test";
import { ControllerError, flushDnsCache, queryDns, updateGeoData } from "../src/api/controllerClient.ts";
import type { RuntimeLoadResult, RuntimeLoadState } from "../src/api/configClient.ts";
import { ConfigError } from "../src/api/configClient.ts";
import { runtimeApplyErrorMessage, runtimeApplyErrorWithBaseline, runtimeRecordMessage } from "../src/features/config-center/runtimeConfigActions.ts";
import { applyPersistentMode, PersistentModeError, readPersistentMode, type PersistentModeRetry } from "../src/features/overview/modeSetting.ts";
import { managerOverridesFromForm, managerSettingsDirty, managerSettingsForm, managerSettingsFormError } from "../src/features/system/managerSettingsForm.ts";
import { applyRuntimeConfig, RuntimeApplyError, runtimeMatchesManagerSettings, confirmedRuntimeSource } from "../src/shared/runtimeApplication.ts";
import { proxyConfigSelection } from "../src/features/proxies/proxyConfigSwitcherState.ts";

test("settings application checks the observed load record before generating or loading", async () => {
  const { calls, services, source } = fixture();
  await assert.rejects(applyRuntimeConfig(source, services, 3), (error: RuntimeApplyError) => error.phase === "prepare" && error.loaded === false);
  assert.deepEqual(calls, []);
  await applyRuntimeConfig(source, services, 4);
  assert.deepEqual(calls, ["generate", "begin", "load", "record:succeeded"]);
});

function fixture() {
  const calls: string[] = [];
  const generated = {
    schemaVersion: 1 as const, version: "candidate-v1", sourceName: "source.yaml", sourceSha256: "source-sha",
    settingsVersion: 3, contentSha256: "runtime-sha", generatedAt: "2026-09-08T00:00:00.000Z", path: "/controlled/generated/candidate-v1.yaml",
  };
  const pending: RuntimeLoadState = {
    schemaVersion: 1, version: 5, lastSuccessful: null,
    lastAttempt: { id: "attempt-1", generated, status: "pending", startedAt: generated.generatedAt, finishedAt: null },
  };
  const services = {
    settings: async () => ({ schemaVersion: 1 as const, version: 3, overrides: {} }),
    generate: async (name: string, sha: string, settingsVersion: number) => {
      calls.push("generate");
      assert.deepEqual([name, sha, settingsVersion], [generated.sourceName, generated.sourceSha256, 3]);
      return generated;
    },
    state: async (): Promise<RuntimeLoadState> => ({ schemaVersion: 1, version: 4, lastSuccessful: null, lastAttempt: null }),
    begin: async (id: string, version: number) => {
      calls.push("begin");
      assert.equal(id, generated.version);
      assert.equal(version, 4);
      return pending;
    },
    load: async (path?: string) => { calls.push("load"); assert.equal(path, generated.path); },
    finish: async (id: string, version: number, result: RuntimeLoadResult): Promise<RuntimeLoadState> => {
      calls.push(`record:${result}`);
      assert.equal(id, pending.lastAttempt!.id);
      assert.equal(version, pending.version);
      return { ...pending, version: 6, lastAttempt: { ...pending.lastAttempt!, status: result },
        lastSuccessful: result === "succeeded" ? { generated, loadedAt: generated.generatedAt } : null };
    },
  };
  return { calls, services, source: { name: generated.sourceName, sha256: generated.sourceSha256 } };
}

test("configuration application generates, loads the exact runtime file and records success in order", async () => {
  const { calls, services, source } = fixture();
  const result = await applyRuntimeConfig(source, services);
  assert.deepEqual(calls, ["generate", "begin", "load", "record:succeeded"]);
  assert.equal(result.lastSuccessful?.generated.sourceSha256, source.sha256);
});

test("missing File dependencies give actionable errors before any Controller load", async () => {
  const { calls, services, source } = fixture();
  services.generate = async () => { throw new ConfigError("unavailable", 422, "provider_files_unavailable", {
    issues: [{ category: "proxy", name: "legacy", status: "missing" }],
  }); };
  await assert.rejects(applyRuntimeConfig(source, services), (error: unknown) =>
    error instanceof RuntimeApplyError && error.phase === "prepare" && error.loaded === false && /legacy：缺少文件/.test(error.message));
  assert.deepEqual(calls, []);
});

test("proxy preview stays local, returning selects confirmed source first, and uncertain loads stay unknown", async () => {
  const { services, source } = fixture();
  const runtime = await applyRuntimeConfig(source, services);
  const files = [
    { name: "other.yaml", sha256: "other-sha", path: "/controlled/other.yaml", size: 1, updatedAt: "now" },
    { name: source.name, sha256: source.sha256, path: "/controlled/source.yaml", size: 1, updatedAt: "now" },
  ];
  const preview = proxyConfigSelection(files, runtime, "other.yaml");
  assert.equal(preview.target, "other.yaml");
  assert.equal(preview.loaded, source.name);
  assert.equal(preview.files[0]?.name, source.name);
  assert.equal(proxyConfigSelection(files, runtime, "").target, source.name);
  const attempt = { ...runtime.lastAttempt!, generated: { ...runtime.lastAttempt!.generated, version: "other", sourceName: "other.yaml", sourceSha256: "other-sha" } };
  const rejected = { ...runtime, lastAttempt: { ...attempt, status: "failed" as const } };
  assert.deepEqual(confirmedRuntimeSource(rejected), source);
  assert.equal(proxyConfigSelection(files, rejected, "").loaded, source.name);
  for (const status of ["pending", "unknown"] as const) {
    const uncertain = { ...runtime, lastAttempt: { ...attempt, status } };
    assert.equal(confirmedRuntimeSource(uncertain), null);
    assert.equal(proxyConfigSelection(files, uncertain, "").target, "");
    assert.equal(proxyConfigSelection(files, uncertain, "").loaded, null);
  }
  assert.equal(proxyConfigSelection(files.map(file => ({ ...file, sha256: "edited" })), runtime, "").loaded, null);
  const succeeded = { ...runtime, lastAttempt: { ...attempt, status: "succeeded" as const }, lastSuccessful: { generated: attempt.generated, loadedAt: "now" } };
  assert.equal(proxyConfigSelection(files, succeeded, "").target, "other.yaml");
});

test("generation or begin failure does not call Controller or claim application", async () => {
  for (const step of ["generate", "begin"] as const) {
    const { calls, services, source } = fixture();
    services[step] = async () => { throw new Error("fixture conflict"); };
    await assert.rejects(applyRuntimeConfig(source, services), (error: RuntimeApplyError) => error.phase === "prepare" && error.loaded === false);
    assert.equal(calls.includes("load"), false);
    assert.equal(calls.some((call) => call.startsWith("record:")), false);
  }
});

test("Controller rejection and lost response preserve distinct failed and unknown outcomes", async () => {
  for (const uncertain of [false, true]) {
    const { calls, services, source } = fixture();
    services.load = async () => { throw uncertain ? new Error("private transport details") : new ControllerError("private response", 400); };
    await assert.rejects(applyRuntimeConfig(source, services), (error: RuntimeApplyError) => {
      assert.equal(error.phase, "load");
      assert.equal(error.loaded, uncertain ? null : false);
      assert.equal(error.state?.lastAttempt?.status, uncertain ? "unknown" : "failed");
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(calls.at(-1), uncertain ? "record:unknown" : "record:failed");
  }
});

test("a successful Controller load with failed recording is never reported as not loaded", async () => {
  const { services, source } = fixture();
  services.finish = async () => { throw new Error("fixture record conflict"); };
  await assert.rejects(applyRuntimeConfig(source, services), (error: RuntimeApplyError) => {
    assert.equal(error.phase, "record");
    assert.equal(error.loaded, true);
    assert.match(error.message, /已加载.*共享记录未确认/);
    return true;
  });
  assert.match(runtimeRecordMessage(null), /未知/);
});

test("a newer successful shared record clears an older local apply error", () => {
  const pending = {
    schemaVersion: 1 as const,
    version: 5,
    lastSuccessful: null,
    lastAttempt: {
      id: "local-attempt",
      generated: {
        schemaVersion: 1 as const,
        version: "local-candidate",
        sourceName: "source.yaml",
        sourceSha256: "source-sha",
        settingsVersion: 3,
        contentSha256: "runtime-sha",
        generatedAt: "2026-09-08T00:00:00.000Z",
        path: "/controlled/generated/local-candidate.yaml",
      },
      status: "pending" as const,
      startedAt: "2026-09-08T00:00:00.000Z",
      finishedAt: null,
    },
  };
  const error = new RuntimeApplyError("共享记录未确认", "record", true, pending);
  assert.equal(runtimeApplyErrorMessage(error, pending), error.message);
  const newer = {
    ...pending,
    version: 6,
    lastAttempt: {
      ...pending.lastAttempt,
      id: "newer-attempt",
      status: "succeeded" as const,
      finishedAt: "2026-09-08T00:01:00.000Z",
    },
    lastSuccessful: {
      generated: pending.lastAttempt.generated,
      loadedAt: "2026-09-08T00:01:00.000Z",
    },
  };
  assert.equal(runtimeApplyErrorMessage(error, newer), null);

  const unavailableStateError = new RuntimeApplyError("共享记录读取失败", "prepare", false);
  assert.equal(runtimeApplyErrorMessage(unavailableStateError, null), unavailableStateError.message);
  assert.equal(runtimeApplyErrorMessage(unavailableStateError, newer), null);

  const cachedError = runtimeApplyErrorWithBaseline(unavailableStateError, pending);
  assert.equal(cachedError.state, pending);
  assert.equal(runtimeApplyErrorMessage(cachedError, pending), cachedError.message);
  assert.equal(runtimeApplyErrorMessage(cachedError, newer), null);
});

test("manager settings application requires the exact source SHA and settings version", () => {
  const { services, source } = fixture();
  const generated = services.begin("candidate-v1", 4).then((state) => ({
    ...state,
    lastSuccessful: { generated: state.lastAttempt!.generated, loadedAt: "2026-09-08T00:00:01.000Z" },
  }));
  return generated.then((state) => {
    assert.equal(runtimeMatchesManagerSettings(state, source, 3), true);
    assert.equal(runtimeMatchesManagerSettings(state, { ...source, sha256: "changed-source" }, 3), false);
    assert.equal(runtimeMatchesManagerSettings(state, source, 4), false);
  });
});

test("DNS manager form keeps follow and explicit empty overrides distinct", () => {
  const base = { dns: { fallback: ["source-only"] } } as never;
  const form = {
    ...managerSettingsForm({}),
    dnsEnable: "enabled" as const,
    dnsListenMode: "override" as const,
    dnsListen: "0.0.0.0:53",
    dnsNameserverMode: "override" as const,
    dnsNameservers: "https://dns.example/dns-query\n1.1.1.1",
    dnsEnhancedMode: "fake-ip" as const,
    dnsFakeIpFilterMode: "override" as const,
    dnsFakeIpFilter: "+.lan\nlocalhost",
    dnsIpv6: "disabled" as const,
  };
  const overrides = managerOverridesFromForm(base, form);
  assert.deepEqual(overrides, {
    dns: {
      fallback: ["source-only"],
      enable: true,
      listen: "0.0.0.0:53",
      nameserver: ["https://dns.example/dns-query", "1.1.1.1"],
      "enhanced-mode": "fake-ip",
      "fake-ip-filter": ["+.lan", "localhost"],
      ipv6: false,
    },
  });
  assert.equal(managerSettingsDirty(base, form, base), true);

  const followed = managerOverridesFromForm(overrides, {
    ...form,
    dnsEnable: "follow",
    dnsListenMode: "follow",
    dnsNameserverMode: "follow",
    dnsEnhancedMode: "follow",
    dnsFakeIpFilterMode: "follow",
    dnsIpv6: "follow",
  });
  assert.deepEqual(followed, { dns: { fallback: ["source-only"] } });
});

test("basic runtime settings share manager follow and override semantics", () => {
  const form = {
    ...managerSettingsForm({}),
    mode: "direct" as const,
    logLevel: "warning" as const,
    ipv6: "disabled" as const,
    tcpConcurrent: "enabled" as const,
    allowLan: "disabled" as const,
  };
  const overridden = managerOverridesFromForm({}, form);
  assert.deepEqual(overridden, {
    mode: "direct",
    "log-level": "warning",
    ipv6: false,
    "tcp-concurrent": true,
    "allow-lan": false,
  });
  assert.deepEqual(managerOverridesFromForm(overridden, {
    ...form,
    mode: "follow",
    logLevel: "follow",
    ipv6: "follow",
    tcpConcurrent: "follow",
    allowLan: "follow",
  }), {});
});

test("dashboard mode patches only mode and records the partial update after preparation", async () => {
  const { services, source } = fixture();
  const current = await applyRuntimeConfig(source, services);
  const calls: string[] = [];
  const prepared = { settings: { schemaVersion: 1 as const, version: 4, overrides: { mode: "global" as const } },
    state: { ...current, version: 7, lastAttempt: { ...current.lastAttempt!, id: "mode-1", kind: "mode" as const, status: "pending" as const } } };
  const result = await applyPersistentMode("global", {
    settings: async () => ({ schemaVersion: 1, version: 3, overrides: {} }),
    runtime: async () => current,
    prepare: async (mode, settingsVersion, loadVersion) => {
      assert.deepEqual([mode, settingsVersion, loadVersion], ["global", 3, current.version]);
      calls.push("prepare"); return prepared;
    },
    patch: async (mode) => { calls.push(`patch:${mode}`); },
    finish: async (id, version, status) => {
      assert.deepEqual([id, version, status], ["mode-1", 7, "succeeded"]);
      calls.push("record"); return { ...prepared.state, version: 8, lastAttempt: { ...prepared.state.lastAttempt, status } };
    },
  });
  assert.deepEqual(calls, ["prepare", "patch:global", "record"]);
  assert.equal(result.recorded.lastSuccessful?.generated.sourceName, source.name);
  assert.match(runtimeRecordMessage(result.recorded), /模式单项更新/);
});

test("DNS tools use separate Mihomo native query and cache paths", async () => {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  const calls: Array<{ url: string; method: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return String(input).includes("/dns/query")
      ? Response.json({ Status: 0, Answer: [{ name: "example.com.", type: 1, TTL: 60, data: "192.0.2.1" }] })
      : new Response(null, { status: 204 });
  };
  try {
    const result = await queryDns("example.com", "A");
    await flushDnsCache();
    await updateGeoData();
    assert.equal(result.Answer?.[0]?.data, "192.0.2.1");
    assert.deepEqual(calls, [
      { url: "/api/controller/dns/query?name=example.com&type=A", method: "GET" },
      { url: "/api/controller/cache/dns/flush", method: "POST" },
      { url: "/api/controller/configs/geo", method: "POST" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TUN settings keep automatic and manual outbound interface modes mutually exclusive", () => {
  const automaticForm = {
    ...managerSettingsForm({}),
    tunEnable: "enabled" as const,
    tunStack: "mixed" as const,
    tunAutoRoute: "enabled" as const,
    outboundMode: "auto" as const,
    tunDnsHijackMode: "override" as const,
    tunDnsHijack: "any:53\ntcp://any:53",
  };
  const automatic = managerOverridesFromForm({}, automaticForm);
  assert.deepEqual(automatic, {
    tun: {
      enable: true,
      stack: "mixed",
      "auto-route": true,
      "auto-detect-interface": true,
      "dns-hijack": ["any:53", "tcp://any:53"],
    },
    "interface-name": "",
  });

  const manual = managerOverridesFromForm(automatic, {
    ...automaticForm,
    outboundMode: "manual",
    interfaceName: "eth0",
  });
  assert.equal(manual.tun?.["auto-detect-interface"], false);
  assert.equal(manual["interface-name"], "eth0");

  const followed = managerOverridesFromForm(manual, {
    ...automaticForm,
    tunEnable: "follow",
    tunStack: "follow",
    tunAutoRoute: "follow",
    outboundMode: "follow",
    tunDnsHijackMode: "follow",
  });
  assert.deepEqual(followed, {});
});

test("sniffer settings replace the selected protocol set and validate port ranges", () => {
  const form = {
    ...managerSettingsForm({}),
    snifferEnable: "enabled" as const,
    snifferProtocolsMode: "override" as const,
    sniffProtocols: ["HTTP", "QUIC"] as Array<"HTTP" | "QUIC">,
    httpPorts: "80, 8080-8880",
    quicPorts: "443\n8443",
    snifferSkipDomainMode: "override" as const,
    snifferSkipDomain: "+.push.example\nMijia Cloud",
  };
  assert.deepEqual(managerOverridesFromForm({}, form), {
    sniffer: {
      enable: true,
      sniff: {
        HTTP: { ports: [80, "8080-8880"] },
        QUIC: { ports: [443, 8443] },
      },
      "skip-domain": ["+.push.example", "Mijia Cloud"],
    },
  });
  assert.equal(managerSettingsFormError({ ...form, httpPorts: "9000-8000" }), "HTTP 端口范围无效");
  assert.equal(managerSettingsFormError({ ...form, quicPorts: "" }), null);
  assert.deepEqual(managerOverridesFromForm({}, { ...form, quicPorts: "" }).sniffer?.sniff?.QUIC, { ports: [] });
  assert.equal(managerSettingsFormError({ ...form, sniffProtocols: [] }), "至少选择一种嗅探协议；停用嗅探请关闭总开关");
  assert.equal(managerSettingsFormError({ ...form, snifferEnable: "disabled", sniffProtocols: [] }), null);
  assert.deepEqual(managerOverridesFromForm({}, { ...form, snifferEnable: "disabled", sniffProtocols: [] }).sniffer?.sniff, {});
});

test("dashboard resolves modes from manager, confirmed runtime and verified defaults without source selection", async () => {
  const source = { name: "source.yaml", path: "/controlled/source.yaml", content: "mode: direct\n", sha256: "source-sha" };
  const identity = { version: "v1.19.29", sha256: "bd2a08ae155b7dffc12a1bdf610ff5f17c45058414a1d2c562e28eb9309abff6" };
  let overrides: import("../src/api/configClient.ts").ManagerOverrides = {};
  let content = source.content;
  const deps = {
    settings: async () => ({ schemaVersion: 1 as const, version: 3, overrides }),
    applied: async () => ({ state: { schemaVersion: 1 as const, version: 0, lastAttempt: null, lastSuccessful: null }, content }),
    core: async () => ({ phase: "idle" as const, busy: false, error: null, current: identity, previous: null, latest: null, candidate: null, source: null, route: null, bytes: 0, total: null }),
  };
  assert.deepEqual(await readPersistentMode(identity.version, undefined, deps), { mode: "direct", pending: true });
  overrides = { mode: "global" };
  assert.equal((await readPersistentMode(identity.version, undefined, deps)).mode, "global");
  overrides = {}; content = "dns: {}\n";
  assert.equal((await readPersistentMode(identity.version, undefined, deps)).mode, "rule");
  assert.equal((await readPersistentMode("v9.0.0", undefined, deps)).mode, null);
  assert.equal((await readPersistentMode(identity.version, undefined, { ...deps, core: async () => ({ ...await deps.core(), current: { ...identity, sha256: "custom" } }) })).mode, null);
  content = "mode: invalid\n";
  assert.equal((await readPersistentMode(identity.version, undefined, deps)).mode, null);
  content = "mode: [\n";
  await assert.rejects(readPersistentMode(identity.version, undefined, deps), /无法解析/);
});

test("mode failure and lost recording never report complete configuration success", async () => {
  for (const scenario of ["rejected", "unknown", "record", "prepare"] as const) {
    const { services, source } = fixture();
    const current = await applyRuntimeConfig(source, services);
    const prepared = { settings: { schemaVersion: 1 as const, version: 4, overrides: { ipv6: false, mode: "direct" as const } },
      state: { ...current, version: 7, lastAttempt: { ...current.lastAttempt!, kind: "mode" as const, status: "pending" as const } } };
    const calls: string[] = [];
    await assert.rejects(applyPersistentMode("direct", {
      settings: async () => ({ schemaVersion: 1, version: 3, overrides: { ipv6: false } }),
      runtime: async () => current,
      prepare: async () => { if (scenario === "prepare") throw new Error("conflict"); return prepared; },
      patch: async () => {
        calls.push("patch");
        if (scenario === "rejected") throw new ControllerError("rejected", 400);
        if (scenario === "unknown") throw new Error("lost response");
      },
      finish: async (_id, _version, status) => {
        calls.push(status);
        if (scenario === "record") throw new Error("lost record");
        return { ...prepared.state, lastAttempt: { ...prepared.state.lastAttempt, status } };
      },
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, scenario === "rejected" ? /拒绝切换/ : scenario === "unknown" ? /结果未知/ : scenario === "record" ? /Core 模式已更新.*未确认/ : /尚未调用 Core/);
      return true;
    });
    assert.deepEqual(calls, scenario === "prepare" ? [] : ["patch", scenario === "rejected" ? "failed" : scenario === "unknown" ? "unknown" : "succeeded"]);
  }
});

test("lost mode confirmation retries the original identity and refresh explicitly patches again", async () => {
  for (const refreshed of [false, true]) {
    const f = fixture();
    let current = await applyRuntimeConfig(f.source, f.services);
    const original = current.lastSuccessful!;
    let attempts = 0, patches = 0, confirmations = 0;
    const settings = { schemaVersion: 1 as const, version: 4, overrides: { mode: "direct" as const } };
    const services = {
      settings: async () => settings,
      runtime: async () => current,
      prepare: async () => {
        attempts++;
        if (current.lastAttempt?.kind !== "mode") current = { ...current, version: current.version + 1,
          lastAttempt: { ...current.lastAttempt!, id: "mode-original", kind: "mode", status: "pending", generated: { ...original.generated, version: "mode-v1", mode: "direct" } } };
        return { settings, state: current };
      },
      patch: async () => { patches++; },
      finish: async (id: string, version: number, result: RuntimeLoadResult) => {
        confirmations++;
        assert.deepEqual([id, version, result], ["mode-original", 7, "succeeded"]);
        if (confirmations === 1) throw new Error("confirmation request lost before configd");
        current = { ...current, version: 8, lastAttempt: { ...current.lastAttempt!, status: result }, lastSuccessful: { ...original, generated: current.lastAttempt!.generated } };
        return current;
      },
    };
    let retry: PersistentModeRetry | undefined;
    await assert.rejects(applyPersistentMode("direct", services), error => {
      assert.ok(error instanceof PersistentModeError);
      retry = error.retry;
      assert.deepEqual(retry, { mode: "direct", attemptId: "mode-original", version: 7 });
      return true;
    });
    assert.equal(current.lastAttempt!.status, "pending");
    assert.equal(current.lastSuccessful, original);
    const completed = await applyPersistentMode("direct", services, refreshed ? undefined : retry);
    assert.equal(completed.recorded.lastAttempt!.status, "succeeded");
    assert.equal(patches, refreshed ? 2 : 1);
    assert.equal(attempts, refreshed ? 2 : 1);
    // A lost response after configd committed is also confirmed by the same identity, without another write.
    await applyPersistentMode("direct", services, retry);
    assert.equal(confirmations, 2);
    current = { ...current, version: 9, lastAttempt: { ...current.lastAttempt!, id: "newer-mode", status: "pending", generated: { ...current.lastAttempt!.generated, mode: "global" } } };
    await assert.rejects(applyPersistentMode("direct", services, retry), /较新操作/);
    assert.equal(patches, refreshed ? 2 : 1);
    assert.equal(confirmations, 2);
  }
});

test("dashboard omitted mode uses verified rule default for both selected and applied mode", async () => {
  const f = fixture();
  const state = await applyRuntimeConfig(f.source, f.services);
  const identity = { version: "v1.19.29", sha256: "bd2a08ae155b7dffc12a1bdf610ff5f17c45058414a1d2c562e28eb9309abff6" };
  const services = {
    settings: f.services.settings,
    applied: async () => ({ state, content: "dns: {}\n" }),
    core: async () => ({ phase: "idle" as const, busy: false, error: null, current: identity, previous: null, latest: null, candidate: null, source: null, route: null, bytes: 0, total: null }),
  };
  assert.deepEqual(await readPersistentMode(identity.version, undefined, services), { mode: "rule", pending: false });
  assert.deepEqual(await readPersistentMode(identity.version, undefined, { ...services, settings: async () => ({ schemaVersion: 1, version: 4, overrides: { mode: "direct" } }) }), { mode: "direct", pending: true });
  assert.deepEqual(await readPersistentMode("unverified", undefined, services), { mode: null, pending: true });
});
