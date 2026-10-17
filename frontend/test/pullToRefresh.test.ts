import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { canStartPullRefresh, registerPullRefresh } from "../src/app/pullRefreshGesture.ts"

function fixture(t: TestContext) {
  let mobile = true
  const nodes: TestElement[] = []
  const view = { innerHeight: 660, visualViewport: { height: 660 }, matchMedia: () => ({ matches: mobile }),
    getComputedStyle: (node: TestElement) => node.style }
  const doc = { defaultView: view, activeElement: null as TestElement | null,
    querySelectorAll: (selector: string) => nodes.filter(node => node.matches(selector)) }
  class TestElement extends EventTarget {
    parentElement: TestElement | null = null
    ownerDocument = doc
    selectors = new Set<string>()
    style = { overflowY: "visible", touchAction: "auto" }
    scrollTop = 0
    scrollHeight = 100
    clientHeight = 100
    visible = true
    constructor(parent?: TestElement, selector?: string) {
      super(); this.parentElement = parent ?? null
      if (selector) this.selectors.add(selector)
      nodes.push(this)
    }
    matches(selector: string) { return selector.split(",").some(part => this.selectors.has(part.trim())) }
    closest(selector: string): TestElement | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null }
    hasAttribute(name: string) { return this.selectors.has("[" + name + "]") }
    getClientRects() { return this.visible ? [{}] : [] }
    contains(target: TestElement): boolean { return target === this || Boolean(target.parentElement && this.contains(target.parentElement)) }
    querySelectorAll(selector: string) { return nodes.filter(node => this.contains(node) && node.matches(selector)) }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Element")
  Object.defineProperty(globalThis, "Element", { configurable: true, value: TestElement })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "Element", previous)
    else Reflect.deleteProperty(globalThis, "Element")
  })
  const root = new TestElement()
  const page = new TestElement(root, "[data-page-scroll]")
  const body = new TestElement(page)
  const allowed = (target = body) => canStartPullRefresh(root as unknown as HTMLElement, target as unknown as Element)
  const touch = (type: string, x: number, y: number, count = 1) => {
    const event = new Event(type, { cancelable: true })
    Object.defineProperty(event, "target", { value: body })
    Object.assign(event, { touches: Array.from({ length: count }, () => ({ clientX: x, clientY: y })) })
    root.dispatchEvent(event)
    return event.defaultPrevented
  }
  return { root, page, body, doc, view, TestElement, allowed, touch, desktop: () => { mobile = false } }
}

test("pull refresh keeps independent scrolling, overlays, dragging and input gestures", t => {
  const f = fixture(t)
  assert.equal(f.allowed(), true)
  f.page.scrollTop = 20
  assert.equal(f.allowed(), false)
  assert.equal(f.allowed(new f.TestElement(f.root)), false, "a workspace header cannot refresh a scrolled main list")
  f.page.scrollTop = 0
  const nested = new f.TestElement(f.body)
  nested.style.overflowY = "auto"; nested.scrollHeight = 500
  assert.equal(f.allowed(nested), false)
  for (const selector of [".monaco-editor", "[data-pull-refresh=ignore]", "input", "textarea", "[draggable=true]", "[role=slider]"]) {
    assert.equal(f.allowed(new f.TestElement(f.body, selector)), false, selector)
  }
  const drag = new f.TestElement(f.body)
  drag.style.touchAction = "none"
  assert.equal(f.allowed(drag), false)
  f.doc.activeElement = new f.TestElement(undefined, "input")
  assert.equal(f.allowed(), false)
  f.doc.activeElement = null
  f.view.visualViewport.height = 390
  assert.equal(f.allowed(), false)
  f.view.visualViewport.height = 660
  const dialog = new f.TestElement(undefined, '[role="dialog"]')
  assert.equal(f.allowed(), false)
  dialog.visible = false
  assert.equal(f.allowed(), true)
  f.desktop()
  assert.equal(f.allowed(), false)
})

test("release threshold triggers once, short pulls settle, and disposal releases listeners", async t => {
  const f = fixture(t)
  let distance = 0, calls = 0, busy = false
  let finish: (() => void) | undefined
  const registration = registerPullRefresh(f.root as unknown as HTMLElement, {
    isRefreshing: () => busy,
    onDistance: value => { distance = value },
    onRefresh: () => { calls++; return new Promise<void>(resolve => { finish = resolve }) },
  })
  const pull = (dy: number) => { f.touch("touchstart", 100, 100); f.touch("touchmove", 100, 100 + dy); f.touch("touchend", 100, 100 + dy) }
  pull(60)
  await Promise.resolve()
  assert.equal(calls, 0); assert.equal(distance, 0)
  f.touch("touchstart", 100, 100)
  assert.equal(f.touch("touchmove", 160, 110), false, "horizontal gestures remain native")
  f.touch("touchend", 160, 110)
  pull(160)
  await Promise.resolve()
  assert.equal(calls, 1); assert.equal(distance, 0)
  pull(160)
  await Promise.resolve()
  assert.equal(calls, 1, "the in-flight gesture lock is immediate")
  finish?.(); await new Promise(resolve => setImmediate(resolve))
  busy = true; pull(160); await Promise.resolve()
  assert.equal(calls, 1, "menu refresh shares the busy guard")
  busy = false
  f.touch("touchstart", 100, 100); f.touch("touchmove", 100, 260); f.touch("touchcancel", 100, 260)
  f.touch("touchend", 100, 260); await Promise.resolve()
  assert.equal(calls, 1); assert.equal(distance, 0)
  f.touch("touchstart", 100, 100); f.touch("touchmove", 100, 260, 2); f.touch("touchend", 100, 260)
  await Promise.resolve(); assert.equal(calls, 1)
  pull(160); await Promise.resolve(); assert.equal(calls, 2)
  finish?.(); await new Promise(resolve => setImmediate(resolve))
  registration.dispose()
  pull(160); await Promise.resolve(); assert.equal(calls, 2)
})
