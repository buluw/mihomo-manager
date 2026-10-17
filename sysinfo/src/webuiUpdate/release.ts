import { requestData, UpdateError } from "../updates/transport.js";

export const WEBUI_REPOSITORY = "buluw/mihomo-manager";
export interface WebUiRelease { version: string; url: string; sha256: string; size: number; releaseNotes: string | null; assetName: string }

export function compareWebUiVersions(left: string, right: string): number | null {
  const parse = (value: string) => /^v?\d+\.\d+\.\d+$/.test(value) ? value.replace(/^v/, "").split(".").map(Number) : null;
  const a = parse(left), b = parse(right);
  if (!a || !b || [...a, ...b].some(value => !Number.isSafeInteger(value))) return null;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

export function webUiRelease(data: unknown, architecture = process.arch): WebUiRelease {
  const release = data as { tag_name?: unknown; draft?: boolean; prerelease?: boolean; body?: unknown;
    assets?: Array<{ name: string; size: number; digest?: string; browser_download_url: string }> };
  if (!release || release.draft || release.prerelease || typeof release.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new UpdateError("webui_invalid_release");
  if (architecture !== "x64") throw new UpdateError("unsupported_architecture");
  const version = release.tag_name.slice(1), prefix = "mihomo-manager-v" + version + "-";
  const available = (release.assets ?? []).filter(asset => typeof asset.name === "string" && asset.name.startsWith(prefix)
    && /^(?:candidate\.[a-f0-9]{12}-)?linux-x64\.tar\.gz$/.test(asset.name.slice(prefix.length)));
  const formal = available.find(asset => asset.name === prefix + "linux-x64.tar.gz");
  const asset = formal ?? (available.length === 1 ? available[0] : undefined);
  if (!asset) throw new UpdateError("webui_asset_unavailable");
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")) throw new UpdateError("official_checksum_unavailable");
  const url = "https://github.com/" + WEBUI_REPOSITORY + "/releases/download/" + release.tag_name + "/" + asset.name;
  if (asset.browser_download_url !== url || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 128 * 1024 * 1024) throw new UpdateError("webui_invalid_release");
  return { version, assetName: asset.name, url, sha256: asset.digest!.slice(7), size: asset.size,
    releaseNotes: typeof release.body === "string" && release.body.trim() ? release.body.slice(0, 200000) : null };
}

export async function queryWebUiRelease(proxy: string | null, request = requestData): Promise<WebUiRelease | null> {
  const response = await request("https://api.github.com/repos/" + WEBUI_REPOSITORY + "/releases/latest", proxy);
  if (response.status === 404) return null;
  if ([401, 403, 429].includes(response.status)) throw new UpdateError("webui_release_forbidden");
  if (response.status !== 200) throw new UpdateError("webui_release_unavailable");
  try { return webUiRelease(JSON.parse(response.body.toString("utf8"))); }
  catch (error) { if (error instanceof UpdateError) throw error; throw new UpdateError("webui_invalid_release"); }
}
