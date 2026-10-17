import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";

export const MAX_UPDATE_BYTES = 128 * 1024 * 1024;
export const sources = { github: "", ghfast: "https://ghfast.top/", ghproxy: "https://gh-proxy.com/", ghproxynet: "https://ghproxy.net/" };
export type Route = { mode: "direct" | "core" | "external"; proxy?: string };
export class UpdateError extends Error {
  constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new UpdateError(code); };

export function validateUrl(value: unknown, proxy = false): string {
  if (typeof value !== "string" || value.length > 4096 || /[\r\n\0]/.test(value)) return fail("invalid_url");
  let url: URL;
  try { url = new URL(value); } catch { return fail("invalid_url"); }
  if (!(proxy ? ["http:", "https:", "socks5:", "socks5h:"] : ["http:", "https:"]).includes(url.protocol) || !url.hostname) return fail("invalid_url");
  return url.href;
}

export async function receiveFile(input: AsyncIterable<Buffer>, path: string, onBytes: (bytes: number) => void, limit = MAX_UPDATE_BYTES) {
  const file = await open(path, "w", 0o600);
  try {
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of input) {
      size += chunk.length;
      if (size > limit) return fail("file_too_large");
      digest.update(chunk);
      await file.writeFile(chunk);
      onBytes(size);
    }
    return digest.digest("hex");
  } finally { await file.close(); }
}

// curl receives URLs and proxy credentials on stdin, never as process arguments or logs.
export async function requestData(url: string, proxy: string | null, output?: string, onBytes?: (bytes: number) => void): Promise<{ status: number; body: Buffer }> {
  const quote = (value: string) => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  const config = ["silent", "show-error", "location", 'write-out = "\\n%{http_code}"', 'proto = "=http,https"', 'proto-redir = "=http,https"', "max-redirs = 5",
    "connect-timeout = 15", `max-time = ${output ? 180 : 40}`, `max-filesize = ${output ? MAX_UPDATE_BYTES : 4 * 1024 * 1024}`,
    'user-agent = "mihomo-manager"', `url = ${quote(validateUrl(url))}`, `proxy = ${quote(proxy ?? "")}`, `noproxy = ${quote(proxy ? "" : "*")}`,
    ...(output ? [`output = ${quote(output)}`] : [])].join("\n") + "\n";
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(http|https|all|no)_proxy$/i.test(key)));
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/curl", ["--config", "-"], { env, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = output && onBytes ? setInterval(() => { void stat(output).then(value => onBytes(value.size), () => {}); }, 250) : null;
    child.stdin.on("error", () => {});
    child.stdin.end(config);
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 4 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
    child.on("error", () => { if (timer) clearInterval(timer); reject(new UpdateError("download_failed")); });
    child.on("close", code => {
      if (timer) clearInterval(timer);
      const result = Buffer.concat(chunks);
      const marker = result.subarray(-4).toString("ascii");
      if (code !== 0 || !/^\n\d{3}$/.test(marker)) { reject(new UpdateError("download_failed")); return; }
      resolve({ status: Number(marker.slice(1)), body: result.subarray(0, -4) });
    });
  });
}

export async function transfer(url: string, proxy: string | null, output?: string, onBytes?: (bytes: number) => void): Promise<Buffer> {
  const response = await requestData(url, proxy, output, onBytes);
  if (response.status < 200 || response.status >= 300) throw new UpdateError("download_failed");
  return response.body;
}

async function controllerConfig() {
  try {
    const response = await fetch(`${process.env.MIHOMO_CONTROLLER_URL ?? "http://127.0.0.1:19090"}/configs`, {
      headers: process.env.MIHOMO_CONTROLLER_SECRET ? { Authorization: `Bearer ${process.env.MIHOMO_CONTROLLER_SECRET}` } : {}, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return fail("core_proxy_unavailable");
    return await response.json() as Record<string, unknown>;
  } catch { return fail("core_proxy_unavailable"); }
}

export async function proxyFor(route: Route, readConfig = controllerConfig): Promise<string | null> {
  if (route.mode === "direct") return null;
  if (route.mode === "external") return validateUrl(route.proxy, true);
  if (route.mode !== "core") return fail("invalid_route");
  const config = await readConfig();
  for (const key of ["mixed-port", "port", "socks-port"]) {
    const port = config[key];
    if (Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535) {
      // Optional authentication is supplied explicitly; no config or node is changed.
      const auth = Array.isArray(config.authentication) ? config.authentication[0] : undefined;
      const credentials = typeof auth === "string" && auth.includes(":")
        ? `${encodeURIComponent(auth.slice(0, auth.indexOf(":")))}:${encodeURIComponent(auth.slice(auth.indexOf(":") + 1))}@` : "";
      return `${key === "socks-port" ? "socks5h" : "http"}://${credentials}127.0.0.1:${port}`;
    }
  }
  return fail("core_proxy_unavailable");
}

