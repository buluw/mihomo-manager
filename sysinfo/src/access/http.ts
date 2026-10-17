import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { AccessSessions, COOKIE_NAME, SESSION_SECONDS } from "./sessions.js";
import { AccessError } from "./store.js";
import { AccessStreams } from "./streams.js";

export function checkOrigin(request: IncomingMessage, origin = request.headers.origin) {
  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  const protocol = request.headers["x-forwarded-proto"] ?? "http";
  if (typeof origin !== "string" || typeof host !== "string" || !["http", "https"].includes(String(protocol))
    || origin !== protocol + "://" + host) throw new AccessError("invalid_origin", 403);
}

function send(response: ServerResponse, status: number, body?: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(body === undefined ? undefined : JSON.stringify(body));
}
function cookie(response: ServerResponse, request: IncomingMessage, token: string | null) {
  response.setHeader("Set-Cookie", COOKIE_NAME + "=" + (token ?? "") + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + (token ? SESSION_SECONDS : 0)
    + (request.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""));
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 4096) { request.resume(); throw new AccessError("invalid_request"); }
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new AccessError("invalid_request"); }
}

export class AccessGateway {
  readonly streams: AccessStreams;
  constructor(readonly sessions = new AccessSessions(), streams?: AccessStreams) { this.streams = streams ?? new AccessStreams(sessions); }
  private validate(request: IncomingMessage, forwarded = false) {
    const method = forwarded ? request.headers["x-access-method"] : request.method;
    if (typeof method !== "string") throw new AccessError("invalid_request");
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) checkOrigin(request, forwarded ? request.headers["x-access-origin"] as string | undefined : request.headers.origin);
    return this.sessions.authorize(request.headers.cookie);
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    await this.sessions.ready;
    try {
      const path = (request.url ?? "").split("?")[0];
      if (path === "/access/verify") {
        this.validate(request, true);
        send(response, 204);
        return true;
      }
      if (path === "/access/status" && request.method === "GET") {
        send(response, 200, this.sessions.status(request.headers.cookie));
        return true;
      }
      if (path?.startsWith("/access/")) {
        if (request.method !== "POST") throw new AccessError("method_not_allowed", 405);
        checkOrigin(request);
        if (path !== "/access/login") this.sessions.authorize(request.headers.cookie);
        const body = await readBody(request);
        if (path === "/access/login") cookie(response, request, await this.sessions.login(body.password));
        else if (path === "/access/logout") { this.sessions.logout(request.headers.cookie); cookie(response, request, null); }
        else if (path === "/access/enable" || path === "/access/password" || path === "/access/disable") {
          const operation = path.slice("/access/".length) as "enable" | "password" | "disable";
          cookie(response, request, await this.sessions.update(request.headers.cookie, operation, body.currentPassword, body.password));
        } else throw new AccessError("not_found", 404);
        send(response, 200, { ok: true });
        return true;
      }
      this.validate(request);
      if (path?.startsWith("/stream/")) { this.streams.http(request, response); return true; }
      return false;
    } catch (error) {
      const failure = error instanceof AccessError ? error : new AccessError("access_unavailable", 503);
      if (failure.code === "access_required" || failure.code === "access_unavailable") response.setHeader("X-Access-State", failure.code === "access_required" ? "required" : "unavailable");
      send(response, failure.status, { error: failure.code });
      return true;
    }
  }
  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    await this.sessions.ready;
    try {
      checkOrigin(request);
      this.sessions.authorize(request.headers.cookie);
      this.streams.upgrade(request, socket, head);
    } catch (error) {
      const status = error instanceof AccessError ? error.status : 503;
      socket.end("HTTP/1.1 " + status + " Access denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  }
  dispose() { this.sessions.dispose(); }
}
