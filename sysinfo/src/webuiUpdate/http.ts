import type { IncomingMessage, ServerResponse } from "node:http";
import { UpdateError, type Route } from "../updates/transport.js";
import type { AutomaticUpdates } from "./policy.js";
import type { WebUiSource, WebUiUpdates } from "./service.js";

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length; if (size > 16384) throw new UpdateError("invalid_request"); chunks.push(chunk);
  }
  const value = size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UpdateError("invalid_request");
  return value as Record<string, unknown>;
}

export class WebUiUpdateApi {
  constructor(readonly updates: WebUiUpdates, readonly policy: AutomaticUpdates) {}
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = request.url;
    if (!path?.startsWith("/webui/update") && path !== "/updates/settings") return false;
    const send = (status: number, body: unknown) => response.writeHead(status).end(JSON.stringify(body));
    try {
      if (request.method === "GET" && path === "/webui/update") { send(200, await this.updates.status()); return true; }
      if (request.method === "GET" && path === "/updates/settings") { send(200, this.policy.status()); return true; }
      if (request.method !== "POST") { send(405, { error: "method_not_allowed" }); return true; }
      if (path === "/updates/settings") {
        const body = await requestBody(request); send(200, await this.policy.save(body.settings, body.expectedRevision)); return true;
      }
      await this.updates.assertIdle();
      if (path === "/webui/update/upload") {
        await this.updates.receiveUpload(request.iterator({ destroyOnReturn: false }), Number(request.headers["content-length"]) || null);
        request.resume(); send(202, { accepted: true }); return true;
      }
      const body = await requestBody(request);
      await this.updates.assertIdle();
      if (path === "/webui/update/check") void this.updates.startCheck(body as Route);
      else if (path === "/webui/update/download") void this.updates.startDownload(body as Route & { source: Exclude<WebUiSource, "upload">; url?: string });
      else if (path === "/webui/update/install") {
        if (typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.sha256)) throw new UpdateError("candidate_changed");
        await this.updates.startInstall(body.sha256);
      } else if (path === "/webui/update/rollback") {
        if (typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.sha256)) throw new UpdateError("previous_unavailable");
        await this.updates.startRollback(body.sha256);
      } else { send(404, { error: "not_found" }); return true; }
      send(202, { accepted: true });
    } catch (error) {
      request.resume();
      const code = error instanceof UpdateError ? error.code : "invalid_request";
      send(["webui_action_busy", "webui_policy_changed"].includes(code) ? 409 : 400, { error: code });
    }
    return true;
  }
  dispose() { this.policy.dispose(); }
}
