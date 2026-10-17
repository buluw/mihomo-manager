import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigStore } from "../src/config/store.js";
import { ManagerSettingsService, type RuntimeLoadState } from "../src/managerSettings/service.js";
import { WriteQueue } from "../src/writeQueue.js";
import { cleanupReason } from "../../frontend/src/shared/collectionCleanup.ts";
import type { ProviderCleanupItem } from "../../frontend/src/api/configClient.ts";

test("formal configd entry supplies complete and partial reference evidence to cleanup text", { skip: process.platform === "win32", timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-reference-evidence-"));
  let child: ChildProcess | undefined;
  t.after(async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "configs"));
  await mkdir(join(root, "providers"));
  const configPath = join(root, "configs/main.yaml");
  await writeFile(configPath, "mode: direct\nproxy-providers:\n  direct: {type: file, path: ./providers/old.yaml}\n  other: {type: file, path: ./providers/other.yaml}\n");
  for (const name of ["old.yaml", "other.yaml", "unused.yaml"]) await writeFile(join(root, "providers", name), "proxies: []\n");
  // Prepare a real versioned candidate with the existing validator fixture.
  // All load attempts and reference evidence below use the formal HTTP entry.
  const writeQueue = new WriteQueue();
  const store = new ConfigStore({ configPath, dataDir: root, mihomoBinary: process.execPath,
    validatorArgsPrefix: [fileURLToPath(new URL("./fixtures/validator.mjs", import.meta.url)), "-"],
    validationTimeoutMs: 2000, maxContentBytes: 16384, writeQueue });
  const manager = new ManagerSettingsService({ statePath: join(root, "manager-settings.json"),
    runtimeDir: join(root, "generated-runtime"), store, writeQueue });
  const source = await store.read();
  const generated = await manager.generate({ sourceName: source.name, expectedSourceSha256: source.sha256, expectedSettingsVersion: 0 });
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const base = "http://127.0.0.1:" + address.port;
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH, MIHOMO_DATA_DIR: root, MIHOMO_CONFIG_PATH: configPath,
      MIHOMO_BINARY_PATH: process.execPath, MIHOMO_PROVIDER_DIR: join(root, "providers"),
      CONFIGD_HOST: "127.0.0.1", CONFIGD_PORT: String(address.port) },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated configd startup timed out")), 10_000);
    child!.once("error", error => { clearTimeout(timer); reject(error); });
    child!.once("exit", () => { clearTimeout(timer); reject(new Error("isolated configd exited")); });
    child!.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("configd listening on ")) { clearTimeout(timer); resolve(); }
    });
  });
  const request = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, method + " " + path);
    return response.json() as Promise<T>;
  };
  const begin = async () => {
    const state = await request<RuntimeLoadState>("/runtime-config/state");
    return request<RuntimeLoadState>("/runtime-config/load-attempt", "POST", { generatedVersion: generated.version, expectedVersion: state.version });
  };
  const finish = async (result: "succeeded" | "unknown" | "failed") => {
    const state = await request<RuntimeLoadState>("/runtime-config/state");
    return request<RuntimeLoadState>("/runtime-config/load-result", "PUT", { attemptId: state.lastAttempt!.id, expectedVersion: state.version, result });
  };
  const preview = async () => (await request<{ files: ProviderCleanupItem[] }>("/provider-cleanup/preview", "POST", { category: "proxy" })).files;
  const checkNoSuccess = async (reason: "no_record" | "load_pending" | "load_unknown" | "load_failed") => {
    const state = await request<RuntimeLoadState>("/runtime-config/state");
    assert.equal(state.lastSuccessful, null);
    const item = (await preview()).find(entry => entry.fileName === "unused.yaml")!;
    assert.equal(item.runtime?.hasSuccessfulRecord, false);
    assert.equal(item.runtime?.scanComplete, false);
    assert.equal(item.runtime?.unknownReason, reason);
    assert.equal(item.runtime?.uncertain, true);
    assert.match(cleanupReason(item), /尚无.*成功加载记录/);
    assert.doesNotMatch(cleanupReason(item), /未引用此路径/);
  };
  await t.test("first attempts keep absence of a successful record explicit", async () => {
    await checkNoSuccess("no_record");
    await begin(); await checkNoSuccess("load_pending");
    await finish("unknown"); await checkNoSuccess("load_unknown");
    await begin(); await finish("failed"); await checkNoSuccess("load_failed");
  });
  await t.test("a complete successful record permits negative path evidence", async () => {
    await begin(); await finish("succeeded");
    const items = await preview();
    const unused = items.find(entry => entry.fileName === "unused.yaml")!;
    assert.equal(unused.runtime?.hasSuccessfulRecord, true);
    assert.equal(unused.runtime?.scanComplete, true);
    assert.equal(unused.runtime?.uncertain, true);
    assert.match(cleanupReason(unused), /最近成功加载的运行文件未引用此路径/);
    assert.match(cleanupReason(items.find(entry => entry.fileName === "old.yaml")!), /最近成功加载的运行文件引用此路径：/);
  });
  await t.test("partial scans preserve known references and the latest load outcome", async () => {
    await rename(join(root, "providers/other.yaml"), join(root, "other-body.yaml"));
    await symlink(join(root, "other-body.yaml"), join(root, "providers/other.yaml"));
    for (const result of ["pending", "unknown", "failed"] as const) {
      if (result !== "unknown") await begin();
      if (result !== "pending") await finish(result);
      const items = await preview();
      const direct = items.find(entry => entry.fileName === "old.yaml")!;
      assert.deepEqual(direct.configReferences, [
        { configName: "main.yaml", kind: "path", path: "./providers/old.yaml" },
        { configName: "main.yaml", kind: "unreadable" },
      ]);
      assert.deepEqual(direct.runtime?.references, [{ kind: "path", path: "./providers/old.yaml" }]);
      assert.equal(direct.runtime?.hasSuccessfulRecord, true);
      assert.equal(direct.runtime?.scanComplete, false);
      assert.equal(direct.runtime?.uncertain, true);
      assert.equal(direct.runtime?.unknownReason, "load_" + result);
      const text = cleanupReason(direct);
      assert.match(text, /配置仍在引用此路径：main.yaml/);
      assert.match(text, /配置引用无法确认/);
      assert.match(text, /最近成功加载的运行文件引用此路径：/);
      assert.match(text, /引用检查不完整/);
      assert.match(text, result === "pending" ? /加载结果尚未确认/ : result === "unknown" ? /上次加载结果未知/ : /上次应用失败/);
      for (const item of [direct, items.find(entry => entry.fileName === "unused.yaml")!]) {
        assert.equal(item.runtime?.scanComplete, false);
        assert.doesNotMatch(cleanupReason(item), /未引用此路径/);
      }
    }
  });
});
