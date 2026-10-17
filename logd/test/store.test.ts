import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sanitizeLogMessage } from "../src/sanitize.ts";
import { LogStore } from "../src/store.ts";

test("stores, filters and pages log entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-logd-"));
  const store = new LogStore(join(root, "logs.sqlite"));
  try {
    const stored = store.insert([
      { timestamp: 1000, level: "info", message: "first message" },
      { timestamp: 2000, level: "warn", message: "second message" },
      { timestamp: 3000, level: "info", message: "third item" },
    ]);
    assert.equal(stored.length, 3);
    assert.deepEqual(store.list({ limit: 2 }).map((entry) => entry.message), [
      "second message",
      "third item",
    ]);
    assert.deepEqual(store.list({ limit: 10, level: "warn" }).map((entry) => entry.message), [
      "second message",
    ]);
    assert.deepEqual(store.list({ limit: 10, search: "ITEM" }).map((entry) => entry.message), [
      "third item",
    ]);
    assert.deepEqual(store.list({ limit: 10, since: 2000 }).map((entry) => entry.message), [
      "second message",
      "third item",
    ]);
    assert.deepEqual(store.list({ limit: 10, since: 1500, until: 2500 }).map((entry) => entry.message), [
      "second message",
    ]);
    assert.equal(store.list({ limit: 10, beforeId: Number(stored[2]!.id) }).length, 2);
  } finally {
    store.close();
  }
});

test("retention removes only expired rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "mihomo-logd-"));
  const store = new LogStore(join(root, "logs.sqlite"), 7);
  const now = 10 * 24 * 60 * 60 * 1000;
  try {
    store.insert([
      { timestamp: now - 8 * 24 * 60 * 60 * 1000, level: "info", message: "expired" },
      { timestamp: now - 6 * 24 * 60 * 60 * 1000, level: "info", message: "kept" },
    ]);
    assert.equal(store.purge(now), 1);
    assert.deepEqual(store.list({ limit: 10 }).map((entry) => entry.message), ["kept"]);
  } finally {
    store.close();
  }
});

test("persistent logs redact credentials and complete URLs", () => {
  const sanitized = sanitizeLogMessage(
    "Bearer abc123 request https://example.com/path?token=secret",
  );
  assert.equal(sanitized.includes("abc123"), false);
  assert.equal(sanitized.includes("https://"), false);
  assert.equal(sanitized.includes("secret"), false);
});
