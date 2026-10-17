import { SettingsGroup, SettingsToolRow as ToolRow } from "./ManagerSettingsFields"
import { systemErrorMessage } from "../../shared/systemMessages.ts";
import { useEffect, useRef, useState, type FormEvent } from "react"
import {
  Eraser,
  Search,
  RefreshCw,
  RotateCw,
  ShieldAlert,
} from "lucide-react"

import {
  flushDnsCache,
  flushFakeIpCache,
  queryDns,
  type DnsQueryResponse,
  updateGeoData,
} from "@/api/controllerClient"
import { readCoreServiceStatus, type CoreServiceStatus } from "@/api/systemClient"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Json, Notify } from "@/shared/types"
import { coreFailureMessage, readControllerConnection, recoverCoreAndRefresh, type ControllerConnection } from "./settingsActions"
import { ManagerSettingsPanel } from "./ManagerSettingsPanel"
import { UpdatesMaintenance } from "./UpdatesMaintenance"
import { recoverTunAndRefresh, type TunObservation } from "./tunRecovery"

type BusyAction = string | null

export function SystemPage({
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
  const [busy, setBusy] = useState<BusyAction>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [restartAction, setRestartAction] = useState<"start" | "restart" | null>(null)
  const [service, setService] = useState<CoreServiceStatus | null>(null)
  const [serviceError, setServiceError] = useState<string | null>(null)
  const [connection, setConnection] = useState<ControllerConnection | null>(null)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const restartWaitAbort = useRef<AbortController | null>(null)
  const serviceReadVersion = useRef(0)
  const online = status?.controller === true && !statusError

  useEffect(() => () => restartWaitAbort.current?.abort(), [])

  useEffect(() => {
    const request = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (!restartWaitAbort.current) {
        const version = serviceReadVersion.current
        const [core, controller] = await Promise.allSettled([
          readCoreServiceStatus(request.signal), readControllerConnection(request.signal),
        ])
        if (request.signal.aborted) return
        if (!restartWaitAbort.current && version === serviceReadVersion.current) {
          if (core.status === "fulfilled") { setService(core.value); setServiceError(null) }
          else { setService(null); setServiceError("无法读取核心服务状态") }
          if (controller.status === "fulfilled") setConnection(controller.value)
        }
      }
      if (!request.signal.aborted) timer = setTimeout(() => void poll(), 3_000)
    }
    void poll()
    return () => { request.abort(); clearTimeout(timer) }
  }, [])

  const runBusyAction = async (action: string, operation: () => Promise<void>, success: string) => {
    if (!online || busy) return false
    setBusy(action)
    try {
      await operation()
      notify(success)
      return true
    } catch (error) {
      notify(systemErrorMessage(error as Error), "error")
      return false
    } finally {
      setBusy(null)
    }
  }

  const restart = async (action: "start" | "restart") => {
    if (busy || updateBusy || settingsBusy || restartWaitAbort.current) return
    setRestartAction(null)
    const abort = new AbortController()
    restartWaitAbort.current = abort
    serviceReadVersion.current++
    setBusy("restart")
    setRecoveryError(null)
    try {
      if (!(await recoverCoreAndRefresh(action, abort.signal, onRefresh))) return
      notify(action === "start" ? "核心已启动，Controller 已恢复" : "核心已重启，Controller 已恢复")
    } catch (error) {
      if (abort.signal.aborted) return
      setRecoveryError(systemErrorMessage(error as Error))
      notify(systemErrorMessage(error as Error), "error")
    } finally {
      if (restartWaitAbort.current === abort) {
        const [core, controller] = await Promise.allSettled([
          readCoreServiceStatus(abort.signal), readControllerConnection(abort.signal),
        ])
        if (!abort.signal.aborted) {
          if (core.status === "fulfilled") { setService(core.value); setServiceError(null) }
          else { setService(null); setServiceError("无法读取核心服务状态") }
          if (controller.status === "fulfilled") setConnection(controller.value)
        }
        restartWaitAbort.current = null
        if (!abort.signal.aborted) setBusy(null)
      }
    }
  }

  const recoverTun = async (devices: string[]): Promise<TunObservation | null> => {
    if (busy || updateBusy || settingsBusy || restartWaitAbort.current) return null
    const abort = new AbortController()
    restartWaitAbort.current = abort
    serviceReadVersion.current++
    setBusy("tun-recovery")
    setRecoveryError(null)
    try {
      const recovered = await recoverTunAndRefresh(devices, abort.signal, onRefresh)
      if (recovered) notify("恢复已确认：核心服务和 Controller 正常，TUN 已关闭，目标网卡已释放")
      return recovered
    } finally {
      if (restartWaitAbort.current === abort) {
        restartWaitAbort.current = null
        if (!abort.signal.aborted) setBusy(null)
      }
    }
  }

  const clearFakeIp = () => runBusyAction("fakeip", flushFakeIpCache, "Fake-IP 缓存已清空")
  const clearDns = () => runBusyAction("dns", flushDnsCache, "DNS 缓存已清空")
  const updateGeo = () => runBusyAction("geo", updateGeoData, "GEO 数据已更新")

  const serviceText = !service ? (serviceError ? "未知" : "读取中") : service.running ? "运行中"
    : ({ active: "等待就绪", inactive: "已停止", activating: "启动中", deactivating: "停止中", failed: "启动失败", unknown: "未知" })[service.state]
  const recoveryAction = service && ["inactive", "failed"].includes(service.state) ? "start" : "restart"
  const recoveryLabel = recoveryAction === "start" ? "启动核心" : "重启核心"
  const recoveryDisabled = updateBusy || settingsBusy || busy !== null || service?.busy || service?.state === "deactivating" || connection === "authentication-failed"
    || (!service && connection !== "online")
  const failureMessage = coreFailureMessage(service)

  return (
    <div className="h-full min-h-0">
      <ManagerSettingsPanel
        notify={notify}
        onRefresh={onRefresh}
        coreVersion={typeof status?.version === "string" ? status.version : undefined}
        coreBusy={updateBusy || busy !== null || Boolean(service?.busy)}
        recoveringTun={busy === "tun-recovery"}
        onRecoverTun={recoverTun}
        onApplyingChange={setSettingsBusy}
        dnsTools={
          <SettingsGroup title="DNS 工具">
              {!online && <Alert><AlertDescription>Controller 未连接，DNS 工具暂不可用；可在更新与维护中检查服务状态或恢复核心。</AlertDescription></Alert>}
              <ToolRow label="DNS 查询"><DnsQueryDialog online={online} disabled={busy !== null} /></ToolRow>
              <CacheToolRow title="DNS 缓存" description="清空解析结果缓存，不影响 Fake-IP 映射"
                dialogTitle="确认清空 DNS 缓存" dialogDescription="该操作会移除现有 DNS 解析缓存，后续查询由 Mihomo 重新解析。"
                busy={busy === "dns"} disabled={!online || busy !== null} onConfirm={clearDns} />
              <CacheToolRow title="Fake-IP 缓存" description="清空域名与 Fake-IP 映射"
                dialogTitle="确认清空 Fake-IP 缓存" dialogDescription="该操作会移除现有域名映射，后续访问时由 Mihomo 重新生成。"
                busy={busy === "fakeip"} disabled={!online || busy !== null} onConfirm={clearFakeIp} />
          </SettingsGroup>
        }
        maintenance={active => <UpdatesMaintenance active={active} disabled={busy !== null || settingsBusy || Boolean(service?.busy)} updateBusy={updateBusy} onRefresh={onRefresh} onBusyChange={setUpdateBusy}>
          <SettingsGroup title="运行维护">
            <ToolRow label="核心服务" description={serviceText + (connection === "online" ? " · Controller 已连接" : " · Controller 未连接")}>
              <Button variant="outline" size="sm" disabled={Boolean(recoveryDisabled) || restartAction !== null} onClick={() => setRestartAction(recoveryAction)}>
                <RotateCw data-icon="inline-start" className={busy === "restart" ? "animate-spin" : undefined} />{busy === "restart" ? "恢复中" : recoveryLabel}
              </Button>
            </ToolRow>
            {restartAction && <div className="px-3 py-3 md:px-4"><Alert>
              <AlertDescription className="gap-3">
                <p>{restartAction === "start" ? "启动固定的 Mihomo Core 服务，并确认 Controller 恢复。" : "重启会短暂中断代理连接；随后确认 Controller 恢复。"}</p>
                <div className="flex gap-2 md:justify-end">
                  <Button variant="outline" size="sm" className="flex-1 md:flex-none" onClick={() => setRestartAction(null)}>取消</Button>
                  <Button size="sm" className="flex-1 md:flex-none" disabled={Boolean(recoveryDisabled)} onClick={() => void restart(restartAction)}><RotateCw data-icon="inline-start" />{restartAction === "start" ? "确认启动" : "确认重启"}</Button>
                </div>
              </AlertDescription>
            </Alert></div>}
            {(serviceError || failureMessage || recoveryError || connection === "authentication-failed") && <Alert variant="destructive"><AlertDescription>{recoveryError || failureMessage || serviceError || "Controller 认证失败，请检查部署中的内部连接凭据。"}</AlertDescription></Alert>}
            <ToolRow label="GEO 数据">
              <Button variant="outline" size="sm" disabled={!online || busy !== null || updateBusy || settingsBusy} onClick={() => void updateGeo()}>
                <RefreshCw data-icon="inline-start" className={busy === "geo" ? "animate-spin" : undefined} />{busy === "geo" ? "更新中" : "更新 GEO 数据"}
              </Button>
            </ToolRow>
          </SettingsGroup>
        </UpdatesMaintenance>}
      />
    </div>
  )
}

function CacheToolRow({
  title,
  description,
  dialogTitle,
  dialogDescription,
  busy,
  disabled,
  onConfirm,
}: {
  title: string
  description: string
  dialogTitle: string
  dialogDescription: string
  busy: boolean
  disabled: boolean
  onConfirm: () => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const confirming = useRef(false)
  const confirm = async () => {
    if (disabled || busy || confirming.current) return
    confirming.current = true
    try {
      if (await onConfirm()) setOpen(false)
    } finally {
      confirming.current = false
    }
  }
  return (
    <ToolRow label={title} description={description}>
      <AlertDialog open={open} onOpenChange={(next) => { if (!confirming.current) setOpen(next) }}>
        <AlertDialogTrigger render={<Button variant="destructive" size="sm" disabled={disabled} />}>
          {busy ? <RefreshCw className="animate-spin" data-icon="inline-start" /> : <Eraser data-icon="inline-start" />}
          {busy ? "清理中" : "清空"}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialogTitle}</AlertDialogTitle>
            <AlertDialogDescription>{dialogDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={disabled || busy} onClick={() => void confirm()}>
              {busy ? <RefreshCw className="animate-spin" data-icon="inline-start" /> : <ShieldAlert data-icon="inline-start" />}{busy ? "清理中" : "确认清空"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ToolRow>
  )
}

const dnsTypeItems = ["A", "AAAA", "CNAME", "TXT"].map((value) => ({ value, label: value }))

function DnsQueryDialog({ online, disabled }: { online: boolean; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [type, setType] = useState<"A" | "AAAA" | "CNAME" | "TXT">("A")
  const [querying, setQuerying] = useState(false)
  const [result, setResult] = useState<DnsQueryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const target = name.trim()
    if (!target || querying) {
      if (!target) setError("请输入要查询的域名")
      return
    }
    setQuerying(true)
    setError(null)
    setResult(null)
    try {
      setResult(await queryDns(target, type))
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : "DNS 查询失败")
    } finally {
      setQuerying(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" disabled={!online || disabled} />}>
        <Search data-icon="inline-start" />查询
      </DialogTrigger>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>DNS 查询</DialogTitle>
            <DialogDescription>使用 Mihomo 当前 DNS 设置查询域名。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={Boolean(error) || undefined}>
              <FieldLabel htmlFor="dns-query-name">域名</FieldLabel>
              <div className="flex gap-2">
                <Input id="dns-query-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="example.com" aria-invalid={Boolean(error)} disabled={querying} />
                <Select items={dnsTypeItems} value={type} onValueChange={(value) => value && setType(value as typeof type)} disabled={querying}>
                  <SelectTrigger className="w-24" aria-label="DNS 记录类型"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{dnsTypeItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </div>
              {error && <FieldError>{error}</FieldError>}
            </Field>
            {result && (
              <Field>
                <FieldLabel>查询结果</FieldLabel>
                <div className="max-h-52 overflow-y-auto rounded-md border px-3 py-2 font-mono text-xs">
                  <div className="mb-1 text-muted-foreground">Rcode: {result.Status}</div>
                  {result.Answer?.length
                    ? result.Answer.map((answer, index) => <div key={`${answer.name}-${answer.type}-${index}`} className="break-all">{answer.data} <span className="text-muted-foreground">TTL {answer.TTL}</span></div>)
                    : <div className="text-muted-foreground">没有 Answer 记录</div>}
                </div>
              </Field>
            )}
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={querying || !online}>
              {querying ? <RefreshCw className="animate-spin" data-icon="inline-start" /> : <Search data-icon="inline-start" />}
              {querying ? "查询中" : "查询"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
