import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LogStore } from "./store.js";
import type { StoredLogEntry } from "./types.js";

type ServerOptions = {
  store: LogStore;
  maxBodyBytes?: number;
};

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("invalid_json");
  return value as Record<string, unknown>;
}

function numberParam(value: string | null) {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export function createLogServer(options: ServerOptions) {
  const clients = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    try {
      const url = new URL(request.url || "/", "http://logd.local");
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { ok: true });
      }
      if (request.method === "GET" && url.pathname === "/entries") {
        const limit = Math.min(numberParam(url.searchParams.get("limit")) ?? 500, 1500);
        const beforeId = numberParam(url.searchParams.get("before"));
        const level = url.searchParams.get("level")?.trim().toLowerCase();
        const search = url.searchParams.get("search")?.trim().slice(0, 200);
        const since = numberParam(url.searchParams.get("since"));
        const until = numberParam(url.searchParams.get("until"));
        const entries = options.store.list({
          limit,
          ...(beforeId ? { beforeId } : {}),
          ...(level && level !== "all" ? { level } : {}),
          ...(search ? { search } : {}),
          ...(since ? { since } : {}),
          ...(until ? { until } : {}),
        });
        return json(response, 200, { entries, hasMore: entries.length === limit });
      }
      if (request.method === "GET" && url.pathname === "/settings") {
        return json(response, 200, { retentionDays: options.store.retentionDays() });
      }
      if (request.method === "PUT" && url.pathname === "/settings") {
        const body = await readJson(request, options.maxBodyBytes ?? 16_384);
        const retentionDays = Number(body.retentionDays);
        if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
          return json(response, 400, { error: "invalid_retention" });
        }
        const removed = options.store.setRetentionDays(retentionDays);
        return json(response, 200, { retentionDays, removed });
      }
      if (request.method === "GET" && url.pathname === "/stream") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.write(": connected\n\n");
        clients.add(response);
        request.on("close", () => clients.delete(response));
        return;
      }
      return json(response, 404, { error: "not_found" });
    } catch {
      return json(response, 400, { error: "invalid_request" });
    }
  });
  const publish = (entries: StoredLogEntry[]) => {
    if (entries.length === 0) return;
    const payload = `data: ${JSON.stringify(entries)}\n\n`;
    clients.forEach((client) => client.write(payload));
  };
  return { server, publish };
}
