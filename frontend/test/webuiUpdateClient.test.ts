import assert from "node:assert/strict"
import test from "node:test"
import { checkWebUiUpdate, prepareWebUiDownload, installWebUiUpdate, rollbackWebUiUpdate, uploadWebUi, readWebUiUpdate, readUpdatePolicy, saveUpdatePolicy } from "../src/api/webuiUpdateClient.ts"
import { webUiRequestMessage } from "../src/shared/webuiUpdateMessages.ts"

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
})
