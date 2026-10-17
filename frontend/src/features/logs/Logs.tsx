import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CalendarClock,
  Clipboard,
  Clock,
  ListFilter,
  List,
  ListEnd,
  Pause,
  Play,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react"

import { getLogSettings, listLogEntries, updateLogSettings, type LogSettings } from "@/api/logClient"
import { useRegisterPageRefresh } from "@/app/pageRefresh"
import { StatusDot } from "@/components/patterns/page-kit"
import { MobileChoiceSheet } from "@/components/patterns/mobile-choice-sheet"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { Notify } from "@/shared/types"
import {
  filterAndSortLogEntries, filterLogEntriesByRange, logEntryLevel, logEntryMessage,
  logEntryProtocol, logEntryProtocols, mergeLogEntriesInRange, presetLogRange,
  retainLogProtocolSelection,
  resolveLogDisplayRange,
  resolveLogTimeRange,
  type LogEntry, type LogSortDirection, type LogTimeRange,
} from "./logEntries"
import { LogCustomRangePicker } from "./LogRangeDialog"
import { LogSettingsDialog } from "./LogSettingsDialog"
import { LogStreamController, type LogConnection } from "./logStream"

const levelItems = [
  { value: "all", label: "全部" },
  { value: "debug", label: "Debug" },
  { value: "info", label: "Info" },
  { value: "warning", label: "Warning" },
  { value: "error", label: "Error" },
]

const presetItems = [
  { value: "15m", label: "最近 15 分钟" },
  { value: "1h", label: "最近 1 小时" },
  { value: "6h", label: "最近 6 小时" },
  { value: "custom", label: "自定义时间" },
]

export function Logs({ notify }: { notify: Notify }) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [paused, setPaused] = useState(false)
  const [queued, setQueued] = useState(0)
  const [connection, setConnection] = useState<LogConnection>("connecting")
  const [query, setQuery] = useState("")
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [timeRange, setTimeRange] = useState<LogTimeRange>(() => presetLogRange("1h"))
  const [customRangeVisible, setCustomRangeVisible] = useState(false)
  const [customRangeOpen, setCustomRangeOpen] = useState(false)
  const [rangeClock, setRangeClock] = useState(Date.now())
  const [autoScroll, setAutoScroll] = useState(true)
  const [sortDirection, setSortDirection] = useState<LogSortDirection>("asc")
  const [selectedLevel, setSelectedLevel] = useState("all")
  const [selectedProtocol, setSelectedProtocol] = useState("all")
  const [settings, setSettings] = useState<LogSettings>({ retentionDays: 7 })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyRevision, setHistoryRevision] = useState(0)
  const logRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const pendingCustomRangeOpen = useRef(false)
  const scrollIntent = useRef({ until: 0, top: 0, touchY: 0 })
  const streamRef = useRef<LogStreamController | null>(null)
  const settingsRequestVersion = useRef(0)
  const settingsRequestAbort = useRef<AbortController | null>(null)
  const settingsActionAbort = useRef<AbortController | null>(null)
  const resolvedRange = useMemo(() => resolveLogDisplayRange(timeRange, rangeClock), [rangeClock, timeRange])
  const resolvedRangeRef = useRef(resolvedRange)
  resolvedRangeRef.current = resolvedRange
  const rangeEntries = useMemo(() => filterLogEntriesByRange(entries, resolvedRange), [entries, resolvedRange])
  const lines = rangeEntries

  useEffect(() => {
    if (mobileSearchOpen) searchRef.current?.focus()
  }, [mobileSearchOpen])

  useEffect(() => {
    const stream = new LogStreamController({
      entries: (incoming) => setEntries((current) =>
        mergeLogEntriesInRange(current, incoming, resolvedRangeRef.current)),
      queued: setQueued,
      connection: setConnection,
      error: (error) => notify((error as Error).message, "error"),
    })
    streamRef.current = stream
    stream.start()
    return () => {
      streamRef.current = null
      stream.dispose()
      settingsRequestAbort.current?.abort()
      settingsActionAbort.current?.abort()
    }
  }, [notify])

  useEffect(() => {
    let disposed = false
    const abort = new AbortController()
    const requestedRange = resolveLogTimeRange(timeRange)
    setHistoryLoading(true)
    listLogEntries({ limit: 1500, since: requestedRange.since, until: requestedRange.until, signal: abort.signal })
      .then(({ entries: historyEntries }) => {
        if (disposed) return
        const history = historyEntries.map((entry) => ({
          ...entry,
          receivedAt: new Date(entry.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
        }))
        setEntries((current) =>
          mergeLogEntriesInRange(current, history, resolvedRangeRef.current))
      })
      .catch((error) => !disposed && !abort.signal.aborted && notify((error as Error).message, "error"))
      .finally(() => !disposed && setHistoryLoading(false))
    return () => {
      disposed = true
      abort.abort()
    }
  }, [historyRevision, notify, timeRange.mode, timeRange.since, timeRange.until])

  useEffect(() => {
    const timer = window.setInterval(() => setRangeClock(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    setEntries((current) => {
      const next = mergeLogEntriesInRange(current, [], resolvedRange)
      return next.length === current.length && next.every((entry, index) => entry === current[index])
        ? current
        : next
    })
  }, [resolvedRange])

  const refreshLogs = useCallback(() => {
    setHistoryRevision((current) => current + 1)
    streamRef.current?.restart()
  }, [])
  useRegisterPageRefresh(refreshLogs)

  useEffect(() => {
    if (autoScroll && !paused && logRef.current) {
      scrollIntent.current.until = 0
      logRef.current.scrollTop = logRef.current.scrollHeight
      scrollIntent.current.top = logRef.current.scrollTop
    }
  }, [autoScroll, lines, paused])

  const markScrollIntent = (upward = false) => {
    scrollIntent.current.until = performance.now() + 1200
    if (upward && logRef.current && logRef.current.scrollTop > 0) setAutoScroll(false)
  }
  const changeAutoScroll = (enabled: boolean) => {
    scrollIntent.current.until = 0
    setAutoScroll(enabled)
    if (enabled && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
      scrollIntent.current.top = logRef.current.scrollTop
    }
  }

  const protocols = useMemo(() => logEntryProtocols(rangeEntries), [rangeEntries])
  useEffect(() => {
    setSelectedProtocol((current) => retainLogProtocolSelection(current, protocols))
  }, [protocols])
  const visible = useMemo(
    () => filterAndSortLogEntries(rangeEntries, { query, timeRange: resolvedRange, selectedLevel, selectedProtocol, sortDirection }),
    [query, rangeEntries, resolvedRange, selectedLevel, selectedProtocol, sortDirection],
  )

  const connectionText = paused
    ? `已暂停${queued ? ` · ${queued} 条待显示` : ""}`
    : { connecting: "连接中", live: "实时跟随", reconnecting: "正在重连", offline: "已离线" }[connection]
  const connectionTone = paused ? "warn" : connection === "live" ? "ok" : connection === "offline" ? "error" : "warn"

  const togglePause = () => {
    const next = !paused
    setPaused(next)
    streamRef.current?.setPaused(next)
  }
  const clear = () => {
    setEntries([])
    streamRef.current?.clearQueue()
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(visible.map((entry) => entry.line).join("\n"))
      notify(`已复制 ${visible.length} 行日志`)
    } catch {
      notify("浏览器未允许复制日志", "error")
    }
  }
  const openSettings = () => {
    const version = ++settingsRequestVersion.current
    settingsRequestAbort.current?.abort()
    const abort = new AbortController()
    settingsRequestAbort.current = abort
    setSettingsOpen(true)
    setSettingsLoading(true)
    getLogSettings(abort.signal)
      .then((next) => {
        if (settingsRequestVersion.current === version) setSettings(next)
      })
      .catch((error) => {
        if (settingsRequestVersion.current !== version || abort.signal.aborted) return
        setSettingsOpen(false)
        notify((error as Error).message, "error")
      })
      .finally(() => {
        if (settingsRequestAbort.current === abort) settingsRequestAbort.current = null
        if (settingsRequestVersion.current === version) setSettingsLoading(false)
      })
  }
  const setSettingsDialogOpen = (open: boolean) => {
    if (!open) {
      settingsRequestVersion.current += 1
      settingsRequestAbort.current?.abort()
      settingsRequestAbort.current = null
    }
    setSettingsOpen(open)
  }
  const saveSettings = async (retentionDays: number) => {
    settingsActionAbort.current?.abort()
    const abort = new AbortController()
    settingsActionAbort.current = abort
    setSettingsBusy(true)
    try {
      const saved = await updateLogSettings(retentionDays, abort.signal)
      if (abort.signal.aborted) return
      setSettings({ retentionDays: saved.retentionDays })
      setSettingsOpen(false)
      notify("日志保留设置已更新")
    } catch (error) {
      if (abort.signal.aborted) return
      notify((error as Error).message, "error")
    } finally {
      if (settingsActionAbort.current === abort) {
        settingsActionAbort.current = null
        setSettingsBusy(false)
      }
    }
  }
  const chooseTimeRange = (value: string) => {
    if (value === "custom") {
      setCustomRangeVisible(true)
      pendingCustomRangeOpen.current = window.matchMedia("(max-width: 767px)").matches
    } else {
      pendingCustomRangeOpen.current = false
      setCustomRangeVisible(false)
      setCustomRangeOpen(false)
      setTimeRange(presetLogRange(value))
    }
  }
  return (
    <div className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden md:p-5">
      <div aria-label="日志工具栏" className="flex min-h-12 flex-nowrap items-center justify-between gap-1 border-b px-1.5 py-2 md:flex-wrap md:justify-start md:gap-2 md:rounded-t-md md:border md:px-3">
        <Tooltip>
          <TooltipTrigger render={<Button variant={query ? "secondary" : "outline"} size="icon" className={cn("size-11 md:hidden", mobileSearchOpen && "hidden")} aria-label={query ? "搜索日志（筛选中）" : "搜索日志"} aria-pressed={Boolean(query)} onClick={() => setMobileSearchOpen(true)} />}>
            <Search />
          </TooltipTrigger>
          <TooltipContent>{query ? "搜索日志（筛选中）" : "搜索日志"}</TooltipContent>
        </Tooltip>
        <div className={cn("min-w-0 md:min-w-40 md:flex-1 md:basis-40", mobileSearchOpen ? "flex-1" : "hidden md:block")}>
          <InputGroup>
            <InputGroupAddon><Search /></InputGroupAddon>
            <InputGroupInput ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索日志" aria-label="搜索日志" />
            {query && <InputGroupAddon align="inline-end" className="md:hidden">
              <Tooltip>
                <TooltipTrigger render={<InputGroupButton size="icon-sm" aria-label="清空搜索" onClick={() => setQuery("")} />}><X /></TooltipTrigger>
                <TooltipContent>清空搜索</TooltipContent>
              </Tooltip>
            </InputGroupAddon>}
          </InputGroup>
        </div>
        {mobileSearchOpen && <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon" className="size-11 md:hidden" aria-label="关闭搜索" onClick={() => { searchRef.current?.blur(); setMobileSearchOpen(false) }} />}><ArrowLeft /></TooltipTrigger>
          <TooltipContent>关闭搜索</TooltipContent>
        </Tooltip>}
        <div className={cn("contents", mobileSearchOpen && "max-md:hidden")}>
          <div className="relative flex shrink-0 items-center md:contents">
            <MobileChoiceSheet title="日志时间范围" value={timeRange.mode} options={presetItems} onChoose={chooseTimeRange} trigger={<Button variant="outline" size="icon" className="size-11 md:hidden" aria-label="日志时间范围"><Clock /></Button>} onClosed={() => {
              if (pendingCustomRangeOpen.current) {
                pendingCustomRangeOpen.current = false
                setCustomRangeOpen(true)
              }
            }} />
            <Select items={presetItems} value={customRangeVisible ? "custom" : timeRange.mode} onValueChange={(value) => value && chooseTimeRange(String(value))}>
              <Tooltip>
                <TooltipTrigger render={<SelectTrigger className="hidden w-28 md:flex" aria-label="日志时间范围" />}>
                  <SelectValue />
                </TooltipTrigger>
                <TooltipContent>日志时间范围</TooltipContent>
              </Tooltip>
              <SelectContent><SelectGroup>{presetItems.map((item) => <SelectItem key={item.value} value={item.value} onClick={item.value === "custom" ? () => chooseTimeRange("custom") : undefined}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
            {customRangeVisible && <LogCustomRangePicker range={timeRange} open={customRangeOpen} onOpenChange={setCustomRangeOpen} onApply={(next) => {
              setTimeRange(next)
              setCustomRangeVisible(true)
            }} />}
          </div>
          <Tooltip>
            <TooltipTrigger render={<Button variant={autoScroll ? "default" : "outline"} size="icon" className="size-11 md:h-6 md:w-auto md:gap-1 md:px-2" aria-label={autoScroll ? "停止跟随最新" : "跟随最新"} aria-pressed={autoScroll} onClick={() => changeAutoScroll(!autoScroll)} />}>
              {autoScroll ? <ListEnd /> : <List />}<span className="hidden md:inline">自动滚动</span>
            </TooltipTrigger>
            <TooltipContent>{autoScroll ? "跟随最新：点击停止" : "自由浏览：点击跟随最新"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant={paused ? "secondary" : "default"} size="icon" className="size-11 md:h-6 md:w-auto md:gap-1 md:px-2" aria-label={paused ? "继续实时流" : "暂停实时流"} aria-pressed={paused} onClick={togglePause} />}>
              {paused ? <Play /> : <Pause />}<span className="hidden md:inline">{paused ? "继续实时流" : "暂停实时流"}</span>
            </TooltipTrigger>
            <TooltipContent>{paused ? "继续实时流" : "暂停实时流"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="icon" className="size-11 md:h-6 md:w-auto md:gap-1 md:px-2" aria-label="复制当前日志" onClick={() => void copy()} disabled={!visible.length} />}><Clipboard /><span className="hidden md:inline">复制当前日志</span></TooltipTrigger>
            <TooltipContent>复制当前日志</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="icon" className="size-11 md:h-6 md:w-auto md:gap-1 md:px-2" aria-label="清屏" onClick={clear} disabled={!lines.length && !queued} />}><Trash2 /><span className="hidden md:inline">清屏</span></TooltipTrigger>
            <TooltipContent>清屏</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="icon" className="size-11 md:h-6 md:w-auto md:gap-1 md:px-2" aria-label="保留设置" onClick={openSettings} />}><Settings /><span className="hidden md:inline">保留设置</span></TooltipTrigger>
            <TooltipContent>保留设置</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div
        ref={logRef}
        data-pull-refresh="ignore"
        className="dark min-h-0 min-w-0 overflow-auto bg-log-background px-2 font-mono text-xs leading-5 text-log-foreground md:border-x md:p-3"
        aria-label="日志内容"
        tabIndex={0}
        onWheel={(event) => markScrollIntent(event.deltaY < 0)}
        onTouchStart={(event) => { scrollIntent.current.touchY = event.touches[0]?.clientY ?? 0 }}
        onTouchMove={(event) => {
          const y = event.touches[0]?.clientY ?? scrollIntent.current.touchY
          markScrollIntent(y > scrollIntent.current.touchY)
          scrollIntent.current.touchY = y
        }}
        onPointerDown={(event) => { if (event.target === event.currentTarget) markScrollIntent() }}
        onPointerMove={(event) => { if (event.buttons === 1 && event.target === event.currentTarget) markScrollIntent() }}
        onKeyDown={(event) => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
            markScrollIntent(["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey))
          }
        }}
        onScroll={() => {
          const element = logRef.current
          if (!element) return
          const previousTop = scrollIntent.current.top
          scrollIntent.current.top = element.scrollTop
          if (performance.now() > scrollIntent.current.until) return
          if (element.scrollHeight - element.scrollTop - element.clientHeight > 28) setAutoScroll(false)
          else if (element.scrollTop > previousTop) {
            scrollIntent.current.until = 0
            setAutoScroll(true)
          }
        }}
      >
        <div className="min-w-0">
          <div className="sticky top-0 z-10 grid h-11 grid-cols-3 items-center gap-x-3 border-b border-log-border bg-log-background text-log-muted md:h-8 md:grid-cols-[5rem_3.5rem_3rem_minmax(0,1fr)] md:px-3 md:before:absolute md:before:inset-x-0 md:before:-top-3 md:before:h-3 md:before:bg-log-background md:before:content-['']">
            <LogSortHeader direction={sortDirection} onSort={() => setSortDirection((current) => current === "asc" ? "desc" : "asc")} />
            <LogFilterHeader label="级别" items={levelItems} value={selectedLevel} onValueChange={setSelectedLevel} />
            <LogFilterHeader label="协议" items={[{ value: "all", label: "全部" }, ...protocols.map((value) => ({ value, label: value }))]} value={selectedProtocol} onValueChange={setSelectedProtocol} />
            <span className="hidden md:block">消息</span>
          </div>
          {!visible.length && (
            <div className="flex h-32 items-center justify-center text-log-subtle">
              {historyLoading ? "正在查询历史日志" : query || selectedLevel !== "all" || selectedProtocol !== "all" ? "没有匹配的日志" : "当前时间范围没有日志"}
            </div>
          )}
          {visible.map((entry) => {
            const logLevel = logEntryLevel(entry)
            return (
              <div key={entry.id} className="grid min-h-7 grid-cols-3 items-start gap-x-3 gap-y-1 border-b border-log-border/80 py-2 last:border-b-0 md:grid-cols-[5rem_3.5rem_3rem_minmax(0,1fr)] md:px-3 md:py-1">
                <span className="text-log-subtle max-md:min-w-0 max-md:wrap-anywhere">{entry.receivedAt || "--:--:--"}</span>
                <span className={cn(
                  "uppercase max-md:min-w-0 max-md:wrap-anywhere",
                  logLevel === "error" ? "text-destructive" : logLevel === "warn" || logLevel === "warning" ? "text-status-warning" : logLevel === "debug" ? "text-status-info" : "text-status-success"
                )}>{logLevel}</span>
                <span className="text-log-muted max-md:min-w-0 max-md:wrap-anywhere">{logEntryProtocol(entry)}</span>
                <span className="col-span-3 min-w-0 whitespace-pre-wrap wrap-anywhere md:col-span-1">{logEntryMessage(entry)}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex min-h-8 flex-wrap items-center gap-x-2 border-t px-2 py-1 text-xs text-muted-foreground md:rounded-b-md md:border md:px-3">
        <StatusDot tone={connectionTone} />
        {paused ? <Pause className="size-3" /> : <Play className="size-3" />}
        {connectionText}
        <span className="ml-auto flex items-center gap-1">
          <CalendarClock className="size-3" />
          {resolvedRange.label} · {visible.length} 行
        </span>
      </div>

      <LogSettingsDialog settings={settings} busy={settingsBusy} loading={settingsLoading} open={settingsOpen} onOpenChange={setSettingsDialogOpen} onSave={(days) => void saveSettings(days)} />
    </div>
  )
}

function LogSortHeader({
  direction,
  onSort,
}: {
  direction: LogSortDirection
  onSort: () => void
}) {
  return (
    <Button variant="ghost" size="xs" className="w-fit px-0" onClick={onSort}>
      时间
      {direction === "asc" ? <ArrowUp data-icon="inline-end" /> : <ArrowDown data-icon="inline-end" />}
    </Button>
  )
}

function LogFilterHeader({
  label,
  items,
  value,
  onValueChange,
}: {
  label: string
  items: Array<{ value: string; label: string }>
  value: string
  onValueChange: (value: string) => void
}) {
  return (
    <>
    <MobileChoiceSheet title={`${label}筛选`} value={value} options={items} onChoose={onValueChange} trigger={<Button variant="ghost" size="xs" className="w-fit px-0 md:hidden" aria-label={`${label}筛选`}>{label}<ListFilter data-icon="inline-end" /></Button>} />
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="xs" className="hidden w-fit px-0 md:flex" />}>
        {label}<ListFilter data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-36">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}筛选</DropdownMenuLabel>
          {items.length ? (
            <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
              {items.map((item) => <DropdownMenuRadioItem key={item.value} value={item.value}>{item.label}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          ) : <DropdownMenuItem disabled>暂无选项</DropdownMenuItem>}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  )
}
