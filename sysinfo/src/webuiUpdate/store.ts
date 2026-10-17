import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class UpdateStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}
  async read<T>(fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(this.path, "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
  }
  write(value: unknown): Promise<void> {
    const text = JSON.stringify(value) + "\n";
    const next = this.queue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.path + ".tmp", text, { mode: 0o600 });
      await rename(this.path + ".tmp", this.path);
    });
    this.queue = next;
    return next;
  }
}
