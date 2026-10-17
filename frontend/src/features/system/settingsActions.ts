import { ControllerError, controllerApi, restartController } from "../../api/controllerClient.ts";
import { operateCoreService, readCoreServiceStatus, type CoreServiceStatus } from "../../api/systemClient.ts";

type RestartDependencies = {
  restart: () => Promise<void>;
  probe: (signal: AbortSignal) => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
};

const restartDependencies: RestartDependencies = {
  restart: restartController,
  probe: async (signal) => {
    await controllerApi("/version", { signal }, 2_000);
  },
  wait: (milliseconds) => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)),
};

export async function restartCoreAndRefresh(
  signal: AbortSignal,
  refresh: () => Promise<void>,
  dependencies: RestartDependencies = restartDependencies,
) {
  await dependencies.restart();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (signal.aborted) return false;
    await dependencies.wait(1_000);
    if (signal.aborted) return false;
    try {
      await dependencies.probe(signal);
    } catch {
      if (signal.aborted) return false;
      // The Controller listener is expected to close briefly during restart.
      continue;
    }
    await refresh();
    return !signal.aborted;
  }
  throw new Error("核心重启后 Controller 未恢复");
}

export type ControllerConnection = "online" | "authentication-failed" | "unavailable";
export async function readControllerConnection(signal: AbortSignal): Promise<ControllerConnection> {
  try { await restartDependencies.probe(signal); return "online"; }
  catch (error) {
    if (signal.aborted) throw error;
    return error instanceof ControllerError && [401, 403].includes(error.status) ? "authentication-failed" : "unavailable";
  }
}

export function coreFailureMessage(service: CoreServiceStatus | null): string | null {
  if (!service?.failure) return null;
  const messages: Record<string, string> = {
    "not-found": "Core 服务未安装", masked: "Core 服务已被屏蔽", "exit-code": "Core 进程启动或运行失败",
    signal: "Core 进程被信号终止", "core-dump": "Core 进程异常终止", timeout: "Core 服务启动超时",
    "start-limit-hit": "Core 连续启动失败，已达到重试限制", resources: "Core 启动所需资源不可用",
    watchdog: "Core 服务无响应", protocol: "Core 服务启动未完成",
  };
  const message = messages[service.failure] ?? "Core 服务启动或运行失败";
  return service.failure === "exit-code" && Number.isInteger(service.exitStatus)
    ? `${message}（退出码 ${service.exitStatus}）` : message;
}

type RecoveryDependencies = {
  connection: (signal: AbortSignal) => Promise<ControllerConnection>;
  service: (signal: AbortSignal) => Promise<CoreServiceStatus>;
  control: (action: "start" | "restart", signal: AbortSignal) => Promise<CoreServiceStatus>;
  restart: () => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
};
const recoveryDependencies: RecoveryDependencies = {
  connection: readControllerConnection, service: readCoreServiceStatus, control: operateCoreService,
  restart: restartController, wait: restartDependencies.wait,
};

export async function recoverCoreAndRefresh(
  action: "start" | "restart", signal: AbortSignal, refresh: () => Promise<void>,
  dependencies: RecoveryDependencies = recoveryDependencies,
) {
  const connection = await dependencies.connection(signal);
  if (signal.aborted) return false;
  if (connection === "authentication-failed") throw new Error("Controller 认证失败，请检查 Secret；未执行服务重启");
  if (connection === "online") {
    if (action === "restart") {
      return restartCoreAndRefresh(signal, refresh, { restart: dependencies.restart, wait: dependencies.wait,
        probe: async (request) => {
          if (await dependencies.connection(request) !== "online") throw new Error("Controller 未恢复");
        } });
    }
    await refresh();
    return !signal.aborted;
  }
  const service = await dependencies.service(signal);
  if (signal.aborted) return false;
  if (service.busy || service.state === "deactivating") throw new Error("核心服务正在执行操作，请稍后再试");
  await dependencies.control(action, signal);
  for (let attempt = 0; attempt < 15; attempt++) {
    if (signal.aborted) return false;
    await dependencies.wait(1_000);
    if (signal.aborted) return false;
    const current = await dependencies.service(signal);
    const connected = await dependencies.connection(signal);
    if (signal.aborted) return false;
    if (connected === "authentication-failed") throw new Error("核心服务操作已执行，但 Controller 认证失败，请检查 Secret");
    if (current.running && connected === "online") { await refresh(); return !signal.aborted; }
    if (current.failure && !current.running) throw new Error(coreFailureMessage(current) ?? "核心服务启动失败");
  }
  throw new Error("核心服务操作已执行，但 Controller 尚未恢复，请查看分别显示的服务与连接状态");
}
