import { isSeq, parseDocument } from "yaml";
import { readAppliedRuntime, readRuntimeLoadState, readProxyAddresses, type ProxyAddresses } from "../../api/configClient.ts";
import { controllerApi } from "../../api/controllerClient.ts";
import { LatestRequestController } from "../../shared/requestLifecycle.ts";
import { confirmedRuntimeSource } from "../../shared/runtimeApplication.ts";
import type { Json } from "../../shared/types";

type ProxyControllerReader = (
  path: string,
  options: { signal: AbortSignal },
) => Promise<Json>;

type ProxyAddressReader = (signal: AbortSignal) => Promise<ProxyAddresses>;

export class ProxyRequestController {
  private readonly runtime = new LatestRequestController();
  private readonly addresses = new LatestRequestController();
  private readonly groupOrder = new LatestRequestController();

  beginRuntime() {
    return this.runtime.begin();
  }

  beginAddresses() {
    return this.addresses.begin();
  }

  beginGroupOrder() {
    return this.groupOrder.begin();
  }

  cancelRuntime() {
    this.runtime.cancel();
  }

  dispose() {
    this.runtime.dispose();
    this.addresses.dispose();
    this.groupOrder.dispose();
  }
}

export type ProxyGroupOrder = { version: string; sha256: string; names: string[] };

// The success record supplies display order only, not proof of the Core's identity.
export async function readOptionalProxyGroupOrder(
  signal: AbortSignal,
  cached: ProxyGroupOrder | null,
  readers = { state: readRuntimeLoadState, applied: readAppliedRuntime },
): Promise<ProxyGroupOrder | null> {
  try {
    const state = await readers.state(signal);
    const generated = confirmedRuntimeSource(state) && state.lastSuccessful?.generated;
    if (!generated || signal.aborted) return null;
    if (cached?.version === generated.version && cached.sha256 === generated.contentSha256) return cached;
    const applied = await readers.applied(signal);
    const loaded = confirmedRuntimeSource(applied.state) && applied.state.lastSuccessful?.generated;
    if (signal.aborted || !loaded || applied.content === null
      || loaded.version !== generated.version || loaded.contentSha256 !== generated.contentSha256) return null;
    const document = parseDocument(applied.content);
    if (document.errors.length) return null;
    const groupNode = document.get("proxy-groups", true);
    if (!isSeq(groupNode)) return null;
    const groups: unknown[] = groupNode.toJSON();
    const names = groups.flatMap((group: unknown) => (
      group && typeof group === "object" && "name" in group && typeof group.name === "string"
        ? [group.name] : []
    ));
    return { version: loaded.version, sha256: loaded.contentSha256, names: [...new Set(names)] };
  } catch {
    return null;
  }
}

export async function readProxyRuntimeSnapshot(
  signal: AbortSignal,
  readController: ProxyControllerReader = (path, options) => controllerApi<Json>(path, options),
) {
  const [proxyResponse, providerResponse] = await Promise.all([
    readController("/proxies", { signal }),
    readController("/providers/proxies", { signal }),
  ]);
  return {
    proxies: (proxyResponse.proxies || {}) as Record<string, Json>,
    providers: (providerResponse.providers || {}) as Record<string, Json>,
  };
}

export async function readOptionalProxyAddresses(
  signal: AbortSignal,
  readAddresses: ProxyAddressReader = readProxyAddresses,
) {
  try {
    return await readAddresses(signal);
  } catch {
    return null;
  }
}
