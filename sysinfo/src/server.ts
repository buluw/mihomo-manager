import { createServer } from "node:http";
import { readInterfaces } from "./interfaces.js";
import { CoreControlError, controlCoreService, readCoreService, type CoreAction } from "./coreService.js";
import type { CoreUpdates } from "./coreUpdate.js";
import { readProjectResources } from "./resources.js";
import type { AccessGateway } from "./access/http.js";
import type { WebUiUpdateApi } from "./webuiUpdate/http.js";

export function createSysinfoServer(read = readInterfaces, core = { read: readCoreService, control: controlCoreService }, updates?: CoreUpdates, resources = readProjectResources, access?: AccessGateway, webui?: WebUiUpdateApi) {
  let busy = false;
  webui?.updates.setCoreBusy(() => busy || Boolean(updates?.busy));
  const webUiBusy = async () => {
    try { return Boolean(await webui?.updates.isBusy()); } catch { return true; }
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (access && await access.handle(request, response)) return;
    if (webui && await webui.handle(request, response)) return;
    if (request.url === "/resources") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        response.writeHead(405).end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      try {
        const value = await resources(request.headers["cache-control"] === "no-cache");
        response.writeHead(200).end(JSON.stringify(value));
      } catch { response.writeHead(503).end(JSON.stringify({ error: "resources_unavailable" })); }
      return;
    }
    if (updates && request.url?.startsWith("/core/update")) { await updates.handle(request, response, async () => busy || await webUiBusy()); return; }
    const action = request.url === "/core/start" ? "start" : request.url === "/core/restart" ? "restart" : null;
    if (request.url === "/core" || action) {
      const method = action ? "POST" : "GET";
      if (request.method !== method) {
        response.setHeader("Allow", method);
        response.writeHead(405).end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!action) {
        try {
          const state = await core.read();
          response.writeHead(200).end(JSON.stringify({ ...state, busy: busy || Boolean(updates?.busy) }));
        }
        catch { response.writeHead(503).end(JSON.stringify({ error: "core_status_unavailable" })); }
        return;
      }
      if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0) {
        response.writeHead(400).end(JSON.stringify({ error: "body_not_allowed" }));
        request.resume();
        return;
      }
      if (busy || updates?.busy || await webUiBusy()) { response.writeHead(409).end(JSON.stringify({ error: "core_action_busy" })); return; }
      busy = true;
      try {
        await core.control(action as CoreAction);
        const state = await core.read();
        response.writeHead(200).end(JSON.stringify({ ...state, busy: false }));
      } catch (error) {
        const code = error instanceof CoreControlError ? error.code : "core_action_failed";
        response.writeHead(code === "core_action_busy" ? 409 : 503).end(JSON.stringify({ error: code }));
      } finally { busy = false; }
      return;
    }
    if (request.url !== "/interfaces") {
      response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      response.writeHead(405).end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    try {
      const interfaces = await read();
      response.writeHead(200).end(JSON.stringify({ interfaces }));
    } catch {
      response.writeHead(503).end(JSON.stringify({ error: "network_interfaces_unavailable" }));
    }
  });
  if (access) {
    server.on("upgrade", (request, socket, head) => { void access.upgrade(request, socket, head); });
    server.on("close", () => access.dispose());
  }
  if (webui) server.on("close", () => webui.dispose());
  return server;
}
