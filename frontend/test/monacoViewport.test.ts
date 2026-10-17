import assert from "node:assert/strict"
import test from "node:test"
import { registerMonacoViewport } from "../src/components/patterns/monacoViewport.ts"

test("mobile editor follows keyboard visibility without following browsing scroll", () => {
  const viewport = Object.assign(new EventTarget(), { height: 660, offsetTop: 0, scale: 1 })
  let frame: (() => void) | undefined
  let change: (() => void) | undefined
  let focused = true
  let blurs = 0
  let reveals = 0
  let layouts = 0
  let top = 114
  let resizeWorkspace: (() => void) | undefined
  const active = { blur() { focused = false; blurs++ } }
  const container = {
    style: { maxHeight: "" },
    contains: (element: unknown) => element === active,
    parentElement: {},
    getBoundingClientRect: () => ({ top }),
  }
  const browser = Object.assign(new EventTarget(), {
    visualViewport: viewport,
    innerHeight: 660,
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: (callback: () => void) => { frame = callback; return 1 },
    cancelAnimationFrame: () => { frame = undefined },
  })
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver")
  const doc = { activeElement: active as unknown }
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser })
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc })
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
    constructor(callback: () => void) { resizeWorkspace = callback }
    observe() {}
    disconnect() { resizeWorkspace = undefined }
  } })
  const flush = () => { const callback = frame; frame = undefined; callback?.() }
  const resize = (height: number) => { viewport.height = height; viewport.dispatchEvent(new Event("resize")); flush() }
  try {
    const editor = {
      getContainerDomNode: () => container,
      hasTextFocus: () => focused,
      getPosition: () => ({ lineNumber: 30, column: 1 }),
      layout: () => { layouts++ },
      revealPositionInCenterIfOutsideViewport: () => { reveals++ },
      onDidChangeModelContent: (callback: () => void) => {
        change = callback
        return { dispose() { change = undefined } }
      },
    } as unknown as Parameters<typeof registerMonacoViewport>[0]
    const registration = registerMonacoViewport(editor)
    resize(392)
    assert.equal(container.style.maxHeight, "278px")
    assert.equal(reveals, 1, "opening the keyboard keeps the input line visible")
    change?.(); flush()
    assert.equal(reveals, 2, "typing or a newline reveals the current input line")
    top = 206
    resizeWorkspace?.(); flush()
    assert.equal(container.style.maxHeight, "186px", "draft toolbar resizing keeps input above the keyboard")
    assert.equal(reveals, 3)
    viewport.dispatchEvent(new Event("scroll")); flush()
    assert.equal(reveals, 3, "browsing does not pull the editor back to its cursor")
    resize(440)
    assert.equal(blurs, 0, "IME candidate bar changes keep input focus")
    resize(660)
    assert.equal(blurs, 1, "manual keyboard dismissal releases retained input focus")
    assert.equal(container.style.maxHeight, "")
    resize(640)
    assert.equal(blurs, 1, "browser toolbar changes are not keyboard dismissal")
    focused = true
    resize(392)
    assert.equal(reveals, 4, "a deliberate tap can resume input")
    doc.activeElement = {}
    resize(660)
    assert.equal(blurs, 1, "another control keeps its focus")
    top = 114
    resizeWorkspace?.(); flush()
    assert.equal(reveals, 5, "draft toolbar resizing keeps a focused input visible without a software keyboard")
    change?.(); flush()
    assert.equal(reveals, 6, "hardware keyboard input keeps its line visible")
    focused = false
    resizeWorkspace?.(); flush()
    assert.equal(reveals, 6, "layout changes preserve the browsing position when input is not focused")
    viewport.scale = 2
    resize(330)
    assert.equal(container.style.maxHeight, "", "pinch zoom does not count as a keyboard")
    viewport.dispatchEvent(new Event("resize"))
    const beforeDispose = layouts
    registration.dispose()
    flush(); resize(392)
    assert.equal(layouts, beforeDispose)
    assert.equal(change, undefined)
    assert.equal(resizeWorkspace, undefined)
    assert.equal(container.style.maxHeight, "")
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument)
    else Reflect.deleteProperty(globalThis, "document")
    if (previousObserver) Object.defineProperty(globalThis, "ResizeObserver", previousObserver)
    else Reflect.deleteProperty(globalThis, "ResizeObserver")
  }
})
