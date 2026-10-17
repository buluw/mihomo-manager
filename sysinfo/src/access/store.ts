import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type AccessConfig = { version: 1; enabled: boolean; password: { salt: string; hash: string } | null };
export class AccessError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, hash) => error ? reject(error) : resolve(hash)));
}

export async function passwordHash(value: unknown): Promise<NonNullable<AccessConfig["password"]>> {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) throw new AccessError("invalid_password");
  const salt = randomBytes(32).toString("hex");
  return { salt, hash: (await derive(value, salt)).toString("hex") };
}

export async function verifyPassword(value: unknown, stored: AccessConfig["password"]): Promise<boolean> {
  if (typeof value !== "string" || value.length > 128 || !stored) return false;
  return timingSafeEqual(await derive(value, stored.salt), Buffer.from(stored.hash, "hex"));
}

export class AccessStore {
  constructor(private readonly directory = process.env.ACCESS_DATA_DIR ?? "/var/lib/mihomo-manager/access") {}
  async read(): Promise<AccessConfig> {
    let data: unknown;
    try { data = JSON.parse(await readFile(join(this.directory, "settings.json"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AccessError("access_unavailable", 503);
      const initialized = await stat(join(this.directory, ".initialized")).then(() => true, error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new AccessError("access_unavailable", 503);
      });
      if (initialized) throw new AccessError("access_unavailable", 503);
      const initial: AccessConfig = { version: 1, enabled: false, password: null };
      await this.save(initial);
      data = initial;
    }
    const value = data as AccessConfig | null;
    if (!value || value.version !== 1 || typeof value.enabled !== "boolean"
      || (value.enabled ? !value.password || !/^[a-f0-9]{64}$/.test(value.password.salt) || !/^[a-f0-9]{128}$/.test(value.password.hash) : value.password !== null)) {
      throw new AccessError("access_unavailable", 503);
    }
    try { await writeFile(join(this.directory, ".initialized"), "1\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new AccessError("access_unavailable", 503); }
    return value;
  }
  async save(config: AccessConfig): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(join(this.directory, "settings.json.tmp"), JSON.stringify(config) + "\n", { mode: 0o600 });
      await rename(join(this.directory, "settings.json.tmp"), join(this.directory, "settings.json"));
    } catch { throw new AccessError("access_unavailable", 503); }
  }
}
