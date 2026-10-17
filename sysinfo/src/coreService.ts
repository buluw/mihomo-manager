import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";

const execute = promisify(execFile);
const states = ["active", "inactive", "activating", "deactivating", "failed", "unknown"] as const;
const failures = ["exit-code", "signal", "core-dump", "timeout", "start-limit-hit", "resources", "watchdog", "protocol"] as const;
export type CoreAction = "start" | "restart";
export interface CoreServiceState {
  state: typeof states[number];
  running: boolean;
  failure: string | null;
  exitStatus: number | null;
}

export function parseCoreService(output: string): CoreServiceState {
  const fields = Object.fromEntries(output.trim().split("\n").map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  const state = states.find(value => value === fields.ActiveState) ?? "unknown";
  const result = failures.find(value => value === fields.Result);
  const failure = fields.LoadState === "not-found" ? "not-found" : fields.LoadState === "masked" ? "masked"
    : result ?? (state === "failed" ? "unknown" : null);
  const status = Number(fields.ExecMainStatus);
  return { state, running: state === "active" && fields.SubState === "running", failure,
    exitStatus: Number.isInteger(status) && status >= 0 && status <= 255 ? status : null };
}

export async function readCoreService(): Promise<CoreServiceState> {
  const { stdout } = await execute("/usr/bin/systemctl", ["show", "mihomo-manager-core.service",
    "--property=LoadState,ActiveState,SubState,Result,ExecMainStatus"], { timeout: 5000, maxBuffer: 4096 });
  return parseCoreService(stdout);
}

export class CoreControlError extends Error {
  constructor(readonly code: "core_control_unavailable" | "core_action_failed" | "core_action_busy") { super(code); }
}

export function controlCoreService(action: CoreAction, socketPath = "/run/mihomo-manager-core-control.sock"): Promise<void> {
  if (action !== "start" && action !== "restart") return Promise.reject(new CoreControlError("core_action_failed"));
  return sendControl(action, socketPath).then(() => {});
}

export function controlCoreUpdate(action: "install" | "rollback"): Promise<"ok" | "rolled_back"> {
  return sendControl(action, "/run/mihomo-manager-core-control.sock", 280000);
}

function sendControl(action: string, socketPath: string, timeout = 30000): Promise<"ok" | "rolled_back"> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    const fail = () => { socket.destroy(); reject(new CoreControlError("core_control_unavailable")); };
    socket.setTimeout(timeout, fail);
    socket.on("error", fail);
    socket.on("connect", () => { socket.write(action + "\n"); });
    socket.on("data", data => {
      response += data.toString("utf8");
      if (response.length > 32) { fail(); return; }
      if (!response.includes("\n")) return;
      socket.destroy();
      if (response.trim() === "ok" || response.trim() === "rolled_back") resolve(response.trim() as "ok" | "rolled_back");
      else reject(new CoreControlError(response.trim() === "busy" ? "core_action_busy" : "core_action_failed"));
    });
    socket.on("end", () => { if (!response.includes("\n")) fail(); });
  });
}
