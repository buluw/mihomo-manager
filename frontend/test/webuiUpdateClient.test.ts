import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"
import { checkWebUiUpdate, prepareWebUiDownload, installWebUiUpdate, rollbackWebUiUpdate, uploadWebUi, readWebUiUpdate, readUpdatePolicy, saveUpdatePolicy } from "../src/api/webuiUpdateClient.ts"
import { webUiRequestMessage } from "../src/shared/webuiUpdateMessages.ts"
import { SystemError, installCoreUpdate, readCoreUpdate } from "../src/api/systemClient.ts"

test("Web UI uses fixed product endpoints, raw uploads and identity-bound installation", async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous })
  const calls: Array<[string, RequestInit | undefined]> = []
  globalThis.fetch = async (url, options) => { calls.push([String(url), options]); return new Response("{}") }
  const file = new File(["runtime package"], "runtime.tar.gz")
  await readWebUiUpdate(); await checkWebUiUpdate({ mode: "core" }); await prepareWebUiDownload({ mode: "direct", source: "custom", url: "https://example.test/webui.tar.gz" })
  await uploadWebUi(file); await installWebUiUpdate("candidate"); await rollbackWebUiUpdate("previous"); await readUpdatePolicy()
  const settings = { autoCheck: true, autoDownload: false, scheduledInstall: false, intervalHours: 24, installTime: "03:00", mode: "direct" as const, source: "github" as const }
  await saveUpdatePolicy(settings, 3)
  assert.deepEqual(calls.map(([url, options]) => [url, options?.method]), [
    ["/api/system/webui/update", "GET"], ["/api/system/webui/update/check", "POST"], ["/api/system/webui/update/download", "POST"],
    ["/api/system/webui/update/upload", "POST"], ["/api/system/webui/update/install", "POST"], ["/api/system/webui/update/rollback", "POST"],
    ["/api/system/updates/settings", "GET"], ["/api/system/updates/settings", "POST"],
  ])
  assert.equal(calls[3]![1]!.body, file)
  assert.deepEqual(JSON.parse(calls[4]![1]!.body as string), { sha256: "candidate" })
  assert.deepEqual(JSON.parse(calls[7]![1]!.body as string), { settings, expectedRevision: 3 })
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "webui_policy_changed" }), { status: 409 })
  await assert.rejects(saveUpdatePolicy(settings, 3), error => webUiRequestMessage(error as Error).includes("草稿保留"))
  globalThis.fetch = async () => { throw new Error("private URL with credentials") }
  await assert.rejects(readWebUiUpdate(), error => !webUiRequestMessage(error as Error).includes("credentials"))
  for (const status of [502, 503, 504]) {
    globalThis.fetch = async () => new Response("<html>gateway unavailable</html>", { status })
    for (const read of [readWebUiUpdate, readCoreUpdate]) await assert.rejects(read(), error =>
      error instanceof SystemError && error.code === "update_request_unconfirmed" && error.status === status)
  }
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "webui_recovery_failed" }), { status: 503 })
  await assert.rejects(readWebUiUpdate(), error => error instanceof SystemError && error.code === "webui_recovery_failed")
})

test("accepted update headers followed by a broken body can recover through a status read", { timeout: 5000 }, async t => {
  const originalFetch = globalThis.fetch
  const calls: Array<[string, string]> = []
  const terminal = { phase: "succeeded", busy: false, error: null }
  const server = createServer((request, response) => {
    calls.push([request.method!, request.url!]); request.resume()
    if (request.method === "POST") {
      response.writeHead(202, { "Content-Type": "application/json", "Content-Length": "64" })
      response.flushHeaders(); response.write('{"accepted":')
      setTimeout(() => response.destroy(), 30)
    } else response.end(JSON.stringify(terminal))
  })
  t.after(() => { globalThis.fetch = originalFetch; server.closeAllConnections(); server.close() })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  globalThis.fetch = (input, options) => originalFetch("http://127.0.0.1:" + address.port + input, options)
  for (const [operate, read] of [[installWebUiUpdate, readWebUiUpdate], [rollbackWebUiUpdate, readWebUiUpdate], [installCoreUpdate, readCoreUpdate]] as const) {
    await assert.rejects(operate("candidate"), error => error instanceof SystemError && error.code === "update_request_unconfirmed" && error.status === 202)
    assert.deepEqual(await read(), terminal)
  }
  assert.deepEqual(calls, [
    ["POST", "/api/system/webui/update/install"], ["GET", "/api/system/webui/update"],
    ["POST", "/api/system/webui/update/rollback"], ["GET", "/api/system/webui/update"],
    ["POST", "/api/system/core/update/install"], ["GET", "/api/system/core/update"],
  ])
})

test("body handling preserves cancellation, HTTP rejections and completed invalid JSON", async t => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch })
  for (const status of [202, 409]) {
    const abort = new AbortController(), reason = new DOMException("Cancelled", "AbortError")
    globalThis.fetch = async () => new Response(new ReadableStream({ pull(controller) { abort.abort(reason); controller.error(reason) } }), { status })
    await assert.rejects(installWebUiUpdate("candidate", abort.signal), error => error === reason)
  }
  for (const [status, code] of [[400, "candidate_changed"], [409, "core_action_busy"], [503, "webui_recovery_failed"]] as const) {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: code }), { status })
    await assert.rejects(installWebUiUpdate("candidate"), error => error instanceof SystemError && error.code === code && error.status === status)
  }
  globalThis.fetch = async () => new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError("terminated")) } }), { status: 409 })
  await assert.rejects(installWebUiUpdate("candidate"), error => error instanceof SystemError && error.code === "update_failed" && error.status === 409)
  globalThis.fetch = async () => new Response("invalid JSON", { status: 202 })
  await assert.rejects(installWebUiUpdate("candidate"), SyntaxError)
})
