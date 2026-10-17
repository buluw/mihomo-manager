import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import type { AccessSessions } from "./sessions.js";
import { AccessError } from "./store.js";

type Targets = { controller: string; config: string; logs: string };
export class AccessStreams {
  constructor(private readonly sessions: AccessSessions, private readonly targets: Targets = {
    controller: process.env.MIHOMO_CONTROLLER_URL ?? "http://127.0.0.1:19090",
    config: "http://" + (process.env.CONFIGD_HOST ?? "127.0.0.1") + ":" + (process.env.CONFIGD_PORT ?? "9081"),
    logs: "http://" + (process.env.LOGD_HOST ?? "127.0.0.1") + ":" + (process.env.LOGD_PORT ?? "9082"),
  }) {}

  private target(request: IncomingMessage, websocket = false) {
    const match = /^\/stream\/(controller|config|logs)(\/[^#]*)$/.exec(request.url ?? "");
    if (!match || request.method !== "GET") throw new AccessError("not_found", 404);
    const service = match[1] as keyof Targets;
    const path = match[2]!;
    const pathname = path.split("?")[0];
    const permitted = service === "controller" ? websocket || ["/traffic", "/memory", "/logs"].includes(pathname!)
      : !websocket && pathname === (service === "config" ? "/changes" : "/stream");
    if (!permitted) throw new AccessError("not_found", 404);
    const base = new URL(this.targets[service]);
    const headers: IncomingHttpHeaders = { ...request.headers, host: base.host };
    delete headers.cookie;
    for (const name of Object.keys(headers)) if (name.startsWith("x-access-")) delete headers[name];
    return { base, path, headers };
  }
  http(request: IncomingMessage, response: ServerResponse) {
    const { base, path, headers } = this.target(request);
    const upstream = (base.protocol === "https:" ? httpsRequest : httpRequest)(base, { method: "GET", path, headers });
    let source: IncomingMessage | null = null;
    const close = () => { upstream.destroy(); source?.destroy(); response.destroy(); };
    const unwatch = this.sessions.watch(request.headers.cookie, close);
    response.once("close", () => { unwatch(); upstream.destroy(); source?.destroy(); });
    upstream.once("response", incoming => {
      source = incoming;
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      response.flushHeaders();
      incoming.on("error", () => response.destroy());
      incoming.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502).end(JSON.stringify({ error: "stream_unavailable" }));
      else response.destroy();
    });
    upstream.end();
  }
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const { base, path, headers } = this.target(request, true);
    const upstream = (base.protocol === "https:" ? httpsRequest : httpRequest)(base, { method: "GET", path, headers });
    let peer: Duplex | null = null;
    const close = () => { upstream.destroy(); peer?.destroy(); socket.destroy(); };
    const unwatch = this.sessions.watch(request.headers.cookie, close);
    socket.once("close", () => { unwatch(); upstream.destroy(); peer?.destroy(); });
    socket.on("error", close);
    upstream.once("upgrade", (response, connected, upstreamHead) => {
      peer = connected;
      const lines = ["HTTP/1.1 101 Switching Protocols"];
      for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(response.rawHeaders[i] + ": " + response.rawHeaders[i + 1]);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      peer.on("error", close);
      peer.once("close", close);
      peer.pipe(socket).pipe(peer);
    });
    upstream.once("response", response => {
      response.resume();
      socket.end("HTTP/1.1 " + (response.statusCode ?? 502) + " Upstream response\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    upstream.on("error", close);
    upstream.end();
  }
}
