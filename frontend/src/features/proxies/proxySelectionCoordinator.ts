export type ProxySelectionResult = {
  success: boolean
  latest: boolean
  confirmed: string
  confirmedPreference?: string | null
  error?: unknown
}

type ProxySelectionPreference = {
  key: string
  current: string | null
}

export class ProxySelectionCoordinator {
  private readonly revisions: Record<string, number> = {}
  private readonly confirmed: Record<string, string> = {}
  private readonly queues: Record<string, Promise<void>> = {}
  private readonly pending: Record<string, { revision: number; selection: string }> = {}
  private readonly confirmedPreferences = new Map<string, string | null>()

  synchronize(group: string, selection: string) {
    this.confirmed[group] = selection
  }

  pendingSelection(group: string) {
    return this.pending[group]?.selection ?? null
  }

  pendingSelections() {
    return Object.fromEntries(
      Object.entries(this.pending).map(([group, pending]) => [group, pending.selection])
    )
  }

  enqueue(
    group: string,
    selection: string,
    commit: () => Promise<unknown>,
    preference?: ProxySelectionPreference,
  ) {
    const revision = (this.revisions[group] || 0) + 1
    this.revisions[group] = revision
    this.pending[group] = { revision, selection }
    if (preference && !this.confirmedPreferences.has(preference.key)) {
      this.confirmedPreferences.set(preference.key, preference.current)
    }
    const previous = this.queues[group] ?? Promise.resolve()
    const operation = previous.then(commit).then(() => undefined)
    const tail = operation.catch(() => undefined)
    this.queues[group] = tail

    const result = operation
      .then<ProxySelectionResult, ProxySelectionResult>(
        () => {
          this.confirmed[group] = selection
          if (preference) this.confirmedPreferences.set(preference.key, selection)
          return {
            success: true,
            latest: this.revisions[group] === revision,
            confirmed: selection,
            confirmedPreference: preference
              ? this.confirmedPreferences.get(preference.key)
              : undefined,
          }
        },
        (error) => ({
          success: false,
          latest: this.revisions[group] === revision,
          confirmed: this.confirmed[group] || "",
          confirmedPreference: preference
            ? this.confirmedPreferences.get(preference.key)
            : undefined,
          error,
        })
      )
      .finally(() => {
        if (this.queues[group] === tail) delete this.queues[group]
        if (this.pending[group]?.revision === revision) delete this.pending[group]
      })

    return { revision, result }
  }
}
