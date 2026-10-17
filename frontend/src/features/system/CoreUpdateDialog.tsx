import { useRef, useState } from "react"
import { Check, ChevronRight, Download, Info, Upload } from "lucide-react"
import { checkCoreUpdate, installCoreUpdate, prepareCoreDownload, rollbackCoreUpdate, uploadCore, type CoreDownloadRoute } from "@/api/systemClient"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { StatusBadge } from "@/components/patterns/status-badge"
import { Button } from "@/components/ui/button"
import { CardDescription } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { coreUpdateError } from "@/shared/systemMessages"
import { formatBytes } from "@/shared/format"
import { cn } from "@/lib/utils"
import { downloadRoutes, downloadSources, type DownloadSettings } from "./UpdateSettings"
import { useCoreUpdate } from "./useCoreUpdate"
import { coreVersionConclusion } from "./coreVersionCheck"
import { UpdateCard, UpdateCardStatus, updateActionsClassName, updateButtonClassName } from "./UpdateCard"

const phases = { idle: "等待准备", checking: "查询官方稳定版", downloading: "正在准备核心", uploading: "上传中", validating: "校验中",
  ready: "校验完成，可安装", installing: "安装并确认启动中", "rolling-back": "回退并确认启动中", succeeded: "切换完成，核心已恢复",
  "rolled-back": "启动失败，已自动回退", failed: "操作失败" }
type Confirmation = { action: "install" | "rollback"; version: string; sha256: string; verification?: "official" | "local" }

export function CoreUpdateCard({ active, settings, disabled, onRefresh, onBusyChange }: {
  active: boolean; settings: DownloadSettings; disabled: boolean
  onRefresh: () => Promise<void>; onBusyChange: (busy: boolean) => void
}) {
  const { state, busy, error, readError, run, refresh } = useCoreUpdate({ active, onRefresh, onBusyChange })
  const [file, setFile] = useState<File | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const blocked = busy || disabled
  const route: CoreDownloadRoute = settings.mode === "external" ? { mode: settings.mode, proxy: settings.proxy } : { mode: settings.mode }
  const routeMissing = settings.mode === "external" && !settings.proxy.trim()
  const showUpload = uploadOpen || (settings.source === "upload" && !state?.candidate)
  const selected = confirmation?.action === "install" ? state?.candidate : state?.previous
  const confirmationValid = Boolean(confirmation && selected?.sha256 === confirmation.sha256 && !readError)
  const switching = state?.phase === "installing" || state?.phase === "rolling-back"
  const conclusion = coreVersionConclusion(state)
  const current = conclusion === "当前已是最新版本"
  const available = conclusion.startsWith("发现新版本")
  const operation = state && state.phase !== "idle" && state.phase !== "checking"
  const title = readError ? "正在重新连接更新服务" : state?.candidate ? state.candidate.version + " 已准备就绪"
    : operation && !(state.phase === "failed" && state.checkState === "failed") ? phases[state.phase] : conclusion
  const warning = Boolean(readError || state?.phase === "failed" || state?.phase === "rolled-back" || (!current && !available && !busy && !state?.candidate))
  const showNotes = Boolean(state?.latest && !confirmation && !showUpload && !state?.candidate && !operation)
  const prepare = () => {
    if (blocked || routeMissing || settings.source === "upload" || (settings.source === "custom" && !settings.url.trim())) return
    const source = settings.source
    void run(signal => prepareCoreDownload({ ...route, source, ...(source === "custom" ? { url: settings.url } : {}) }, signal))
  }
  const confirm = () => {
    if (!confirmation || !confirmationValid || blocked) return
    const target = confirmation
    setConfirmation(null)
    void run(signal => target.action === "install" ? installCoreUpdate(target.sha256, signal) : rollbackCoreUpdate(target.sha256, signal), true)
  }
  return <UpdateCard title="Mihomo Core" version={state?.current?.version ?? (state || readError ? "未知" : "读取中")}
    checking={state?.phase === "checking"} checkDisabled={blocked || routeMissing || Boolean(confirmation)}
    onCheck={() => void run(signal => checkCoreUpdate(route, signal))} checkedAt={state?.checkedAt ?? null}
    previous={state?.previous?.version ?? "暂无"} rollbackDisabled={blocked || !state?.previous || Boolean(readError) || Boolean(confirmation)}
    onRollback={() => state?.previous && setConfirmation({ action: "rollback", ...state.previous })}>
    <Collapsible open={notesOpen} onOpenChange={setNotesOpen} className="flex flex-col gap-3">
      {!confirmation && <div>
        <UpdateCardStatus icon={busy ? <Spinner /> : warning ? <Info className="size-[17px] shrink-0 text-status-warning" />
          : available && !operation ? <Download className="size-[17px] shrink-0 text-primary" /> : <Check className="size-[17px] shrink-0 text-primary" />}
          action={showNotes && <CollapsibleTrigger render={<Button variant="ghost" size="default" className="h-7 shrink-0 gap-1 px-0 max-md:min-h-7" />}>
            更新内容<ChevronRight data-icon="inline-end" className={cn(notesOpen && "rotate-90")} />
          </CollapsibleTrigger>}>{showUpload && !busy ? "上传核心" : title}</UpdateCardStatus>
        {!operation && !showUpload && <CardDescription className="mt-1.5">
          {state?.checkState === "checking" ? "正在读取官方发布版本…" : available ? "下载和校验完成后再安装。"
            : current ? "当前运行 " + state?.current?.version + "。" : "检查官方稳定版本，或上传核心文件。"}
        </CardDescription>}
      </div>}
      {state && operation && <CardDescription>
        {state.source && "本次来源：" + downloadSources.find(item => item.value === state.source)?.label + "。"}
        {state.route && " 连接：" + downloadRoutes.find(item => item.value === state.route)?.label + "。"}
        {state.bytes > 0 && " " + formatBytes(state.bytes) + (state.total ? " / " + formatBytes(state.total) + "（" + Math.min(100, Math.round(state.bytes / state.total * 100)) + "%）" : "")}
        {switching && " 版本切换会短暂中断代理连接，正在确认核心恢复。"}
      </CardDescription>}
      {(error || state?.error) && <Alert variant="destructive"><AlertDescription>
        {error || coreUpdateError(state?.error ?? null)} 可调整连接方式或来源后重试。
      </AlertDescription></Alert>}
      {readError && <Alert><AlertDescription>
        正在重新连接更新服务，连接恢复后自动确认任务结果。
        <Button variant="outline" size="lg" onClick={refresh}>重新读取状态</Button>
      </AlertDescription></Alert>}
      {state?.candidate && !showUpload && <div className="flex flex-col gap-2">
        <StatusBadge status={state.candidate.verification === "official" ? "success" : "warning"}>{state.candidate.verification === "official" ? "官方 SHA256 已核对" : "未核对官方摘要"}</StatusBadge>
        <CardDescription className="break-all">SHA256：{state.candidate.sha256}</CardDescription>
        {!confirmation && <div className={updateActionsClassName}>
          <Button size="lg" className={updateButtonClassName} disabled={blocked || Boolean(readError)} onClick={() => setConfirmation({ action: "install", ...state.candidate! })}>安装并重启</Button>
          <Button size="lg" variant="outline" className={updateButtonClassName} disabled={blocked} onClick={() => setUploadOpen(true)}>更换文件</Button>
        </div>}
      </div>}
      {confirmation ? <Alert>
        <AlertTitle>{confirmation.action === "install" ? "安装 " : "回退到 "}{confirmation.version}？</AlertTitle>
        <AlertDescription className="gap-3">
          {confirmation.action === "install" ? <>
            <p>{confirmation.verification === "official" ? "已核对官方 SHA256。" : "此文件由你提供，未核对官方摘要。"}</p>
            <p>安装会重启 Core，代理连接将短暂中断；启动失败将自动恢复切换前版本。</p>
          </> : <p>使用本地上一可用版本并重启 Core，代理连接将短暂中断，随后确认核心恢复。</p>}
          {!confirmationValid && <p>文件状态已变化或暂不可确认，请取消后重新读取状态。</p>}
          <div className={updateActionsClassName}>
            <Button variant="outline" size="lg" className={updateButtonClassName} onClick={() => setConfirmation(null)}>取消</Button>
            <Button size="lg" className={updateButtonClassName} disabled={blocked || !confirmationValid} onClick={confirm}>{confirmation.action === "install" ? "确认安装" : "回退并重启"}</Button>
          </div>
        </AlertDescription>
      </Alert> : <>
        {showUpload && <Field>
          <FieldLabel htmlFor="core-upload-file">上传 Linux Core 文件</FieldLabel>
          <input ref={fileInput} id="core-upload-file" type="file" className="sr-only" disabled={blocked} onChange={event => setFile(event.target.files?.[0] ?? null)} />
          <div className="flex min-w-0 items-center gap-3"><Button variant="outline" size="lg" className={updateButtonClassName} disabled={blocked} onClick={() => fileInput.current?.click()}>选择文件</Button><span className="min-w-0 truncate text-sm">{file?.name ?? "未选择文件"}</span></div>
          <FieldDescription>原始可执行文件或 .gz，最大 128 MiB。上传不使用网络设置，不核对官方摘要。</FieldDescription>
          <div className={updateActionsClassName}>
            {settings.source !== "upload" && <Button variant="outline" size="lg" disabled={blocked} className={updateButtonClassName} onClick={() => setUploadOpen(false)}>取消上传</Button>}
            <Button size="lg" disabled={blocked || !file} className={updateButtonClassName} onClick={() => file && void run(async signal => { await uploadCore(file, signal); if (!signal.aborted) setUploadOpen(false) })}><Upload data-icon="inline-start" />上传并校验</Button>
          </div>
        </Field>}
        {!showUpload && !state?.candidate && !busy && <div className={cn(updateActionsClassName, "mt-0", current && settings.source !== "custom" && "grid-cols-1")}>
          {(!current || settings.source === "custom") && <Button size="lg" className={updateButtonClassName} disabled={blocked || routeMissing || (settings.source === "custom" && !settings.url.trim())} onClick={prepare}><Download data-icon="inline-start" />下载更新</Button>}
          <Button variant="outline" size="lg" className={updateButtonClassName} disabled={blocked} onClick={() => setUploadOpen(true)}><Upload data-icon="inline-start" />上传核心</Button>
        </div>}
        {(routeMissing || (settings.source === "custom" && !settings.url.trim())) && <CardDescription>请在下方更新设置中填写{routeMissing ? "外部代理地址" : "Core 文件地址"}。</CardDescription>}
      </>}
      {showNotes && <CollapsibleContent>
        <Separator className="mb-3" />
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium">{state?.checkState === "succeeded" ? "官方发布说明" : "上次查询的发布说明"} · {state?.latest?.version}</h3>
          <p className="text-xs text-muted-foreground whitespace-pre-wrap wrap-anywhere">{state?.latest?.releaseNotes ?? "此版本未提供发布说明。"}</p>
        </div>
      </CollapsibleContent>}
    </Collapsible>
  </UpdateCard>
}
