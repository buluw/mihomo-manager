import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { ConfigStore } from "../src/config/store.ts";
import { ConfigConflictError, ConfigValidationError } from "../src/config/errors.ts";
import { createConfigdServer } from "../src/server.ts";
import { ManagerSettingsService, ManagerSettingsConflictError, ManagerSettingsValidationError, generateRuntimeContent } from "../src/managerSettings/service.ts";
import { WriteQueue } from "../src/writeQueue.ts";
import { ProxyAddressReader, ProxyAddressSourceError, proxyAddressSource } from "../src/config/proxyAddresses.ts";
import { confirmedRuntimePath } from "../../deploy/debian/startup-config.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mihomo-manager-settings-"));
  const configPath = join(root, "source.yaml");
  await mkdir(join(root, "providers"));
  await writeFile(join(root, "providers", "remote.yaml"), "proxies: []\n");
  await writeFile(configPath, "# source comment\nipv6: true\ndns:\n  ipv6: true\n  nameserver: [1.1.1.1]\n  fallback: [9.9.9.9]\nproxy-providers:\n  remote: { type: file, path: ./providers/remote.yaml }\n");
  const writeQueue = new WriteQueue();
  const store = new ConfigStore({
    configPath, dataDir: root, mihomoBinary: process.execPath,
    validatorArgsPrefix: [join(dirname(fileURLToPath(import.meta.url)), "fixtures/validator.mjs"), "-"],
    validationTimeoutMs: 1000, maxContentBytes: 4096, writeQueue,
  });
  const options = { statePath: join(root, "manager-settings.json"), runtimeDir: join(root, "generated"), store, writeQueue };
  return { root, store, options, service: new ManagerSettingsService(options) };
}

test("mode-only updates preserve applied source and pending settings, persist startup only after Core success", async () => {
  const { service, store, options } = await fixture();
  const source = await store.read();
  const settings = await service.save({ expectedVersion: 0, overrides: { mode: "rule", ipv6: true } });
  const generated = await service.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: settings.version });
  const attempt = await service.beginLoad({ generatedVersion: generated.version, expectedVersion: 0 });
  let state = await service.finishLoad({ attemptId: attempt.lastAttempt!.id, expectedVersion: attempt.version, result: "succeeded" });
  const fullyLoadedAt = state.lastSuccessful!.loadedAt;
  const before = parse((await service.readApplied()).content!);
  // Pending source and unrelated saved overrides must never enter a mode-only runtime.
  await writeFile(store.options.configPath, "mode: global\nipv6: false\n");
  const pendingSettings = await service.save({ expectedVersion: settings.version, overrides: { mode: "rule", ipv6: false } });
  const prepared = await service.prepareMode({ mode: "direct", expectedSettingsVersion: pendingSettings.version, expectedVersion: state.version });
  assert.equal(prepared.state.lastAttempt?.kind, "mode");
  assert.equal(confirmedRuntimePath("bootstrap", options.runtimeDir), generated.path);
  assert.deepEqual(parse(await readFile(prepared.state.lastAttempt!.generated.path, "utf8")), { ...before, mode: "direct" });
  assert.equal(prepared.state.lastAttempt!.generated.sourceSha256, source.sha256);
  assert.notEqual(prepared.state.lastAttempt!.generated.settingsVersion, prepared.settings.version);
  state = await service.finishLoad({ attemptId: prepared.state.lastAttempt!.id, expectedVersion: prepared.state.version, result: "succeeded" });
  assert.equal(state.lastSuccessful!.loadedAt, fullyLoadedAt);
  assert.ok(state.lastSuccessful!.modeUpdatedAt);
  assert.equal(confirmedRuntimePath("bootstrap", options.runtimeDir), state.lastSuccessful!.generated.path);
  assert.deepEqual(parse((await service.readApplied()).content!), { ...before, mode: "direct" });
  assert.deepEqual((await service.read()).overrides, { mode: "direct", ipv6: false });
  const restored = new ManagerSettingsService(options);
  assert.deepEqual(await restored.readApplied(), await service.readApplied());
  for (const result of ["failed", "unknown"] as const) {
    const failed = await service.prepareMode({ mode: "global", expectedSettingsVersion: (await service.read()).version, expectedVersion: state.version });
    const next = await service.finishLoad({ attemptId: failed.state.lastAttempt!.id, expectedVersion: failed.state.version, result });
    assert.equal(next.lastSuccessful!.generated.version, state.lastSuccessful!.generated.version);
    assert.equal(confirmedRuntimePath("bootstrap", options.runtimeDir), state.lastSuccessful!.generated.path);
    state = next;
  }
  await assert.rejects(service.prepareMode({ mode: "rule", expectedSettingsVersion: 0, expectedVersion: state.version }), ManagerSettingsConflictError);
});

test("mode-only updates advance applied settings only when all persisted overrides match", async () => {
  const { service, store } = await fixture();
  const source = await store.read();
  const generated = await service.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: 0 });
  const loading = await service.beginLoad({ generatedVersion: generated.version, expectedVersion: 0 });
  const loaded = await service.finishLoad({ attemptId: loading.lastAttempt!.id, expectedVersion: loading.version, result: "succeeded" });
  const mode = await service.prepareMode({ mode: "direct", expectedSettingsVersion: 0, expectedVersion: loaded.version });
  assert.equal(mode.state.lastAttempt!.generated.settingsVersion, mode.settings.version);
  assert.throws(() => service.prepareMode({ mode: "invalid" as never, expectedSettingsVersion: 1, expectedVersion: mode.state.version }), ManagerSettingsValidationError);
  await assert.rejects(service.prepareMode({ mode: "rule", expectedSettingsVersion: 1, expectedVersion: mode.state.version }), ManagerSettingsConflictError);
  const finished = await service.finishLoad({ attemptId: mode.state.lastAttempt!.id, expectedVersion: mode.state.version, result: "succeeded" });
  assert.equal(finished.lastSuccessful!.loadedAt, loaded.lastSuccessful!.loadedAt);
  assert.equal(finished.lastSuccessful!.generated.mode, "direct");
});

test("mode recovery reuses pending identity after restart and rejects stale or different attempts", async () => {
  const { service, store, options } = await fixture();
  const source = await store.read();
  const generated = await service.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: 0 });
  const loading = await service.beginLoad({ generatedVersion: generated.version, expectedVersion: 0 });
  const loaded = await service.finishLoad({ attemptId: loading.lastAttempt!.id, expectedVersion: loading.version, result: "succeeded" });
  const prepared = await service.prepareMode({ mode: "direct", expectedSettingsVersion: 0, expectedVersion: loaded.version });
  // PATCH succeeded; its confirmation never reached configd. A new client/service must not infer success.
  const restarted = new ManagerSettingsService(options);
  const retry = { mode: "direct" as const, expectedSettingsVersion: prepared.settings.version, expectedVersion: prepared.state.version };
  assert.deepEqual(await restarted.prepareMode(retry), prepared);
  assert.equal(confirmedRuntimePath("bootstrap", options.runtimeDir), generated.path);
  const pendingSettings = await restarted.save({ expectedVersion: prepared.settings.version, overrides: { mode: "direct", ipv6: false } });
  await writeFile(store.options.configPath, "mode: global\nipv6: false\n");
  const resumed = await restarted.prepareMode({ ...retry, expectedSettingsVersion: pendingSettings.version });
  assert.deepEqual(resumed.state, prepared.state);
  assert.equal(parse(await readFile(resumed.state.lastAttempt!.generated.path, "utf8")).ipv6, true);
  await assert.rejects(restarted.prepareMode(retry), ManagerSettingsConflictError);
  await assert.rejects(restarted.prepareMode({ ...retry, mode: "global", expectedSettingsVersion: pendingSettings.version }), ManagerSettingsConflictError);
  const confirmed = await restarted.finishLoad({ attemptId: resumed.state.lastAttempt!.id, expectedVersion: resumed.state.version, result: "succeeded" });
  assert.equal(confirmedRuntimePath("bootstrap", options.runtimeDir), resumed.state.lastAttempt!.generated.path);
  const newer = await restarted.prepareMode({ mode: "rule", expectedSettingsVersion: pendingSettings.version, expectedVersion: confirmed.version });
  await assert.rejects(restarted.finishLoad({ attemptId: resumed.state.lastAttempt!.id, expectedVersion: resumed.state.version, result: "succeeded" }), ManagerSettingsConflictError);
  await assert.rejects(restarted.prepareMode({ ...retry, expectedSettingsVersion: newer.settings.version }), ManagerSettingsConflictError);
  assert.equal((await restarted.readLoadState()).lastAttempt!.id, newer.state.lastAttempt!.id);
});

test("direct delay settings persist independently without changing Core versions or generated YAML", async () => {
  const { service, store, options } = await fixture();
  const source = await store.read();
  const generated = await service.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: 0 });
  const loading = await service.beginLoad({ generatedVersion: generated.version, expectedVersion: 0 });
  const loaded = await service.finishLoad({ attemptId: loading.lastAttempt!.id, expectedVersion: loading.version, result: "succeeded" });
  let preferenceVersion = 0;
  for (const preset of ["huawei", "xiaomi", "vivo", "custom"] as const) {
    const saved = await service.saveDirectDelayTest({ expectedVersion: preferenceVersion++, preset, url: "https://example.com/generate_204" });
    assert.equal(saved.version, 0);
    assert.equal(saved.directDelayTest!.version, preferenceVersion);
    assert.equal(saved.directDelayTest!.preset, preset);
    assert.equal(saved.directDelayTest!.url, preset === "custom" ? "https://example.com/generate_204" : undefined);
    assert.deepEqual(await new ManagerSettingsService(options).read(), saved);
    assert.deepEqual(await service.readLoadState(), loaded);
    assert.equal((await store.read()).content, source.content);
    assert.equal((await service.readApplied()).content, source.content);
  }
  for (const url of ["", "ftp://example.com/204", "not a url", "https://bad host/204"]) {
    assert.throws(() => service.saveDirectDelayTest({ expectedVersion: preferenceVersion, preset: "custom", url }), ManagerSettingsValidationError);
  }
  await assert.rejects(service.saveDirectDelayTest({ expectedVersion: 0, preset: "xiaomi" }), ManagerSettingsConflictError);
  const savedCore = await service.save({ expectedVersion: 0, overrides: { ipv6: false } });
  assert.equal(savedCore.directDelayTest!.preset, "custom");
  const next = await service.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: savedCore.version });
  const content = await readFile(next.path, "utf8");
  assert.deepEqual(parse(content), { ...parse(source.content), ipv6: false });
  assert.equal(content.includes("example.com"), false);
});

test("proxy addresses follow successful generated files, not later disk edits or pending loads", async () => {
  const { root, store, service } = await fixture();
  const reader = new ProxyAddressReader({
    readSource: async () => proxyAddressSource(await service.readApplied()),
    dataDir: root, providerDir: join(root, "providers"), countryCachePath: join(root, "countries.json"),
    resolveAddress: async () => "8.8.8.8", lookupCountry: async () => ({ country: "Japan", countryCode: "JP" }),
  });
  await assert.rejects(reader.read(), ProxyAddressSourceError);
  const load = async (name: string, content: string) => {
    await writeFile(join(root, name), content);
    const source = await store.read(name);
    const generated = await service.generate({ sourceName: name, expectedSourceSha256: source.sha256, expectedSettingsVersion: 0 });
    const pending = await service.beginLoad({ generatedVersion: generated.version, expectedVersion: (await service.readLoadState()).version });
    await assert.rejects(reader.read(), ProxyAddressSourceError);
    return service.finishLoad({ attemptId: pending.lastAttempt!.id, expectedVersion: pending.version, result: "succeeded" });
  };
  await load("first.yaml", "proxies: [{ name: shared, server: first.example.test }]\n");
  const first = await reader.read();
  await writeFile(join(root, "first.yaml"), "proxies: [{ name: shared, server: changed.example.test }]\n");
  assert.equal((await reader.read()).inline.shared, "first.example.test");
  await load("second.yaml", "proxy-providers:\n  fixture: { type: inline, payload: [{ name: shared, server: second.example.test }] }\n");
  const second = await reader.read();
  assert.equal(second.source?.name, "second.yaml");
  assert.equal(second.providers.fixture?.shared, "second.example.test");
  assert.deepEqual(second.inline, {});
  await assert.rejects(reader.refreshCountries(first.source?.loadVersion), ProxyAddressSourceError);
  await assert.rejects(reader.recognizeCountry({ provider: "fixture", name: "shared" }, first.source?.loadVersion), ProxyAddressSourceError);
  assert.equal((await reader.refreshCountries(second.source?.loadVersion)).recognized, 1);
  assert.equal((await reader.recognizeCountry({ provider: "fixture", name: "shared" }, second.source?.loadVersion)).countryCode, "JP");
  const state = await service.readLoadState();
  assert.throws(() => proxyAddressSource({ state: { ...state, lastAttempt: { ...state.lastAttempt!, status: "unknown" } }, content: "" }), ProxyAddressSourceError);
});

test("manager settings persist, preserve explicit values, and reject stale or unknown fields", async () => {
  const { service, options } = await fixture();
  assert.deepEqual(await service.read(), { schemaVersion: 1, version: 0, overrides: {} });
  const saved = await service.save({ expectedVersion: 0, overrides: {
    ipv6: false, dns: { nameserver: [] }, sniffer: { sniff: { HTTP: { ports: [0] } } },
  } });
  assert.deepEqual(await new ManagerSettingsService(options).read(), saved);
  await assert.rejects(service.save({ expectedVersion: 0, overrides: {} }), ManagerSettingsConflictError);
  assert.throws(() => service.save({ expectedVersion: 1, overrides: { secret: "blocked" } as never }), ManagerSettingsValidationError);
  assert.throws(() => service.save({ expectedVersion: 1, overrides: { ipv6: null } as never }), ManagerSettingsValidationError);
  const follow = await service.save({ expectedVersion: 1, overrides: {} });
  assert.deepEqual(follow.overrides, {});
});

test("runtime generation preserves source bytes and unoverridden siblings, follows and switches sources", async () => {
  const { root, service, store, options } = await fixture();
  const before = await readFile(store.options.configPath);
  const source = await store.read();
  const saved = await service.save({ expectedVersion: 0, overrides: { ipv6: false, dns: { nameserver: [] } } });
  const first = await service.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: saved.version });
  const candidate = await service.readCandidate();
  assert.equal(candidate?.version, first.version);
  const parsed = parse(candidate!.content);
  assert.equal(parsed.ipv6, false);
  assert.deepEqual(parsed.dns, { ipv6: true, nameserver: [], fallback: ["9.9.9.9"] });
  assert.equal(parsed["proxy-providers"].remote.path, "./providers/remote.yaml");
  assert.match(candidate!.content, /# source comment/);
  assert.deepEqual(await readFile(store.options.configPath), before);
  assert.equal((await store.list()).some((entry) => entry.path === candidate!.path), false);
  await assert.rejects(store.read(`generated/${first.version}.yaml`));
  await assert.rejects(service.generate({ sourceName: source.name, expectedSourceSha256: "stale", expectedSettingsVersion: saved.version }), ConfigConflictError);
  await assert.rejects(service.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: 0 }), ManagerSettingsConflictError);
  await writeFile(join(root, "second.yaml"), "ipv6: true\nmode: direct\n");
  const second = await store.read("second.yaml");
  await service.generate({ sourceName: second.name, expectedSourceSha256: second.sha256, expectedSettingsVersion: saved.version });
  assert.deepEqual(parse((await service.readCandidate())!.content), { ipv6: false, mode: "direct", dns: { nameserver: [] } });
  const follow = await service.save({ expectedVersion: saved.version, overrides: {} });
  await service.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: follow.version });
  assert.equal((await service.readCandidate())!.content, source.content);
  assert.equal((await readdir(options.runtimeDir)).filter((name) => name.endsWith(".yaml")).length, 1);
  assert.deepEqual(await readFile(store.options.configPath), before);
});

test("DNS overrides persist and generate only the selected common fields", async () => {
  const { service, store } = await fixture();
  const source = await store.read();
  const saved = await service.save({ expectedVersion: 0, overrides: {
    dns: {
      enable: true,
      listen: "0.0.0.0:53",
      nameserver: ["https://dns.example/dns-query", "1.1.1.1"],
      "enhanced-mode": "fake-ip",
      "fake-ip-filter": ["+.lan", "localhost"],
      ipv6: false,
    },
  } });
  await service.generate({
    sourceName: source.name,
    expectedSourceSha256: source.sha256,
    expectedSettingsVersion: saved.version,
  });
  assert.deepEqual(parse((await service.readCandidate())!.content).dns, {
    enable: true,
    listen: "0.0.0.0:53",
    nameserver: ["https://dns.example/dns-query", "1.1.1.1"],
    "enhanced-mode": "fake-ip",
    "fake-ip-filter": ["+.lan", "localhost"],
    ipv6: false,
    fallback: ["9.9.9.9"],
  });
});

test("TUN overrides generate distinct automatic and manual outbound interface settings", async () => {
  const { service, store } = await fixture();
  const source = await store.read();
  const manual = await service.save({ expectedVersion: 0, overrides: {
    tun: {
      enable: true,
      stack: "mixed",
      "auto-route": true,
      "auto-detect-interface": false,
      "dns-hijack": ["any:53", "tcp://any:53"],
    },
    "interface-name": "eth0",
  } });
  await service.generate({
    sourceName: source.name,
    expectedSourceSha256: source.sha256,
    expectedSettingsVersion: manual.version,
  });
  const manualRuntime = parse((await service.readCandidate())!.content);
  assert.equal(manualRuntime["interface-name"], "eth0");
  assert.deepEqual(manualRuntime.tun, {
    enable: true,
    stack: "mixed",
    "auto-route": true,
    "auto-detect-interface": false,
    "dns-hijack": ["any:53", "tcp://any:53"],
  });

  const automatic = await service.save({ expectedVersion: manual.version, overrides: {
    tun: { "auto-detect-interface": true },
    "interface-name": "",
  } });
  await service.generate({
    sourceName: source.name,
    expectedSourceSha256: source.sha256,
    expectedSettingsVersion: automatic.version,
  });
  const automaticRuntime = parse((await service.readCandidate())!.content);
  assert.equal(automaticRuntime.tun["auto-detect-interface"], true);
  assert.equal(automaticRuntime["interface-name"], "");
});

test("sniffer protocol selection replaces sniff while preserving other source settings", async () => {
  const { service, store } = await fixture();
  await writeFile(store.options.configPath, [
    "sniffer:",
    "  enable: false",
    "  force-dns-mapping: true",
    "  sniff:",
    "    HTTP: { ports: [80], override-destination: true }",
    "    TLS: { ports: [443], override-destination: false }",
    "  skip-domain: [source.example]",
    "",
  ].join("\n"));
  const source = await store.read();
  const saved = await service.save({ expectedVersion: 0, overrides: {
    sniffer: {
      enable: true,
      sniff: {
        HTTP: { ports: [80, "8080-8880"] },
        QUIC: { ports: [443, 8443] },
      },
      "skip-domain": ["+.push.example", "Mijia Cloud"],
    },
  } });
  await service.generate({
    sourceName: source.name,
    expectedSourceSha256: source.sha256,
    expectedSettingsVersion: saved.version,
  });
  assert.deepEqual(parse((await service.readCandidate())!.content).sniffer, {
    enable: true,
    "force-dns-mapping": true,
    sniff: {
      HTTP: { ports: [80, "8080-8880"], "override-destination": true },
      QUIC: { ports: [443, 8443] },
    },
    "skip-domain": ["+.push.example", "Mijia Cloud"],
  });
  assert.throws(() => service.save({ expectedVersion: saved.version, overrides: {
    sniffer: { sniff: { HTTP: { ports: ["9000-8000"] } } },
  } }), ManagerSettingsValidationError);
  assert.throws(() => service.save({ expectedVersion: saved.version, overrides: {
    sniffer: { sniff: { QUIC: { ports: ["65536"] } } },
  } }), ManagerSettingsValidationError);
});

test("explicit empty sniff survives saving, reloading and generation until the override is removed", async () => {
  const { service, store, options } = await fixture();
  const sourceContent = "# untouched source\nsniffer:\n  enable: true\n  force-dns-mapping: true\n  sniff:\n    HTTP: { ports: [80], override-destination: true }\n    TLS: { ports: [443] }\n    QUIC: { ports: [443] }\n";
  await writeFile(store.options.configPath, sourceContent);
  const source = await store.read();
  const selected = { sniffer: { enable: false, sniff: {} } };
  const saved = await service.save({ expectedVersion: 0, overrides: selected });
  assert.deepEqual(saved.overrides, selected);
  assert.deepEqual(JSON.parse(await readFile(options.statePath, "utf8")).overrides, selected);
  const restarted = new ManagerSettingsService(options);
  assert.deepEqual(await restarted.read(), saved);
  const generated = await restarted.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: saved.version });
  assert.deepEqual(parse(await readFile(generated.path, "utf8")).sniffer, { enable: false, "force-dns-mapping": true, sniff: {} });
  assert.deepEqual(parse((await restarted.readCandidate())!.content).sniffer.sniff, {});
  assert.equal(await readFile(store.options.configPath, "utf8"), sourceContent);

  // Removing just this override restores the source protocols, while enable remains explicit.
  const restored = await restarted.save({ expectedVersion: saved.version, overrides: { sniffer: { enable: false } } });
  assert.equal(Object.hasOwn((await restarted.read()).overrides.sniffer!, "sniff"), false);
  await restarted.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: restored.version });
  assert.deepEqual(parse((await restarted.readCandidate())!.content).sniffer, { ...parse(sourceContent).sniffer, enable: false });
  assert.equal(await readFile(store.options.configPath, "utf8"), sourceContent);
});

test("explicit empty sniff is generated even when the source has no sniffer mapping", async () => {
  const { service, store, options } = await fixture();
  const source = await store.read();
  const saved = await service.save({ expectedVersion: 0, overrides: { sniffer: { sniff: {} } } });
  assert.deepEqual((await new ManagerSettingsService(options).read()).overrides, { sniffer: { sniff: {} } });
  const generated = await service.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: saved.version });
  assert.deepEqual(parse(await readFile(generated.path, "utf8")).sniffer, { sniff: {} });
  assert.equal((await store.read()).content, source.content);
});

test("invalid generated configuration retains the previous candidate and nested non-mappings are rejected", async () => {
  const { service, store, root } = await fixture();
  const source = await store.read();
  const before = await service.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: 0 });
  await writeFile(join(root, "invalid.yaml"), "INVALID: true\n");
  const invalid = await store.read("invalid.yaml");
  await assert.rejects(service.generate({ sourceName: invalid.name, expectedSourceSha256: invalid.sha256, expectedSettingsVersion: 0 }), ConfigValidationError);
  assert.equal((await service.readCandidate())!.version, before.version);
  assert.throws(() => generateRuntimeContent("dns: disabled\n", { dns: { ipv6: false } }), ConfigValidationError);
});

test("HTTP settings and candidate interfaces remain independent from Controller loading", async () => {
  const { service, store } = await fixture();
  const server = createConfigdServer({ store, managerSettings: service, maxBodyBytes: 4096 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const saved = await fetch(`${base}/manager-settings`, { method: "PUT", body: JSON.stringify({ expectedVersion: 0, overrides: { ipv6: false } }) });
    assert.equal(saved.status, 200);
    assert.equal((await (await fetch(`${base}/manager-settings`)).json()).overrides.ipv6, false);
    const preference = await fetch(`${base}/manager-settings/direct-delay-test`, { method: "PUT", body: JSON.stringify({ expectedVersion: 0, preset: "vivo" }) });
    assert.equal(preference.status, 200);
    assert.equal((await preference.json()).version, 1);
    const invalidPreference = await fetch(`${base}/manager-settings/direct-delay-test`, { method: "PUT", body: JSON.stringify({ expectedVersion: 1, preset: "custom", url: "" }) });
    assert.equal(invalidPreference.status, 400);
    const conflict = await fetch(`${base}/manager-settings`, { method: "PUT", body: JSON.stringify({ expectedVersion: 0, overrides: {} }) });
    assert.equal(conflict.status, 409);
    const source = await store.read();
    const generated = await fetch(`${base}/runtime-config/generate`, { method: "POST", body: JSON.stringify({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: 1 }) });
    assert.equal(generated.status, 200);
    const candidate = await (await fetch(`${base}/runtime-config/candidate`)).json();
    assert.equal(parse(candidate.content).ipv6, false);
    assert.equal(candidate.sourceSha256, source.sha256);
    assert.equal(Object.hasOwn(candidate, "loaded"), false);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("load records retain the confirmed file across new candidates, failures and restart", async () => {
  const { service, store, options } = await fixture();
  const source = await store.read();
  const first = await service.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: 0 });
  const started = await service.beginLoad({ generatedVersion: first.version, expectedVersion: 0 });
  assert.equal(started.lastSuccessful, null);
  assert.equal(started.lastAttempt?.status, "pending");
  const succeeded = await service.finishLoad({ attemptId: started.lastAttempt!.id, expectedVersion: started.version, result: "succeeded" });
  assert.equal(succeeded.lastSuccessful?.generated.version, first.version);
  const appliedContent = (await service.readApplied()).content;
  const settings = await service.save({ expectedVersion: 0, overrides: { ipv6: false } });
  const second = await service.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: settings.version });
  assert.equal((await service.readLoadState()).lastSuccessful?.generated.version, first.version);
  assert.equal(await readFile(first.path, "utf8"), appliedContent);
  const pending = await service.beginLoad({ generatedVersion: second.version, expectedVersion: succeeded.version });
  const failed = await service.finishLoad({ attemptId: pending.lastAttempt!.id, expectedVersion: pending.version, result: "failed" });
  assert.equal(failed.lastSuccessful?.generated.version, first.version);
  assert.equal((await new ManagerSettingsService(options).readApplied()).content, appliedContent);
  const retry = await service.beginLoad({ generatedVersion: second.version, expectedVersion: failed.version });
  const unknown = await service.finishLoad({ attemptId: retry.lastAttempt!.id, expectedVersion: retry.version, result: "unknown" });
  assert.equal(unknown.lastAttempt?.status, "unknown");
  assert.equal(unknown.lastSuccessful?.generated.version, first.version);
  assert.equal((await readdir(options.runtimeDir)).filter((name) => name.endsWith(".yaml")).length, 2);
});

test("late load results cannot overwrite newer records and stale inputs never begin loading", async () => {
  const { service, store } = await fixture();
  const source = await store.read();
  const generated = await service.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: 0 });
  const old = await service.beginLoad({ generatedVersion: generated.version, expectedVersion: 0 });
  const newer = await service.beginLoad({ generatedVersion: generated.version, expectedVersion: old.version });
  const committed = await service.finishLoad({ attemptId: newer.lastAttempt!.id, expectedVersion: newer.version, result: "succeeded" });
  await assert.rejects(service.finishLoad({ attemptId: old.lastAttempt!.id, expectedVersion: old.version, result: "succeeded" }), ManagerSettingsConflictError);
  assert.deepEqual(await service.readLoadState(), committed);
  await service.save({ expectedVersion: 0, overrides: { ipv6: false } });
  await assert.rejects(service.beginLoad({ generatedVersion: generated.version, expectedVersion: committed.version }), ManagerSettingsConflictError);
  const latest = await service.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: 1 });
  await writeFile(store.options.configPath, "mode: direct\n");
  await assert.rejects(service.beginLoad({ generatedVersion: latest.version, expectedVersion: committed.version }), ConfigConflictError);
  assert.deepEqual(await service.readLoadState(), committed);
});
