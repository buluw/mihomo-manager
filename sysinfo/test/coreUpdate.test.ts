import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { CoreUpdates, assetName, downloadUrl, officialRelease, unpackCore } from "../src/coreUpdate.js";
import { proxyFor, sources, transfer, receiveFile, validateUrl } from "../src/updates/transport.js";
import { createSysinfoServer } from "../src/server.js";

const binary = Buffer.alloc(128);
binary.write("\x7fELF"); binary[4] = 2; binary[5] = 1; binary.writeUInt16LE(62, 18);
const archive = gzipSync(binary);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const version = "v1.19.31";
const url = `https://github.com/MetaCubeX/mihomo/releases/download/${version}/${assetName(version, "x64")}`;
const release = { tag_name: version, assets: [{ name: assetName(version, "x64"), browser_download_url: url, digest: "sha256:" + sha(archive), size: archive.length }] };

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(finish => { resolve = finish; });
  return { promise, resolve };
};

for (const outcome of ["success", "failure"] as const) {
  test("concurrent uploads preserve the owner through " + outcome, { timeout: 5000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), "core-upload-owner-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const guardReady = deferred(), guard = deferred(), received = deferred(), body = deferred();
    const secondSettled = deferred(), validating = deferred(), validation = deferred(), cleaning = deferred(), cleanup = deferred();
    let guardCalls = 0, entered = 0, streamFailed = false, cleanupPaused = false;
    const operations: string[] = [];
    const manager = new CoreUpdates(directory, join(directory, "installed"), {
      transfer: async () => { throw new Error("unexpected transfer"); }, proxyFor: async () => null,
      probeBinary: async path => { validating.resolve(); await validation.promise; return { version, sha256: sha(await readFile(path)) }; },
      controlCoreUpdate: async action => { operations.push(action); return "ok"; },
    });
    const candidateOwner = manager as unknown as { clearCandidate(): Promise<void> };
    const clear = candidateOwner.clearCandidate.bind(manager);
    t.mock.method(candidateOwner, "clearCandidate", async () => {
      if (streamFailed && !cleanupPaused) { cleanupPaused = true; cleaning.resolve(); await cleanup.promise; }
      await clear();
    });
    const blocked = async () => { if (++guardCalls === 2) guardReady.resolve(); await guard.promise; return false; };
    const upload = (second = false, immediate = false) => {
      const result = { status: 0, body: {} as { error?: string } };
      const request = { url: "/core/update/upload", method: "POST", headers: { "content-length": String(binary.length) }, resume() {},
        iterator: () => (async function* () {
          entered++; if (second) secondSettled.resolve();
          yield binary.subarray(0, 64);
          received.resolve();
          if (!immediate) await body.promise;
          if (!immediate && outcome === "failure") { streamFailed = true; throw new Error("fixture upload failure"); }
          yield binary.subarray(64);
        })(),
      } as unknown as IncomingMessage;
      const response = { writeHead(status: number) { result.status = status; return this; },
        end(value: string) { result.body = JSON.parse(value); if (second) secondSettled.resolve(); },
      } as unknown as ServerResponse;
      return { result, pending: manager.handle(request, response, immediate ? false : blocked) };
    };
    const settled = async () => {
      for (let i = 0; i < 200 && manager.busy; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(manager.busy, false);
      return manager.status();
    };
    const first = upload(), second = upload(true);
    try {
      await guardReady.promise; guard.resolve(); await received.promise; await secondSettled.promise;
      assert.equal(entered, 1);
      assert.equal(second.result.status, 409); assert.equal(second.result.body.error, "core_action_busy");
      assert.equal(manager.busy, true);
      const state = await manager.status();
      assert.equal(state.source, "upload"); assert.equal(state.route, null); assert.equal(state.bytes, 64); assert.equal(state.total, binary.length);
      assert.deepEqual(await readFile(join(directory, "download")), binary.subarray(0, 64));
      body.resolve();
      if (outcome === "success") await validating.promise;
      else await cleaning.promise;
      assert.equal(manager.busy, true);
      const rejected = upload(false, true); await rejected.pending; assert.equal(rejected.result.status, 409); assert.equal(entered, 1);
      if (outcome === "success") assert.deepEqual(await readFile(join(directory, "candidate")), binary);
      validation.resolve(); cleanup.resolve(); await first.pending; await second.pending;
      assert.equal(first.result.status, outcome === "success" ? 202 : 400);
      const completed = await settled();
      assert.equal(completed.phase, outcome === "success" ? "ready" : "failed");
      if (outcome === "failure") { assert.equal(completed.candidate, null); await assert.rejects(readFile(join(directory, "download")), { code: "ENOENT" }); }
      const next = upload(false, true); await next.pending; assert.equal(next.result.status, 202);
      assert.equal((await settled()).candidate?.sha256, sha(binary)); assert.deepEqual(operations, []);
    } finally {
      guard.resolve(); body.resolve(); validation.resolve(); cleanup.resolve();
      await Promise.allSettled([first.pending, second.pending]); await settled();
    }
  });
}

test("official assets require publisher digest; mirrors apply to files only; URL rejection", () => {
  const value = officialRelease(release, "x64");
  assert.equal(value.releaseNotes, null);
  const releaseNotes = "## Changes\nFixed routing. <script>example</script>";
  assert.equal(officialRelease({ ...release, body: releaseNotes }, "x64").releaseNotes, releaseNotes);
  assert.equal(officialRelease({ ...release, body: "  " }, "x64").releaseNotes, null);
  assert.equal(officialRelease({ ...release, body: {} }, "x64").releaseNotes, null);
  assert.deepEqual(Object.keys(sources).map(source => downloadUrl(source as keyof typeof sources, value)),
    [url, "https://ghfast.top/" + url, "https://gh-proxy.com/" + url, "https://ghproxy.net/" + url]);
  assert.throws(() => officialRelease({ ...release, assets: [{ ...release.assets[0], digest: null }] }, "x64"), /official_checksum_unavailable/);
  assert.throws(() => officialRelease({ ...release, prerelease: true }), /invalid_release/);
  assert.throws(() => validateUrl("file:///etc/passwd"), /invalid_url/);
  assert.throws(() => validateUrl("https://example.com\noutput=x"), /invalid_url/);
});

test("streamed raw/gzip ELF validation keeps architecture and output limits and removes failed output", async t => {
  const directory = await mkdtemp(join(tmpdir(), "core-stream-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input"), output = join(directory, "output");
  for (const bytes of [archive, binary]) {
    await writeFile(input, bytes);
    await unpackCore(input, output, "x64");
    assert.deepEqual(await readFile(output), binary);
    await assert.rejects(unpackCore(input, output, "arm64"), /invalid_binary/);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
  for (const bytes of [Buffer.from("#!/bin/sh\necho test"), Buffer.from([31, 139, 0]), archive.subarray(0, archive.length - 4)]) {
    await writeFile(input, bytes);
    await assert.rejects(unpackCore(input, output), /invalid_binary/);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
  await writeFile(input, archive);
  await assert.rejects(unpackCore(input, output, "x64", 100), /invalid_binary/);
  await assert.rejects(readFile(output), { code: "ENOENT" });
  const progress: number[] = [];
  assert.equal(await receiveFile(Readable.from([binary.subarray(0, 50), binary.subarray(50)]), input, bytes => progress.push(bytes)), sha(binary));
  assert.deepEqual(progress, [50, 128]);
  await assert.rejects(receiveFile(Readable.from([binary]), input, () => {}, 100), /file_too_large/);
  assert.equal((await readFile(input)).length, 0);
});

test("status reuses unchanged and concurrent probes, refreshes changed or removed files, and rollback never trusts the cache", async t => {
  const directory = await mkdtemp(join(tmpdir(), "core-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = join(directory, "installed");
  await writeFile(installed, "first");
  await writeFile(installed + ".previous", "previous");
  let probes = 0;
  const operations: string[] = [];
  const manager = new CoreUpdates(directory, installed, {
    transfer, proxyFor,
    probeBinary: async path => { probes++; await new Promise(resolve => setTimeout(resolve, 5)); return { version, sha256: sha(await readFile(path)) }; },
    controlCoreUpdate: async action => { operations.push(action); return "ok"; },
  });
  const initial = await Promise.all([manager.status(), manager.status(), manager.status()]);
  assert.equal(probes, 2);
  assert.equal(initial[0]?.current?.sha256, sha(Buffer.from("first")));
  await manager.status(); assert.equal(probes, 2);
  await writeFile(installed, "changed");
  assert.equal((await manager.status()).current?.sha256, sha(Buffer.from("changed")));
  assert.equal(probes, 3);
  await utimes(installed, new Date(), new Date(Date.now() + 2000));
  await manager.status(); assert.equal(probes, 4);
  await rm(installed);
  assert.equal((await manager.status()).current, null);
  const server = createSysinfoServer(async () => [], undefined, manager);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/core/update/rollback`, { method: "POST", body: JSON.stringify({ sha256: sha(Buffer.from("previous")) }) });
  assert.equal(response.status, 202);
  while (manager.busy) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(probes, 5); assert.deepEqual(operations, ["rollback"]);
  await manager.status(); assert.equal(probes, 6);
});

test("explicit direct, current Core and external proxy routing never changes Core settings", async () => {
  let reads = 0;
  const configs = async () => { reads++; return { "mixed-port": 7890, "mode": "direct" }; };
  assert.equal(await proxyFor({ mode: "direct" }, configs), null);
  assert.equal(await proxyFor({ mode: "external", proxy: "socks5h://127.0.0.1:2080" }, configs), "socks5h://127.0.0.1:2080");
  assert.equal(reads, 0);
  assert.equal(await proxyFor({ mode: "core" }, configs), "http://127.0.0.1:7890");
  assert.equal(reads, 1);
  await assert.rejects(proxyFor({ mode: "core" }, async () => ({ "mixed-port": 0 })), /core_proxy_unavailable/);
});

test("curl uses the selected HTTP proxy even with NO_PROXY, and direct downloads bypass it", async t => {
  const previous = process.env.NO_PROXY;
  process.env.NO_PROXY = "*";
  t.after(() => { if (previous === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = previous; });
  const directory = await mkdtemp(join(tmpdir(), "core-transfer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const received: string[] = [];
  const server = createServer((request, response) => { received.push(request.url!); response.end(archive); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const proxy = `http://127.0.0.1:${address.port}`;
  assert.deepEqual(await transfer("http://publisher.invalid/version", proxy), archive);
  await transfer("http://publisher.invalid/core.gz", proxy, join(directory, "core.gz"));
  assert.deepEqual(await readFile(join(directory, "core.gz")), archive);
  assert.deepEqual(await transfer(proxy + "/direct", null), archive);
  assert.deepEqual(received, ["http://publisher.invalid/version", "http://publisher.invalid/core.gz", "/direct"]);
});

test("HTTP check, all sources, custom and upload prepare safely; rejection and stale install do not operate Core", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mihomo-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const operations: string[] = [];
  const requests: Array<[string, string | null]> = [];
  let corrupt = false;
  let checkFails = false;
  const manager = new CoreUpdates(directory, join(directory, "installed"), {
    proxyFor: async route => proxyFor(route, async () => ({ "mixed-port": 7890 })),
    transfer: async (input, proxy, output, progress) => {
      requests.push([input, proxy]);
      if (!output) { if (checkFails) throw new Error("fixture_check_failed"); return Buffer.from(JSON.stringify(release)); }
      await writeFile(output, corrupt ? Buffer.from("broken") : archive);
      progress?.(archive.length);
      return Buffer.alloc(0);
    },
    probeBinary: async path => ({ version, sha256: sha(await readFile(path)) }),
    controlCoreUpdate: async action => { operations.push(action); return "ok"; },
  });
  const server = createSysinfoServer(async () => [], undefined, manager);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/core/update`;
  const post = (path: string, body: object | Buffer) => fetch(base + path, { method: "POST", body: Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const settled = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await manager.status();
      if (!state.busy) return state;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail("update did not finish");
  };
  assert.equal((await manager.status()).checkState, "unchecked");
  assert.equal((await manager.status()).checkedAt, null);
  const checkStarted = Date.now();
  assert.equal((await post("/check", { mode: "core" })).status, 202);
  assert.deepEqual((await settled()).latest, { version, releaseNotes: null });
  assert.ok(Date.parse((await settled()).checkedAt!) >= checkStarted);
  assert.equal((await settled()).checkState, "succeeded");
  assert.deepEqual(requests[0], ["https://api.github.com/repos/MetaCubeX/mihomo/releases/latest", "http://127.0.0.1:7890"]);
  for (const source of Object.keys(sources)) {
    assert.equal((await post("/download", { mode: "direct", source })).status, 202);
    const state = await settled();
    assert.equal(state.phase, "ready"); assert.equal(state.candidate?.verification, "official");
    assert.equal(state.checkState, "succeeded");
    assert.equal(state.candidate?.sha256, sha(binary));
    assert.equal((await post("/install", { sha256: "stale" })).status, 400);
  }
  assert.deepEqual(operations, []);
  assert.equal((await post("/install", { sha256: sha(binary) })).status, 202);
  assert.equal((await settled()).phase, "succeeded"); assert.deepEqual(operations, ["install"]);
  await post("/download", { mode: "external", proxy: "http://localhost:2080", source: "custom", url: "https://example.com/core.gz" });
  assert.equal((await settled()).candidate?.verification, "local");
  assert.deepEqual(requests.at(-1), ["https://example.com/core.gz", "http://localhost:2080/"]);
  for (const file of [binary, archive]) {
    await post("/upload", file);
    const state = await settled(); assert.equal(state.candidate?.verification, "local"); assert.equal(state.candidate?.source, "upload");
  }
  await post("/upload", Buffer.from("not a Core"));
  assert.equal((await settled()).error, "invalid_binary");
  corrupt = true;
  await post("/download", { mode: "direct", source: "github" });
  assert.equal((await settled()).error, "checksum_mismatch");
  assert.equal((await settled()).candidate, null);
  assert.deepEqual(operations, ["install"]);
  assert.equal((await fetch(base)).status, 200);
  checkFails = true;
  const failureStarted = Date.now();
  await post("/check", { mode: "direct" });
  assert.equal((await settled()).checkState, "failed");
  assert.deepEqual((await settled()).latest, { version, releaseNotes: null });
  assert.ok(Date.parse((await settled()).checkedAt!) >= failureStarted);
});
