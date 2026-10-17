import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "yaml";
import { sourceDiagnostics } from "../src/features/config-center/configDiagnostics.ts";
import { restoreCollectionPath } from "../src/shared/collectionPath.ts";

test("collection recovery is tied to the exact path and restores only its scalar in the draft", async (t) => {
  const change = { category: "proxy" as const, name: "first", fromPath: "./providers/old.yaml", toPath: "./providers/new.yaml", fileSha256: "a".repeat(64) };
  const cases = [
    { name: "plain", value: "./providers/new.yaml # preserve path comment", restored: '"./providers/old.yaml" # preserve path comment' },
    { name: "double quoted", value: '"./providers/new.yaml" # preserve path comment', restored: '"./providers/old.yaml" # preserve path comment' },
    { name: "single quoted", value: "'./providers/new.yaml' # preserve path comment", restored: '"./providers/old.yaml" # preserve path comment' },
    { name: "folded block", value: ">- # preserve block header\n      ./providers/new.yaml", restored: ">- # preserve block header\n      ./providers/old.yaml" },
    { name: "literal block", value: "|- # preserve block header\n      ./providers/new.yaml", restored: "|- # preserve block header\n      ./providers/old.yaml" },
  ];
  for (const sample of cases) await t.test(sample.name, () => {
    const content = '# unrelated unsaved draft\nmode: direct\nproxy-providers:\n  first:\n    type: file\n    path: ' + sample.value + '\n    # preserve following comment\n    interval: 1200 # preserve interval\n  second: {type: file, path: ./providers/other.yaml}\n';
    const before = parseDocument(content);
    assert.deepEqual(before.errors, []);
    assert.equal(before.getIn(["proxy-providers", "first", "path"]), change.toPath);
    const restored = restoreCollectionPath(content, change);
    assert.equal(restored, content.replace("path: " + sample.value, "path: " + sample.restored));
    const after = parseDocument(restored);
    assert.deepEqual(after.errors, []);
    const expected = before.toJS();
    expected["proxy-providers"].first.path = change.fromPath;
    assert.deepEqual(after.toJS(), expected);
    const updated = content.replace('./providers/new.yaml', './providers/changed.yaml');
    assert.throws(() => restoreCollectionPath(updated, change));
  });
});

test("source diagnostics mark syntax and missing File paths without reusing provider-body locations", () => {
  const broken = sourceDiagnostics("mode: [rule\n");
  assert.ok(broken.length > 0);
  assert.ok(broken[0]!.line >= 1);
  const content = "proxy-providers:\n  sample:\n    type: file\n    path: ./providers/sample.yaml\n";
  const markers = sourceDiagnostics(content, [{ category: "proxy", name: "sample", status: "missing" }], [{ code: "invalid_provider", message: "collection body failed" }]);
  assert.equal(markers.length, 1);
  assert.equal(markers[0]!.line, 4);
  assert.equal(markers[0]!.column, 11);
  assert.equal(sourceDiagnostics(content.replace("type: file", "type: http"), [{ category: "proxy", name: "sample", status: "missing" }]).length, 0);
});

test("source diagnostics explain missing declarations and missing declared files at their own source lines", () => {
  const content = '# fixture\nrule-providers:\n  声明集合:\n    type: file\n    behavior: domain\n    path: ./ruleset/original.yaml\nrules:\n  - RULE-SET,示例规则,DIRECT\n';
  const diagnostic = { code: "rule_provider_missing", message: "规则集合不存在", path: ["rules", 0] };
  const missing = sourceDiagnostics(content, [], [diagnostic], "main.yaml");
  assert.equal(missing[0]!.line, 8);
  assert.equal(missing[0]!.message, "main.yaml 第8行：规则引用了集合「示例规则」，但配置中没有声明这个集合。");
  const file = sourceDiagnostics(content, [{ category: "rule", name: "声明集合", status: "missing" }], [], "main.yaml");
  assert.equal(file[0]!.line, 6);
  assert.equal(file[0]!.message, "main.yaml 第6行：集合「声明集合」已声明，但声明中的文件「./ruleset/original.yaml」找不到，请导入或恢复文件。");
  assert.deepEqual(sourceDiagnostics(content, [], [{ ...diagnostic, path: undefined }]), []);
  assert.deepEqual(sourceDiagnostics(content, [], [{ ...diagnostic, path: ["rules", 5] }]), []);
  assert.deepEqual(sourceDiagnostics(content.replace("RULE-SET,示例规则", "RULE-SET,声明集合"), [], [diagnostic]), []);
  assert.deepEqual(sourceDiagnostics(content.replace("RULE-SET,示例规则,DIRECT", "MATCH,DIRECT"), [], [diagnostic]), []);
});
import { controllerApi } from "../src/api/controllerClient.ts";
import {
  ConfigError,
  configApi,
  createConfigFile,
  deleteConfigFile,
  listConfigFiles,
  readConfig,
  readConfigFile,
  renameConfigFile,
  saveConfig,
  saveConfigFile,
  type ConfigSnapshot,
  validateConfig,
} from "../src/api/configClient.ts";
import { LatestRequestController } from "../src/shared/requestLifecycle.ts";
import { ConfigPublishCoordinator, ConfigReconciliationLifecycle } from "../src/features/config-center/configReconciliationLifecycle.ts";
import { ConfigSnapshotSession } from "../src/features/config-center/configSnapshotSession.ts";
import {
  applyExternalConfigSnapshot,
  canReplaceEditorWithExternalSnapshot,
  configRuntimeState,
  configApplyControl,
  setConfigRuntimeState,
  stageExternalConfigSnapshot,
  applyConfigWorkspaceRename,
  createConfigWorkspaceEntry,
  newConfigFileName,
  validUploadedConfigName,
  validUploadedConfigContent,
  configInlineMutationError,
  reconcileConfigWorkspace,
} from "../src/features/config-center/configWorkspaceState.ts";
import { isConfigDirty, saveConfigToDisk } from "../src/features/config-center/configActions.ts";
import { configProviderIssues, matchesCollectionImportSource } from "../src/features/config-center/configCollectionImport.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("configuration apply control distinguishes switching, editing, reapplying and unknown runtime", () => {
  for (const [loadedName, dirty, label, icon, completed] of [
    ["other.yaml", false, "切换配置", "switch", "已切换配置"],
    ["other.yaml", true, "切换配置", "switch", "已切换配置"],
    ["source.yaml", true, "应用配置", "apply", "已应用配置"],
    ["source.yaml", false, "应用配置", "apply", "已应用配置"],
    [null, false, "应用配置", "apply", "已应用配置"],
    [null, true, "应用配置", "apply", "已应用配置"],
  ] as const) {
    const control = configApplyControl({ activeName: "source.yaml", loadedName, dirty });
    assert.deepEqual({ label: control.label, icon: control.icon, completed: control.completed, disabled: control.disabled }, { label, icon, completed, disabled: dirty });
    if (dirty) assert.equal(control.reason, "请先保存配置");
    else if (loadedName) assert.equal(control.reason, null);
    else assert.match(control.reason!, /运行来源未知/);
  }
  assert.equal(configApplyControl({ activeName: null, loadedName: null, dirty: false }).disabled, true);
});

test("config snapshot session caches by listed version and reuses rapid A/B/A reads", async () => {
  const session = new ConfigSnapshotSession();
  const requests = new LatestRequestController();
  const pending = new Map<string, ReturnType<typeof deferred<ConfigSnapshot>>>();
  const calls: string[] = [];
  const files = {
    A: { name: "a.yaml", path: "/config/a.yaml", sha256: "a", size: 1, updatedAt: "", subscriptionManaged: false, subscriptionId: null },
    B: { name: "b.yaml", path: "/config/b.yaml", sha256: "b", size: 1, updatedAt: "", subscriptionManaged: false, subscriptionId: null },
  };
  const loader = (name: string) => {
    calls.push(name);
    const operation = pending.get(name) ?? deferred<ConfigSnapshot>();
    pending.set(name, operation);
    return operation.promise;
  };
  let published = "";
  const select = (file: typeof files.A) => {
    const request = requests.begin();
    return session.read(file, loader).then((snapshot) => {
      if (request.isCurrent()) published = snapshot.name;
      request.finish();
    });
  };

  const firstA = select(files.A);
  const selectedB = select(files.B);
  const secondA = select(files.A);
  assert.deepEqual(calls, ["a.yaml", "b.yaml"]);
  pending.get("b.yaml")!.resolve({ ...files.B, content: "mode: direct\n" });
  await selectedB;
  assert.equal(published, "");
  pending.get("a.yaml")!.resolve({ ...files.A, content: "mode: rule\n" });
  await Promise.all([firstA, secondA]);
  assert.equal(published, "a.yaml");

  await session.read(files.A, loader);
  assert.deepEqual(calls, ["a.yaml", "b.yaml"]);
  session.reconcile([{ ...files.A, sha256: "a2" }, files.B]);
  const nextA = session.read({ ...files.A, sha256: "a2" }, async (name) => {
    calls.push(name);
    return { ...files.A, sha256: "a2", content: "mode: global\n" };
  });
  assert.equal((await nextA).sha256, "a2");
  assert.deepEqual(calls, ["a.yaml", "b.yaml", "a.yaml"]);
});

test("config snapshot session isolates read failures and permits an explicit retry", async () => {
  const session = new ConfigSnapshotSession();
  const failed = { name: "failed.yaml", sha256: "f" };
  const healthy = { name: "healthy.yaml", sha256: "h" };
  let failedReads = 0;
  await assert.rejects(session.read(failed, async () => {
    failedReads += 1;
    throw new Error("fixture read failure");
  }), /fixture read failure/);
  const healthySnapshot = await session.read(healthy, async () => ({
    ...healthy,
    path: "/config/healthy.yaml",
    content: "mode: rule\n",
  }));
  assert.equal(healthySnapshot.name, "healthy.yaml");
  session.invalidate(failed.name);
  const retried = await session.read(failed, async () => ({
    ...failed,
    path: "/config/failed.yaml",
    content: "mode: direct\n",
  }));
  assert.equal(retried.content, "mode: direct\n");
  assert.equal(failedReads, 1);
  assert.equal(session.get(healthy)?.content, "mode: rule\n");
});

test("configuration client uses the fixed file and validate endpoints", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (String(input).endsWith("/file") && !init?.method) {
      return new Response(JSON.stringify({ content: "", sha256: "0".repeat(64) }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(init?.method === "POST" ? { valid: true } : { sha256: "1".repeat(64) }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await readConfig();
    await validateConfig("mode: rule");
    await configApi("/file", { method: "PUT", body: "{}" });
    assert.deepEqual(calls, [
      "GET /api/config/file",
      "POST /api/config/validate",
      "PUT /api/config/file",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("configd unavailable is isolated from Controller requests", async () => {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).startsWith("/api/config")) throw new TypeError("offline");
    return new Response(JSON.stringify({ version: "test" }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await assert.rejects(readConfig(), (error: ConfigError) => error.status === 0);
    assert.deepEqual(await controllerApi("/version"), { version: "test" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("configuration load returns content and dirty state tracks edits", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ content: "mode: rule", sha256: "abc" }), {
    headers: { "content-type": "application/json" },
  });
  try {
    const snapshot = await readConfig();
    assert.equal(snapshot.sha256, "abc");
    assert.equal(isConfigDirty(snapshot.content, snapshot.content), false);
    assert.equal(isConfigDirty(`${snapshot.content}\n`, snapshot.content), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validation failure preserves the configd status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "validation_failed" }), {
    status: 422,
    headers: { "content-type": "application/json" },
  });
  try {
    await assert.rejects(
      validateConfig("invalid"),
      (error: ConfigError) => error.status === 422 && error.code === "validation_failed",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("configuration editor save writes only to disk", async () => {
  const calls: string[] = [];
  const result = await saveConfigToDisk("profile.yaml", "mode: rule", "old", {
    save: async (name, content, expected) => {
      calls.push(`save:${name}:${content}:${expected}`);
      return { name, path: "/srv/mihomo/profile.yaml", content, sha256: "new" };
    },
  });
  assert.deepEqual(calls, ["save:profile.yaml:mode: rule:old"]);
  assert.deepEqual(result, { name: "profile.yaml", path: "/srv/mihomo/profile.yaml", sha256: "new" });
});

test("sha256 conflict is exposed without retrying the write", async () => {
  let writes = 0;
  await assert.rejects(
    saveConfigToDisk("profile.yaml", "mode: rule", "stale", {
      save: async () => {
        writes += 1;
        throw new ConfigError("conflict", 409, "config_conflict");
      },
    }),
    (error: ConfigError) => error.status === 409,
  );
  assert.equal(writes, 1);
});

test("configd validation failure blocks the disk update", async () => {
  let saves = 0;
  await assert.rejects(saveConfigToDisk("profile.yaml", "invalid", "old", {
    save: async () => {
      saves += 1;
      throw new ConfigError("invalid", 422, "validation_failed");
    },
  }), (error: ConfigError) => error.status === 422);
  assert.equal(saves, 1);
});

test("named configuration CRUD uses encoded fixed configd paths", async () => {
  const calls: string[] = [];
  let createdBody = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (init?.method === "POST" && String(input).endsWith("/files")) createdBody = String(init.body);
    if (String(input).endsWith("/files") && !init?.method) {
      return new Response(JSON.stringify({ files: [] }), { headers: { "content-type": "application/json" } });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ name: "profile one.yaml", path: "/srv/profile one.yaml", content: "", sha256: "a" }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await listConfigFiles();
    await createConfigFile("profile one.yaml", "");
    await readConfigFile("profile one.yaml");
    await saveConfigFile("profile one.yaml", "mode: rule", "a");
    await renameConfigFile("profile one.yaml", "renamed.yml", "a");
    await deleteConfigFile("profile one.yaml", "a");
    assert.deepEqual(calls, [
      "GET /api/config/files",
      "POST /api/config/files",
      "GET /api/config/files/profile%20one.yaml",
      "PUT /api/config/files/profile%20one.yaml",
      "POST /api/config/files/profile%20one.yaml/rename",
      "DELETE /api/config/files/profile%20one.yaml",
    ]);
    assert.deepEqual(JSON.parse(createdBody), {
      name: "profile one.yaml",
      content: "",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("add modes validate empty drafts and uploaded YAML names without accepting paths", () => {
  assert.equal(newConfigFileName("新配置"), "新配置.yaml");
  assert.equal(newConfigFileName("../outside"), null);
  assert.equal(newConfigFileName("already.yaml"), null);
  assert.equal(validUploadedConfigName("existing.yml"), true);
  assert.equal(validUploadedConfigName("现有配置.yaml"), true);
  assert.equal(validUploadedConfigName("existing.txt"), false);
  assert.equal(validUploadedConfigName("nested/existing.yaml"), false);
  assert.equal(validUploadedConfigContent("\n  "), false);
  assert.equal(validUploadedConfigContent("mode: rule\n"), true);
  assert.equal(configInlineMutationError(new ConfigError("hidden", 409, "config_exists")), "同名配置文件已存在");
  assert.equal(configInlineMutationError(new ConfigError("hidden", 422, "validation_failed")), "Mihomo 校验失败，请检查上传的 YAML 配置");
  assert.equal(configInlineMutationError(new ConfigError("hidden", 0, "configd_unavailable")), "配置服务暂不可用，请稍后重试");
});

test("upload action keeps empty errors inline and selects a successful disk-only snapshot", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response(JSON.stringify({
      name: "uploaded.yml",
      path: "/config/uploaded.yml",
      content: "mode: rule\n",
      sha256: "b".repeat(64),
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  try {
    const snapshots = new Map();
    const states = new Map();
    const empty = await createConfigWorkspaceEntry({
      files: [],
      snapshots,
      states,
      name: "empty.yaml",
      content: " \n",
      mode: "upload",
    }, createConfigFile);
    assert.deepEqual(empty, {
      ok: false,
      createError: "上传文件为空，请选择可校验的 YAML 配置",
    });
    assert.equal(calls.length, 0);

    const uploaded = await createConfigWorkspaceEntry({
      files: [],
      snapshots,
      states,
      name: "uploaded.yml",
      content: "mode: rule\n",
      mode: "upload",
      updatedAt: "2026-08-10T00:00:00.000Z",
    }, createConfigFile);
    assert.equal(uploaded.ok, true);
    if (!uploaded.ok) assert.fail("upload should succeed");
    assert.deepEqual(calls, ["POST /api/config/files"]);
    assert.equal(calls.some((call) => call.includes("/api/controller")), false);
    assert.equal(uploaded.files[0]?.name, "uploaded.yml");
    assert.equal(uploaded.activeName, "uploaded.yml");
    assert.equal(uploaded.content, "mode: rule\n");
    assert.equal(uploaded.savedContent, "mode: rule\n");
    assert.equal(uploaded.path, "/config/uploaded.yml");
    assert.equal(uploaded.sha256, "b".repeat(64));
    assert.equal(uploaded.runtimeState, "pending-apply");
    assert.equal(uploaded.createError, null);
    assert.equal(snapshots.get("uploaded.yml"), uploaded.snapshot);
    assert.equal(states.get("uploaded.yml"), "pending-apply");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("renaming a dirty selected config migrates identity and cache without losing the editor draft", () => {
  const files = [{
    name: "old.yaml",
    path: "/config/old.yaml",
    sha256: "a",
    size: 10,
    updatedAt: "2026-08-01T00:00:00.000Z",
    subscriptionManaged: true,
    subscriptionId: "subscription-id",
  }];
  const snapshots = new Map([["old.yaml", {
    name: "old.yaml",
    path: "/config/old.yaml",
    content: "mode: rule\n",
    sha256: "a",
  }]]);
  const states = new Map([["old.yaml", "synced" as const]]);
  const renamed = applyConfigWorkspaceRename({
    files,
    snapshots,
    states,
    oldName: "old.yaml",
    snapshot: {
      name: "new.yml",
      path: "/config/new.yml",
      content: "mode: rule\n",
      sha256: "b",
    },
    activeName: "old.yaml",
    loadedName: "old.yaml",
    editorContent: "mode: direct\n",
    savedContent: "mode: rule\n",
    editorPath: "/config/old.yaml",
    editorSha256: "a",
  });
  assert.deepEqual(renamed.files.map((file) => ({ name: file.name, managed: file.subscriptionManaged })), [
    { name: "new.yml", managed: true },
  ]);
  assert.equal(renamed.activeName, "new.yml");
  assert.equal(renamed.loadedName, null);
  assert.equal(renamed.editorPath, "/config/new.yml");
  assert.equal(renamed.editorSha256, "b");
  assert.equal(renamed.editorContent, "mode: direct\n");
  assert.equal(renamed.savedContent, "mode: rule\n");
  assert.equal(renamed.dirty, true);
  assert.equal(renamed.runtimeState, "pending-apply");
  assert.equal(snapshots.has("old.yaml"), false);
  assert.equal(snapshots.get("new.yml")?.path, "/config/new.yml");
  assert.equal(states.has("old.yaml"), false);
  assert.equal(states.get("new.yml"), "pending-apply");
});

test("Config Client never forwards Controller authorization", async () => {
  let headers = new Headers();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    headers = new Headers(init?.headers);
    return new Response(null, { status: 204 });
  };
  try {
    await configApi<void>("/file", { method: "PUT", body: "{}" });
    assert.equal(headers.has("Authorization"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("configuration reads use the default timeout while validation and save use long timeouts", async () => {
  const delays: number[] = [];
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = ((delay: number) => {
    delays.push(delay);
    return new AbortController().signal;
  }) as typeof AbortSignal.timeout;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.endsWith("/file")) {
      return new Response(JSON.stringify({ content: "", sha256: "0".repeat(64) }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (path.endsWith("/validate")) {
      return new Response(JSON.stringify({ valid: true }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ sha256: "1".repeat(64) }), { headers: { "content-type": "application/json" } });
  };
  try {
    await readConfig();
    await validateConfig("mode: rule");
    await saveConfig("mode: rule", "0".repeat(64));
    assert.deepEqual(delays, [6_000, 30_000, 30_000]);
  } finally {
    AbortSignal.timeout = originalTimeout;
    globalThis.fetch = originalFetch;
  }
});

test("caller abort signals remain effective with the request timeout", async () => {
  const caller = new AbortController();
  let requestSignal: AbortSignal | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    return new Response(JSON.stringify({ content: "", sha256: "0".repeat(64) }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await readConfig(caller.signal);
    assert.equal(requestSignal?.aborted, false);
    caller.abort();
    assert.equal(requestSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("only the latest configuration read may publish state", async () => {
  const requests = new LatestRequestController();
  const firstResult = deferred<string>();
  const secondResult = deferred<string>();
  const published: string[] = [];

  const run = async (
    request: ReturnType<LatestRequestController["begin"]>,
    result: Promise<string>,
  ) => {
    try {
      const value = await result;
      if (request.isCurrent()) published.push(value);
    } finally {
      request.finish();
    }
  };

  const first = requests.begin();
  const firstRun = run(first, firstResult.promise);
  const second = requests.begin();
  const secondRun = run(second, secondResult.promise);

  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  secondResult.resolve("latest");
  await secondRun;
  firstResult.resolve("stale");
  await firstRun;

  assert.deepEqual(published, ["latest"]);
  requests.dispose();
});

test("an external subscription merge replaces the cached file SHA and size", () => {
  const files = [{
    name: "profile.yaml",
    path: "/srv/profile.yaml",
    sha256: "a".repeat(64),
    size: 10,
    updatedAt: "2026-08-01T00:00:00.000Z",
  }, {
    name: "other.yaml",
    path: "/srv/other.yaml",
    sha256: "d".repeat(64),
    size: 4,
    updatedAt: "2026-08-01T00:00:00.000Z",
  }];
  const snapshot = {
    name: "profile.yaml",
    path: "/srv/profile.yaml",
    content: "mode: rule\nproxy-providers: {}\n",
    sha256: "b".repeat(64),
  };
  const snapshots = new Map();
  const next = applyExternalConfigSnapshot(
    files,
    snapshots,
    snapshot,
    "2026-08-02T00:00:00.000Z",
  );
  assert.equal(next[0]?.sha256, snapshot.sha256);
  assert.equal(snapshots.get("profile.yaml"), snapshot);
  assert.equal(next[0]?.size, new TextEncoder().encode(snapshot.content).byteLength);
  assert.equal(next[0]?.updatedAt, "2026-08-02T00:00:00.000Z");
  assert.equal(next[1], files[1]);
  assert.notEqual(next, files);
});

test("a successful subscription update appends its raw YAML config snapshot", () => {
  const snapshots = new Map();
  const snapshot = {
    name: "订阅示例.yaml",
    path: "/srv/订阅示例.yaml",
    content: "proxies: []\n",
    sha256: "e".repeat(64),
    subscriptionManaged: true,
    subscriptionId: "subscription-id",
  };
  const next = applyExternalConfigSnapshot([], snapshots, snapshot, "2026-08-10T00:00:00.000Z");
  assert.equal(next.length, 1);
  assert.equal(next[0]?.name, snapshot.name);
  assert.equal(next[0]?.sha256, snapshot.sha256);
  assert.equal(next[0]?.subscriptionManaged, true);
  assert.equal(next[0]?.subscriptionId, "subscription-id");
  assert.equal(snapshots.get(snapshot.name), snapshot);
});

test("external snapshots never replace a dirty, busy, mutating, or different editor", () => {
  const base = {
    activeName: "profile.yaml",
    snapshotName: "profile.yaml",
    dirty: false,
    busy: false,
    mutating: false,
  };
  assert.equal(canReplaceEditorWithExternalSnapshot(base), true);
  assert.equal(canReplaceEditorWithExternalSnapshot({ ...base, dirty: true }), false);
  assert.equal(canReplaceEditorWithExternalSnapshot({ ...base, busy: true }), false);
  assert.equal(canReplaceEditorWithExternalSnapshot({ ...base, mutating: true }), false);
  assert.equal(canReplaceEditorWithExternalSnapshot({ ...base, activeName: "other.yaml" }), false);

  for (const editor of [
    { ...base, dirty: true },
    { ...base, busy: true },
    { ...base, mutating: true },
    { ...base, activeName: "other.yaml" },
  ]) {
    const snapshots = new Map();
    const snapshot = {
      name: "profile.yaml",
      path: "/srv/profile.yaml",
      content: "mode: global\n",
      sha256: "c".repeat(64),
    };
    const staged = stageExternalConfigSnapshot([], snapshots, snapshot, editor);
    assert.equal(staged.editorSnapshot, null);
    assert.equal(snapshots.get(snapshot.name), snapshot);
  }
});

test("pending runtime synchronization is retained independently for each config file", () => {
  const states = new Map();
  setConfigRuntimeState(states, "a.yaml", "pending-apply");
  assert.equal(configRuntimeState(states, "a.yaml"), "pending-apply");
  assert.equal(configRuntimeState(states, "b.yaml"), "idle");
  setConfigRuntimeState(states, "b.yaml", "synced");
  assert.equal(configRuntimeState(states, "b.yaml"), "synced");
  assert.equal(configRuntimeState(states, "a.yaml"), "pending-apply");
});

test("an explicit missing configuration remains the target during background reconciliation", async () => {
  const lifecycle = new ConfigReconciliationLifecycle();
  const cleanup = lifecycle.setup();
  const missing: string[] = [];
  let reads = 0;
  try {
    await reconcileConfigWorkspace(lifecycle.begin()!, { activeName: () => "A.yaml", sha256: () => "",
      dirty: () => false, busy: () => false, mutating: () => false, explicitTarget: true }, {
      list: async () => [{ name: "B.yaml", path: "/configs/B.yaml", sha256: "B", size: 1, updatedAt: "now" }],
      read: async () => { reads++; throw new Error("another configuration must not be read"); },
    }, { files: () => {}, pending: () => {}, dirty: () => {}, empty: (name) => missing.push(name),
      snapshot: () => assert.fail("another configuration must not replace the target") });
    assert.deepEqual(missing, ["A.yaml"]);
    assert.equal(reads, 0);
  } finally { cleanup(); }
});

test("config reconciliation publishes only the latest matching disk version and preserves dirty drafts", async () => {
  const lifecycle = new ConfigReconciliationLifecycle();
  const cleanupOld = lifecycle.setup();
  const replayed = lifecycle.begin()!;
  cleanupOld();
  assert.equal(replayed.signal.aborted, true);
  assert.equal(replayed.isCurrent(), false);

  const cleanup = lifecycle.setup();
  const listA = deferred<any[]>();
  const listB = deferred<any[]>();
  const readB = deferred<any>();
  let listCall = 0;
  let readCall = 0;
  let dirty = false;
  const publishedFiles: string[][] = [];
  const publishedSnapshots: string[] = [];
  const messages: string[] = [];
  const state = {
    activeName: () => "profile.yaml",
    sha256: () => "old",
    dirty: () => dirty,
    busy: () => false,
    mutating: () => false,
  };
  const publish = {
    files: (files: Array<{ sha256: string }>) => publishedFiles.push(files.map((file) => file.sha256)),
    pending: () => messages.push("pending"),
    dirty: () => messages.push("dirty"),
    empty: () => messages.push("empty"),
    snapshot: (snapshot: { sha256: string }) => publishedSnapshots.push(snapshot.sha256),
  };
  const dependencies = {
    list: async () => (++listCall === 1 ? listA.promise : listB.promise),
    read: async () => { readCall += 1; return readB.promise; },
  };
  const requestA = lifecycle.begin()!;
  const operationA = reconcileConfigWorkspace(requestA, state, dependencies, publish);
  const requestB = lifecycle.begin()!;
  const operationB = reconcileConfigWorkspace(requestB, state, dependencies, publish);
  listB.resolve([{ name: "profile.yaml", path: "/config/profile.yaml", sha256: "B", size: 1, updatedAt: "now" }]);
  await Promise.resolve();
  readB.resolve({ name: "profile.yaml", path: "/config/profile.yaml", content: "mode: rule\n", sha256: "B" });
  await operationB;
  listA.resolve([{ name: "profile.yaml", path: "/config/profile.yaml", sha256: "A", size: 1, updatedAt: "old" }]);
  await operationA;
  assert.equal(requestA.signal.aborted, true);
  assert.deepEqual(publishedFiles, [["B"]]);
  assert.deepEqual(publishedSnapshots, ["B"]);

  dirty = true;
  const dirtyRequest = lifecycle.begin()!;
  await reconcileConfigWorkspace(
    dirtyRequest,
    state,
    {
      list: async () => [{ name: "profile.yaml", path: "/config/profile.yaml", sha256: "C", size: 1, updatedAt: "new" }],
      read: async () => { readCall += 1; throw new Error("dirty editor must not read"); },
    },
    publish,
  );
  assert.deepEqual(publishedSnapshots, ["B"]);
  assert.equal(messages.at(-1), "dirty");
  assert.equal(readCall, 1);

  dirty = false;
  const fallbackRequest = lifecycle.begin()!;
  await reconcileConfigWorkspace(
    fallbackRequest,
    state,
    {
      list: async () => [{ name: "fallback.yaml", path: "/config/fallback.yaml", sha256: "F", size: 1, updatedAt: "new" }],
      read: async () => ({ name: "fallback.yaml", path: "/config/fallback.yaml", content: "mode: direct\n", sha256: "F" }),
    },
    publish,
  );
  assert.deepEqual(publishedSnapshots, ["B", "F"]);

  const emptyRequest = lifecycle.begin()!;
  await reconcileConfigWorkspace(
    emptyRequest,
    state,
    { list: async () => [], read: async () => { throw new Error("no file should be read"); } },
    publish,
  );
  assert.equal(messages.at(-1), "empty");

  const coordinator = new ConfigPublishCoordinator();
  let cleanupCoordinator = coordinator.setup();
  const initialForeground = coordinator.beginForeground()!;
  assert.equal(coordinator.beginBackground(), null);
  assert.equal(coordinator.beginBackground(), null);
  assert.equal(initialForeground.isCurrent(), true);
  const initialDrain = initialForeground.finish()!;
  assert.equal(coordinator.consumeDrain(initialDrain), true);
  assert.equal(coordinator.consumeDrain(initialDrain), false);
  assert.equal(initialForeground.finish(), null);
  const coalescedBackground = coordinator.beginBackground()!;
  assert.equal(coalescedBackground.isCurrent(), true);
  assert.equal(coalescedBackground.finish(), null);

  const interruptedBackground = coordinator.beginBackground()!;
  const interruptingForeground = coordinator.beginForeground()!;
  assert.equal(interruptedBackground.isCurrent(), false);
  assert.equal(interruptingForeground.finish(), null);
  const interruptedDrain = interruptedBackground.finish()!;
  assert.equal(coordinator.consumeDrain(interruptedDrain), true);
  assert.equal(coordinator.consumeDrain(interruptedDrain), false);
  const latestBackground = coordinator.beginBackground()!;
  assert.equal(latestBackground.isCurrent(), true);
  assert.equal(latestBackground.finish(), null);

  const blockedBackground = coordinator.beginBackground()!;
  const protectedForeground = coordinator.beginForeground()!;
  assert.equal(blockedBackground.isCurrent(), false);
  assert.equal(coordinator.beginBackground(true), null);
  assert.equal(coordinator.beginBackground(true), null);
  assert.equal(protectedForeground.isCurrent(), true);
  assert.equal(blockedBackground.finish(), null);
  const protectedDrain = protectedForeground.finish()!;
  assert.equal(coordinator.consumeDrain(protectedDrain), true);
  assert.equal(coordinator.consumeDrain(protectedDrain), false);

  const drainingForeground = coordinator.beginForeground()!;
  assert.equal(coordinator.beginBackground(), null);
  const replacedDrain = drainingForeground.finish()!;
  const convergingBackground = coordinator.beginBackground()!;
  assert.equal(coordinator.consumeDrain(replacedDrain), false);
  assert.equal(convergingBackground.isCurrent(), true);
  assert.equal(convergingBackground.finish(), null);

  dirty = true;
  const editedBackground = coordinator.beginBackground()!;
  coordinator.invalidate();
  assert.equal(editedBackground.isCurrent(), false);
  const editDrain = editedBackground.finish()!;
  assert.equal(coordinator.consumeDrain(editDrain), true);
  const dirtyBackground = coordinator.beginBackground()!;
  const dirtyController = new LatestRequestController();
  const dirtyCoordinatorRequest = dirtyController.begin();
  await reconcileConfigWorkspace(
    {
      ...dirtyCoordinatorRequest,
      isCurrent: () => dirtyCoordinatorRequest.isCurrent() && dirtyBackground.isCurrent(),
    },
    state,
    {
      list: async () => [{ name: "profile.yaml", path: "/config/profile.yaml", sha256: "dirty-latest", size: 1, updatedAt: "new" }],
      read: async () => { throw new Error("dirty drain must not replace the editor"); },
    },
    publish,
  );
  assert.deepEqual(publishedSnapshots, ["B", "F"]);
  assert.equal(messages.at(-1), "dirty");
  assert.equal(dirtyCoordinatorRequest.finish(), true);
  assert.equal(dirtyBackground.finish(), null);
  dirty = false;

  const replacedBackground = coordinator.beginBackground()!;
  const replacingBackground = coordinator.beginBackground()!;
  assert.equal(replacedBackground.isCurrent(), false);
  assert.equal(replacedBackground.finish(), null);
  assert.equal(replacingBackground.finish(), null);

  const ticketForeground = coordinator.beginForeground()!;
  assert.equal(coordinator.beginBackground(), null);
  const staleTicket = ticketForeground.finish()!;
  cleanupCoordinator();
  cleanupCoordinator = coordinator.setup();
  assert.equal(coordinator.consumeDrain(staleTicket), false);
  const replayBackground = coordinator.beginBackground()!;
  assert.equal(replayBackground.finish(), null);

  const manualResponse = deferred<string>();
  const manualA = coordinator.beginForeground()!;
  const crossLanePublished: string[] = [];
  const manualPublication = manualResponse.promise.then((value) => {
    if (manualA.isCurrent()) crossLanePublished.push(value);
  });
  const reconciliationB = coordinator.beginForeground()!;
  const reconciliationController = new LatestRequestController();
  const reconciliationRequest = reconciliationController.begin();
  await reconcileConfigWorkspace(
    {
      ...reconciliationRequest,
      isCurrent: () => reconciliationRequest.isCurrent() && reconciliationB.isCurrent(),
    },
    state,
    {
      list: async () => [{ name: "profile.yaml", path: "/config/profile.yaml", sha256: "B2", size: 1, updatedAt: "new" }],
      read: async () => ({ name: "profile.yaml", path: "/config/profile.yaml", content: "mode: global\n", sha256: "B2" }),
    },
    { ...publish, snapshot: (snapshot) => crossLanePublished.push(snapshot.sha256) },
  );
  manualResponse.resolve("A2");
  await manualPublication;
  assert.equal(reconciliationRequest.finish(), true);
  assert.deepEqual(crossLanePublished, ["B2"]);
  assert.equal(manualA.finish(), null);
  assert.equal(reconciliationB.finish(), null);

  const staleMutationResponse = deferred<string>();
  const beforeMutation = coordinator.beginForeground()!;
  const staleMutationPublication = staleMutationResponse.promise.then((value) => {
    if (beforeMutation.isCurrent()) crossLanePublished.push(value);
  });
  coordinator.invalidate();
  crossLanePublished.push("local-commit");
  staleMutationResponse.resolve("stale-after-mutation");
  await staleMutationPublication;
  assert.deepEqual(crossLanePublished, ["B2", "local-commit"]);
  assert.equal(beforeMutation.finish(), null);

  const pendingEditResponse = deferred<string>();
  const beforeEdit = coordinator.beginForeground()!;
  const pendingEditPublication = pendingEditResponse.promise.then((value) => {
    if (beforeEdit.isCurrent()) crossLanePublished.push(value);
  });
  coordinator.invalidate();
  pendingEditResponse.resolve("stale-after-edit");
  await pendingEditPublication;
  assert.deepEqual(crossLanePublished, ["B2", "local-commit"]);
  assert.equal(beforeEdit.finish(), null);
  cleanupCoordinator();
  assert.equal(coordinator.beginForeground(), null);
  cleanup();
  assert.equal(lifecycle.begin(), null);
});

test("unfinished aliases stay diagnosable until their anchors are defined", () => {
  const body = 'proxy-providers:\n  sample: {type: file, path: ./providers/sample.yaml}\nreview_alias: *missing\n';
  const missing = [{ category: "proxy" as const, name: "sample", status: "missing" as const }];
  const diagnostics = sourceDiagnostics(body, missing);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.line, 3);
  assert.match(diagnostics[0]!.message, /别名未定义/);
  const fixed = 'anchor: &missing ready\n' + body;
  assert.deepEqual(sourceDiagnostics(fixed), []);
  assert.equal(configInlineMutationError(new ConfigError("blocked", 409, "config_source_in_use")), "此配置正在使用，请先切换到其他配置");
  assert.match(configInlineMutationError(new ConfigError("unknown", 409, "config_source_usage_unknown")), /重命名或删除/);
});

test("provider diagnostics retain recognized file issues", () => {
  const expected = [
    { category: "proxy", name: "a", status: "missing" },
    { category: "rule", name: "a", status: "missing" },
    { category: "proxy", name: "outside", status: "outside_scope" },
    { category: "proxy", name: "unreadable", status: "unreadable" },
  ];
  assert.deepEqual(configProviderIssues(new ConfigError("missing", 422, "provider_files_unavailable", {
    issues: [...expected, { category: "unknown", name: "a", status: "missing" },
      { category: "proxy", name: 1, status: "missing" }, { category: "proxy", name: "a", status: "ready" }],
  })), expected);
  assert.deepEqual(configProviderIssues(new ConfigError("invalid", 422, "validation_failed")), []);
});

test("config validation source excludes changed names, content, versions and readonly views", () => {
  const source = { name: "draft.yaml", path: "/configs/draft.yaml", content: "mode: rule", sha256: "before" };
  const current = { ...source, view: "edit" };
  assert.equal(matchesCollectionImportSource(source, current), true);
  for (const patch of [{ name: "other.yaml" }, { content: "mode: direct" }, { sha256: "newer" }, { view: "runtime" }]) {
    assert.equal(matchesCollectionImportSource(source, { ...current, ...patch }), false);
  }
});
