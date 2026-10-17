// Monaco 0.55.1 accepts movement below 30px as a tap. Keep its scrolling
// and selection handlers, but stop a moved finger from focusing text input.
export function registerMonacoTouch(editorNode: HTMLElement) {
  let touch: { id: number; x: number; y: number; moved: boolean } | null = null
  const start = (event: PointerEvent) => {
    touch = event.pointerType === "touch"
      ? { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
      : null
  }
  const move = (event: PointerEvent) => {
    if (touch?.id === event.pointerId && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 8) {
      touch.moved = true
    }
  }
  const cancel = () => { if (touch) touch.moved = true }
  const tap = (event: Event) => {
    if (!touch?.moved) return
    event.preventDefault()
    event.stopPropagation()
  }
  editorNode.addEventListener("pointerdown", start, { capture: true })
  editorNode.addEventListener("pointermove", move, { capture: true })
  editorNode.addEventListener("pointercancel", cancel, { capture: true })
  editorNode.addEventListener("-monaco-gesturetap", tap, { capture: true })
  return {
    dispose: () => {
      editorNode.removeEventListener("pointerdown", start, { capture: true })
      editorNode.removeEventListener("pointermove", move, { capture: true })
      editorNode.removeEventListener("pointercancel", cancel, { capture: true })
      editorNode.removeEventListener("-monaco-gesturetap", tap, { capture: true })
    },
  }
}
