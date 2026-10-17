import type { ConfigFileRecord, ConfigSnapshot } from "../../api/configClient.ts"

type SnapshotLoader = (name: string, signal: AbortSignal) => Promise<ConfigSnapshot>

type PendingSnapshot = {
  name: string
  sha256: string
  controller: AbortController
  promise: Promise<ConfigSnapshot>
}

export class ConfigSnapshotVersionError extends Error {
  constructor() {
    super("配置文件在读取期间发生变化")
  }
}

function requestKey(name: string, sha256: string) {
  return `${name}\u0000${sha256}`
}

export class ConfigSnapshotSession {
  private readonly pending = new Map<string, PendingSnapshot>()
  readonly snapshots: Map<string, ConfigSnapshot>

  constructor(snapshots = new Map<string, ConfigSnapshot>()) {
    this.snapshots = snapshots
  }

  get(file: Pick<ConfigFileRecord, "name" | "sha256">) {
    const snapshot = this.snapshots.get(file.name)
    return snapshot?.sha256 === file.sha256 ? snapshot : null
  }

  put(snapshot: ConfigSnapshot) {
    this.snapshots.set(snapshot.name, snapshot)
    return snapshot
  }

  read(file: Pick<ConfigFileRecord, "name" | "sha256">, loader: SnapshotLoader) {
    const cached = this.get(file)
    if (cached) return Promise.resolve(cached)

    const key = requestKey(file.name, file.sha256)
    const current = this.pending.get(key)
    if (current) return current.promise

    const controller = new AbortController()
    const pending = {} as PendingSnapshot
    const promise = loader(file.name, controller.signal)
      .then((snapshot) => {
        if (snapshot.name !== file.name || snapshot.sha256 !== file.sha256) {
          throw new ConfigSnapshotVersionError()
        }
        return this.put(snapshot)
      })
      .finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key)
      })
    Object.assign(pending, {
      name: file.name,
      sha256: file.sha256,
      controller,
      promise,
    })
    this.pending.set(key, pending)
    return promise
  }

  reconcile(files: Array<Pick<ConfigFileRecord, "name" | "sha256">>) {
    const versions = new Map(files.map((file) => [file.name, file.sha256]))
    for (const [name, snapshot] of this.snapshots) {
      if (versions.get(name) !== snapshot.sha256) this.snapshots.delete(name)
    }
    for (const [key, request] of this.pending) {
      if (versions.get(request.name) === request.sha256) continue
      request.controller.abort()
      this.pending.delete(key)
    }
  }

  invalidate(name: string) {
    this.snapshots.delete(name)
    for (const [key, request] of this.pending) {
      if (request.name !== name) continue
      request.controller.abort()
      this.pending.delete(key)
    }
  }

  cancelPending() {
    this.pending.forEach((request) => request.controller.abort())
    this.pending.clear()
  }
}
