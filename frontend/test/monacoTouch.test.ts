import assert from "node:assert/strict"
import test from "node:test"
import { registerMonacoTouch } from "../src/components/patterns/monacoTouch.ts"

test("Monaco touch keeps short drags as scrolling and permits deliberate taps", () => {
  const node = new EventTarget()
  const listener = registerMonacoTouch(node as HTMLElement)
  const pointer = (type: string, x: number, y: number, pointerType = "touch") => {
    node.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, pointerType, clientX: x, clientY: y }))
  }
  const tap = () => {
    const event = new Event("-monaco-gesturetap", { cancelable: true })
    node.dispatchEvent(event)
    return event.defaultPrevented
  }
  pointer("pointerdown", 100, 200)
  pointer("pointermove", 100, 180)
  assert.equal(tap(), true)
  pointer("pointermove", 100, 200)
  assert.equal(tap(), true, "returning to the start does not turn a scroll into a tap")
  pointer("pointerdown", 100, 200)
  pointer("pointermove", 102, 198)
  assert.equal(tap(), false, "ordinary finger jitter still allows editing")
  pointer("pointerdown", 100, 200, "mouse")
  pointer("pointermove", 100, 180, "mouse")
  assert.equal(tap(), false)
  pointer("pointerdown", 100, 200)
  pointer("pointercancel", 100, 200)
  assert.equal(tap(), true)
  listener.dispose()
  assert.equal(tap(), false, "disposal releases the gesture guard")
})
