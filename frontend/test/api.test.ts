import assert from "node:assert/strict";
import test from "node:test";
import { SharedControllerStreams, subscribeControllerStream } from "../src/api/sharedControllerStreams.ts";
import { healthCheckCollectionProvider } from "../src/features/providers/providerOperations.ts";

import {
  ControllerError,
  controllerSecretState,
  controllerApi,
  flushFakeIpCache,
  loadControllerConfig,
  readControllerRules,
  restartController,
  setControllerSecret,
  subscribeController,
} from "../src/api/controllerClient.ts";
import {
  configApi,
  createLocalProviderExtraction,
  previewLocalProviderExtraction,
  readProviderDeclaration,
  readProviderPayload,
  readProxyMergeSettings,
  readProxyNodeSettings,
  refreshProxyCountries,
  saveProxyMergeSettings,
  saveProxyNodeInfo,
  saveProxyNodeSettings,
  saveLocalProviderExtractionSettings,
  saveManagedProviderFilterSettingsOnly,
  regenerateLocalProviderExtraction,
  renameLocalProviderExtraction,
  setLocalProviderExtractionEnabled,
  saveSubscriptionFilterSettings,
  previewSubscriptionFilter,
} from "../src/api/configClient.ts";

test("Controller transport distinguishes timeouts, caller cancellation and connection failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  try {
    globalThis.fetch = async () => { throw new TypeError("unavailable"); };
    await assert.rejects(controllerApi("/version"), { message: "Controller 连接失败" });
    const cancelled = new DOMException("cancelled", "AbortError");
    globalThis.fetch = async () => { throw cancelled; };
    await assert.rejects(controllerApi("/version"), (error) => error === cancelled);
    const timeout = new AbortController();
    AbortSignal.timeout = () => timeout.signal;
    timeout.abort(new DOMException("deadline", "TimeoutError"));
    await assert.rejects(controllerApi("/version"), { name: "TimeoutError", message: "Controller 请求超时" });
    const caller = new AbortController();
    caller.abort(cancelled);
    await assert.rejects(controllerApi("/version", { signal: caller.signal }), (error) => error === cancelled);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});

test("a seven-second provider health check succeeds and caller cancellation remains effective", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/api/controller/providers/proxies/slow/healthcheck");
    assert.equal(init?.method ?? "GET", "GET");
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const abort = () => { clearTimeout(timer); reject(signal?.reason); };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve(new Response(null, { status: 204 }));
      }, 7_000);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  };
  try {
    await healthCheckCollectionProvider("slow", new AbortController().signal);
    const caller = new AbortController();
    const operation = healthCheckCollectionProvider("slow", caller.signal);
    caller.abort();
    await assert.rejects(operation, { name: "AbortError" });
  } finally { globalThis.fetch = originalFetch; }
});

test("proxy node settings use fixed configd paths and never call Controller", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input).endsWith("/rename")) return new Response(JSON.stringify({
      config: { name: "fixture.yaml", path: "fixture.yaml", content: "", sha256: "b".repeat(64) },
      settings: { schemaVersion: 1, version: 2, regions: [] },
    }), { headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ schemaVersion: 1, version: 1, regions: [] }), { headers: { "content-type": "application/json" } });
  };
  try {
    await readProxyNodeSettings();
    await saveProxyNodeSettings({ schemaVersion: 1, version: 1, regions: [] });
    await saveProxyNodeInfo({
      configName: "fixture.yaml", content: "proxies: []\n", expectedSha256: "a".repeat(64), settingsVersion: 1,
      from: { provider: "", name: "old" }, to: { provider: "", name: "new" }, region: "Region",
    });
    assert.deepEqual(requests.map((entry) => [entry.url, entry.init?.method ?? "GET"]), [
      ["/api/config/proxy-node-settings", "GET"],
      ["/api/config/proxy-node-settings", "PUT"],
      ["/api/config/proxy-node-settings/rename", "PUT"],
    ]);
    assert.equal(requests.some((entry) => entry.url.includes("/api/controller")), false);
    const renameBody = JSON.parse(String(requests[2]?.init?.body));
    assert.equal(renameBody.expectedVersion, 1);
    assert.equal(renameBody.expectedSha256, "a".repeat(64));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function installSessionSecret(secret: string) {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) =>
        key === "mihomo-controller-secret" ? secret : null,
      setItem: () => {},
      removeItem: () => {},
    },
  });
}

test("controller requests preserve native paths and add bearer authorization", async () => {
  installSessionSecret("test-secret");
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({ version: "v1.19.29" }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await controllerApi<{ version: string }>("/version");
    assert.equal(capturedUrl, "/api/controller/version");
    assert.equal(new Headers(capturedInit?.headers).get("Authorization"), "Bearer test-secret");
    assert.equal(result.version, "v1.19.29");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime rules use the native Controller path, preserve fields, and accept cancellation", async () => {
  installSessionSecret("");
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({
      rules: [
        { type: "DOMAIN-SUFFIX", payload: "cached.example", proxy: "DIRECT" },
        { type: "MATCH", payload: "", proxy: "Proxy" },
      ],
    }), { headers: { "content-type": "application/json" } });
  };
  const caller = new AbortController();
  try {
    const response = await readControllerRules(caller.signal);
    assert.equal(capturedUrl, "/api/controller/rules");
    assert.equal(capturedInit?.method ?? "GET", "GET");
    assert.deepEqual(response.rules, [
      { type: "DOMAIN-SUFFIX", payload: "cached.example", proxy: "DIRECT" },
      { type: "MATCH", payload: "", proxy: "Proxy" },
    ]);
    caller.abort();
    assert.equal(capturedInit?.signal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("REST client accepts text and empty 204 responses", async () => {
  installSessionSecret("");
  const originalFetch = globalThis.fetch;
  const responses = [
    new Response("ok", { headers: { "content-type": "text/plain" } }),
    new Response(null, { status: 204 }),
  ];
  globalThis.fetch = async () => responses.shift()!;
  try {
    assert.equal(await controllerApi<string>("/version"), "ok");
    assert.equal(
      await controllerApi<void>("/proxies/example", { method: "PUT" }),
      undefined,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("full configuration loads use the long controller timeout", async () => {
  installSessionSecret("");
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  let timeoutMs = 0;
  AbortSignal.timeout = ((delay: number) => {
    timeoutMs = delay;
    return new AbortController().signal;
  }) as typeof AbortSignal.timeout;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    await loadControllerConfig();
    assert.equal(timeoutMs, 30_000);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});

test("Controller HTTP failures expose status without echoing response content", async () => {
  installSessionSecret("");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("sensitive controller detail", { status: 400 });
  try {
    await assert.rejects(
      loadControllerConfig("/srv/mihomo/empty.yaml"),
      (error: ControllerError) =>
        error.status === 400 &&
        error.message === "Controller 请求失败 (400)" &&
        !error.message.includes("sensitive controller detail"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("core maintenance actions use Mihomo native endpoints", async () => {
  installSessionSecret("");
  const requests: { url: string; method: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method || "GET" });
    return new Response(null, { status: 204 });
  };
  try {
    await restartController();
    await flushFakeIpCache();
    assert.deepEqual(requests, [
      { url: "/api/controller/restart", method: "POST" },
      { url: "/api/controller/cache/fakeip/flush", method: "POST" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("config requests use only the fixed configd namespace", async () => {
  installSessionSecret("must-not-be-forwarded");
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input).endsWith("/preview")) return Response.json({ totalCount: 2, remainingCount: 1, matchedNames: ["notice"] });
    if (String(input).includes("/subscriptions/") && String(input).endsWith("/filter-settings")) return Response.json({ version: 1, enabled: true, rules: ["notice"] });
    if (String(input).endsWith("/filter-settings")) return Response.json({ settings: {}, provider: { category: "proxy", name: "local", nodeCount: 1 } });
    return Response.json({ category: "proxy", name: "local", nodeCount: 1 });
  };
  try {
    await createLocalProviderExtraction({
      configName: "local.yaml", sourceSha256: "a".repeat(64), fileName: "local.yaml",
      enabled: false, filterSettings: { enabled: true, rules: ["notice"] },
    });
    await previewLocalProviderExtraction("relation", ["notice & expired"]);
    await saveLocalProviderExtractionSettings("relation", { version: 3, enabled: true, rules: ["notice & expired"] });
    await regenerateLocalProviderExtraction("relation");
    await setLocalProviderExtractionEnabled("relation", false);
    await renameLocalProviderExtraction("relation", "renamed.yaml");
    await saveSubscriptionFilterSettings("subscription-id", { version: 0, enabled: true, rules: ["notice"] });
    await previewSubscriptionFilter("subscription-id", ["notice"]);
    await saveManagedProviderFilterSettingsOnly("proxy", "subscription.yaml", { version: 2, enabled: true, rules: ["notice"] });
    assert.deepEqual(requests.map((entry) => [entry.url, entry.init?.method ?? "GET"]), [
      ["/api/config/local-provider-extractions", "POST"],
      ["/api/config/local-provider-extractions/relation/preview", "POST"],
      ["/api/config/local-provider-extractions/relation/filter-settings", "PUT"],
      ["/api/config/local-provider-extractions/relation/update", "POST"],
      ["/api/config/local-provider-extractions/relation", "PUT"],
      ["/api/config/local-provider-extractions/relation/rename", "POST"],
      ["/api/config/subscriptions/subscription-id/filter-settings", "PUT"],
      ["/api/config/subscriptions/subscription-id/filter-preview", "POST"],
      ["/api/config/managed-providers/proxy/subscription.yaml/filter-settings-only", "PUT"],
    ]);
    assert.equal(requests.every((entry) => !new Headers(entry.init?.headers).has("Authorization")), true);
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      configName: "local.yaml",
      sourceSha256: "a".repeat(64),
      fileName: "local.yaml",
      enabled: false,
      filterSettings: { enabled: true, rules: ["notice"] },
    });
    assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), {
      expectedVersion: 3,
      enabled: true,
      rules: ["notice & expired"],
    });
    assert.deepEqual(JSON.parse(String(requests[4]?.init?.body)), { enabled: false });
    assert.deepEqual(JSON.parse(String(requests[5]?.init?.body)), { fileName: "renamed.yaml" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("country recognition uses the fixed configd endpoint and long timeout", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  let timeoutMs = 0;
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = ((delay: number) => {
    timeoutMs = delay;
    return new AbortController().signal;
  }) as typeof AbortSignal.timeout;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedMethod = init?.method || "GET";
    return new Response(JSON.stringify({
      addresses: { inline: {}, providers: {}, countries: {} },
      recognized: 0,
      failed: 0,
    }), { headers: { "content-type": "application/json" } });
  };
  try {
    await refreshProxyCountries();
    assert.equal(capturedUrl, "/api/config/proxy-addresses/countries");
    assert.equal(capturedMethod, "POST");
    assert.equal(timeoutMs, 5 * 60_000);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});

test("proxy merge settings use fixed configd paths and preserve version conflicts", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method || "GET", body: String(init?.body || "") });
    if (init?.method === "PUT") return new Response(JSON.stringify({ error: "proxy_merge_settings_conflict" }), { status: 409 });
    return new Response(JSON.stringify({ schemaVersion: 1, version: 3, groups: [], exclusions: [] }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const settings = await readProxyMergeSettings();
    await assert.rejects(saveProxyMergeSettings(settings), (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "proxy_merge_settings_conflict"
    ));
    assert.equal(requests[0]?.url, "/api/config/proxy-merge-settings");
    assert.equal(requests[1]?.url, "/api/config/proxy-merge-settings");
    assert.equal(requests[1]?.method, "PUT");
    assert.deepEqual(JSON.parse(requests[1]?.body || "{}"), {
      expectedVersion: 3,
      groups: [],
      exclusions: [],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider declaration and payload use fixed configd namespaces and preserve YAML text", async () => {
  const capturedUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    capturedUrls.push(String(input));
    return new Response("# original\nproxies: []\n", {
      headers: { "content-type": "application/yaml" },
    });
  };
  try {
    const source = { name: "selected.yaml", sha256: "abc" };
    assert.equal(
      await readProviderDeclaration("proxy", "provider/name", undefined, source),
      "# original\nproxies: []\n",
    );
    assert.equal(await readProviderPayload("proxy", "provider/name", undefined, source), "# original\nproxies: []\n");
    assert.deepEqual(capturedUrls, [
      "/api/config/provider-configs/proxy/provider%2Fname?configName=selected.yaml&sha256=abc",
      "/api/config/provider-files/proxy/provider%2Fname?configName=selected.yaml&sha256=abc",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("controller errors do not echo response bodies or credentials", async () => {
  installSessionSecret("secret-that-must-not-leak");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("token=secret-that-must-not-leak", { status: 401 });
  try {
    await assert.rejects(
      controllerApi("/configs"),
      (error: Error) =>
        error.message === "Controller 请求失败 (401)" &&
        !error.message.includes("secret-that-must-not-leak"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Controller Secret can remain memory-only without being readable from session storage", async () => {
  let stored = "";
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: () => stored || null,
      setItem: (_key: string, value: string) => { stored = value; },
      removeItem: () => { stored = ""; },
    },
  });
  setControllerSecret("memory-secret", false);
  let authorization = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("Authorization") || "";
    return new Response(JSON.stringify({ version: "test" }), { headers: { "content-type": "application/json" } });
  };
  try {
    await controllerApi("/version");
    assert.equal(stored, "");
    assert.deepEqual(controllerSecretState(), { configured: true, remembered: false });
    assert.equal(authorization, "Bearer memory-secret");
  } finally {
    setControllerSecret("", false);
    globalThis.fetch = originalFetch;
  }
});

test("Controller native HTTP streams preserve data and release subscriptions", async (t) => {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: { setTimeout, clearTimeout },
  });
  const waitUntil = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !ready(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(ready(), true);
  };
  try {
    await t.test("split UTF-8 and multiple native lines retain fields and header authentication", async () => {
      installSessionSecret("test-stream-secret");
      const data: unknown[] = [];
      const states: boolean[] = [];
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let signal: AbortSignal | null | undefined;
      let canceled = 0;
      const body = new ReadableStream<Uint8Array>({
        start: (next) => { controller = next; }, cancel: () => { canceled++; },
      });
      const stop = subscribeControllerStream("/traffic", "test-stream-secret", (value) => data.push(value), (state) => states.push(state),
        async (url, init) => {
          assert.equal(url, "/api/controller/traffic");
          assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-stream-secret");
          signal = init?.signal;
          return new Response(body);
        });
      try {
        await waitUntil(() => states.includes(true));
        const bytes = new TextEncoder().encode('{"up":7,"label":"流量"}\ninvalid\n{"down":9}\n');
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        await waitUntil(() => data.length === 2);
        assert.deepEqual(data, [{ up: 7, label: "流量" }, { down: 9 }]);
        stop();
        assert.equal(signal?.aborted, true);
        // A transport may deliver an already buffered chunk after abort.
        controller.enqueue(new TextEncoder().encode('{"up":999}\n'));
        await waitUntil(() => canceled === 1);
        assert.equal(data.length, 2);
        assert.deepEqual(states, [true]);
      } finally { stop(); }
    });

    await t.test("disposing before headers cancels a late response without publishing or reconnecting", async () => {
      let resolve!: (response: Response) => void;
      let signal: AbortSignal | null | undefined;
      let canceled = 0;
      let requests = 0;
      const stop = subscribeControllerStream("/memory", "", assert.fail, assert.fail, (_url, init) => {
        requests++;
        signal = init?.signal;
        return new Promise<Response>((done) => { resolve = done; });
      }, 0);
      stop();
      assert.equal(signal?.aborted, true);
      resolve(new Response(new ReadableStream({ cancel: () => { canceled++; } })));
      await waitUntil(() => canceled === 1);
      await new Promise((done) => setTimeout(done, 5));
      assert.equal(requests, 1);
    });

    await t.test("opening timeout, HTTP failure and EOF reconnect with one active stream", async () => {
      const states: boolean[] = [];
      const data: unknown[] = [];
      let attempts = 0;
      let firstSignal: AbortSignal | null | undefined;
      let finalSignal: AbortSignal | null | undefined;
      const stop = subscribeControllerStream("/memory", "", (value) => data.push(value), (state) => states.push(state),
        async (_url, init) => {
          attempts++;
          if (attempts === 1) {
            firstSignal = init?.signal;
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("sensitive detail")), { once: true });
            });
          }
          if (attempts === 2) return new Response("sensitive body", { status: 503 });
          if (attempts === 3) return new Response('{"inuse":42}\n');
          finalSignal = init?.signal;
          return new Response(new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
            },
          }));
        }, 0, 10);
      try {
        await waitUntil(() => attempts === 4 && states.at(-1) === true);
        assert.equal(firstSignal?.aborted, true);
        assert.deepEqual(data, [{ inuse: 42 }]);
        assert.deepEqual(states, [false, false, true, false, true]);
        stop();
        assert.equal(finalSignal?.aborted, true);
        await new Promise((done) => setTimeout(done, 20));
        assert.equal(attempts, 4);
      } finally { stop(); }
    });
  } finally {
    installSessionSecret("");
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

async function waitForStreamCheck(ready: () => boolean) {
  for (let attempt = 0; attempt < 100 && !ready(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(ready(), true);
}

test("three tab ports share native streams, preserve authentication isolation and stop only after the last subscriber", async () => {
  const requests: Array<{
    path: string; secret: string | null; signal: AbortSignal;
    body: ReadableStreamDefaultController<Uint8Array>;
  }> = [];
  const hub = new SharedControllerStreams((path, secret, onData, onState) =>
    subscribeControllerStream(path, secret, onData, onState, async (url, init) => {
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        body = controller;
        init!.signal!.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      } });
      requests.push({ path: String(url), secret: new Headers(init?.headers).get("Authorization"), signal: init!.signal!, body });
      return new Response(stream);
    }, 0));
  const clients: Array<{ port: MessagePort; received: Array<{ type: string; data?: unknown; connected?: boolean }> }> = [];
  const join = (path: "/traffic" | "/memory", secret = "shared-fixture") => {
    const { port1, port2 } = new MessageChannel();
    hub.connect(port1);
    const client = { port: port2, received: [] as Array<{ type: string; data?: unknown; connected?: boolean }> };
    port2.onmessage = ({ data }) => client.received.push(data);
    port2.postMessage({ type: "subscribe", path, secret });
    clients.push(client);
    return client;
  };
  const leave = (client: typeof clients[number]) => {
    client.port.postMessage({ type: "unsubscribe" });
    client.port.close();
  };
  try {
    for (let tab = 0; tab < 3; tab++) { join("/traffic"); join("/memory"); }
    await waitForStreamCheck(() => clients.every((client) => client.received.some((event) => event.connected)));
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(({ path }) => path).sort(), ["/api/controller/memory", "/api/controller/traffic"]);
    assert.ok(requests.every(({ secret }) => secret === "Bearer shared-fixture"));
    for (const request of requests) request.body.enqueue(new TextEncoder().encode('{"native":1}\n'));
    await waitForStreamCheck(() => clients.every((client) => client.received.some((event) => event.type === "data")));
    leave(clients[0]); leave(clients[1]);
    const refreshed = [join("/traffic"), join("/memory")];
    await waitForStreamCheck(() => refreshed.every((client) => client.received.some((event) => event.type === "data")));
    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ signal }) => !signal.aborted));
    const otherAuth = join("/memory", "different-fixture");
    await waitForStreamCheck(() => otherAuth.received.some((event) => event.connected));
    assert.equal(requests.length, 3);
    assert.equal(requests[2].secret, "Bearer different-fixture");
    for (const request of requests.slice(0, 2)) request.body.enqueue(new TextEncoder().encode('{"native":2}\n'));
    await waitForStreamCheck(() => refreshed.every((client) => client.received.filter((event) => event.type === "data").length === 2));
    assert.equal(otherAuth.received.some((event) => event.type === "data"), false);
    // Removing two tabs leaves the refreshed tab's shared upstream intact.
    for (const client of clients.slice(2, 6)) leave(client);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(requests.slice(0, 2).every(({ signal }) => !signal.aborted));
    for (const client of refreshed) leave(client);
    await waitForStreamCheck(() => requests.slice(0, 2).every(({ signal }) => signal.aborted));
    assert.equal(requests[2].signal.aborted, false);
    leave(otherAuth);
    await waitForStreamCheck(() => requests.every(({ signal }) => signal.aborted));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(requests.length, 3);
  } finally {
    for (const client of clients) leave(client);
  }
});

test("page exit releases its port, bfcache return resubscribes and disposed ports cannot publish", () => {
  const originalWindow = globalThis.window;
  const target = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  const workers: Array<{ port: { onmessage: ((event: { data: unknown }) => void) | null; close: () => void; start: () => void; postMessage: (data: unknown) => void }; onerror: unknown }> = [];
  const commands: unknown[] = [];
  const values: unknown[] = [];
  let closed = 0;
  const createWorker = () => {
    const worker = { port: { onmessage: null as ((event: { data: unknown }) => void) | null,
      close: () => { closed++; }, start: () => {}, postMessage: (data: unknown) => commands.push(data),
    }, onerror: null };
    workers.push(worker);
    return worker as unknown as SharedWorker;
  };
  installSessionSecret("port-fixture");
  const stop = subscribeController("/traffic", (data) => values.push(data), undefined, createWorker);
  try {
    workers[0].port.onmessage?.({ data: { type: "data", data: { up: 1 } } });
    target.dispatchEvent(new Event("pagehide"));
    workers[0].port.onmessage?.({ data: { type: "data", data: { up: 2 } } });
    target.dispatchEvent(new Event("pageshow"));
    workers[1].port.onmessage?.({ data: { type: "data", data: { up: 3 } } });
    stop();
    workers[1].port.onmessage?.({ data: { type: "data", data: { up: 4 } } });
    target.dispatchEvent(new Event("pageshow"));
    assert.deepEqual(values, [{ up: 1 }, { up: 3 }]);
    assert.equal(workers.length, 2);
    assert.equal(closed, 2);
    assert.deepEqual(commands, [
      { type: "subscribe", path: "/traffic", secret: "port-fixture" }, { type: "unsubscribe" },
      { type: "subscribe", path: "/traffic", secret: "port-fixture" }, { type: "unsubscribe" },
    ]);
  } finally {
    stop();
    installSessionSecret("");
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("failed SharedWorker startup retries once and ignores events from the failed port", () => {
  const originalWindow = globalThis.window;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const target = Object.assign(new EventTarget(), {
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  const workers: Array<{
    port: { onmessage: ((event: { data: unknown }) => void) | null; start: () => void; close: () => void; postMessage: (data: unknown) => void };
    onerror: (() => void) | null;
  }> = [];
  const commands: unknown[] = [];
  const values: unknown[] = [];
  const states: boolean[] = [];
  let closed = 0;
  const createWorker = () => {
    const worker = {
      port: { onmessage: null as ((event: { data: unknown }) => void) | null, start: () => {},
        close: () => { closed++; }, postMessage: (data: unknown) => commands.push(data),
      }, onerror: null as (() => void) | null,
    };
    workers.push(worker);
    return worker as unknown as SharedWorker;
  };
  const stop = subscribeController("/traffic", (value) => values.push(value), (state) => states.push(state), createWorker);
  try {
    const lateError = workers[0].onerror!;
    const lateMessage = workers[0].port.onmessage!;
    lateError();
    lateError();
    target.dispatchEvent(new Event("pageshow"));
    assert.equal(closed, 1);
    assert.equal(workers[0].port.onmessage, null);
    assert.equal(workers[0].onerror, null);
    assert.deepEqual(commands.at(-1), { type: "unsubscribe" });
    assert.equal(timers.size, 1);
    assert.equal(workers.length, 1);
    const [id, callback] = [...timers][0];
    timers.delete(id);
    callback();
    assert.equal(workers.length, 2);
    workers[1].port.onmessage?.({ data: { type: "state", connected: true } });
    workers[1].port.onmessage?.({ data: { type: "data", data: { up: 42 } } });
    lateError();
    lateMessage({ data: { type: "data", data: { up: 999 } } });
    lateMessage({ data: { type: "state", connected: false } });
    assert.deepEqual(values, [{ up: 42 }]);
    assert.deepEqual(states, [false, true]);
    assert.equal(timers.size, 0);
    assert.equal(closed, 1);
  } finally {
    stop();
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("pagehide and disposal cancel pending Worker retries; pageshow resumes only a live subscription", () => {
  const originalWindow = globalThis.window;
  try {
    for (const exit of ["pagehide", "dispose"] as const) {
      const timers = new Map<number, () => void>();
      let timerId = 0;
      const target = Object.assign(new EventTarget(), {
        setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: (id: number) => { timers.delete(id); },
      });
      Object.defineProperty(globalThis, "window", { configurable: true, value: target });
      let attempts = 0;
      let error: (() => void) | null = null;
      let closed = 0;
      const stop = subscribeController("/memory", assert.fail, () => {}, () => {
        attempts++;
        const worker = {
          port: { onmessage: null, start: () => {}, postMessage: () => {}, close: () => { closed++; } },
          get onerror() { return error; }, set onerror(value: (() => void) | null) { error = value; },
        };
        return worker as unknown as SharedWorker;
      });
      try {
        const lateError = error!;
        lateError();
        assert.equal(timers.size, 1);
        const pending = [...timers.values()][0];
        if (exit === "pagehide") target.dispatchEvent(new Event("pagehide"));
        else stop();
        assert.equal(timers.size, 0);
        assert.equal(closed, 1);
        // Even a timer/error already queued when exiting must not reopen the port.
        pending();
        lateError();
        assert.equal(attempts, 1);
        target.dispatchEvent(new Event("pageshow"));
        assert.equal(attempts, exit === "pagehide" ? 2 : 1);
        assert.equal(timers.size, 0);
      } finally { stop(); }
    }
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});
