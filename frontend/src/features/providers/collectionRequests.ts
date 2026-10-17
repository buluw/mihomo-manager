import {
  AbortableRequestPool,
  LatestRequestController,
} from "../../shared/requestLifecycle.ts"
import type { ProviderCategory } from "./collectionViewModel.ts"

export class CollectionRequestController {
  private readonly categories: Record<ProviderCategory, LatestRequestController> = {
    proxy: new LatestRequestController(),
    rule: new LatestRequestController(),
  }
  private readonly actions = new AbortableRequestPool()
  private batch: AbortController | null = null

  get batchRunning() {
    return this.batch !== null
  }

  beginBatch(onFinish: () => void) {
    if (this.batch) return null
    const controller = this.actions.begin()
    if (controller.signal.aborted) return null
    this.batch = controller
    const finish = () => {
      if (this.batch !== controller) return
      this.batch = null
      controller.signal.removeEventListener("abort", finish)
      this.actions.finish(controller)
      onFinish()
    }
    controller.signal.addEventListener("abort", finish, { once: true })
    return { signal: controller.signal, finish }
  }

  beginCategory(category: ProviderCategory) {
    return this.categories[category].begin()
  }

  beginAction() {
    return this.actions.begin()
  }

  finishAction(controller: AbortController) {
    this.actions.finish(controller)
  }

  dispose() {
    this.categories.proxy.dispose()
    this.categories.rule.dispose()
    this.actions.dispose()
  }
}
