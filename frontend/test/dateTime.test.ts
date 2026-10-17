import assert from "node:assert/strict";
import test from "node:test";
import { customLogRange, presetLogRange, resolveLogDisplayRange } from "../src/features/logs/logEntries.ts";

test("custom log range retains local date and second precision", () => {
  const since = new Date(2026, 6, 31, 22, 9, 13).getTime();
  const until = new Date(2026, 7, 1, 8, 15, 27).getTime();
  const range = customLogRange(since, until)!;
  assert.equal(range.since, since);
  assert.equal(range.until, until);
  assert.match(range.label, /22:09:13/);
  assert.match(range.label, /08:15:27/);
  assert.deepEqual(resolveLogDisplayRange(range, until + 1000), range);
});

test("custom log range rejects missing, equal and reversed endpoints", () => {
  for (const [since, until] of [[NaN, 100], [0, Infinity], [100, 100], [101, 100]]) {
    assert.equal(customLogRange(since!, until!), null);
  }
});

test("calendar day presets retain local day boundaries across month changes", () => {
  const now = new Date(2026, 7, 1, 8, 0).getTime();
  const start = new Date(2026, 7, 1).getTime();
  const yesterday = presetLogRange("yesterday", now);
  assert.equal(yesterday.since, new Date(2026, 6, 31).getTime());
  assert.equal(yesterday.until, start - 1);
  assert.equal(presetLogRange("today", now).since, start);
});
