import { providerFilesErrorMessage, configValidationErrorMessage } from "./configMessages.ts";
import {
  beginRuntimeLoad,
  finishRuntimeLoad,
  generateRuntimeConfig,
  readManagerSettings,
  readRuntimeLoadState,
  type ConfigSnapshot,
  type RuntimeLoadState,
} from "../api/configClient.ts";
import { ControllerError, loadControllerConfig } from "../api/controllerClient.ts"

export class RuntimeApplyError extends Error {
  readonly phase: "prepare" | "load" | "record"
  readonly loaded: boolean | null
  readonly state?: RuntimeLoadState

  constructor(
    message: string,
    phase: "prepare" | "load" | "record",
    loaded: boolean | null,
    state?: RuntimeLoadState,
    cause?: unknown,
  ) {
    super(message, { cause })
    this.phase = phase
    this.loaded = loaded
    this.state = state
  }
}

const dependencies = {
  settings: readManagerSettings,
  generate: generateRuntimeConfig,
  state: readRuntimeLoadState,
  begin: beginRuntimeLoad,
  load: loadControllerConfig,
  finish: finishRuntimeLoad,
}

export const RUNTIME_CONFIG_LOADED_EVENT = "mihomo-runtime-config-loaded"

// Fixed phase names only; never record configuration names, URLs or contents.
export async function measureRuntimeStep<T>(scope: "apply" | "mode", phase: string, operation: () => Promise<T>): Promise<T> {
  const start = performance.now()
  try { return await operation() }
  finally { performance.measure(`mihomo:${scope}:${phase}`, { start, end: performance.now() }) }
}

export async function applyRuntimeConfig(
  source: Pick<ConfigSnapshot, "name" | "sha256">,
  services = dependencies,
  expectedLoadVersion?: number,
) {
  let attempt: RuntimeLoadState
  let observedState: RuntimeLoadState | undefined
  try {
    const [state, settings] = await measureRuntimeStep("apply", "read", () => Promise.all([services.state(), services.settings()]))
    observedState = state
    if (expectedLoadVersion !== undefined && state.version !== expectedLoadVersion) throw new Error("加载记录已变化")
    const generated = await measureRuntimeStep("apply", "generate", () => services.generate(source.name, source.sha256, settings.version))
    attempt = await measureRuntimeStep("apply", "begin", () => services.begin(generated.version, state.version))
  } catch (error) {
    const issues = providerFilesErrorMessage(error)
    throw new RuntimeApplyError(issues ? `${issues}；请先补齐配套文件，尚未应用`
      : configValidationErrorMessage(error) ?? "运行文件生成或版本确认失败；磁盘已保存，尚未调用 Controller", "prepare", false, observedState, error)
  }
  if (!attempt.lastAttempt) throw new RuntimeApplyError("加载记录不可用，尚未调用 Controller", "prepare", false, attempt)
  const pending = attempt.lastAttempt
  let loaded: boolean | null = true
  try {
    await measureRuntimeStep("apply", "controller", () => services.load(pending.generated.path))
  } catch (error) {
    loaded = error instanceof ControllerError && [400, 401, 403, 404].includes(error.status) ? false : null
  }
  let recorded: RuntimeLoadState
  try {
    recorded = await measureRuntimeStep("apply", "record", () => services.finish(pending.id, attempt.version, loaded === true ? "succeeded" : loaded === false ? "failed" : "unknown"))
  } catch {
    throw new RuntimeApplyError(loaded === true
      ? "Controller 已加载，但共享记录未确认；运行可能已变化，请重新读取记录"
      : "加载结果及共享记录未确认；磁盘与运行配置可能不一致", "record", loaded, attempt)
  } finally {
    if (loaded === true && typeof window !== "undefined") window.dispatchEvent(new Event(RUNTIME_CONFIG_LOADED_EVENT))
  }
  if (loaded !== true) throw new RuntimeApplyError(loaded === false
    ? "Controller 拒绝加载；磁盘配置与运行配置不一致"
    : "未收到明确加载结果；磁盘配置与运行配置可能不一致，运行身份未知", "load", loaded, recorded)
  return recorded
}

export function runtimeSourceIdentity(state: RuntimeLoadState | null | undefined) {
  const generated = state?.lastSuccessful?.generated
  return generated
    ? { name: generated.sourceName, sha256: generated.sourceSha256 }
    : null
}

// A shared success is an operation record, not continuous proof of Core identity.
// Pending/unknown attempts invalidate it for views that must choose one runtime source.
export function confirmedRuntimeSource(state: RuntimeLoadState | null | undefined) {
  if (!state?.lastSuccessful || !state.lastAttempt) return null
  if (state.lastAttempt.status === "pending" || state.lastAttempt.status === "unknown") return null
  if (state.lastAttempt.status === "succeeded" && state.lastAttempt.generated.version !== state.lastSuccessful.generated.version) return null
  return runtimeSourceIdentity(state)
}

export function runtimeMatchesManagerSettings(
  state: RuntimeLoadState | null | undefined,
  source: Pick<ConfigSnapshot, "name" | "sha256"> | null | undefined,
  settingsVersion: number,
) {
  const generated = state?.lastSuccessful?.generated
  return Boolean(
    generated &&
    source &&
    generated.sourceName === source.name &&
    generated.sourceSha256 === source.sha256 &&
    generated.settingsVersion === settingsVersion,
  )
}
