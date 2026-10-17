import { ChevronDown, CircleAlert, CircleHelp, RefreshCw, RotateCcw, Save, Undo2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useManagerSettings } from "./useManagerSettings";
import { AccessSettings } from "./AccessSettings";

import { type DirectDelayTestSettings } from "@/api/configClient";
import { type HostNetworkInterface } from "@/api/systemClient";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { MobileChoiceSheet } from "@/components/patterns/mobile-choice-sheet";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Notify } from "@/shared/types";
import { type BooleanOverride, type ManagerSettingsForm, type SniffProtocol } from "./managerSettingsForm";

import { directDelayPresets } from "@/shared/directDelay";
import { settingGroups, type SettingGroup } from "./managerSettingsValues";
import { type TunObservation } from "./tunRecovery";
import { SettingsGroup, SettingsToolRow, SelectField, TextSettingField, booleanItems, settingRowClassName, settingLabelClassName, settingDetailClassName } from "./ManagerSettingsFields";

const modeItems = [
  { value: "rule", label: "规则" },
  { value: "direct", label: "直连" },
  { value: "global", label: "全局" },
]
const directDelayItems = directDelayPresets.map(({ value, label }) => ({ value, label }))

const logLevelItems = ["silent", "error", "warning", "info", "debug"].map((value) => ({
  value,
  label: value,
}))

const enhancedModeItems = [
  { value: "fake-ip", label: "Fake-IP" },
  { value: "redir-host", label: "Redir-Host" },
]

const tunStackItems = [
  { value: "mixed", label: "Mixed" },
  { value: "system", label: "System" },
  { value: "gvisor", label: "gVisor" },
]

const outboundModeItems = [
  { value: "auto", label: "自动识别" },
  { value: "system", label: "系统默认出口" },
  { value: "manual", label: "手动指定" },
]

const sniffProtocols = ["HTTP", "TLS", "QUIC"] as const
const categories: Array<{ value: string; label: string; groups: SettingGroup[] }> = [
  { value: "general", label: "常规", groups: ["mode", "logLevel", "ipv6", "allowLan", "tcpConcurrent"] },
  { value: "dns", label: "DNS", groups: ["dnsEnable", "dnsListen", "dnsNameservers", "dnsEnhancedMode", "dnsFakeIpFilter", "dnsIpv6"] },
  { value: "tun", label: "TUN 与出口", groups: ["tunEnable", "tunStack", "tunAutoRoute", "outboundMode", "tunDnsHijack"] },
  { value: "sniffer", label: "嗅探", groups: ["snifferEnable", "sniffProtocols", "snifferSkipDomain"] },
  { value: "maintenance", label: "更新与维护", groups: [] },
  { value: "access", label: "访问认证", groups: [] },
]
const interfaceStateLabels: Record<HostNetworkInterface["state"], string> = {
  up: "链路已连接", down: "链路未连接", unknown: "状态未知",
  dormant: "链路休眠", lowerlayerdown: "下层链路未连接", notpresent: "接口未就绪", testing: "接口测试中",
}

export function ManagerSettingsPanel({
  notify,
  onRefresh,
  coreVersion,
  dnsTools,
  maintenance,
  coreBusy,
  recoveringTun,
  onRecoverTun,
  onApplyingChange,
}: {
  notify: Notify
  onRefresh: () => Promise<void>
  coreVersion?: string
  dnsTools: ReactNode
  maintenance: (active: boolean) => ReactNode
  coreBusy: boolean
  recoveringTun: boolean
  onRecoverTun: (devices: string[]) => Promise<TunObservation | null>
  onApplyingChange: (busy: boolean) => void
}) {
  const [category, setCategory] = useState("general")
  const {
    sourceName, saving, dirty, pendingApply, message, error, sourceLoading, sourceReady, sourceStatus, fieldEditing, setFieldEditing,
    sourceError, defaultsLabel, form, formError, disabled, availableInterfaces, selectedInterface,
    interfacesLoading, interfacesError, tun, tunError, tunMessage, directDelayDraft, directDelayDirty,
    directDelayValidation, directDelayDisabled, directDelayError, directDelayMessage, savingDirectDelay, patch,
    reset, refreshInterfaces, recoverTun, patchDirectDelay, saveDirectDelay, saveAndApply,
    cancelChanges, cancelDirectDelay, isExplicit, categoryChanged, known,
  } = useManagerSettings({ notify, onRefresh, coreVersion, coreBusy, onRecoverTun, onApplyingChange })
  const resetButton = (group: SettingGroup, label: string) => <Tooltip><TooltipTrigger render={<span className="inline-flex" />}><Button variant="ghost" size="icon-sm" className="md:size-8" aria-label={`${label}：恢复配置值`} disabled={disabled || !isExplicit(group)} onClick={() => reset(group)}><RotateCcw /></Button></TooltipTrigger><TooltipContent>恢复配置值</TooltipContent></Tooltip>

  const saveActions = (
    <>
        <Button variant="outline" size="sm" className="max-md:flex-1" disabled={!dirty || saving || fieldEditing} onClick={cancelChanges}><Undo2 data-icon="inline-start" />取消修改</Button>
        <Button size="sm" className="max-md:flex-1" onClick={() => void saveAndApply()} disabled={disabled || fieldEditing || !sourceName || Boolean(formError) || (!dirty && !pendingApply)}>
          {saving ? <RefreshCw className="animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          {saving ? "处理中" : "保存并应用"}
        </Button>
    </>
  )

  return (
    <Tabs value={category} onValueChange={value => value && setCategory(String(value))} className="flex h-full min-h-0 w-full min-w-0 flex-col gap-0">
      <div className="flex min-h-16 shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b px-4 py-2 md:min-h-[62px] md:px-6">
        <div className="md:hidden"><MobileChoiceSheet title="设置分类" value={category}
          options={categories.map(item => ({ value:item.value, label:item.label, dirty:Boolean((item.value === "general" && directDelayDirty) || categoryChanged(item.groups)) }))}
          onChoose={setCategory} trigger={<Button variant="ghost" className="min-h-11 justify-start px-0 max-md:text-base" aria-label="切换设置分类">
            设置 · {categories.find(item => item.value === category)?.label}<ChevronDown data-icon="inline-end" />
          </Button>} /></div>
        <div className="hidden min-w-0 overflow-x-auto overflow-y-hidden pb-1.5 md:block">
          <TabsList variant="line" className="min-h-11 min-w-max gap-6 p-0 align-middle" aria-label="设置分类">
            {categories.map(item => <TabsTrigger key={item.value} value={item.value} className="h-11 px-0 text-[13px]">
              {item.label}{((item.value === "general" && directDelayDirty) || categoryChanged(item.groups)) && <><span aria-hidden="true">·</span><span className="sr-only">有未保存修改</span></>}
            </TabsTrigger>)}
          </TabsList>
        </div>
        {(!["maintenance", "access"].includes(category) || dirty || pendingApply) && <div className="ml-auto hidden shrink-0 items-center gap-2 md:flex">{saveActions}</div>}
      </div>
      <div data-page-scroll className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 md:px-6 md:py-6">
        <div className="mx-auto flex w-full max-w-[680px] flex-col gap-4">
          {(dirty || pendingApply || message || sourceLoading) && <div role="status" className="text-xs text-muted-foreground">{[dirty ? "有未保存修改" : pendingApply ? "源配置或设置已更新，待应用" : null, sourceLoading ? "正在读取加载来源…" : message].filter(Boolean).join(" · ")}</div>}
          {(error || sourceError || formError) && <Alert variant="destructive"><CircleAlert /><AlertTitle>无法保存并应用</AlertTitle><AlertDescription>{error || sourceError || formError}</AlertDescription></Alert>}
      <TabsContent value="general" keepMounted className="flex flex-col gap-6">
        <SettingsGroup title="基础运行">
          <SelectField reset={resetButton("mode", "运行模式")} id="manager-mode" label="运行模式" value={form.mode} items={modeItems} disabled={disabled} onChange={(value) => patch({ mode: value as ManagerSettingsForm["mode"] })} />
          <SelectField reset={resetButton("logLevel", "日志等级")} id="manager-log-level" label="日志等级" value={form.logLevel} items={logLevelItems} disabled={disabled} onChange={(value) => patch({ logLevel: value as ManagerSettingsForm["logLevel"] })} />
          <SelectField reset={resetButton("ipv6", "IPv6")} id="manager-ipv6" label="IPv6" value={form.ipv6} items={booleanItems} disabled={disabled} onChange={(value) => patch({ ipv6: value as BooleanOverride })} />
          <SelectField reset={resetButton("tcpConcurrent", "TCP 并发")} id="manager-tcp-concurrent" label="TCP 并发" value={form.tcpConcurrent} items={booleanItems} disabled={disabled} onChange={(value) => patch({ tcpConcurrent: value as BooleanOverride })} />
          <SelectField reset={resetButton("allowLan", "允许局域网")} id="manager-allow-lan" label="允许局域网" value={form.allowLan} items={booleanItems} disabled={disabled} onChange={(value) => patch({ allowLan: value as BooleanOverride })} />
        </SettingsGroup>
        <SettingsGroup title="直连测速" description="独立保存，下次直连测速生效。">
          <SelectField reset={null} id="manager-direct-delay-preset" label="测速地址" value={directDelayDraft.preset} items={directDelayItems} disabled={directDelayDisabled} onChange={value => patchDirectDelay({ preset: value as DirectDelayTestSettings["preset"] })} />
          {directDelayDraft.preset === "custom" && <Field orientation="horizontal" className={settingRowClassName} data-invalid={Boolean(directDelayValidation) || undefined}>
            <FieldLabel htmlFor="manager-direct-delay-url" className={settingLabelClassName}>自定义测速 URL</FieldLabel>
            <Input id="manager-direct-delay-url" type="url" value={directDelayDraft.url ?? ""} maxLength={2048} placeholder="https://example.com/generate_204" disabled={directDelayDisabled} aria-invalid={Boolean(directDelayValidation)} onChange={event => patchDirectDelay({ url: event.target.value })} />
            <span />
          </Field>}
          {(directDelayDirty || directDelayValidation || directDelayError || directDelayMessage) && <Field className="gap-2 px-4 py-3">
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" disabled={directDelayDisabled || !directDelayDirty} onClick={cancelDirectDelay}>取消测速修改</Button>
              <Button variant="outline" size="sm" disabled={directDelayDisabled || !directDelayDirty || Boolean(directDelayValidation)} onClick={() => void saveDirectDelay()}>
                {savingDirectDelay ? <RefreshCw className="animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}
                保存测速设置
              </Button>
            </div>
            {(directDelayValidation || directDelayError) && <Alert variant="destructive"><CircleAlert /><AlertDescription>{directDelayValidation || directDelayError}</AlertDescription></Alert>}
            {directDelayMessage && <FieldDescription role="status">{directDelayMessage}</FieldDescription>}
          </Field>}
        </SettingsGroup>
      </TabsContent>

      <TabsContent value="dns" keepMounted className="flex flex-col gap-6">
        <SettingsGroup title="DNS 服务">
          <SelectField reset={resetButton("dnsEnable", "DNS 服务")} id="manager-dns-enable" label="DNS 服务" value={form.dnsEnable} items={booleanItems} disabled={disabled} onChange={(value) => patch({ dnsEnable: value as BooleanOverride })} />
          <TextSettingField
            id="manager-dns-listen"
            known={known.has("dnsListen")} reset={resetButton("dnsListen", "监听地址与端口")}
            label="监听地址与端口"
            description="例如 0.0.0.0:53；空值表示不启用 DNS 网络监听。"
            value={form.dnsListen}
            disabled={disabled}
            onChange={(value) => patch({ dnsListen: value })}
          />
        </SettingsGroup>
        <SettingsGroup title="解析策略">
          <TextSettingField
            id="manager-dns-nameserver"
            onRestore={() => reset("dnsNameservers")} canRestore={isExplicit("dnsNameservers")} known={known.has("dnsNameservers")} reset={resetButton("dnsNameservers", "上游 DNS")}
            label="上游 DNS"
            description="每行一个服务器；留空会保存空列表。"
            value={form.dnsNameservers}
            disabled={disabled}
            multiline onEditingChange={setFieldEditing}
            onChange={(value) => patch({ dnsNameservers: value })}
          />
          <SelectField reset={resetButton("dnsEnhancedMode", "增强模式")} id="manager-dns-mode" label="增强模式" value={form.dnsEnhancedMode} items={enhancedModeItems} disabled={disabled} onChange={(value) => patch({ dnsEnhancedMode: value as ManagerSettingsForm["dnsEnhancedMode"] })} />
          <TextSettingField
            id="manager-dns-fakeip-filter"
            onRestore={() => reset("dnsFakeIpFilter")} canRestore={isExplicit("dnsFakeIpFilter")} known={known.has("dnsFakeIpFilter")} reset={resetButton("dnsFakeIpFilter", "Fake-IP 排除域名")}
            label="Fake-IP 排除域名"
            description="每行一个域名或 Mihomo 域名通配表达式。"
            value={form.dnsFakeIpFilter}
            disabled={disabled}
            multiline onEditingChange={setFieldEditing}
            onChange={(value) => patch({ dnsFakeIpFilter: value })}
          />
          <SelectField reset={resetButton("dnsIpv6", "解析 IPv6")} id="manager-dns-ipv6" label="解析 IPv6" value={form.dnsIpv6} items={booleanItems} disabled={disabled} onChange={(value) => patch({ dnsIpv6: value as BooleanOverride })} />
        </SettingsGroup>
        {dnsTools}
      </TabsContent>

      <TabsContent value="tun" keepMounted className="flex flex-col gap-6">
        <SettingsGroup title="TUN 设置">
          <SettingsToolRow label="TUN 运行状态" description={<span role="status">{recoveringTun ? "正在重启核心服务并核对 TUN 关闭与设备释放…"
                : interfacesLoading ? "正在等待并核对 TUN 状态与网卡…" : tunError || tunMessage
                || (tun?.state === "enabled" ? "TUN 正在开启，设备存在属于正常状态。"
                  : tun?.state === "residual" ? `TUN 已关闭，但网卡 ${tun.remainingDevices.join("、")} 仍存在。可重启核心恢复。`
                    : tun?.state === "unconfirmed" ? "TUN 已关闭，但网卡类型未知，暂时无法确认目标设备是否释放；请重新读取。"
                      : tun?.state === "clear" ? "TUN 已关闭，目标网卡已释放。" : "TUN 状态尚未确认。")}</span>}>
                <Button variant="outline" size="icon-sm" aria-label="重新读取 TUN 状态" disabled={interfacesLoading || saving || coreBusy} onClick={() => void refreshInterfaces()}><RefreshCw /></Button>
                {tun?.state === "residual" && <Button variant="outline" size="sm" disabled={saving || savingDirectDelay || interfacesLoading || coreBusy} onClick={() => void recoverTun()}><RotateCcw data-icon="inline-start" className={recoveringTun ? "animate-spin" : undefined} />{recoveringTun ? "恢复中" : "重启核心恢复"}</Button>}
          </SettingsToolRow>
          <SelectField reset={resetButton("tunEnable", "TUN 模式")} id="manager-tun-enable" label="TUN 模式" value={form.tunEnable} items={booleanItems} disabled={disabled} onChange={(value) => patch({ tunEnable: value as BooleanOverride })} />
          <SelectField reset={resetButton("tunStack", "协议栈")} id="manager-tun-stack" label="协议栈" value={form.tunStack} items={tunStackItems} disabled={disabled} onChange={(value) => patch({ tunStack: value as ManagerSettingsForm["tunStack"] })} />
          <SelectField reset={resetButton("tunAutoRoute", "自动路由")} id="manager-tun-auto-route" label="自动路由" value={form.tunAutoRoute} items={booleanItems} disabled={disabled} onChange={(value) => patch({ tunAutoRoute: value as BooleanOverride })} />
        </SettingsGroup>
        <SettingsGroup title="出口网卡">
          <Field className="gap-0">
            <SelectField id="manager-outbound-mode" label="出口方式" value={form.outboundMode} items={outboundModeItems} disabled={disabled}
              onChange={value => patch({ outboundMode: value as ManagerSettingsForm["outboundMode"] })} reset={resetButton("outboundMode", "出口网卡")} />
            {form.outboundMode === "manual" && (
              <FieldGroup className="gap-0">
                <Field orientation="horizontal" className={settingRowClassName}>
                  <FieldLabel htmlFor="manager-interface-list" className={settingLabelClassName}>主机网卡</FieldLabel>
                  <div className="min-w-0">
                    <MobileChoiceSheet title="选择主机网卡" value={selectedInterface?.name ?? ""} options={availableInterfaces.map(item => ({ value: item.name, label: item.name, description: `${interfaceStateLabels[item.state] ?? "状态未知"} · ${item.addresses.map(ip => ip.cidr ?? ip.address).join(" · ") || "无 IP 地址"}` }))} onChoose={interfaceName => patch({ interfaceName })} trigger={<Button variant="outline" disabled={disabled || interfacesLoading || availableInterfaces.length === 0} className="h-auto min-h-11 w-full justify-between gap-2 py-2 whitespace-normal md:hidden" aria-label="主机网卡"><span className="min-w-0 text-left wrap-anywhere">{selectedInterface?.name ?? (interfacesLoading ? "正在读取网卡" : "选择已识别网卡")}</span><ChevronDown data-icon="inline-end" /></Button>} />
                    <Select
                      items={[{ value: null, label: interfacesLoading ? "正在读取网卡" : "选择已识别网卡" }, ...availableInterfaces.map((item) => ({ value: item.name, label: item.name }))]}
                      value={selectedInterface?.name ?? null}
                      onValueChange={(value) => value && patch({ interfaceName: String(value) })}
                      disabled={disabled || interfacesLoading || availableInterfaces.length === 0}
                    >
                      <SelectTrigger id="manager-interface-list" className="hidden w-full md:flex"><SelectValue /></SelectTrigger>
                      <SelectContent className="max-w-[calc(100vw-2rem)]">
                        <SelectGroup>{availableInterfaces.map((item) => (
                          <SelectItem key={item.name} value={item.name}>
                            <span className="flex flex-col gap-1">
                              <span>{item.name} · {interfaceStateLabels[item.state] ?? "状态未知"}</span>
                              <span className="whitespace-normal break-all">{item.addresses.map((ip) => ip.cidr ?? ip.address).join(" · ") || "无 IP 地址"}</span>
                            </span>
                          </SelectItem>
                        ))}</SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button variant="ghost" size="icon-sm" aria-label="刷新网卡列表" disabled={interfacesLoading || saving || coreBusy} onClick={() => void refreshInterfaces()}><RefreshCw data-icon="inline-start" /></Button>
                  {interfacesError && <Alert variant="destructive" className={settingDetailClassName}><CircleAlert /><AlertTitle>无法读取网卡</AlertTitle><AlertDescription>{interfacesError}</AlertDescription></Alert>}
                  {!interfacesLoading && !interfacesError && (
                    <FieldDescription className={settingDetailClassName}>
                      {selectedInterface
                        ? `${interfaceStateLabels[selectedInterface.state] ?? "状态未知"} · ${selectedInterface.addresses.map((ip) => ip.cidr ?? ip.address).join(" · ") || "无 IP 地址"}`
                        : form.interfaceName ? "当前名称不在可选出口列表中，已保留填写的值。" : availableInterfaces.length ? "选择网卡会填入下方名称。" : "没有可选出口网卡，仍可手动填写名称。"}
                    </FieldDescription>
                  )}
                </Field>
                <Field orientation="horizontal" className={settingRowClassName} data-invalid={!form.interfaceName.trim() || undefined}>
                  <FieldLabel htmlFor="manager-interface-name" className={settingLabelClassName}>网卡名称</FieldLabel>
                  <div className="min-w-0">
                  <Input
                    id="manager-interface-name"
                    value={form.interfaceName}
                    onChange={(event) => patch({ interfaceName: event.target.value })}
                    placeholder="例如 eth0"
                    aria-label="手动出口网卡名称"
                    aria-invalid={!form.interfaceName.trim()}
                    disabled={disabled}
                    className="w-full"
                  />
                  </div>
                  <div />
                </Field>
              </FieldGroup>
            )}
            <FieldDescription className="px-3 pb-3 md:px-4">网卡链路状态不代表互联网连通性。自动识别或手动指定出口，保存并应用后生效。</FieldDescription>
          </Field>
        </SettingsGroup>
        <SettingsGroup title="DNS 接管">
          <TextSettingField
            id="manager-tun-dns-hijack"
            onRestore={() => reset("tunDnsHijack")} canRestore={isExplicit("tunDnsHijack")} known={known.has("tunDnsHijack")} reset={resetButton("tunDnsHijack", "DNS 接管")}
            label="DNS 接管"
            description="每行一个接管地址，例如 any:53。"
            value={form.tunDnsHijack}
            disabled={disabled}
            multiline onEditingChange={setFieldEditing}
            onChange={(value) => patch({ tunDnsHijack: value })}
          />
        </SettingsGroup>
      </TabsContent>

      <TabsContent value="sniffer" keepMounted className="flex flex-col gap-6">
        <SettingsGroup title="嗅探">
          <SelectField reset={resetButton("snifferEnable", "嗅探总开关")} id="manager-sniffer-enable" label="嗅探总开关" value={form.snifferEnable} items={booleanItems} disabled={disabled} onChange={(value) => patch({ snifferEnable: value as BooleanOverride })} />
        </SettingsGroup>
        <SettingsGroup title="协议与端口">
          <Field className="gap-0">
            <div className={settingRowClassName}>
              <FieldLabel className={settingLabelClassName}>嗅探协议</FieldLabel>
              <div className="min-w-0">
            <ToggleGroup
              multiple
              value={form.sniffProtocols}
              onValueChange={(value) => patch({ sniffProtocols: value as SniffProtocol[] })}
              variant="outline"
              spacing={0}
              aria-label="嗅探协议"
              disabled={disabled}
            >
              {sniffProtocols.map((protocol) => <ToggleGroupItem key={protocol} value={protocol}>{protocol}</ToggleGroupItem>)}
            </ToggleGroup>
              </div>
              <div>{resetButton("sniffProtocols", "嗅探协议与端口")}</div>
              <FieldDescription className={settingDetailClassName}>协议与端口作为一项设置；修改后保存所选集合，端口留空表示所有端口。</FieldDescription>
              {!known.has("sniffProtocols") && <FieldDescription className={settingDetailClassName}>协议默认值未知，请明确选择。</FieldDescription>}
            </div>
            <FieldGroup className="gap-0">
              {sniffProtocols.map((protocol) => {
                const key = protocol === "HTTP" ? "httpPorts" : protocol === "TLS" ? "tlsPorts" : "quicPorts"
                return (
                  <TextSettingField key={protocol} id={`manager-${protocol.toLowerCase()}-ports`} label={`${protocol} 端口`}
                    description="每行一个端口或范围；空为所有端口。" known reset={null} multiline onEditingChange={setFieldEditing}
                    value={form[key]} onChange={value => patch({ [key]: value })} disabled={disabled || !form.sniffProtocols.includes(protocol)} />
                )
              })}
            </FieldGroup>
          </Field>
        </SettingsGroup>
        <SettingsGroup title="跳过规则">
          <TextSettingField
            id="manager-sniffer-skip-domain"
            onRestore={() => reset("snifferSkipDomain")} canRestore={isExplicit("snifferSkipDomain")} known={known.has("snifferSkipDomain")} reset={resetButton("snifferSkipDomain", "跳过域名")}
            label="跳过域名"
            description="每行一个域名或 Mihomo 域名通配表达式；明确留空表示不跳过。"
            value={form.snifferSkipDomain}
            disabled={disabled}
            multiline onEditingChange={setFieldEditing}
            onChange={(value) => patch({ snifferSkipDomain: value })}
          />
        </SettingsGroup>
      </TabsContent>
      <TabsContent value="maintenance" keepMounted>{maintenance(category === "maintenance")}</TabsContent>
      <TabsContent value="access" keepMounted><AccessSettings disabled={coreBusy || saving} /></TabsContent>
          <div hidden={category === "access"} className={category === "access" ? "hidden" : "flex min-w-0 items-center gap-1 text-xs text-muted-foreground"}>
            <span className="min-w-0 wrap-anywhere">{sourceStatus}</span>
            <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="设置值与默认值说明" />}><CircleHelp /></TooltipTrigger><TooltipContent>显示来源配置准备应用的值；仅保存修改项，恢复配置值也需保存。{defaultsLabel}</TooltipContent></Tooltip>
          </div>
          {category !== "access" && sourceReady && known.size < Object.keys(settingGroups).length && <FieldDescription>部分字段或默认值无法确定，已标明未知；可以明确设置后保存。</FieldDescription>}
        </div>
      </div>
      {(dirty || pendingApply) && <div aria-label="设置操作" className="flex shrink-0 items-center gap-2 border-t bg-background px-4 py-2.5 md:hidden">{saveActions}</div>}
    </Tabs>
  )
}
