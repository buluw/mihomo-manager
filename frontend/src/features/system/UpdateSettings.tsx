import { ChevronDown } from "lucide-react"
import type { CoreDownloadRoute, CoreDownloadSource } from "@/api/systemClient"
import type { UpdatePolicy } from "@/api/webuiUpdateClient"
import { MobileChoiceSheet } from "@/components/patterns/mobile-choice-sheet"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SettingsGroup, SettingsToolRow } from "./ManagerSettingsFields"
import { useUpdatePolicy } from "./useUpdatePolicy"
import { webUiUpdateError } from "@/shared/webuiUpdateMessages"

export type DownloadSettings = { mode: CoreDownloadRoute["mode"]; proxy: string; source: CoreDownloadSource; url: string; webuiUrl: string }
export const downloadRoutes = [{ value: "direct", label: "直连" }, { value: "core", label: "经当前 Mihomo" }, { value: "external", label: "指定外部代理" }]
export const downloadSources = [{ value: "github", label: "GitHub 官方" }, { value: "ghfast", label: "GHFast · ghfast.top" },
  { value: "ghproxy", label: "gh-proxy.com" }, { value: "ghproxynet", label: "ghproxy.net" },
  { value: "custom", label: "自定义完整下载地址" }, { value: "upload", label: "手动上传" }]

export function UpdateSettings({ active, value, onChange, disabled }: {
  active: boolean; value: DownloadSettings; onChange: (value: DownloadSettings) => void; disabled: boolean
}) {
  const policy = useUpdatePolicy(active)
  const settings = policy.settings
  const policyBlocked = disabled || policy.saving || !policy.state?.available
  const routeAllowed = value.mode !== "external" && !["custom", "upload"].includes(value.source)
  const valid = settings && Number.isInteger(settings.intervalHours) && settings.intervalHours >= 1 && settings.intervalHours <= 168 && /^([01]\d|2[0-3]):[0-5]\d$/.test(settings.installTime)
  const save = () => {
    if (!settings || !routeAllowed || !valid || policyBlocked) return
    void policy.save({ ...settings, mode: value.mode as UpdatePolicy["mode"], source: value.source as UpdatePolicy["source"] })
  }
  const scheduled = (time: string | null | undefined) => time && policy.state ? new Date(time).toLocaleString("zh-CN", { timeZone: policy.state.timeZone, hour12: false }) : "未安排"
  return <SettingsGroup title="更新设置" description="手动下载参数仅用于当前页；保存后台策略后，检查、下载与定时安装由容器持续执行。设置不写入运行 YAML。">
    <DownloadChoice label="下载来源" value={value.source} options={downloadSources} disabled={disabled}
      onChange={source => onChange({ ...value, source: source as CoreDownloadSource })} />
    {value.source === "custom" && <Field className="px-3 py-3 md:px-4">
      <FieldLabel htmlFor="core-download-url">Core 文件地址</FieldLabel>
      <Input id="core-download-url" value={value.url} autoComplete="off" disabled={disabled} placeholder="https://example.com/mihomo.gz" onChange={event => onChange({ ...value, url: event.target.value })} />
      <FieldDescription>完整 Linux 文件 URL，支持原始可执行文件或 .gz；仅计算本地摘要。</FieldDescription>
    </Field>}
    {value.source === "custom" && <Field className="px-3 py-3 md:px-4">
      <FieldLabel htmlFor="webui-download-url">Web UI 文件地址</FieldLabel>
      <Input id="webui-download-url" value={value.webuiUrl} autoComplete="off" disabled={disabled} placeholder="https://example.com/mihomo-manager.tar.gz" onChange={event => onChange({ ...value, webuiUrl: event.target.value })} />
      <FieldDescription>完整 Linux x64 管理器运行包 URL，与 Core 文件地址分别使用。</FieldDescription>
    </Field>}
    <DownloadChoice label="连接方式" value={value.mode} options={downloadRoutes} disabled={disabled}
      onChange={mode => onChange({ ...value, mode: mode as CoreDownloadRoute["mode"] })} />
    {value.mode === "external" && <Field className="px-3 py-3 md:px-4">
      <FieldLabel htmlFor="core-download-proxy">外部代理地址</FieldLabel>
      <Input id="core-download-proxy" type="password" autoComplete="off" value={value.proxy} disabled={disabled} placeholder="http://host:port 或 socks5h://host:port" onChange={event => onChange({ ...value, proxy: event.target.value })} />
    </Field>}
    <Field className="px-3 py-3 md:px-4"><FieldDescription>
      {value.mode === "core" ? "请求经当前 Mihomo 代理端口，出站遵循当前规则和模式。" : value.mode === "external" ? "版本查询和文件下载经指定代理。" : "版本查询和文件下载直连，不使用系统代理环境变量。"}
      {" "}Core 与 Web UI 分别查询各自的 GitHub 官方 API；手动上传不使用网络设置。
    </FieldDescription></Field>
    <SettingsToolRow label="自动检查" description="在后台检查 Core 与 Web UI 正式发布。">
      <Switch aria-label="自动检查" checked={settings?.autoCheck ?? false} disabled={policyBlocked} onCheckedChange={autoCheck => settings && policy.change({ ...settings, autoCheck, autoDownload: autoCheck && settings.autoDownload })} />
    </SettingsToolRow>
    {settings?.autoCheck && <SettingsToolRow label="检查周期（小时）"><Input aria-label="检查周期（小时）" className="w-24" type="number" min={1} max={168} value={settings.intervalHours} disabled={policyBlocked} onChange={event => policy.change({ ...settings, intervalHours: Number(event.target.value) })} /></SettingsToolRow>}
    <SettingsToolRow label="Web UI 自动下载" description="发现新版本后下载并校验，安装单独执行。">
      <Switch aria-label="Web UI 自动下载" checked={settings?.autoDownload ?? false} disabled={policyBlocked || !settings?.autoCheck} onCheckedChange={autoDownload => settings && policy.change({ ...settings, autoDownload })} />
    </SettingsToolRow>
    <SettingsToolRow label="Web UI 定时安装" description="仅安装已核对官方摘要的新版本候选。">
      <Switch aria-label="Web UI 定时安装" checked={settings?.scheduledInstall ?? false} disabled={policyBlocked} onCheckedChange={scheduledInstall => settings && policy.change({ ...settings, scheduledInstall })} />
    </SettingsToolRow>
    {settings?.scheduledInstall && <SettingsToolRow label="每日安装时间" description={"容器时区：" + policy.state?.timeZone}>
      <Input aria-label="每日安装时间" type="time" className="w-28" value={settings.installTime} disabled={policyBlocked} onChange={event => policy.change({ ...settings, installTime: event.target.value })} />
    </SettingsToolRow>}
    <Field className="px-3 py-3 md:px-4">
      <FieldDescription>{policy.state ? <>已保存线路：{downloadRoutes.find(item => item.value === policy.state!.settings.mode)?.label} · {downloadSources.find(item => item.value === policy.state!.settings.source)?.label}。容器时区：{policy.state.timeZone}。<br />下次检查：{scheduled(policy.state.nextCheckAt)}；下次安装：{scheduled(policy.state.nextInstallAt)}。</> : "正在读取后台策略…"}</FieldDescription>
      <FieldDescription>{routeAllowed ? "保存将采用上方选定的连接方式和下载来源。" : "后台策略仅支持直连／当前 Mihomo 与固定下载来源；请先在上方选择。外部代理凭据与自定义 URL 仅供手动请求。"}</FieldDescription>
      {(policy.error || policy.state?.error) && <Alert variant="destructive"><AlertDescription>{policy.error || webUiUpdateError(policy.state?.error ?? null)}<Button variant="outline" size="sm" disabled={policy.saving} onClick={policy.refresh}>重新载入策略（丢弃草稿）</Button></AlertDescription></Alert>}
      {policy.saved && <Alert><AlertDescription>后台策略已保存，关闭浏览器后继续生效。</AlertDescription></Alert>}
      <div className="flex justify-end"><Button disabled={policyBlocked || !routeAllowed || !valid} onClick={save}>{policy.saving ? "正在保存…" : "保存后台策略"}</Button></div>
    </Field>
  </SettingsGroup>
}

function DownloadChoice({ label, value, options, disabled, onChange }: {
  label: string; value: string; options: Array<{ value: string; label: string }>; disabled: boolean; onChange: (value: string) => void
}) {
  return <SettingsToolRow label={label}>
    <MobileChoiceSheet title={label} value={value} options={options} onChoose={onChange}
      trigger={<Button variant="outline" disabled={disabled} aria-label={label} className="h-auto min-h-11 max-w-44 justify-between gap-2 whitespace-normal py-2 md:hidden">
        <span className="min-w-0 wrap-anywhere">{options.find(option => option.value === value)?.label}</span><ChevronDown data-icon="inline-end" />
      </Button>} />
    <Select items={options} value={value} disabled={disabled} onValueChange={next => next && onChange(String(next))}>
      <SelectTrigger aria-label={label} className="hidden w-56 md:flex"><SelectValue /></SelectTrigger>
      <SelectContent align="end"><SelectGroup>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>
  </SettingsToolRow>
}
