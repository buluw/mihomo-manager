import type { ConfigSnapshot, ManagerOverrides } from "@/api/configClient";
import {
  ConfigError,
  createConfigChangeSource,
  readConfigFile,
  readManagerSettings,
  readRuntimeLoadState,
  saveDirectDelayTest,
  saveManagerSettings,
  type DirectDelayTestSettings,
  type ManagerSettings,
  type RuntimeLoadState,
} from "@/api/configClient";
import { readCoreUpdate, readNetworkInterfaces, type HostNetworkInterface } from "@/api/systemClient";
import { useRegisterPageRefresh } from "@/app/pageRefresh";
import { useDirtyGuard } from "@/hooks/useDirtyGuard";
import { defaultDirectDelayTest, directDelayTestError, directDelayTestUrl } from "@/shared/directDelay";
import { coreSettingsDefaults, sourceSettingsDocument } from "@/shared/managerSettingsSource";
import {
  applyRuntimeConfig,
  RuntimeApplyError,
  runtimeMatchesManagerSettings,
  RUNTIME_CONFIG_LOADED_EVENT,
} from "@/shared/runtimeApplication";
import type { Notify } from "@/shared/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { systemErrorMessage } from "../../shared/systemMessages.ts";
import { managerSettingsForm, managerSettingsFormError, type ManagerSettingsForm } from "./managerSettingsForm";
import {
  editSetting,
  managerDraftOverrides,
  resolveSettingsValues,
  restoreSetting,
  settingGroups,
  settingIsExplicit,
  settingsValuesEqual,
  type SettingGroup,
} from "./managerSettingsValues";
import { observeTun, outboundInterfaces, readTunRuntime, type TunObservation } from "./tunRecovery";
import { assertManagerSettingsTarget, managerSettingsTarget } from "./managerSettingsTarget";

export function useManagerSettings({ notify, onRefresh, coreVersion, coreBusy, onRecoverTun, onApplyingChange }: {
  notify: Notify
  onRefresh: () => Promise<void>
  coreVersion?: string
  coreBusy: boolean
  onRecoverTun: (devices: string[]) => Promise<TunObservation | null>
  onApplyingChange: (busy: boolean) => void
}) {
  const [settings, setSettings] = useState<ManagerSettings | null>(null)
  const [runtimeState, setRuntimeState] = useState<RuntimeLoadState | null>(null)
  const [draft, setDraft] = useState<ManagerSettingsForm>(() => managerSettingsForm({}))
  const [sourceName, setSourceName] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [directDelaySaved, setDirectDelaySaved] = useState(defaultDirectDelayTest)
  const [directDelayDraft, setDirectDelayDraft] = useState(defaultDirectDelayTest)
  const [savingDirectDelay, setSavingDirectDelay] = useState(false)
  const [directDelayMessage, setDirectDelayMessage] = useState("")
  const [directDelayError, setDirectDelayError] = useState<string | null>(null)
  const [pendingApply, setPendingApply] = useState(false)
  const [message, setMessage] = useState("正在读取管理器设置")
  const [error, setError] = useState<string | null>(null)
  const [interfaces, setInterfaces] = useState<HostNetworkInterface[]>([])
  const [interfacesLoading, setInterfacesLoading] = useState(true)
  const [interfacesError, setInterfacesError] = useState<string | null>(null)
  const [tun, setTun] = useState<TunObservation | null>(null)
  const [tunError, setTunError] = useState<string | null>(null)
  const [tunMessage, setTunMessage] = useState("")
  const tunRequest = useRef<AbortController | null>(null)
  const tunDevices = useRef<string[]>([])
  const recovering = useRef(false)
  const [edited, setEdited] = useState<Set<SettingGroup>>(new Set())
  const [editingFields, setEditingFields] = useState<Set<string>>(new Set())
  const [source, setSource] = useState<{ snapshot: ConfigSnapshot; values: Record<string, unknown> } | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [defaults, setDefaults] = useState<ManagerOverrides | null>(null)
  const [defaultsLabel, setDefaultsLabel] = useState("正在核对 Core 默认值")
  const [valueRefresh, setValueRefresh] = useState(0)
  const action = useRef(false)
  const draftRevision = useRef(0)
  const refreshRequest = useRef<AbortController | null>(null)
  const sourceReady = Boolean(sourceName && source?.snapshot.name === sourceName)
  const projected = resolveSettingsValues(draft, sourceReady ? source!.values : {}, defaults)
  const form = projected.form
  const availableInterfaces = outboundInterfaces(interfaces)
  const selectedInterface = availableInterfaces.find((item) => item.name === form.interfaceName)
  const nextOverrides = settings ? managerDraftOverrides(settings.overrides, draft, edited) : {}
  const dirty = Boolean(settings && !settingsValuesEqual(nextOverrides, settings.overrides))
  const fieldEditing = editingFields.size > 0
  const target = managerSettingsTarget(runtimeState, sourceName, dirty || fieldEditing)
  const targetError = target.error || (target.name !== sourceName ? "正在确认加载来源…" : null)
  const sourceStatus = sourceName ? "设置来源：" + sourceName + (target.confirmed?.name === sourceName ? " · 最近成功加载记录" : " · 已保留原草稿目标") + (target.confirmed?.name === sourceName && sourceReady && target.confirmed.sha256 !== source!.snapshot.sha256 ? " · 源文件新版本待应用" : "") : "设置来源尚未确认"
  const directDelayDirty = directDelayDraft.preset !== directDelaySaved.preset || directDelayTestUrl(directDelayDraft) !== directDelayTestUrl(directDelaySaved)
  const directDelayValidation = directDelayTestError(directDelayDraft)
  const directDelayDisabled = loading || saving || savingDirectDelay || !settings
  const formError = managerSettingsFormError(Object.assign(managerSettingsForm({}), ...[...edited].map(group => Object.fromEntries(settingGroups[group].map(key => [key, draft[key]]))), {
    snifferEnable: form.snifferEnable,
    snifferProtocolsMode: draft.snifferProtocolsMode,
    sniffProtocols: form.sniffProtocols,
  }))
  const disabled = loading || saving || savingDirectDelay || coreBusy || sourceLoading || !sourceReady || Boolean(targetError || sourceError)
  const latest = useRef({ dirty, directDelayDirty, sourceName, source, settings, fieldEditing })
  latest.current = { dirty, directDelayDirty, sourceName, source, settings, fieldEditing }
  const setFieldEditing = useCallback((id: string, editing: boolean) => {
    draftRevision.current++
    setEditingFields(current => {
      if (current.has(id) === editing) return current
      const next = new Set(current)
      if (editing) next.add(id); else next.delete(id)
      return next
    })
  }, [])
  const resetDraft = (overrides: ManagerOverrides) => { draftRevision.current++; setDraft(managerSettingsForm(overrides)); setEdited(new Set()) }
  const reset = (group: SettingGroup) => {
    draftRevision.current++
    setDraft(current => restoreSetting(current, group)); setEdited(current => new Set(current).add(group))
    setMessage("")
  }

  useEffect(() => {
    const request = new AbortController()
    setDefaults(null)
    setDefaultsLabel("正在核对 Core 默认值")
    void readCoreUpdate(request.signal).then(value => {
      if (request.signal.aborted) return
      const verified = !coreVersion || coreVersion === value.current?.version ? coreSettingsDefaults(value.current) : null
      setDefaults(verified)
      setDefaultsLabel(verified ? `缺项采用已核实的 ${value.current!.version} 默认值` : "当前 Core 默认值未核实；缺项显示未知，可明确设置")
    }, () => { if (!request.signal.aborted) setDefaultsLabel("无法核实 Core 默认值；缺项显示未知，可明确设置") })
    return () => request.abort()
  }, [coreVersion, valueRefresh])

  useDirtyGuard(dirty || directDelayDirty || fieldEditing, saving || savingDirectDelay)

  const refreshInterfaces = useCallback(async (waitMs = 0) => {
    tunRequest.current?.abort()
    const request = new AbortController()
    tunRequest.current = request
    setInterfacesLoading(true)
    setInterfacesError(null)
    setTun(null)
    setTunError(null)
    setTunMessage("")
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs))
    if (request.signal.aborted) return
    const [listed, runtime] = await Promise.allSettled([readNetworkInterfaces(request.signal), readTunRuntime(request.signal)])
    if (request.signal.aborted) return
    if (listed.status === "fulfilled") setInterfaces(listed.value)
    else {
      setInterfaces([])
      setInterfacesError("网卡列表读取失败，仍可手动填写网卡名称")
    }
    if (listed.status === "fulfilled" && runtime.status === "fulfilled") {
      const observation = observeTun(runtime.value, listed.value, tunDevices.current)
      tunDevices.current = [...new Set([observation.device, ...observation.remainingDevices])]
      setTun(observation)
    } else setTunError("TUN 状态或网卡读取失败，无法确认设备是否释放；请重新读取")
    setInterfacesLoading(false)
  }, [])
  useEffect(() => {
    void refreshInterfaces()
    return () => tunRequest.current?.abort()
  }, [refreshInterfaces])
  useEffect(() => { onApplyingChange(saving); return () => onApplyingChange(false) }, [saving, onApplyingChange])

  const recoverTun = async () => {
    if (!tun || tun.state !== "residual" || saving || savingDirectDelay || coreBusy || action.current || recovering.current) return
    recovering.current = true
    tunRequest.current?.abort()
    setInterfacesLoading(false)
    setTunError(null)
    try {
      const recovered = await onRecoverTun(tun.remainingDevices)
      if (recovered) {
        setTun(recovered)
        setTunMessage("恢复已确认：服务和 Controller 正常，TUN 已关闭，目标网卡已释放")
      }
    } catch (reason) {
      const detail = reason instanceof Error ? systemErrorMessage(reason) : "TUN 恢复未确认，请重新读取后重试"
      setTunError(detail)
      notify(detail, "error")
    } finally { recovering.current = false }
  }

  const refreshPersistentState = useCallback(async ({ initial = false, discard = false, manual = true } = {}) => {
    if (action.current) return
    refreshRequest.current?.abort()
    const request = new AbortController()
    refreshRequest.current = request
    const revision = draftRevision.current
    const current = latest.current
    setSourceLoading(true)
    try {
      const [saved, runtime] = await Promise.all([
        readManagerSettings(request.signal),
        readRuntimeLoadState(request.signal).catch(() => null),
      ])
      const preserve = !discard && (current.dirty || current.fieldEditing)
      const nextTarget = managerSettingsTarget(runtime, current.sourceName, preserve)
      let nextSource = preserve ? current.source : null
      let readError: string | null = nextTarget.error
      if (nextTarget.name && !nextTarget.error) {
        try {
          const snapshot = await readConfigFile(nextTarget.name, request.signal)
          const values = sourceSettingsDocument(snapshot.content)
          if (preserve && !manual && current.source && current.source.snapshot.sha256 !== snapshot.sha256) {
            readError = "源配置已更新；当前草稿及读取版本已保留，请重新读取并核对后应用。"
          } else nextSource = { snapshot, values }
        } catch {
          readError = "加载来源配置读取或解析失败；草稿已保留，请刷新重试。"
        }
      }
      if (request.signal.aborted || action.current || revision !== draftRevision.current) return
      setRuntimeState(runtime)
      setSourceName(nextTarget.name)
      setSource(nextSource)
      setSourceError(readError)
      if (!preserve || discard) { setSettings(saved); resetDraft(saved.overrides) }
      if (!current.directDelayDirty) {
        setDirectDelaySaved(saved.directDelayTest ?? defaultDirectDelayTest)
        setDirectDelayDraft(saved.directDelayTest ?? defaultDirectDelayTest)
      }
      const baselineVersion = preserve ? current.settings?.version ?? saved.version : saved.version
      setPendingApply(Boolean(nextSource && !nextTarget.error) && !runtimeMatchesManagerSettings(runtime, nextSource?.snapshot, baselineVersion))
      setError(preserve && current.settings?.version !== saved.version ? "管理器设置已被其他设备修改；当前草稿已保留，请取消本页修改后重新读取。" : null)
      setValueRefresh(current => current + 1)
      setMessage(initial || !manual ? "" : "设置和来源版本已重新读取")
    } catch {
      if (request.signal.aborted) return
      setRuntimeState(null)
      setError("管理器设置读取失败；当前草稿已保留，Controller 独立工具仍可使用。")
    } finally {
      if (refreshRequest.current === request) { setLoading(false); setSourceLoading(false) }
    }
  }, [])
  useRegisterPageRefresh(() => refreshPersistentState())
  useEffect(() => {
    void refreshPersistentState({ initial: true })
    const refresh = () => { if (!document.hidden) void refreshPersistentState({ manual: false }) }
    const changes = createConfigChangeSource(event => { if (event.operation !== "ready") refresh() })
    window.addEventListener(RUNTIME_CONFIG_LOADED_EVENT, refresh)
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      refreshRequest.current?.abort()
      refreshRequest.current = null
      changes.close()
      window.removeEventListener(RUNTIME_CONFIG_LOADED_EVENT, refresh)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [refreshPersistentState])
  useEffect(() => {
    if (!saving && !dirty && !fieldEditing && target.name !== sourceName) void refreshPersistentState({ manual: false })
  }, [saving, dirty, fieldEditing, target.name, sourceName, refreshPersistentState])

  const patch = (next: Partial<ManagerSettingsForm>) => {
    const group = (Object.keys(settingGroups) as SettingGroup[]).find(group => settingGroups[group].some(key => Object.hasOwn(next, key)))
    if (!group) return
    draftRevision.current++
    setDraft(current => editSetting(current, form, group, next))
    setEdited(current => new Set(current).add(group))
    setMessage("")
  }

  const patchDirectDelay = (next: Partial<DirectDelayTestSettings>) => {
    draftRevision.current++
    setDirectDelayDraft(current => ({ ...current, ...next }))
    setDirectDelayError(null)
    setDirectDelayMessage("")
  }

  const saveDirectDelay = async () => {
    if (directDelayDisabled || action.current || !directDelayDirty || directDelayValidation) return
    action.current = true
    refreshRequest.current?.abort()
    setSavingDirectDelay(true)
    setDirectDelayError(null)
    try {
      const saved = await saveDirectDelayTest({ preset: directDelayDraft.preset, ...(directDelayDraft.preset === "custom" ? { url: directDelayDraft.url?.trim() } : {}) }, directDelaySaved.version)
      setDirectDelaySaved(saved.directDelayTest!)
      setDirectDelayDraft(saved.directDelayTest!)
      setSettings(current => current ? { ...current, directDelayTest: saved.directDelayTest } : saved)
      setDirectDelayMessage("已保存，下次直连测速生效")
      notify("直连测速设置已保存")
    } catch (reason) {
      setDirectDelayError(reason instanceof ConfigError && reason.code === "manager_settings_conflict"
        ? "直连测速设置已被其他设备修改；请取消本项修改并刷新后重试" : "直连测速设置保存失败；草稿已保留，请重试")
    } finally {
      action.current = false
      setSavingDirectDelay(false)
    }
  }

  const saveAndApply = async () => {
    if (!settings || !sourceName || disabled || fieldEditing || action.current || formError || (!dirty && !pendingApply)) return
    action.current = true
    refreshRequest.current?.abort()
    setSaving(true)
    setError(null)
    setMessage(dirty ? "正在保存设置" : "正在重新应用已保存设置")
    let attemptedApply = false
    try {
      const [selected, runtime, currentSettings] = await Promise.all([readConfigFile(sourceName), readRuntimeLoadState(), readManagerSettings()])
      setRuntimeState(runtime)
      assertManagerSettingsTarget(runtime, sourceName)
      if (selected.sha256 !== source?.snapshot.sha256) {
        setSourceError("源配置已变化；草稿已保留，请重新读取并核对后应用。")
        throw new Error("源配置已变化；草稿已保留，请重新读取并核对后应用。")
      }
      if (currentSettings.version !== settings.version) throw new Error("管理器设置已被其他设备修改；当前草稿已保留，请取消本页修改后重新读取。")
      const selectedSource = selected
      let saved = settings
      if (dirty) {
        saved = await saveManagerSettings(nextOverrides, settings.version)
        setSettings(saved)
        resetDraft(saved.overrides)
        setPendingApply(true)
      }
      setMessage("设置已保存，正在生成并加载运行配置")
      try {
        attemptedApply = true
        const recorded = await applyRuntimeConfig(selectedSource, undefined, runtime.version)
        setRuntimeState(recorded)
        let latestSettings: ManagerSettings
        let latestSource: Awaited<ReturnType<typeof readConfigFile>>
        try {
          [latestSettings, latestSource] = await Promise.all([
            readManagerSettings(),
            readConfigFile(sourceName),
          ])
        } catch {
          setPendingApply(true)
          setError("运行配置已加载，但无法确认当前设置与源配置版本；请重新读取后应用")
          setMessage("")
          notify("运行配置已加载，但无法确认当前设置与源配置版本", "error")
          return
        }
        setSettings(latestSettings)
        resetDraft(latestSettings.overrides)
        setSource({ snapshot: latestSource, values: sourceSettingsDocument(latestSource.content) })
        const exact = latestSettings.version === saved.version &&
          latestSource.sha256 === selectedSource.sha256 &&
          runtimeMatchesManagerSettings(recorded, latestSource, latestSettings.version)
        setPendingApply(!exact)
        if (!exact) {
          setError("运行配置已加载，但设置或源配置又有更新；当前版本仍需重新应用")
          setMessage("")
          notify("运行配置已加载，但设置或源配置又有更新；请重新应用", "error")
          return
        }
        setMessage("设置已保存并应用")
        notify(`${sourceName} 的管理器设置已保存并应用`)
      } catch (applyError) {
        const detail = applyError instanceof RuntimeApplyError
          ? applyError.message
          : "运行配置应用未完成，运行身份未知"
        setPendingApply(true)
        setError(`设置已保存；${detail}`)
        setMessage("")
        notify(`设置已保存；${detail}`, "error")
        return
      }
    } catch (saveError) {
      const detail = saveError instanceof ConfigError && saveError.code === "manager_settings_conflict"
        ? "设置已被其他设备修改；当前草稿已保留，请刷新后再处理"
        : saveError instanceof Error ? saveError.message : "设置保存失败"
      setError(detail)
      setMessage("设置未保存")
      notify(detail, "error")
    } finally {
      if (attemptedApply) {
        await refreshInterfaces(form.tunEnable === "disabled" ? 4_000 : 0)
        await onRefresh().catch(() => undefined)
      }
      action.current = false
      setSaving(false)
    }
  }
  const cancelChanges = () => { if (settings) resetDraft(settings.overrides); void refreshPersistentState({ discard: true }) }
  const cancelDirectDelay = () => { draftRevision.current++; setDirectDelayDraft(directDelaySaved); setDirectDelayError(null); setDirectDelayMessage("") }
  const isExplicit = (group: SettingGroup) => settingIsExplicit(draft, group)
  const categoryChanged = (groups: SettingGroup[]) => settings && groups.some(group => edited.has(group) && !settingsValuesEqual(managerDraftOverrides(settings.overrides, draft, new Set([group])), settings.overrides))

  return {
    sourceName, loading, saving, dirty, pendingApply, message, error, sourceLoading, sourceReady, sourceStatus, fieldEditing, setFieldEditing,
    sourceError: loading ? null : sourceError || targetError, defaultsLabel, form, formError, disabled, availableInterfaces, selectedInterface,
    interfacesLoading, interfacesError, tun, tunError, tunMessage, directDelayDraft, directDelayDirty,
    directDelayValidation, directDelayDisabled, directDelayError, directDelayMessage, savingDirectDelay, patch,
    reset, refreshInterfaces, recoverTun, patchDirectDelay, saveDirectDelay, saveAndApply,
    cancelChanges, cancelDirectDelay, isExplicit, categoryChanged, known: projected.known,
  }
}
