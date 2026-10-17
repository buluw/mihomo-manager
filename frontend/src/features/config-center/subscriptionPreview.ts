export type SubscriptionFilterPreview = {
  totalCount: number
  remainingCount: number
  matchedNames: string[]
}

export type SubscriptionPreviewTarget = {
  subscriptionId: string
  rules: string[]
  rulesVersion: string
}

type PreviewReader = (
  subscriptionId: string,
  rules: string[],
  signal: AbortSignal,
) => Promise<SubscriptionFilterPreview>

export function subscriptionPreviewIdentity(subscriptionId: string, rulesVersion: string) {
  return JSON.stringify([subscriptionId, rulesVersion])
}

export class SubscriptionPreviewSession {
  private active: {
    key: string
    controller: AbortController
    promise: Promise<SubscriptionFilterPreview>
  } | null = null

  start(target: SubscriptionPreviewTarget, reader: PreviewReader) {
    const key = subscriptionPreviewIdentity(target.subscriptionId, target.rulesVersion)
    if (this.active?.key === key) return null
    this.invalidate()
    const controller = new AbortController()
    const promise = reader(target.subscriptionId, target.rules, controller.signal)
    this.active = { key, controller, promise }
    return { key, promise }
  }

  isCurrent(key: string) {
    return this.active?.key === key && !this.active.controller.signal.aborted
  }

  finish(key: string) {
    if (this.active?.key !== key) return false
    this.active = null
    return true
  }

  invalidate() {
    this.active?.controller.abort()
    this.active = null
  }
}
