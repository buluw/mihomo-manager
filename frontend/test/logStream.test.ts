import assert from "node:assert/strict";
import test from "node:test";

import { LogStreamController } from "../src/features/logs/logStream.ts";
import { LogEventStream } from "../src/api/logClient.ts";
import {
  filterAndSortLogEntries,
  logEntryMessage,
  mergeLogEntries,
  mergeLogEntriesInRange,
  presetLogRange,
  resolveLogDisplayRange,
  resolveLogTimeRange,
  type LogEntry,
} from "../src/features/logs/logEntries.ts";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { setTimeout, clearTimeout },
});

class FakeSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closed = false;

  close() {
    this.closed = true;
  }
}

test("live display accepts events after the last clock tick while history bounds remain fixed", () => {
  const now = Date.UTC(2026, 8, 16, 12);
  const selected = presetLogRange("1h", now);
  const display = resolveLogDisplayRange(selected, now);
  const incoming = [
    { id: "expired", timestamp: now - 3_600_001, line: "level=info [TCP] fixture expired" },
    { id: "live", timestamp: now + 1_000, line: "level=info [TCP] fixture live" },
    { id: "warning", timestamp: now + 2_000, line: "level=warning [TCP] fixture warning" },
  ];
  const entries = mergeLogEntriesInRange([], incoming, display);
  assert.deepEqual(entries.map(({ id }) => id), ["live", "warning"]);
  assert.deepEqual(filterAndSortLogEntries(entries, {
    query: "FIXTURE", timeRange: display, selectedLevel: "info", selectedProtocol: "TCP", sortDirection: "asc",
  }).map(({ id }) => id), ["live"]);
  assert.equal(resolveLogTimeRange(selected, now).until, now);
  assert.equal(resolveLogDisplayRange(selected, now + 30_000).since, selected.since! + 30_000);
  assert.equal(resolveLogDisplayRange(presetLogRange("today", now), now).until, undefined);
  for (const fixed of [
    { mode: "custom", label: "fixed", since: now - 10_000, until: now },
    presetLogRange("yesterday", now),
  ]) {
    const fixedDisplay = resolveLogDisplayRange(fixed, now);
    assert.deepEqual(fixedDisplay, fixed);
    assert.deepEqual(mergeLogEntriesInRange([], incoming.slice(1), fixedDisplay), []);
  }
});

test("resume publishes the bounded live queue once without losing events newer than the display clock", () => {
  const now = Date.UTC(2026, 8, 16, 12);
  const display = resolveLogDisplayRange(presetLogRange("1h", now), now);
  const socket = new FakeSocket();
  let entries: LogEntry[] = [];
  let published = 0;
  const stream = new LogStreamController({
    entries: (incoming) => {
      published++;
      entries = mergeLogEntriesInRange(entries, incoming, display);
    },
    queued: () => {}, connection: () => {}, error: assert.fail,
  }, 1500, () => socket);
  stream.start();
  stream.setPaused(true);
  socket.onmessage?.({ data: JSON.stringify(Array.from({ length: 1501 }, (_, index) => ({
    id: `queued-${index}`, timestamp: now + index + 1, line: `level=info queued ${index}`,
  }))) } as MessageEvent<string>);
  assert.equal(published, 0);
  stream.setPaused(false);
  stream.setPaused(false);
  assert.equal(published, 1);
  assert.equal(entries.length, 1500);
  assert.equal(entries[0]?.id, "queued-1");
  assert.equal(entries.at(-1)?.id, "queued-1500");
  stream.dispose();
});

test("event stream retains native identity while redacting credentials", () => {
  const socket = new FakeSocket();
  const paths: string[] = [];
  const states: string[] = [];
  let entries: LogEntry[] = [];
  const stream = new LogStreamController(
    {
      entries: (incoming) => (entries = incoming),
      queued: assert.fail,
      connection: (state) => states.push(state),
      error: assert.fail,
    },
    1500,
    (path) => {
      paths.push(path);
      return socket;
    },
  );

  stream.start();
  socket.onopen?.({} as Event);
  socket.onmessage?.({
    data: JSON.stringify([{
      id: "42",
      timestamp: Date.now(),
      level: "info",
      message: "public stream Authorization: Bearer FIXTURE_STREAM_BEARER",
      line: "level=info public stream Authorization: Bearer FIXTURE_STREAM_BEARER",
    }]),
  } as MessageEvent<string>);

  assert.deepEqual(paths, ["/stream"]);
  assert.deepEqual(states, ["connecting", "live"]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, "42");
  assert.equal(entries[0]?.line.includes("FIXTURE_STREAM_BEARER"), false);
  assert.equal(entries[0]?.message?.includes("FIXTURE_STREAM_BEARER"), false);
  assert.equal(entries[0]?.line.includes("public stream"), true);
  assert.match(entries[0]?.receivedAt || "", /\d/);
  stream.dispose();
});

test("paused events can be cleared without publishing on resume", () => {
  const socket = new FakeSocket();
  const queued: number[] = [];
  let published = 0;
  const stream = new LogStreamController(
    {
      entries: () => published++,
      queued: (count) => queued.push(count),
      connection: () => {},
      error: assert.fail,
    },
    1500,
    () => socket,
  );

  stream.start();
  stream.setPaused(true);
  socket.onmessage?.({
    data: JSON.stringify([{
      id: "paused-fixture",
      timestamp: Date.now(),
      line: "level=info pending fixture",
    }]),
  } as MessageEvent<string>);
  stream.clearQueue();
  stream.setPaused(false);

  assert.equal(published, 0);
  assert.deepEqual(queued, [1, 0]);
  stream.dispose();
});

test("log entry buffers keep the newest 1500 entries", () => {
  const entries = Array.from({ length: 1501 }, (_, index) => ({
    id: String(index),
    line: `level=info line ${index}`,
  }));
  const merged = mergeLogEntries([], entries);

  assert.equal(merged.length, 1500);
  assert.equal(merged[0]?.id, "1");
  assert.equal(merged[1499]?.id, "1500");
});

test("stored log text hides credentials while preserving public content", () => {
  const fixtures = [
    {
      id: "credential-fixture",
      line: 'level=info public-credential token=FIXTURE_TOKEN {"password":"FIXTURE_PASSWORD"} X-Api-Key: FIXTURE_API_KEY retry=3',
      secrets: ["FIXTURE_TOKEN", "FIXTURE_PASSWORD", "FIXTURE_API_KEY"],
      publicParts: ["public-credential", "retry=3"],
    },
    {
      id: "url-fixture",
      line: "level=info public-url https://fixture-user:fixture-pass@logs.example.test/collect?access_token=FIXTURE_QUERY_TOKEN&retry=3",
      secrets: ["fixture-user", "fixture-pass", "FIXTURE_QUERY_TOKEN"],
      publicParts: ["public-url", "logs.example.test", "retry=3"],
    },
  ];

  for (const fixture of fixtures) {
    const [entry] = mergeLogEntries([], [{
      id: fixture.id,
      line: fixture.line,
      message: fixture.line.replace("level=info ", ""),
      timestamp: 10,
    }]);
    assert.ok(entry);

    const project = (query: string) => filterAndSortLogEntries([entry], {
      query,
      timeRange: { mode: "custom", label: "fixture", since: 0, until: 20 },
      sortDirection: "asc",
    });
    const visible = project(fixture.publicParts[0]!);
    const displayed = logEntryMessage(entry);
    const copied = visible.map(({ line }) => line).join("\n");

    assert.deepEqual(visible.map(({ id }) => id), [fixture.id]);
    for (const publicPart of fixture.publicParts) {
      assert.equal(entry.line.includes(publicPart), true, `${fixture.id}: public text was removed`);
    }
    for (const secret of fixture.secrets) {
      assert.equal(entry.line.includes(secret), false, `${fixture.id}: stored line exposed a fixture secret`);
      assert.equal(displayed.includes(secret), false, `${fixture.id}: display text exposed a fixture secret`);
      assert.equal(copied.includes(secret), false, `${fixture.id}: copied text exposed a fixture secret`);
      assert.equal(project(secret).length, 0, `${fixture.id}: search matched a fixture secret`);
    }
  }
});

test("disposing closes the event stream and ignores later events", () => {
  const socket = new FakeSocket();
  let published = 0;
  const stream = new LogStreamController(
    {
      entries: () => published++,
      queued: () => {},
      connection: () => {},
      error: assert.fail,
    },
    1500,
    () => socket,
  );

  stream.start();
  stream.dispose();
  socket.onmessage?.({
    data: JSON.stringify([{
      id: "44",
      timestamp: Date.now(),
      level: "info",
      message: "late",
      line: "level=info late",
    }]),
  } as MessageEvent<string>);

  assert.equal(socket.closed, true);
  assert.equal(published, 0);
});

test("failed event stream reconnects without exposing Controller details", async () => {
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  const paths: string[] = [];
  const states: string[] = [];
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout, clearTimeout },
  });
  try {
    const stream = new LogStreamController(
      {
        entries: () => {},
        queued: () => {},
        connection: (state) => states.push(state),
        error: assert.fail,
      },
      0,
      (path) => {
        paths.push(path);
        return sockets.shift()!;
      },
    );
    stream.start();
    first.onerror?.({} as Event);
    await new Promise((resolve) => setTimeout(resolve, 5));
    stream.dispose();

    assert.deepEqual(paths, ["/stream", "/stream"]);
    assert.ok(states.includes("reconnecting"));
    assert.equal(second.closed, true);
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

test("a stalled event stream reconnects after the open timeout", async () => {
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  const paths: string[] = [];
  const states: string[] = [];
  const stream = new LogStreamController(
    {
      entries: () => {},
      queued: () => {},
      connection: (state) => states.push(state),
      error: assert.fail,
    },
    0,
    (path) => {
      paths.push(path);
      const socket = sockets.shift()!;
      if (socket === second) window.setTimeout(() => socket.onopen?.({} as Event), 0);
      return socket;
    },
    1,
  );

  stream.start();
  for (let attempt = 0; attempt < 20 && paths.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  stream.dispose();

  assert.deepEqual(paths, ["/stream", "/stream"]);
  assert.equal(first.closed, true);
  assert.ok(states.includes("offline"));
  assert.ok(states.includes("reconnecting"));
  assert.ok(states.includes("live"));
});

test("log transport preserves handshake/retry timing and isolates restarted connections", t => {
  const originalWindow = globalThis.window;
  t.after(() => Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }));
  let timerId = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  } });
  const first = new FakeSocket(), second = new FakeSocket();
  const sockets = [first, second];
  const states: string[] = [];
  let messages = 0;
  const stream = new LogEventStream({ connection: state => states.push(state),
    entries: () => messages++, invalidEvent: assert.fail }, undefined, () => sockets.shift()!);
  stream.start();
  assert.deepEqual([...timers.values()].map(timer => timer.delay), [6000]);
  first.onopen?.({} as Event);
  assert.equal(timers.size, 0);
  first.onerror?.({} as Event);
  assert.deepEqual([...timers.values()].map(timer => timer.delay), [1500]);
  stream.restart();
  assert.deepEqual([...timers.values()].map(timer => timer.delay), [6000]);
  first.onopen?.({} as Event);
  first.onmessage?.({ data: "[]" } as MessageEvent<string>);
  first.onerror?.({} as Event);
  assert.equal(messages, 0);
  assert.deepEqual(states, ["connecting", "live", "offline", "connecting"]);
  second.onopen?.({} as Event);
  second.onmessage?.({ data: "[]" } as MessageEvent<string>);
  assert.equal(messages, 1);
  stream.dispose();
  assert.equal(first.closed && second.closed, true);
  assert.equal(timers.size, 0);
  second.onopen?.({} as Event);
  second.onmessage?.({ data: "[]" } as MessageEvent<string>);
  second.onerror?.({} as Event);
  assert.equal(messages, 1);
  assert.equal(timers.size, 0);
});

test("restarting preserves paused entries and parse-error feedback", () => {
  const first = new FakeSocket(), second = new FakeSocket();
  const sockets = [first, second];
  const published: LogEntry[][] = [];
  const errors: string[] = [];
  const stream = new LogStreamController({ entries: entries => published.push(entries), queued: () => {},
    connection: () => {}, error: error => errors.push((error as Error).message) }, 1500, () => sockets.shift()!);
  stream.start();
  stream.setPaused(true);
  first.onmessage?.({ data: JSON.stringify([{ id: "queued", timestamp: 1, line: "info fixture" }]) } as MessageEvent<string>);
  stream.restart();
  second.onmessage?.({ data: "{" } as MessageEvent<string>);
  assert.deepEqual(errors, ["Controller 返回了无法解析的日志事件"]);
  stream.setPaused(false);
  assert.deepEqual(published.map(entries => entries.map(entry => entry.id)), [["queued"]]);
  stream.dispose();
});
