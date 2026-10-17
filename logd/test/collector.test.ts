import assert from "node:assert/strict";
import test from "node:test";
import { LogCollector } from "../src/collector.js";
import { LogStore } from "../src/store.js";

test("collector defaults to info, permits explicit debug, and retains warning/error and query history", t => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: URL) { sockets.push(this); }
    close() { this.onclose?.(); }
    emit(level: string) { this.onmessage?.({ data: JSON.stringify({ type: level, payload: "test " + level }) }); }
  }
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = originalSocket; });
  const store = new LogStore(":memory:", 7);
  t.after(() => store.close());
  const normal = new LogCollector({ controllerUrl: "http://127.0.0.1:9090", store, publish: () => {} });
  normal.start();
  assert.equal(sockets[0]?.url.searchParams.get("level"), "info");
  for (const level of ["info", "warning", "error"]) sockets[0]?.emit(level);
  normal.stop();
  assert.deepEqual(store.list({ limit: 10 }).map(item => item.level), ["info", "warn", "error"]);
  const debug = new LogCollector({ controllerUrl: "http://127.0.0.1:9090", level: "debug", store, publish: () => {} });
  debug.start();
  assert.equal(sockets[1]?.url.searchParams.get("level"), "debug");
  for (const level of ["debug", "info", "warning", "error"]) sockets[1]?.emit(level);
  debug.stop();
  assert.equal(store.list({ limit: 10, level: "debug" }).length, 1);
  assert.equal(store.list({ limit: 10, level: "error" }).length, 2);
  assert.equal(store.list({ limit: 10 }).length, 7);
});
