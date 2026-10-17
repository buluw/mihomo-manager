import { LatestRequestController, type LatestRequest } from "../../shared/requestLifecycle.ts"

export class ConfigReconciliationLifecycle {
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

  begin(): LatestRequest | null {
    return this.current?.begin() ?? null
  }
}

export class ConfigPublishEpoch {
  private revision = 0

  begin() {
    const revision = ++this.revision
    return { isCurrent: () => revision === this.revision }
  }

  observe() {
    const revision = this.revision
    return { isCurrent: () => revision === this.revision }
  }

  invalidate() {
    this.revision += 1
  }
}

type CoordinatorSession = {
  epoch: ConfigPublishEpoch
  foreground: number
  pendingBackground: boolean
  background: ConfigBackgroundHandle | null
  outstandingDrain: ConfigDrainTicket | null
}

type ConfigBackgroundHandle = {
  isCurrent: () => boolean
  finish: () => ConfigDrainTicket | null
}

export type ConfigDrainTicket = {
  readonly session: object
  consumed: boolean
}

export class ConfigPublishCoordinator {
  private current: CoordinatorSession | null = null

  setup() {
    this.current?.epoch.invalidate()
    if (this.current) this.current.pendingBackground = false
    this.current = {
      epoch: new ConfigPublishEpoch(),
      foreground: 0,
      pendingBackground: false,
      background: null,
      outstandingDrain: null,
    }
    const session = this.current
    return () => {
      session.epoch.invalidate()
      session.pendingBackground = false
      session.background = null
      session.outstandingDrain = null
      if (this.current === session) this.current = null
    }
  }

  beginForeground() {
    const session = this.current
    if (!session) return null
    if (session.background) session.pendingBackground = true
    this.invalidateOutstandingDrain(session, true)
    session.foreground += 1
    const token = session.epoch.begin()
    let finished = false
    return {
      isCurrent: token.isCurrent,
      finish: () => {
        if (finished || this.current !== session) return null
        finished = true
        session.foreground = Math.max(0, session.foreground - 1)
        return this.drainTicket(session)
      },
    }
  }

  beginBackground(blocked = false) {
    const session = this.current
    if (!session) return null
    if (blocked || session.foreground > 0) {
      if (session.background?.isCurrent()) session.epoch.invalidate()
      this.invalidateOutstandingDrain(session, true)
      session.pendingBackground = true
      return null
    }
    this.invalidateOutstandingDrain(session, false)
    session.pendingBackground = false
    const token = session.epoch.begin()
    let finished = false
    const handle = {
      isCurrent: token.isCurrent,
      finish: () => {
        if (finished || this.current !== session) return null
        finished = true
        if (session.background === handle) session.background = null
        return this.drainTicket(session)
      },
    }
    session.background = handle
    return handle
  }

  observe() {
    return this.current?.epoch.observe() ?? null
  }

  invalidate() {
    const session = this.current
    if (!session) return
    if (session.background) session.pendingBackground = true
    session.epoch.invalidate()
  }

  consumeDrain(ticket: ConfigDrainTicket) {
    const session = this.current
    if (
      ticket.consumed ||
      session !== ticket.session ||
      session.outstandingDrain !== ticket
    ) return false
    ticket.consumed = true
    session.outstandingDrain = null
    return true
  }

  private drainTicket(session: CoordinatorSession): ConfigDrainTicket | null {
    if (
      this.current !== session ||
      session.foreground > 0 ||
      session.background ||
      !session.pendingBackground
    ) return null
    session.pendingBackground = false
    const ticket = { session, consumed: false }
    session.outstandingDrain = ticket
    return ticket
  }

  private invalidateOutstandingDrain(session: CoordinatorSession, preservePending: boolean) {
    if (!session.outstandingDrain) return
    session.outstandingDrain.consumed = true
    session.outstandingDrain = null
    if (preservePending) session.pendingBackground = true
  }
}
