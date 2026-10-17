import { LatestRequestController, type LatestRequest } from "../../shared/requestLifecycle.ts"

export class RuleRequestLifecycle {
  private current: LatestRequestController | null = null

  setup() {
    this.current?.dispose()
    const session = new LatestRequestController()
    this.current = session

    return () => {
      session.dispose()
      if (this.current === session) this.current = null
    }
  }

  begin(blocked = false): LatestRequest | null {
    if (blocked) return null
    return this.current?.begin() ?? null
  }

  cancel() {
    this.current?.cancel()
  }
}
