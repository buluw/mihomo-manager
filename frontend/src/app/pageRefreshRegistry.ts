export type PageRefreshHandler = () => void | Promise<void>

export class PageRefreshRegistry {
  private handler: PageRefreshHandler | null = null

  register(handler: PageRefreshHandler) {
    this.handler = handler
    return () => {
      if (this.handler === handler) this.handler = null
    }
  }

  async run() {
    await this.handler?.()
  }
}
