import { useCallback, useEffect, useMemo, useState } from "react"
import ReactECharts from "echarts-for-react"
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Database,
  Gauge,
  MemoryStick,
} from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useRegisterPageRefresh } from "@/app/pageRefresh"
import { StandardPage } from "@/components/layout/page-frame"
import { Panel, Segmented, StatusDot } from "@/components/patterns/page-kit"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useTheme } from "@/components/theme-provider"
import { useDirtyGuard } from "@/hooks/useDirtyGuard"
import { cn } from "@/lib/utils"
import { formatBytes } from "@/shared/format"
import type { Json, Notify } from "@/shared/types"
import {
  appendTrafficSample,
  summarizeDownloadRates,
  trafficSamplesInRange,
  trafficTrendOption,
  type TrafficChartPalette,
  type TrafficRange,
  type TrafficSample,
} from "./trafficProjection"
import { applyPersistentMode, PersistentModeError, readPersistentMode, type PersistentMode, type PersistentModeRetry } from "./modeSetting"
import { ServiceResources, useProjectResources } from "./ServiceResources"

type RuntimeMode = "rule" | "direct" | "global"

function readTrafficChartPalette(): TrafficChartPalette | null {
  const styles = window.getComputedStyle(document.documentElement)
  const palette = {
    series: styles.getPropertyValue("--mode-rule").trim(),
    tooltipBackground: styles.getPropertyValue("--popover").trim(),
    tooltipBorder: styles.getPropertyValue("--border").trim(),
    tooltipText: styles.getPropertyValue("--popover-foreground").trim(),
  }
  return Object.values(palette).every(Boolean) ? palette : null
}

function rateMetric(value: number) {
  const formatted = formatBytes(value)
  const split = formatted.lastIndexOf(" ")
  return split === -1
    ? { value: formatted, unit: "/s" }
    : { value: formatted.slice(0, split), unit: `${formatted.slice(split + 1)}/s` }
}

export function Dashboard({
  status,
  statusError,
  notify,
  onRefresh,
}: {
  status: Json | null
  statusError: boolean
  notify: Notify
  onRefresh: () => Promise<void>
}) {
  const [samples, setSamples] = useState<TrafficSample[]>([])
  const [rates, setRates] = useState({ up: 0, down: 0 })
  const [range, setRange] = useState<TrafficRange>("24h")
  const [chartPalette, setChartPalette] = useState<TrafficChartPalette | null>(null)
  const [modeBusy, setModeBusy] = useState(false)
  const [modeReady, setModeReady] = useState(false)
  const [persistentMode, setPersistentMode] = useState<PersistentMode | null>(null)
  const [optimisticMode, setOptimisticMode] = useState<PersistentMode | null>(null)
  const [modePending, setModePending] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)
  const [modeRetry, setModeRetry] = useState<PersistentModeRetry | null>(null)
  const [modeRefresh, setModeRefresh] = useState(0)
  const resources = useProjectResources()
  const { theme } = useTheme()
  const runtimeMode = status?.mode ? (String(status.mode) as RuntimeMode) : null
  const selectedMode = optimisticMode || persistentMode
  useDirtyGuard(false, modeBusy)
  useRegisterPageRefresh(useCallback(async () => { if (!modeBusy) setModeRefresh(current => current + 1) }, [modeBusy]))

  useEffect(() => {
    const request = new AbortController()
    setModeReady(false)
    void readPersistentMode(request.signal).then((value) => {
      if (request.signal.aborted) return
      setPersistentMode(value.mode)
      setModePending(value.pending)
      setModeReady(true)
      setModeError(null)
    }, () => {
      if (!request.signal.aborted) { setModeReady(false); setPersistentMode(null); setModeError("模式设置或源配置读取失败，请刷新重试") }
    })
    return () => request.abort()
  }, [status?.version, modeRefresh])

  useEffect(() => {
    if (!status?.traffic) {
      setRates({ up: 0, down: 0 })
      return
    }
    const next = {
      up: Number(status.traffic.up || 0),
      down: Number(status.traffic.down || 0),
    }
    const now = Date.now()
    setRates(next)
    setSamples((current) => appendTrafficSample(current, next, now))
  }, [status?.traffic])

  useEffect(() => {
    const root = document.documentElement
    const updatePalette = () => setChartPalette(readTrafficChartPalette())
    const observer = new MutationObserver(updatePalette)
    observer.observe(root, { attributes: true, attributeFilter: ["class"] })
    const frame = window.requestAnimationFrame(updatePalette)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [theme])

  const setMode = async (mode: PersistentMode) => {
    if ((mode === selectedMode && !modePending && !modeRetry) || modeBusy || !status?.controller || !modeReady) return
    setOptimisticMode(mode)
    setModeBusy(true)
    setModeError(null)
    try {
      await applyPersistentMode(mode, undefined, modeRetry ?? undefined)
      setModeRetry(null)
      setPersistentMode(mode)
      setOptimisticMode(null)
      setModePending(false)
      notify(`运行模式已保存并应用为 ${{ rule: "规则", direct: "直连", global: "全局" }[mode]}`)
      void onRefresh().catch(() => undefined)
    } catch (error) {
      setModeRetry(error instanceof PersistentModeError ? error.retry ?? null : null)
      setOptimisticMode(null)
      setModeError((error as Error).message)
      notify((error as Error).message, "error")
      await Promise.all([
        readPersistentMode().then((value) => {
          setPersistentMode(value.mode); setModePending(value.pending)
        }).catch(() => { setPersistentMode(null); setModeReady(false) }),
        onRefresh().catch(() => undefined),
      ])
    } finally {
      setModeBusy(false)
    }
  }

  const visibleSamples = useMemo(() => {
    return trafficSamplesInRange(samples, range, Date.now())
  }, [range, samples])
  const totals = useMemo(() => summarizeDownloadRates(visibleSamples), [visibleSamples])
  const chartOption = useMemo(
    () => chartPalette ? trafficTrendOption(visibleSamples, chartPalette) : null,
    [chartPalette, visibleSamples],
  )
  const downloadMetric = rateMetric(rates.down)
  const uploadMetric = rateMetric(rates.up)
  const pending = status === null && !statusError
  const online = status?.controller === true && !statusError
  const hasTraffic = Boolean(status?.traffic)
  const cumulativeUpload = Number(status?.traffic?.upTotal || 0)
  const cumulativeDownload = Number(status?.traffic?.downTotal || 0)
  const streamsHealthy = status?.trafficConnected === true && status?.memoryConnected === true
  const containerMemory = resources.value?.containerMemory

  const metrics = [
    {
      title: "实时下行",
      value: hasTraffic ? downloadMetric.value : "-",
      unit: hasTraffic ? downloadMetric.unit : "",
      icon: ArrowDown,
      tone: "text-status-success",
    },
    {
      title: "实时上行",
      value: hasTraffic ? uploadMetric.value : "-",
      unit: hasTraffic ? uploadMetric.unit : "",
      icon: ArrowUp,
      tone: "text-status-info",
    },
    {
      title: "活动连接",
      value: online ? String(status?.connections ?? "-") : "-",
      unit: online ? "条" : "",
      icon: Activity,
      tone: "text-primary",
    },
    {
      title: "容器内存",
      value: containerMemory?.usedBytes != null ? formatBytes(containerMemory.usedBytes) : "不可用",
      unit: containerMemory?.limitBytes != null ? `/ ${formatBytes(containerMemory.limitBytes)}` : "额度未知",
      detail: containerMemory?.usagePercent != null ? `占用 ${containerMemory.usagePercent.toFixed(1)}%` : "占用比例不可用",
      icon: MemoryStick,
      tone: "text-status-warning",
    },
  ]

  return (
    <StandardPage>
      <section className="flex min-h-12 flex-wrap items-center gap-2 border-b py-1.5">
        <ToggleGroup
          value={selectedMode ? [selectedMode] : []}
          spacing={0}
          className="h-8 max-md:h-12 rounded-md bg-muted/55 p-0.5"
          aria-label="运行模式"
          disabled={!status?.controller || modeBusy || !modeReady}
          onValueChange={(values) => {
            const next = values.at(-1) as PersistentMode | undefined
            if (next) void setMode(next)
          }}
        >
          {(
            [
              ["rule", "规则"],
              ["direct", "直连"],
              ["global", "全局"],
            ] as const
          ).map(([value, label]) => (
            <ToggleGroupItem
              key={value}
              value={value}
              className={cn(
                "relative h-7 min-w-12 rounded-[5px] border-0 px-2 text-xs font-medium text-muted-foreground transition-colors duration-150 sm:min-w-[58px] sm:px-3",
                value === "rule" && "aria-pressed:bg-mode-rule/15 aria-pressed:text-mode-rule aria-pressed:ring-1 aria-pressed:ring-mode-rule/40",
                value === "direct" && "aria-pressed:bg-mode-direct/15 aria-pressed:text-mode-direct aria-pressed:ring-1 aria-pressed:ring-mode-direct/40",
                value === "global" && "aria-pressed:bg-mode-global/15 aria-pressed:text-mode-global aria-pressed:ring-1 aria-pressed:ring-mode-global/40"
              )}
            >
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {modeBusy ? <Spinner className="text-muted-foreground" aria-label="正在切换运行模式" /> : null}
        {!modeBusy && !selectedMode && <span className="text-xs text-muted-foreground">{modeReady ? "模式未明确，请选择后保存" : "模式设置未就绪"}</span>}
        {modePending && !modeBusy && selectedMode && <span className="text-xs text-muted-foreground">已保存设置待应用</span>}
        {(modePending || modeRetry) && selectedMode && <Button variant="outline" size="sm" disabled={modeBusy || !modeReady || !online} onClick={() => void setMode(selectedMode)}>{modeRetry ? "重试确认" : "重新应用"}</Button>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot tone={statusError ? "error" : pending || !streamsHealthy ? "warn" : "ok"} />
          {statusError
            ? "Core 状态不可用"
            : pending
              ? "Core 检测中"
              : online
                ? streamsHealthy
                  ? "Core 运行中"
                  : "Core 运行中 · 实时流重连中"
                : "Core 未连接"}
        </span>
      </section>
      {modeError && <Alert variant="destructive"><AlertDescription>{modeError}</AlertDescription></Alert>}

      <section className="grid grid-cols-2 overflow-hidden rounded-md border lg:grid-cols-4">
        {metrics.map((metric) => (
          <div
            key={metric.title}
            className="flex min-h-24 flex-wrap content-center items-center gap-x-2 gap-y-1 border-b border-r px-3 py-2 nth-[2n]:border-r-0 nth-last-[-n+2]:border-b-0 sm:h-20 sm:min-h-20 sm:flex-nowrap sm:gap-3 sm:px-4 lg:border-b-0 lg:last:border-r-0 lg:nth-[2]:border-r"
          >
            <span className={cn("hidden size-8 shrink-0 items-center justify-center rounded-md bg-muted/70 sm:flex", metric.tone)}>
              <metric.icon className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><metric.icon className={cn("size-4 shrink-0 sm:hidden", metric.tone)} />{metric.title}</div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
                <span className="text-[22px] leading-none font-semibold whitespace-nowrap tabular-nums">{metric.value}</span>
                {metric.unit && <span className={cn("text-xs whitespace-nowrap text-muted-foreground", metric.title === "容器内存" && "basis-full sm:basis-auto")}>{metric.unit}</span>}
              </div>
              {metric.detail && <div className="mt-1 text-xs text-muted-foreground">{metric.detail}</div>}
            </div>
          </div>
        ))}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Panel
          title="流量趋势"
          desktopSpan={8}
          actions={
            <Segmented
              value={range}
              onChange={setRange}
              ariaLabel="统计时间范围"
              options={[
                { value: "24h", label: "24h" },
                { value: "7d", label: "7d" },
                { value: "30d", label: "30d" },
                { value: "month", label: "本月" },
              ]}
            />
          }
        >
          <div className="h-64 px-4 pt-6 pb-4">
            {visibleSamples.length && chartOption ? (
              <ReactECharts
                option={chartOption}
                notMerge
                lazyUpdate
                autoResize
                className="size-full"
                style={{ height: "100%", width: "100%" }}
                role="img"
                aria-label="实时流量统计图"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">等待实时流量数据</div>
            )}
          </div>
          <div className="flex h-10 items-center gap-5 border-t px-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-2"><span className="size-2 rounded-sm bg-mode-rule" />下载速率</span>
            <span>峰值 {formatBytes(totals.peak)}/s</span>
            <span>平均 {formatBytes(totals.average)}/s</span>
          </div>
        </Panel>
        <Panel title="统计详情" desktopSpan={4}>
          {[
            { label: "累计上传", value: hasTraffic ? formatBytes(cumulativeUpload) : "-", icon: ArrowUp },
            { label: "累计下载", value: hasTraffic ? formatBytes(cumulativeDownload) : "-", icon: ArrowDown },
            { label: "总流量", value: hasTraffic ? formatBytes(cumulativeUpload + cumulativeDownload) : "-", icon: Database },
            { label: "峰值速率", value: `${formatBytes(totals.peak)}/s`, icon: Gauge },
          ].map((item) => (
            <div key={item.label} className="flex h-14 items-center gap-2 border-b px-4 last:border-b-0">
              <item.icon className="size-4 text-muted-foreground" />
              <span className="text-sm">{item.label}</span>
              <span className="ml-auto text-sm font-semibold tabular-nums">{item.value}</span>
            </div>
          ))}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Panel title="运行状态" desktopSpan={5}>
          {[
            ["Controller 连接", online ? "已连接" : pending ? "检测中" : "不可用", String(status?.version || "-").split(" ")[0]],
            ["运行模式", runtimeMode?.toUpperCase() || "未知", ""],
            ["局域网访问", online && typeof status?.configs?.["allow-lan"] === "boolean" ? status.configs["allow-lan"] ? "已启用" : "已停用" : "未知", ""],
            ["流量嗅探", online && typeof status?.configs?.sniffing === "boolean" ? status.configs.sniffing ? "已启用" : "已停用" : "未知", ""],
            ["流量数据流", status?.trafficConnected ? "已连接" : "重连中", "/traffic"],
            ["内存数据流", status?.memoryConnected ? "已连接" : "重连中", "/memory"],
          ].map(([label, value, meta]) => (
            <div key={label} className="flex h-10 items-center px-3 text-sm not-last:border-b">
              <StatusDot tone={value === "不可用" ? "error" : value === "重连中" || value === "检测中" || value === "未知" ? "warn" : "ok"} />
              <span className="ml-2">{label}</span>
              <span className="ml-auto text-muted-foreground">{value}</span>
              <span className="ml-4 w-20 truncate text-right font-mono text-xs text-muted-foreground">{meta}</span>
            </div>
          ))}
        </Panel>
        <ServiceResources resources={resources} />
      </div>
    </StandardPage>
  )
}
