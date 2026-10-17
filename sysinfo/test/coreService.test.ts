import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CoreControlError, controlCoreService, parseCoreService } from "../src/coreService.js";
import { createSysinfoServer } from "../src/server.js";

test("service state does not depend on Controller and exposes only safe failure fields", () => {
  assert.deepEqual(parseCoreService("LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nExecMainStatus=0\n"),
    { state: "active", running: true, failure: null, exitStatus: 0 });
  assert.deepEqual(parseCoreService("LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nExecMainStatus=1\n"),
    { state: "failed", running: false, failure: "exit-code", exitStatus: 1 });
  const safe = parseCoreService("LoadState=loaded\nActiveState=failed\nSubState=private config\nResult=private credential\nExecMainStatus=private\n");
  assert.equal(safe.failure, "unknown");
  assert.equal(safe.exitStatus, null);
  assert.equal(JSON.stringify(safe).includes("private"), false);
  assert.equal(parseCoreService("LoadState=not-found\nActiveState=inactive").failure, "not-found");
});

test("restricted control sends only one fixed action and handles busy/unavailable replies", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mihomo-core-control-"));
  const path = join(directory, "control.sock");
  t.after(() => rm(directory, { recursive: true, force: true }));
  let reply = "ok\n";
  const actions: string[] = [];
  const server = createServer(socket => socket.once("data", data => { actions.push(data.toString()); socket.end(reply); }));
  await new Promise<void>(resolve => server.listen(path, resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await controlCoreService("start", path);
  reply = "busy\n";
  await assert.rejects(controlCoreService("restart", path), (error: unknown) => error instanceof CoreControlError && error.code === "core_action_busy");
  reply = "secret error\n";
  await assert.rejects(controlCoreService("restart", path), { message: "core_action_failed" });
  await assert.rejects(controlCoreService("stop" as "start", path));
  assert.deepEqual(actions, ["start\n", "restart\n", "restart\n"]);
  await assert.rejects(controlCoreService("start", join(directory, "missing.sock")), { message: "core_control_unavailable" });
});

test("HTTP recovery is restricted, remains available when stopped, and serializes operations", async (t) => {
  const state = { state: "inactive" as const, running: false, failure: null, exitStatus: 0 };
  let release: () => void = () => {};
  let entered: () => void = () => {};
  let fail = false;
  let controls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const server = createSysinfoServer(async () => [], {
    read: async () => state,
    control: async () => { controls++; if (fail) throw new Error("secret process details"); entered(); await new Promise<void>(resolve => { release = resolve; }); },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  assert.deepEqual(await (await fetch(url + "/core")).json(), { ...state, busy: false });
  const first = fetch(url + "/core/start", { method: "POST" });
  await started;
  assert.equal((await (await fetch(url + "/core")).json()).busy, true);
  assert.equal((await fetch(url + "/core/restart", { method: "POST" })).status, 409);
  release(); assert.equal((await first).status, 200); assert.equal(controls, 1);
  assert.equal((await fetch(url + "/core/stop", { method: "POST" })).status, 404);
  assert.equal((await fetch(url + "/core/start", { method: "POST", body: '{"service":"ssh"}' })).status, 400);
  assert.equal((await fetch(url + "/core/start")).status, 405);
  assert.equal(controls, 1);
  fail = true;
  const failure = await fetch(url + "/core/restart", { method: "POST" });
  assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), { error: "core_action_failed" });
  assert.equal((await (await fetch(url + "/core")).json()).busy, false);
});

test("GET state read failure returns 503 and leaves status and interfaces available", { timeout: 5000 }, async (t) => {
  const state = { state: "active" as const, running: true, failure: null, exitStatus: 0 };
  const interfaces = [{ name: "eth0", state: "up", addresses: [] }];
  let fail = true;
  const server = createSysinfoServer(async () => interfaces, {
    read: async () => { if (fail) throw new Error("private systemctl details"); return state; },
    control: async () => { assert.fail("GET must not invoke a Core operation"); },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const failure = await fetch(url + "/core");
  assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), { error: "core_status_unavailable" });
  const network = await fetch(url + "/interfaces");
  assert.equal(network.status, 200);
  assert.deepEqual(await network.json(), { interfaces });
  fail = false;
  const recovered = await fetch(url + "/core");
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { ...state, busy: false });
});

test("POST state read failure returns 503, keeps serving, and releases busy for the next operation", { timeout: 5000 }, async (t) => {
  const state = { state: "active" as const, running: true, failure: null, exitStatus: 0 };
  const interfaces = [{ name: "eth0", state: "up", addresses: [] }];
  const actions: string[] = [];
  let fail = true;
  const server = createSysinfoServer(async () => interfaces, {
    read: async () => { if (fail) throw new Error("private systemctl details"); return state; },
    control: async action => { actions.push(action); },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const failure = await fetch(url + "/core/start", { method: "POST" });
  assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), { error: "core_action_failed" });
  assert.deepEqual(actions, ["start"]);
  const network = await fetch(url + "/interfaces");
  assert.equal(network.status, 200);
  assert.deepEqual(await network.json(), { interfaces });
  fail = false;
  const recovered = await fetch(url + "/core");
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { ...state, busy: false });
  const next = await fetch(url + "/core/restart", { method: "POST" });
  assert.equal(next.status, 200);
  assert.deepEqual(await next.json(), { ...state, busy: false });
  assert.deepEqual(actions, ["start", "restart"]);
});
