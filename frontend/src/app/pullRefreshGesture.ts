export const PULL_REFRESH_THRESHOLD = 64

const inputSelector = "input, textarea, select, [contenteditable=true], .native-edit-context"
const gestureSelector = inputSelector + ", .monaco-editor, [data-pull-refresh=ignore], [draggable=true], [role=slider]"

export function canStartPullRefresh(root: HTMLElement, target: Element) {
  const doc = root.ownerDocument
  const view = doc.defaultView!
  if (!view.matchMedia("(max-width: 767px) and (pointer: coarse)").matches) return false
  if (!root.contains(target) || target.closest(gestureSelector)) return false
  if (doc.activeElement?.matches(inputSelector)) return false
  if (view.visualViewport && view.innerHeight - view.visualViewport.height > 100) return false
  if ([...doc.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]')].some(node => node.getClientRects().length)) return false
  if ([...root.querySelectorAll<HTMLElement>("[data-page-scroll]")].some(node => node.getClientRects().length && node.scrollTop > 1)) return false
  for (let node: Element | null = target; node && node !== root; node = node.parentElement) {
    const style = view.getComputedStyle(node)
    if (style.touchAction === "none") return false
    if (node.hasAttribute("data-page-scroll")) continue
    if (/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return false
  }
  return true
}

export function registerPullRefresh(root: HTMLElement, options: {
  isRefreshing: () => boolean
  onRefresh: () => Promise<void>
  onDistance: (distance: number) => void
}) {
  let gesture: { x: number; y: number; target: Element; distance: number; claimed: boolean } | null = null
  let pending = false
  let disposed = false
  const reset = () => { gesture = null; if (!disposed) options.onDistance(0) }
  const start = (event: TouchEvent) => {
    reset()
    if (pending || options.isRefreshing() || event.touches.length !== 1 || !(event.target instanceof Element)) return
    if (!canStartPullRefresh(root, event.target)) return
    const point = event.touches[0]
    gesture = { x: point.clientX, y: point.clientY, target: event.target, distance: 0, claimed: false }
  }
  const move = (event: TouchEvent) => {
    if (!gesture) return
    if (event.touches.length !== 1 || options.isRefreshing() || !canStartPullRefresh(root, gesture.target)) { reset(); return }
    const point = event.touches[0]
    const dx = point.clientX - gesture.x
    const dy = point.clientY - gesture.y
    if (!gesture.claimed) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      if (dy <= 0 || Math.abs(dx) >= dy) { reset(); return }
      gesture.claimed = true
    }
    if (!event.cancelable) { reset(); return }
    event.preventDefault()
    gesture.distance = Math.min(80, Math.max(0, dy) / 2)
    options.onDistance(gesture.distance)
  }
  const end = (event: TouchEvent) => {
    if (!gesture) return
    if (gesture.claimed) event.preventDefault()
    const ready = gesture.distance >= PULL_REFRESH_THRESHOLD && canStartPullRefresh(root, gesture.target)
    reset()
    if (!ready || pending || options.isRefreshing()) return
    pending = true
    // Feature handlers own data and error feedback; the gesture owns only its
    // trigger lock, including the interval before React publishes busy.
    const finish = () => { pending = false }
    Promise.resolve().then(() => disposed ? undefined : options.onRefresh()).then(finish, finish)
  }
  root.addEventListener("touchstart", start, { capture: true, passive: true })
  root.addEventListener("touchmove", move, { capture: true, passive: false })
  root.addEventListener("touchend", end, { capture: true, passive: false })
  root.addEventListener("touchcancel", reset, { capture: true })
  root.addEventListener("dragstart", reset, { capture: true })
  return {
    dispose() {
      disposed = true
      gesture = null
      root.removeEventListener("touchstart", start, { capture: true })
      root.removeEventListener("touchmove", move, { capture: true })
      root.removeEventListener("touchend", end, { capture: true })
      root.removeEventListener("touchcancel", reset, { capture: true })
      root.removeEventListener("dragstart", reset, { capture: true })
    },
  }
}
