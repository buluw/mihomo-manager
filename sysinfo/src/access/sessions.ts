import { createHash, randomBytes } from "node:crypto";
import { AccessError, AccessStore, passwordHash, verifyPassword, type AccessConfig } from "./store.js";

export const SESSION_SECONDS = 12 * 60 * 60;
export const COOKIE_NAME = "mihomo_access";
type Session = { expiresAt: number; timer: NodeJS.Timeout };
export type Identity = { key: string | null; expiresAt: number | null };

function cookieKey(cookie: string | undefined): string | null {
  const token = cookie?.split(";").map(item => item.trim()).find(item => item.startsWith(COOKIE_NAME + "="))?.slice(COOKIE_NAME.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? createHash("sha256").update(token).digest("hex") : null;
}

export class AccessSessions {
  private config: AccessConfig | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly connections = new Map<() => void, string | null>();
  private queue = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(private readonly store = new AccessStore(), private readonly lifetimeMs = SESSION_SECONDS * 1000) {
    this.ready = store.read().then(config => { this.config = config; }).catch(() => {});
  }
  private settings(): AccessConfig {
    if (!this.config) throw new AccessError("access_unavailable", 503);
    return this.config;
  }
  authorize(cookie?: string): Identity {
    if (!this.settings().enabled) return { key: null, expiresAt: null };
    const key = cookieKey(cookie);
    const session = key ? this.sessions.get(key) : undefined;
    if (!key || !session) throw new AccessError("access_required", 401);
    if (session.expiresAt <= Date.now()) { this.revoke(key); throw new AccessError("access_required", 401); }
    return { key, expiresAt: session.expiresAt };
  }
  status(cookie?: string) {
    const enabled = this.settings().enabled;
    try { return { enabled, authenticated: true, expiresAt: this.authorize(cookie).expiresAt }; }
    catch (error) { if (error instanceof AccessError && error.status === 401) return { enabled, authenticated: false, expiresAt: null }; throw error; }
  }
  private create() {
    const token = randomBytes(32).toString("hex");
    const key = createHash("sha256").update(token).digest("hex");
    const expiresAt = Date.now() + this.lifetimeMs;
    const timer = setTimeout(() => this.revoke(key), this.lifetimeMs);
    timer.unref();
    this.sessions.set(key, { expiresAt, timer });
    return token;
  }
  private revoke(key: string) {
    const session = this.sessions.get(key);
    if (session) clearTimeout(session.timer);
    this.sessions.delete(key);
    for (const [close, owner] of this.connections) if (owner === key) { this.connections.delete(close); close(); }
  }
  private revokeAll() {
    for (const session of this.sessions.values()) clearTimeout(session.timer);
    this.sessions.clear();
    const close = [...this.connections.keys()];
    this.connections.clear();
    close.forEach(callback => callback());
  }
  watch(cookie: string | undefined, close: () => void): () => void {
    const identity = this.authorize(cookie);
    this.connections.set(close, identity.key);
    return () => { this.connections.delete(close); };
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { await this.ready; return await action(); } finally { release(); }
  }
  login(password: unknown) {
    return this.exclusive(async () => {
      const config = this.settings();
      if (!config.enabled) return null;
      if (!await verifyPassword(password, config.password)) throw new AccessError("invalid_credentials", 401);
      return this.create();
    });
  }
  update(cookie: string | undefined, operation: "enable" | "password" | "disable", currentPassword: unknown, nextPassword: unknown) {
    return this.exclusive(async () => {
      this.authorize(cookie);
      const previous = this.settings();
      if (operation === "enable" ? previous.enabled : !previous.enabled) throw new AccessError("access_state_changed", 409);
      if (previous.enabled && !await verifyPassword(currentPassword, previous.password)) throw new AccessError("invalid_credentials", 401);
      const next: AccessConfig = { version: 1, enabled: operation !== "disable", password: operation === "disable" ? null : await passwordHash(nextPassword) };
      await this.store.save(next);
      this.config = next;
      this.revokeAll();
      return operation === "enable" ? this.create() : null;
    });
  }
  logout(cookie?: string) {
    const key = cookieKey(cookie);
    if (key) this.revoke(key);
  }
  dispose() { this.revokeAll(); }
}
