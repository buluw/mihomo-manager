import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { UpdateError } from "../updates/transport.js";

export interface InstalledProgram { version: string; sha256: string; sourceSha256: string | null }
export interface InstallState {
  version: 1; id: string | null; action: "install" | "rollback" | null; sha256: string | null;
  phase: "idle" | "installing" | "rolling-back" | "succeeded" | "rolled-back" | "failed";
  busy: boolean; error: string | null; startedAt: string | null; finishedAt: string | null;
  previous: InstalledProgram | null; services: string[];
}
export const defaultInstallState: InstallState = { version: 1, id: null, action: null, sha256: null, phase: "idle", busy: false,
  error: null, startedAt: null, finishedAt: null, previous: null, services: [] };

export async function readInstallState(directory = "/var/lib/mihomo-manager-webui-install"): Promise<InstallState> {
  try {
    const state = JSON.parse(await readFile(join(directory, "status.json"), "utf8")) as InstallState;
    if (state.version !== 1 || typeof state.busy !== "boolean" || !["idle", "installing", "rolling-back", "succeeded", "rolled-back", "failed"].includes(state.phase)) throw new Error();
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaultInstallState };
    throw new UpdateError("webui_install_status_unavailable");
  }
}

export function requestWebUiInstall(action: "install" | "rollback", sha256: string, id: string,
  socketPath = "/run/mihomo-manager-webui-update.sock"): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "", settled = false;
    const fail = (code = "webui_install_unconfirmed") => { if (settled) return; settled = true; socket.destroy(); reject(new UpdateError(code)); };
    socket.setTimeout(15000, () => fail()); socket.on("error", () => fail());
    socket.on("connect", () => socket.write(JSON.stringify({ action, sha256, id }) + "\n"));
    socket.on("data", data => {
      response += data.toString("utf8");
      if (response.length > 4096) { fail(); return; }
      if (!response.includes("\n")) return;
      try {
        const result = JSON.parse(response.trim()) as { accepted?: boolean; id?: string; error?: string };
        if (!result.accepted || result.id !== id) { fail(result.error === "busy" ? "webui_action_busy" : "webui_install_rejected"); return; }
        settled = true; socket.destroy(); resolve();
      } catch { fail(); }
    });
    socket.on("end", () => { if (!settled) fail(); });
  });
}
