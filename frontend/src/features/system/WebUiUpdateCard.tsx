import { useRef, useState } from "react"
import { Check, ChevronRight, Download, Info, Upload } from "lucide-react"
import { checkWebUiUpdate, installWebUiUpdate, prepareWebUiDownload, readWebUiUpdate, rollbackWebUiUpdate, uploadWebUi } from "@/api/webuiUpdateClient"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { StatusBadge } from "@/components/patterns/status-badge"
import { Button } from "@/components/ui/button"
import { CardDescription } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { webUiRequestMessage, webUiUpdateError } from "@/shared/webuiUpdateMessages"
import { formatBytes } from "@/shared/format"
import { cn } from "@/lib/utils"
import { coreVersionConclusion } from "./coreVersionCheck"
import { downloadRoutes, downloadSources, type DownloadSettings } from "./UpdateSettings"
import { useUpdateTask } from "./useUpdateTask"
import { UpdateCard, UpdateCardStatus, updateActionsClassName, updateButtonClassName } from "./UpdateCard"

const phases = { idle: "等待准备", checking: "查询官方稳定版", downloading: "正在下载运行包", uploading: "上传中", validating: "校验中",
  ready: "校验完成，可安装", installing: "正在安装并确认服务恢复", "rolling-back": "正在回退并确认服务恢复", succeeded: "Web UI 更新完成",
  "rolled-back": "已恢复上一程序", failed: "操作失败" }
type Confirmation = { action: "install" | "rollback"; version: string; sha256: string; verification?: "official" | "local" }

export function WebUiUpdateCard({ active, settings, disabled, onBusyChange }: {
  active: boolean; settings: DownloadSettings; disabled: boolean; onBusyChange: (busy: boolean) => void
}) {
  const { state, busy, error, readError, run, refresh } = useUpdateTask({ active, read: readWebUiUpdate, message: webUiRequestMessage, onBusyChange })
  const [file, setFile] = useState<File | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const blocked = busy || disabled || !state?.available
  const route = settings.mode === "external" ? { mode: settings.mode, proxy: settings.proxy } : { mode: settings.mode }
  const routeMissing = settings.mode === "external" && !settings.proxy.trim()
  const showUpload = uploadOpen || (settings.source === "upload" && !state?.candidate)
  const selected = confirmation?.action === "install" ? state?.candidate : state?.previous
  const confirmationValid = Boolean(confirmation && selected?.sha256 === confirmation.sha256 && !readError)
  const conclusion = state?.checkState === "unpublished" ? "尚无可用的正式发布" : state?.checkState === "unavailable" ? "本平台发布包暂不可用"
    : coreVersionConclusion(state ? { ...state, checkState: state.checkState } : null)
  const current = conclusion === "当前已是最新版本", available = conclusion.startsWith("发现新版本")
  const operation = state && state.phase !== "idle" && state.phase !== "checking"
  const switching = state?.phase === "installing" || state?.phase === "rolling-back"
  const title = readError ? "正在重新连接更新服务" : state?.candidate ? "v" + state.candidate.version + " 已准备就绪"
    : operation && !(state.phase === "failed" && ["failed", "unpublished", "unavailable"].includes(state.checkState)) ? phases[state.phase] : conclusion
  const warning = Boolean(readError || state?.error || (!current && !available && !busy && !state?.candidate))
  const showNotes = Boolean(state?.latest && !confirmation && !showUpload && !state?.candidate)
  const prepare = () => {
    if (blocked || routeMissing || settings.source === "upload" || (settings.source === "custom" && !settings.webuiUrl.trim())) return
    const source = settings.source
    void run(signal => prepareWebUiDownload({ ...route, source, ...(source === "custom" ? { url: settings.webuiUrl } : {}) }, signal))
  }
  const confirm = () => {
    if (!confirmation || !confirmationValid || blocked) return
    const target = confirmation; setConfirmation(null)
    void run(signal => target.action === "install" ? installWebUiUpdate(target.sha256, signal) : rollbackWebUiUpdate(target.sha256, signal))
  }
  return <UpdateCard title="Web UI" version={state ? "v" + state.current.version : readError ? "未知" : "读取中"}
    checking={state?.phase === "checking"} checkDisabled={blocked || routeMissing || Boolean(confirmation)}
    onCheck={() => void run(signal => checkWebUiUpdate(route, signal))} checkedAt={state?.checkedAt ?? null}
    previous={state?.previous ? "v" + state.previous.version + " · " + state.previous.sha256.slice(0, 12) : "暂无"}
    rollbackDisabled={blocked || !state?.previous || Boolean(readError) || Boolean(confirmation)}
    onRollback={() => state?.previous && setConfirmation({ action: "rollback", ...state.previous })}>
    <Collapsible open={notesOpen} onOpenChange={setNotesOpen} className="flex flex-col gap-3">
      {!confirmation && <div>
        <UpdateCardStatus icon={busy ? <Spinner /> : warning ? <Info className="size-[17px] shrink-0 text-status-warning" />
          : available && !operation ? <Download className="size-[17px] shrink-0 text-primary" /> : <Check className="size-[17px] shrink-0 text-primary" />}
          action={showNotes && <CollapsibleTrigger render={<Button variant="ghost" className="h-7 shrink-0 gap-1 px-0 max-md:min-h-7" />}>
            更新内容<ChevronRight data-icon="inline-end" className={cn(notesOpen && "rotate-90")} />
          </CollapsibleTrigger>}>{showUpload && !busy ? "上传更新包" : title}</UpdateCardStatus>
        {!operation && !showUpload && <CardDescription className="mt-1.5">{state?.checkState === "unpublished"
          ? "发布仓库或正式 Release 尚未公开，可手动上传受信任的运行包。" : "下载并校验完整管理器运行包，确认后安装。"}</CardDescription>}
      </div>}
      {state && operation && <CardDescription>
        {state.source && "本次来源：" + downloadSources.find(item => item.value === state.source)?.label + "。"}
        {state.route && " 连接：" + downloadRoutes.find(item => item.value === state.route)?.label + "。"}
        {state.bytes > 0 && " " + formatBytes(state.bytes) + (state.total ? " / " + formatBytes(state.total) : "")}
        {switching && " 管理器服务正在更新，页面会自动重连并查询结果。"}
      </CardDescription>}
      {(error || readError || state?.error) && <Alert variant="destructive"><AlertDescription>
        {error || readError || webUiUpdateError(state?.error ?? null)}
        {readError && <Button variant="outline" size="lg" onClick={refresh}>重新读取状态</Button>}
      </AlertDescription></Alert>}
      {state?.install?.finishedAt && !state.error && <CardDescription>
        完成于 {new Date(state.install.finishedAt).toLocaleString("zh-CN", { hour12: false })}。请完成当前编辑后刷新浏览器以使用新的页面资源。
      </CardDescription>}
      {state?.candidate && !showUpload && <div className="flex flex-col gap-2">
        <StatusBadge status={state.candidate.verification === "official" ? "success" : "warning"}>{state.candidate.verification === "official" ? "官方 SHA256 已核对" : "本地运行包已校验"}</StatusBadge>
        <CardDescription>{state.candidate.platform} {state.candidate.arch} · Node {state.candidate.node}{state.candidate.dirty && " · 工作区候选"}</CardDescription>
        <CardDescription className="break-all">SHA256：{state.candidate.sha256}</CardDescription>
        {!confirmation && <div className={updateActionsClassName}>
          <Button size="lg" className={updateButtonClassName} disabled={blocked || Boolean(readError)} onClick={() => setConfirmation({ action: "install", ...state.candidate! })}>安装更新</Button>
          <Button size="lg" variant="outline" className={updateButtonClassName} disabled={blocked} onClick={() => setUploadOpen(true)}>更换文件</Button>
        </div>}
      </div>}
      {confirmation ? <Alert>
        <AlertTitle>{confirmation.action === "install" ? "安装 v" : "回退到 v"}{confirmation.version}？</AlertTitle>
        <AlertDescription className="gap-3">
          {confirmation.action === "install" && <p>{confirmation.verification === "official" ? "已核对官方 SHA256。" : "请确认此运行包来自可信来源；已校验包内文件及构建身份。"}</p>}
          <p>仅切换项目程序并重启受影响的管理器服务；保留用户数据及 Core 代理运行。健康检查失败会自动恢复。</p>
          {!confirmationValid && <p>候选状态已变化，请取消后重新读取。</p>}
          <div className={updateActionsClassName}>
            <Button variant="outline" size="lg" className={updateButtonClassName} onClick={() => setConfirmation(null)}>取消</Button>
            <Button size="lg" className={updateButtonClassName} disabled={blocked || !confirmationValid} onClick={confirm}>{confirmation.action === "install" ? "确认安装" : "确认回退"}</Button>
          </div>
        </AlertDescription>
      </Alert> : <>
        {showUpload && <Field>
          <FieldLabel htmlFor="webui-upload-file">上传 Linux Web UI 运行包</FieldLabel>
          <Input ref={fileInput} id="webui-upload-file" type="file" accept=".gz,.tgz" className="sr-only" disabled={blocked} onChange={event => setFile(event.target.files?.[0] ?? null)} />
          <div className="flex min-w-0 items-center gap-3"><Button variant="outline" size="lg" className={updateButtonClassName} disabled={blocked} onClick={() => fileInput.current?.click()}>选择文件</Button><span className="min-w-0 truncate text-sm">{file?.name ?? "未选择文件"}</span></div>
          <FieldDescription>完整 Linux x64 .tar.gz 运行包，最大 128 MiB。</FieldDescription>
          <div className={updateActionsClassName}>
            {settings.source !== "upload" && <Button variant="outline" size="lg" className={updateButtonClassName} disabled={blocked} onClick={() => setUploadOpen(false)}>取消上传</Button>}
            <Button size="lg" className={updateButtonClassName} disabled={blocked || !file} onClick={() => file && void run(async signal => { await uploadWebUi(file, signal); if (!signal.aborted) { setUploadOpen(false); setFile(null) } })}><Upload data-icon="inline-start" />上传并校验</Button>
          </div>
        </Field>}
        {!showUpload && !state?.candidate && !busy && <div className={cn(updateActionsClassName, "mt-0", current && settings.source !== "custom" && "grid-cols-1")}>
          {(!current || settings.source === "custom") && <Button size="lg" className={updateButtonClassName} disabled={blocked || routeMissing || (settings.source === "custom" && !settings.webuiUrl.trim())} onClick={prepare}><Download data-icon="inline-start" />下载更新</Button>}
          <Button variant="outline" size="lg" className={updateButtonClassName} disabled={blocked} onClick={() => setUploadOpen(true)}><Upload data-icon="inline-start" />上传更新包</Button>
        </div>}
        {(routeMissing || (settings.source === "custom" && !settings.webuiUrl.trim())) && <CardDescription>请在下方更新设置中填写{routeMissing ? "外部代理地址" : "Web UI 文件地址"}。</CardDescription>}
      </>}
      {showNotes && <CollapsibleContent><Separator className="mb-3" />
        <h3 className="text-xs font-medium">{state?.checkState === "succeeded" ? "官方发布说明" : "上次查询的发布说明"} · {state?.latest?.version}</h3>
        <p className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap wrap-anywhere">{state?.latest?.releaseNotes ?? "此版本未提供发布说明。"}</p>
      </CollapsibleContent>}
    </Collapsible>
  </UpdateCard>
}
