import test from "node:test"
import assert from "node:assert/strict"
import { accessFetch, getAccessState, refreshAccess } from "../src/api/accessClient.ts"

test("session loss pauses reads, resumes after login, and does not replay writes", async () => {
  const original = globalThis.fetch
  let authenticated = true
  let reads = 0, writes = 0
  globalThis.fetch = async (input, options) => {
    if (String(input) === "/api/access/status") return Response.json({ enabled: true, authenticated, expiresAt: null })
    if (options?.method === "POST") { writes++; return new Response(null, { status: 401, headers: { "X-Access-State": "required" } }) }
    reads++
    return authenticated ? Response.json({ preserved: true }) : new Response(null, { status: 401, headers: { "X-Access-State": "required" } })
  }
  try {
    await refreshAccess()
    authenticated = false
    let completed = false
    const read = accessFetch("/api/config/files").then(response => { completed = true; return response })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(getAccessState().phase, "login")
    assert.equal(completed, false)
    assert.equal(reads, 1)
    await assert.rejects(accessFetch("/api/config/files", { method: "POST" }), { code: "access_required" })
    assert.equal(writes, 0)
    authenticated = true
    await refreshAccess()
    assert.deepEqual(await (await read).json(), { preserved: true })
    assert.equal(reads, 2)
    await assert.rejects(accessFetch("/api/config/files", { method: "POST" }), { code: "access_required" })
    assert.equal(writes, 1)
    await refreshAccess()
    assert.equal(writes, 1)
  } finally { globalThis.fetch = original }
})

test("Controller authentication failure does not invalidate the website session", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 401 })
  try {
    assert.equal((await accessFetch("/api/controller/version")).status, 401)
    assert.equal(getAccessState().phase, "ready")
  } finally { globalThis.fetch = original }
})

test("paused reads remain cancellable and authentication read failures fail closed", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 503 })
  try {
    await refreshAccess()
    assert.equal(getAccessState().phase, "unavailable")
    const abort = new AbortController()
    const read = accessFetch("/api/system/interfaces", { signal: abort.signal })
    abort.abort()
    await assert.rejects(read, { name: "AbortError" })
    globalThis.fetch = async () => Response.json({ enabled: false, authenticated: true, expiresAt: null })
    await refreshAccess()
  } finally { globalThis.fetch = original }
})
