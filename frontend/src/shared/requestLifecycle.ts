export type LatestRequest = {
  signal: AbortSignal
  isCurrent: () => boolean
  finish: () => boolean
}

export class LatestRequestController {
  private version = 0
  private disposed = false
  private active: { version: number; controller: AbortController } | null = null

  begin(): LatestRequest {
    if (this.disposed) {
      const controller = new AbortController()
      controller.abort()
      return {
        signal: controller.signal,
        isCurrent: () => false,
        finish: () => false,
      }
    }

    this.cancel()
    const active = {
      version: this.version,
      controller: new AbortController(),
    }
    this.active = active

    const isCurrent = () =>
      this.active === active &&
      active.version === this.version &&
      !active.controller.signal.aborted

    return {
      signal: active.controller.signal,
      isCurrent,
      finish: () => {
        if (!isCurrent()) return false
        this.active = null
        return true
      },
    }
  }

  cancel() {
    this.version += 1
    const active = this.active
    this.active = null
    active?.controller.abort()
  }

  dispose() {
    this.cancel()
    this.disposed = true
  }
}

export class AbortableRequestPool {
  private readonly controllers = new Set<AbortController>()
  private disposed = false

  begin() {
    const controller = new AbortController()
    if (this.disposed) controller.abort()
    else this.controllers.add(controller)
    return controller
  }

  finish(controller: AbortController) {
    this.controllers.delete(controller)
  }

  dispose() {
    this.disposed = true
    this.controllers.forEach((controller) => controller.abort())
    this.controllers.clear()
  }
}
