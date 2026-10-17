import { systemErrorMessage } from "../../shared/systemMessages.ts";
import { useEffect, useState } from "react"
import { CircleHelp, RefreshCw } from "lucide-react"
import { readProjectResources, type ProjectResources, type ProjectServiceResource } from "@/api/systemClient"
import { Panel } from "@/components/patterns/page-kit"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { StatusBadge, type StatusTone } from "@/components/patterns/status-badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatBytes } from "@/shared/format"

const serviceNames = { core: "Mihomo Core", configd: "配置服务", logd: "日志服务", sysinfo: "系统管理服务", web: "网页服务" }
const states = { active: "已启动", inactive: "已停止", activating: "启动中", deactivating: "停止中", failed: "失败", unknown: "未知" }
const stateTones: Record<ProjectServiceResource["state"], StatusTone> = { active: "success", inactive: "neutral", activating: "info", deactivating: "info", failed: "error", unknown: "neutral" }
const failures: Record<string, string> = {
  "not-found": "服务未安装", masked: "服务已屏蔽", "unit-invalid": "服务定义无效", "exit-code": "进程异常退出",
  signal: "进程被信号终止", "core-dump": "进程崩溃", timeout: "启动或停止超时", "start-limit-hit": "连续启动失败，达到限制",
  resources: "系统资源不足", "oom-kill": "内存不足，被系统终止", watchdog: "看门狗超时", protocol: "服务就绪协议失败", unknown: "系统未提供具体原因",
}
const memoryUnavailable = { "service-unavailable": "服务状态不可用", "not-running": "服务未运行", "not-accounted": "未启用内存计量", "not-reported": "系统未提供内存读数" }
const diskNames = { program: "程序文件", data: "配置与数据", logs: "日志" }

function failureReason(service: ProjectServiceResource) {
  if (!service.available) return "服务状态读取失败"
  if (!service.failure) return null
  const description = failures[service.failure] ?? "系统未提供具体原因"
  return ["exit-code", "signal", "core-dump"].includes(service.failure) && service.exitStatus !== null
    ? `${description}（${service.failure === "exit-code" ? "退出码" : "信号"} ${service.exitStatus}）` : description
}

export function useProjectResources() {
  const [value, setValue] = useState<ProjectResources | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let request: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined }
    const poll = async (refreshDisks = false) => {
      if (disposed || document.visibilityState === "hidden") return
      request?.abort()
      const current = new AbortController()
      request = current
      setLoading(true)
      try {
        const next = await readProjectResources(current.signal, refreshDisks)
        if (!current.signal.aborted) { setValue(next); setError(null) }
      } catch (error) {
        if (!current.signal.aborted) { setValue(null); setError(systemErrorMessage(error as Error)) }
      } finally {
        if (request === current) request = null
        if (!current.signal.aborted && !disposed) {
          setLoading(false)
          clearTimer()
          if (!document.hidden) timer = setTimeout(() => void poll(), 10000)
        }
      }
    }
    const onVisibilityChange = () => {
      clearTimer()
      if (document.visibilityState === "hidden") {
        request?.abort()
        return
      }
      void poll()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    void poll(refresh > 0)
    return () => {
      disposed = true
      document.removeEventListener("visibilitychange", onVisibilityChange)
      clearTimer()
      request?.abort()
    }
  }, [refresh])

  return { value, error, loading, refresh: () => setRefresh(current => current + 1) }
}

export function ServiceResources({ resources }: { resources: ReturnType<typeof useProjectResources> }) {
  const { value, error, loading, refresh } = resources
  const memory = value?.containerMemory

  return <Panel title="运行详情" desktopSpan={7}
    actions={<><Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="资源统计口径" />}><CircleHelp /></TooltipTrigger><TooltipContent className="max-w-sm flex-col items-start">
      <p>本容器内存由 LXCFS 提供：额度取容器可用上限，已用为额度减可用内存，可回收缓存计入可用。覆盖整个容器，与服务内存不相加。</p>
      <p>服务内存来自 systemd，包含子进程及计入服务组的缓存，与 Controller 自报内存口径不同。</p>
      <p>按实际分配空间统计。程序文件含依赖、Core 及上一版本；配置与数据含源配置、运行文件及缓存；日志单独统计，不含系统 journal。三类互不重复。</p>
    </TooltipContent></Tooltip><Button variant="ghost" size="icon-sm" aria-label="刷新服务资源" disabled={loading} onClick={refresh}>
      {loading ? <Spinner /> : <RefreshCw />}
    </Button></>}>
    <div className="@container/resources flex w-full flex-col gap-1 px-3 py-2">
      {error && <Alert variant="destructive"><AlertDescription>{error}，也可点击刷新。</AlertDescription></Alert>}
      {!value && !error && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner />读取服务资源…</div>}
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span>本容器内存</span>
        <span className="tabular-nums">{memory?.usedBytes != null ? formatBytes(memory.usedBytes) : "不可用"} / {memory?.limitBytes != null ? formatBytes(memory.limitBytes) : "额度未知"}</span>
        <span className="text-muted-foreground">{memory?.usagePercent != null ? `${memory.usagePercent.toFixed(1)}%` : "占用比例不可用"}</span>
      </div>
      <div className="grid min-w-0 grid-cols-1 items-start gap-x-6 gap-y-2 @2xl/resources:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Table aria-label="项目服务状态与内存" className="[&_th]:h-8 [&_th:first-child]:pl-0 [&_td:first-child]:pl-0 [&_th:last-child]:pr-0 [&_td:last-child]:pr-0">
          <TableHeader><TableRow><TableHead>服务</TableHead><TableHead>状态</TableHead><TableHead className="text-right">服务内存</TableHead></TableRow></TableHeader>
          <TableBody>{(Object.keys(serviceNames) as Array<keyof typeof serviceNames>).map(id => {
            const service = value?.services.find(item => item.id === id)
            const reason = service ? failureReason(service) : null
            return <TableRow key={id} className="h-9 border-0">
              <TableCell className="py-1.5 whitespace-normal"><span>{serviceNames[id]}</span>{reason && <p className="mt-0.5 text-xs text-muted-foreground">{reason}</p>}</TableCell>
              <TableCell><StatusBadge status={!service?.available ? "neutral" : service.failure ? "error" : service.running ? "success" : stateTones[service.state]}>{service?.available ? service.running ? "运行中" : states[service.state] : "未知"}</StatusBadge></TableCell>
              <TableCell className="py-1.5 text-right tabular-nums">
                {service?.memoryBytes != null ? formatBytes(service.memoryBytes) : <Tooltip><TooltipTrigger render={<span tabIndex={0} />}>不可用</TooltipTrigger><TooltipContent>{service?.memoryUnavailable ? memoryUnavailable[service.memoryUnavailable] : "资源数据不可用"}</TooltipContent></Tooltip>}
              </TableCell>
            </TableRow>
          })}</TableBody>
        </Table>
        <Table aria-label="磁盘占用" className="[&_th]:h-8 [&_th:first-child]:pl-0 [&_td:first-child]:pl-0 [&_th:last-child]:pr-0 [&_td:last-child]:pr-0">
          <TableHeader><TableRow><TableHead>磁盘占用</TableHead><TableHead className="text-right">占用空间</TableHead></TableRow></TableHeader>
          <TableBody>{(Object.keys(diskNames) as Array<keyof typeof diskNames>).map(id => {
            const disk = value?.disks.find(item => item.id === id)
            return <TableRow key={id} className="h-9 border-0">
              <TableCell className="py-1.5 whitespace-normal">{diskNames[id]}</TableCell>
              <TableCell className="py-1.5 text-right tabular-nums">{disk?.bytes != null ? formatBytes(disk.bytes) : "不可用"}</TableCell>
            </TableRow>
          })}</TableBody>
        </Table>
      </div>
      {value && <p className="text-xs text-muted-foreground">采样 {new Date(value.sampledAt).toLocaleTimeString()} · 服务每 10 秒刷新，磁盘最多缓存 30 秒 · 页面隐藏时暂停</p>}
    </div>
  </Panel>
}
