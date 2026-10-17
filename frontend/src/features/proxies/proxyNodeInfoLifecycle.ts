import { LatestRequestController, type LatestRequest } from "../../shared/requestLifecycle.ts";

export type ProxyNodeInfoBinding = {
  generation: number;
  identityKey: string;
  configName: string;
};

export type BoundProxyNodeInfoRequest = LatestRequest & ProxyNodeInfoBinding;

export class ProxyNodeInfoLifecycle {
  private readonly settings = new LatestRequestController();
  private readonly config = new LatestRequestController();
  private generation = 0;
  private open = false;
  private identityKey = "";
  private configName = "";
  private disposed = false;

  openSession(identityKey: string) {
    this.settings.cancel();
    this.config.cancel();
    this.generation += 1;
    this.open = true;
    this.identityKey = identityKey;
    this.configName = "";
    return this.generation;
  }

  closeSession() {
    this.settings.cancel();
    this.config.cancel();
    this.generation += 1;
    this.open = false;
    this.configName = "";
  }

  selectIdentity(identityKey: string) {
    this.config.cancel();
    this.identityKey = identityKey;
    this.configName = "";
  }

  beginSettings(generation?: number): BoundProxyNodeInfoRequest | null {
    if (this.disposed) return null;
    const request = this.settings.begin();
    const binding = {
      generation: generation ?? this.generation,
      identityKey: this.identityKey,
      configName: "",
    };
    return this.bind(request, binding, generation == null ? () => true : () => this.open, false, false);
  }

  beginConfig(configName: string): BoundProxyNodeInfoRequest | null {
    this.config.cancel();
    this.configName = configName;
    if (this.disposed || !this.open || !configName) return null;
    const request = this.config.begin();
    return this.bind(request, this.currentBinding(), () => this.open);
  }

  snapshotBinding(): ProxyNodeInfoBinding | null {
    return this.open && this.configName ? this.currentBinding() : null;
  }

  isCurrent(binding: ProxyNodeInfoBinding | null) {
    return Boolean(binding)
      && this.open
      && binding!.generation === this.generation
      && binding!.identityKey === this.identityKey
      && binding!.configName === this.configName;
  }

  isOpenIdentity(identityKey: string) {
    return this.open && this.identityKey === identityKey;
  }

  currentIdentityKey() {
    return this.open ? this.identityKey : null;
  }

  dispose() {
    this.disposed = true;
    this.open = false;
    this.settings.dispose();
    this.config.dispose();
  }

  private currentBinding(): ProxyNodeInfoBinding {
    return {
      generation: this.generation,
      identityKey: this.identityKey,
      configName: this.configName,
    };
  }

  private bind(
    request: LatestRequest,
    binding: ProxyNodeInfoBinding,
    active: () => boolean,
    matchConfig = true,
    matchIdentity = true,
  ): BoundProxyNodeInfoRequest {
    const matches = () => request.isCurrent()
      && active()
      && binding.generation === this.generation
      && (!matchIdentity || binding.identityKey === this.identityKey)
      && (!matchConfig || binding.configName === this.configName);
    return {
      ...binding,
      signal: request.signal,
      isCurrent: matches,
      finish: () => matches() && request.finish(),
    };
  }
}

export function publishProxyNodeInfoSettings<T>(
  lifecycle: ProxyNodeInfoLifecycle,
  request: BoundProxyNodeInfoRequest,
  resolveIdentity: (identityKey: string) => T | null,
) {
  if (!request.isCurrent()) return null;
  const identityKey = lifecycle.currentIdentityKey();
  if (identityKey == null) return null;
  return { identityKey, selected: resolveIdentity(identityKey) };
}

export class ProxyNodeInfoLifecycleHost {
  private active: ProxyNodeInfoLifecycle | null = null;

  setup() {
    this.active?.dispose();
    const lifecycle = new ProxyNodeInfoLifecycle();
    this.active = lifecycle;
    return {
      lifecycle,
      cleanup: () => {
        lifecycle.dispose();
        if (this.active === lifecycle) this.active = null;
      },
    };
  }

  current() {
    return this.active;
  }
}

export async function saveBoundProxyNodeInfo<T>(
  lifecycle: ProxyNodeInfoLifecycle,
  binding: ProxyNodeInfoBinding | null,
  save: () => Promise<T>,
) {
  if (!lifecycle.isCurrent(binding)) return null;
  return save();
}
