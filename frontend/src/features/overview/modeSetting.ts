import {
  readManagerSettings,
  readRuntimeLoadState,
  readAppliedRuntime,
  prepareRuntimeMode,
  finishRuntimeLoad,
  type RuntimeLoadState,
} from "../../api/configClient.ts"
import { measureRuntimeStep } from "../../shared/runtimeApplication.ts"
import { ControllerError, patchControllerMode } from "../../api/controllerClient.ts"
import { sourceSettingsDocument } from "../../shared/managerSettingsSource.ts"

export type PersistentMode = "rule" | "direct" | "global"

export async function readPersistentMode(
  signal?: AbortSignal,
  services = { settings: readManagerSettings, applied: readAppliedRuntime },
) {
  const [settings, applied] = await Promise.all([
    services.settings(signal), services.applied(signal),
  ])
  const runtime = applied.state
  const sourceMode = applied.content ? sourceSettingsDocument(applied.content).mode : undefined
  const appliedMode = runtime.lastSuccessful?.generated.mode ?? sourceMode
  const value: unknown = settings.overrides.mode ?? sourceMode
  const mode: PersistentMode | null = value === "rule" || value === "direct" || value === "global" ? value : null
  return { mode, pending: mode === null || mode !== appliedMode || !runtime.lastSuccessful || runtime.lastAttempt?.status === "pending" || runtime.lastAttempt?.status === "unknown" }
}

export type PersistentModeRetry = { mode: PersistentMode; attemptId: string; version: number }

export class PersistentModeError extends Error {
  readonly saved: boolean
  readonly retry?: PersistentModeRetry

  constructor(message: string, saved: boolean, retry?: PersistentModeRetry) {
    super(message)
    this.saved = saved
    this.retry = retry
  }
}

const dependencies = {
  settings: readManagerSettings,
  runtime: readRuntimeLoadState,
  prepare: prepareRuntimeMode,
  patch: patchControllerMode,
  finish: finishRuntimeLoad,
}

export async function applyPersistentMode(
  mode: PersistentMode,
  services = dependencies,
  retry?: PersistentModeRetry,
) {
  let prepared: Awaited<ReturnType<typeof prepareRuntimeMode>>
  const confirming = retry?.mode === mode ? retry : undefined
  try {
    const [settings, runtime] = await measureRuntimeStep("mode", "read", () => Promise.all([services.settings(), services.runtime()]))
    if (!runtime.lastSuccessful) throw new PersistentModeError("尚无已确认运行配置，请先应用配置", false)
    if (confirming) {
      const original = runtime.lastAttempt
      if (original?.id !== confirming.attemptId || original.kind !== "mode" || original.generated.mode !== mode) {
        throw new PersistentModeError("原模式尝试已被较新操作替代；请刷新后重新选择模式", true)
      }
      if (runtime.version === confirming.version + 1 && original.status === "succeeded"
        && runtime.lastSuccessful.generated.version === original.generated.version) return { settings, recorded: runtime }
      if (runtime.version !== confirming.version || original.status !== "pending") {
        throw new PersistentModeError("原模式记录已变化；请刷新后重新选择模式", true)
      }
      prepared = { settings, state: runtime }
    } else {
      if (runtime.lastAttempt?.kind === "mode" && runtime.lastAttempt.status === "pending" && runtime.lastAttempt.generated.mode !== mode) {
        throw new PersistentModeError("请先重试未确认的模式，再选择其他模式", true)
      }
      prepared = await measureRuntimeStep("mode", "prepare", () => services.prepare(mode, settings.version, runtime.version))
    }
  } catch (error) {
    if (error instanceof PersistentModeError) throw error
    throw new PersistentModeError("模式准备或版本确认失败，尚未调用 Core；请刷新设置与运行记录", false)
  }
  const attempt = prepared.state.lastAttempt
  if (!attempt || attempt.kind !== "mode") throw new PersistentModeError("模式记录不可用，尚未调用 Core", true)
  let result: "succeeded" | "failed" | "unknown" = "succeeded"
  if (!confirming) {
    try {
      await measureRuntimeStep("mode", "controller", () => services.patch(mode))
    } catch (error) {
      result = error instanceof ControllerError && [400, 401, 403, 404].includes(error.status) ? "failed" : "unknown"
    }
  }
  let recorded: RuntimeLoadState
  try {
    recorded = await measureRuntimeStep("mode", "record", () => services.finish(attempt.id, prepared.state.version, result))
  } catch {
    throw new PersistentModeError(result === "succeeded"
      ? "Core 模式已更新，但持久运行记录未确认；重启仍使用上次确认值，请重试"
      : "模式设置已保存，但本次结果未确认；重启仍使用上次确认值，请重试", true,
      result === "succeeded" ? { mode, attemptId: attempt.id, version: prepared.state.version } : undefined)
  }
  if (result !== "succeeded") throw new PersistentModeError(result === "failed"
    ? "模式设置已保存，但 Core 拒绝切换；重启仍使用上次确认值"
    : "模式设置已保存，但 Core 结果未知；重启仍使用上次确认值，请重试", true)
  return { settings: prepared.settings, recorded }
}
