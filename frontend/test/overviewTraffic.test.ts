import assert from "node:assert/strict";
import test from "node:test";

import {
  appendTrafficSample,
  summarizeDownloadRates,
  trafficSamplesInRange,
  trafficTrendOption,
  type TrafficSample,
} from "../src/features/overview/trafficProjection.ts";

const sample = (at: number, down: number, up = 0): TrafficSample => ({
  at,
  down,
  up,
  label: String(at),
});

test("overview traffic sampling stays bounded to real session samples", () => {
  const samples = Array.from({ length: 120 }, (_, index) => sample(index, index));
  const appended = appendTrafficSample(samples, { down: 500, up: 50 }, 120);

  assert.equal(appended.length, 120);
  assert.equal(appended[0]?.at, 1);
  assert.deepEqual(appended.at(-1), {
    at: 120,
    down: 500,
    up: 50,
    label: new Date(120).toLocaleTimeString([], {
      minute: "2-digit",
      second: "2-digit",
    }),
  });
});

test("overview ranges only filter samples collected in this page session", () => {
  const now = new Date(2026, 7, 7, 12).getTime();
  const samples = [
    sample(now - 32 * 24 * 60 * 60 * 1_000, 10),
    sample(now - 25 * 60 * 60 * 1_000, 30),
    sample(now, 40),
  ];

  assert.deepEqual(trafficSamplesInRange(samples, "month", now), samples.slice(1));
  assert.deepEqual(trafficSamplesInRange(samples, "24h", now), [samples[2]]);
});

test("overview statistics and chart option use the real download series only", () => {
  const samples = [sample(1, 100, 900), sample(2, 300, 800)];
  const option = trafficTrendOption(
    samples,
    {
      series: "teal",
      tooltipBackground: "white",
      tooltipBorder: "gray",
      tooltipText: "black",
    },
  ) as { series: Array<{ name: string; type: string; data: number[] }> };

  assert.deepEqual(summarizeDownloadRates(samples), { peak: 300, average: 200 });
  assert.equal(option.series.length, 1);
  assert.equal(option.series[0]?.name, "下载速率");
  assert.equal(option.series[0]?.type, "bar");
  assert.deepEqual(option.series[0]?.data, [100, 300]);
});
