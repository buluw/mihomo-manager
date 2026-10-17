import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createConnection } from "node:net";
import { AccessStore, AccessError } from "../src/access/store.js";
import { AccessSessions, COOKIE_NAME } from "../src/access/sessions.js";
import { AccessGateway } from "../src/access/http.js";
import { AccessStreams } from "../src/access/streams.js";
import { createSysinfoServer } from "../src/server.js";

const password = "fixture-access-2026";
const cookie = (value: string | null) => COOKIE_NAME + "=" + value;
async function fixture(t: test.TestContext, lifetime?: number) {
  const directory = await mkdtemp(join(tmpdir(), "manager-access-"));
  const store = new AccessStore(directory);
  const sessions = new AccessSessions(store, lifetime);
  await sessions.ready;
  t.after(async () => { sessions.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, sessions };
}
async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return "http://127.0.0.1:" + address.port;
}

test("password lifecycle persists salted hashes and revokes all old sessions", async t => {
  const { directory, store, sessions } = await fixture(t);
  assert.deepEqual(sessions.status(), { enabled: false, authenticated: true, expiresAt: null });
  let anonymousClosed = false;
  sessions.watch(undefined, () => { anonymousClosed = true; });
  await assert.rejects(sessions.update(undefined, "enable", null, "short"), { code: "invalid_password" });
  const first = cookie(await sessions.update(undefined, "enable", null, password));
  assert.ok(anonymousClosed);
  assert.equal(sessions.status().authenticated, false);
  assert.equal(sessions.status(first).authenticated, true);
  const persisted = await readFile(join(directory, "settings.json"), "utf8");
  assert.equal(persisted.includes(password), false);
  assert.equal(JSON.parse(persisted).password.hash.length, 128);
  await assert.rejects(sessions.login("incorrect"), { code: "invalid_credentials" });
  const second = cookie(await sessions.login(password));
  let firstClosed = false, secondClosed = false;
  sessions.watch(first, () => { firstClosed = true; });
  sessions.watch(second, () => { secondClosed = true; });
  sessions.logout(first);
  assert.ok(firstClosed); assert.equal(secondClosed, false);
  await assert.rejects(sessions.update(second, "password", "wrong", password), { code: "invalid_credentials" });
  await sessions.update(second, "password", password, "changed-fixture-2026");
  assert.ok(secondClosed); assert.equal(sessions.status(second).authenticated, false);
  await assert.rejects(sessions.login(password), { code: "invalid_credentials" });
  const third = cookie(await sessions.login("changed-fixture-2026"));
  const restarted = new AccessSessions(store);
  await restarted.ready;
  assert.equal(restarted.status(third).authenticated, false);
  assert.ok(await restarted.login("changed-fixture-2026"));
  restarted.dispose();
  await sessions.update(third, "disable", "changed-fixture-2026", null);
  assert.equal(sessions.status().enabled, false);
  assert.equal((await store.read()).password, null);
});

test("expiry closes established connections without a later request", async t => {
  const { sessions } = await fixture(t, 60);
  const session = cookie(await sessions.update(undefined, "enable", null, password));
  let closed = false;
  sessions.watch(session, () => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.ok(closed);
  assert.equal(sessions.status(session).authenticated, false);
});

test("storage errors fail closed and failed saves retain the active state", async t => {
  const { directory, store, sessions } = await fixture(t);
  const session = cookie(await sessions.update(undefined, "enable", null, password));
  store.save = async () => { throw new AccessError("access_unavailable", 503); };
  await assert.rejects(sessions.update(session, "disable", password, null), { code: "access_unavailable" });
  assert.equal(sessions.status(session).enabled, true);
  await writeFile(join(directory, "settings.json"), "corrupt");
  const broken = new AccessSessions(new AccessStore(directory));
  await broken.ready;
  assert.throws(() => broken.status(), { code: "access_unavailable" });
  broken.dispose();
  await rm(join(directory, "settings.json"));
  const missing = new AccessSessions(new AccessStore(directory));
  await missing.ready;
  assert.throws(() => missing.status(), { code: "access_unavailable" });
  missing.dispose();
});

test("HTTP access checks Origin and distinguishes password errors from lost sessions", async t => {
  const { sessions } = await fixture(t);
  const gateway = new AccessGateway(sessions);
  const server = createSysinfoServer(async () => [], undefined, undefined, undefined, gateway);
  const base = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = (path: string, body: object, session = "", origin = base) => fetch(base + path, {
    method: "POST", headers: { Origin: origin, Cookie: session, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await request("/access/enable", { password }, "", "http://foreign.invalid")).status, 403);
  const enable = await request("/access/enable", { password });
  assert.equal(enable.status, 200);
  const session = enable.headers.get("set-cookie")!;
  assert.match(session, /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(base + "/interfaces")).headers.get("x-access-state"), "required");
  assert.equal((await fetch(base + "/interfaces", { headers: { Cookie: session } })).status, 200);
  const wrong = await request("/access/password", { currentPassword: "wrong", password }, session);
  assert.equal(wrong.status, 401); assert.equal(wrong.headers.get("x-access-state"), null);
  const verify = await fetch(base + "/access/verify", { headers: { Cookie: session, "X-Access-Method": "POST", "X-Access-Origin": "http://foreign.invalid" } });
  assert.equal(verify.status, 403);
  await request("/access/logout", {}, session);
  assert.equal((await fetch(base + "/interfaces", { headers: { Cookie: session } })).status, 401);
});

test("logout closes each HTTP stream upstream and blocks reconnection", async t => {
  const { sessions } = await fixture(t);
  const session = cookie(await sessions.update(undefined, "enable", null, password));
  const peers = new Set<import("node:http").ServerResponse>();
  const upstream = createServer((_request, response) => {
    peers.add(response);
    response.on("close", () => peers.delete(response));
    response.writeHead(200, { "Content-Type": "text/event-stream" }); response.write("data: {}\n\n");
  });
  const origin = await listen(upstream);
  const gateway = new AccessGateway(sessions, new AccessStreams(sessions, { controller: origin, config: origin, logs: origin }));
  const server = createSysinfoServer(async () => [], undefined, undefined, undefined, gateway);
  const base = await listen(server);
  t.after(() => { gateway.dispose(); server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close(); });
  const paths = ["/stream/controller/traffic", "/stream/controller/memory", "/stream/config/changes", "/stream/logs/stream"];
  const streams = await Promise.all(paths.map(path => fetch(base + path, { headers: { Cookie: session } })));
  const readers = streams.map(response => response.body!.getReader());
  await Promise.all(readers.map(reader => reader.read()));
  assert.equal(peers.size, 4);
  const finished = readers.map(reader => reader.read().then(value => value.done, () => true));
  sessions.logout(session);
  assert.deepEqual(await Promise.all(finished), [true, true, true, true]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(peers.size, 0);
  for (const path of paths) assert.equal((await fetch(base + path, { headers: { Cookie: session } })).status, 401);
});

test("Controller WebSocket relay preserves the raw path and is revoked on password change", { timeout: 5000 }, async t => {
  const { sessions } = await fixture(t);
  const session = cookie(await sessions.update(undefined, "enable", null, password));
  let forwardedPath = "";
  let upstreamClosed = false;
  let ended!: () => void;
  const upstreamEnd = new Promise<void>(resolve => { ended = resolve; });
  const upstream = createServer();
  const sockets = new Set<import("node:stream").Duplex>();
  upstream.on("upgrade", (request, socket) => {
    sockets.add(socket); forwardedPath = request.url ?? "";
    socket.resume();
    socket.on("error", () => {});
    socket.once("end", () => { upstreamClosed = true; socket.destroy(); ended(); });
    socket.once("close", () => { sockets.delete(socket); upstreamClosed = true; });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  const origin = await listen(upstream);
  const gateway = new AccessGateway(sessions, new AccessStreams(sessions, { controller: origin, config: origin, logs: origin }));
  const server = createSysinfoServer(async () => [], undefined, undefined, undefined, gateway);
  const base = await listen(server);
  const client = createConnection(Number(new URL(base).port), "127.0.0.1");
  t.after(() => { client.destroy(); gateway.dispose(); for (const socket of sockets) socket.destroy(); server.close(); upstream.close(); });
  await once(client, "connect");
  const data = once(client, "data");
  client.write("GET /stream/controller/connections?interval=1000 HTTP/1.1\r\nHost: " + new URL(base).host + "\r\nOrigin: " + base + "\r\nCookie: " + session + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  assert.match(String((await data)[0]), /^HTTP\/1.1 101/);
  assert.equal(forwardedPath, "/connections?interval=1000");
  const closed = once(client, "close");
  await sessions.update(session, "password", password, "new-password-fixture");
  await closed;
  await upstreamEnd;
  assert.ok(upstreamClosed);
});
