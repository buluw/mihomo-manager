import type { EChartsOption } from "echarts"

import { formatBytes } from "../../shared/format.ts"

export type TrafficRange = "24h" | "7d" | "30d" | "month"
type TrafficRates = { up: number; down: number }
export type TrafficSample = TrafficRates & { at: number; label: string }

export type TrafficChartPalette = {
  series: string
  tooltipBackground: string
  tooltipBorder: string
  tooltipText: string
}

const MAX_TRAFFIC_SAMPLES = 120
const rangeDurations: Record<TrafficRange, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
  month: 31 * 24 * 60 * 60 * 1_000,
}

export function appendTrafficSample(
  samples: TrafficSample[],
  rates: TrafficRates,
  at: number,
): TrafficSample[] {
  return [
    ...samples.slice(-(MAX_TRAFFIC_SAMPLES - 1)),
    {
      at,
      label: new Date(at).toLocaleTimeString([], {
        minute: "2-digit",
        second: "2-digit",
      }),
      ...rates,
    },
  ]
}

export function trafficSamplesInRange(
  samples: TrafficSample[],
  range: TrafficRange,
  now: number,
) {
  const threshold = now - rangeDurations[range]
  return samples.filter((sample) => sample.at >= threshold)
}

export function summarizeDownloadRates(samples: TrafficSample[]) {
  const total = samples.reduce((sum, sample) => sum + sample.down, 0)
  return {
    peak: samples.reduce((max, sample) => Math.max(max, sample.down), 0),
    average: samples.length ? total / samples.length : 0,
  }
}

export function trafficTrendOption(
  samples: TrafficSample[],
  palette: TrafficChartPalette,
): EChartsOption {
  return {
    animationDuration: 300,
    aria: {
      enabled: true,
      label: { description: `本次页面会话收到的 ${samples.length} 个真实下载速率样本` },
    },
    grid: { top: 0, right: 0, bottom: 0, left: 0 },
    tooltip: {
      trigger: "axis",
      confine: true,
      axisPointer: { type: "shadow" },
      backgroundColor: palette.tooltipBackground,
      borderColor: palette.tooltipBorder,
      textStyle: { color: palette.tooltipText },
      valueFormatter: (value) => `${formatBytes(Number(value))}/s`,
    },
    xAxis: {
      type: "category",
      show: false,
      data: samples.map((sample) => sample.label),
    },
    yAxis: {
      type: "value",
      show: false,
      min: 0,
    },
    series: [
      {
        name: "下载速率",
        type: "bar",
        data: samples.map((sample) => sample.down),
        barMinHeight: 2,
        barMaxWidth: 18,
        itemStyle: {
          color: palette.series,
          opacity: 0.75,
          borderRadius: [2, 2, 0, 0],
        },
      },
    ],
  }
}
