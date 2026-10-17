import type { editor as MonacoEditor } from "monaco-editor"

// Keep Monaco's own container within the keyboard's visible area. Its parent
// retains the normal workspace height so dismissing the keyboard restores it.
export function registerMonacoViewport(editor: MonacoEditor.IStandaloneCodeEditor) {
  const viewport = window.visualViewport
  if (!viewport || !window.matchMedia("(pointer: coarse)").matches) {
    return { dispose() {} }
  }
  const container = editor.getContainerDomNode()
  const originalMaxHeight = container.style.maxHeight
  let keyboardVisible = false
  let revealInput = false
  let frame = 0

  const layout = () => {
    frame = 0
    const keyboardNow = viewport.scale === 1 && window.innerHeight - viewport.height > 100
    const opened = keyboardNow && !keyboardVisible
    if (keyboardVisible && !keyboardNow && viewport.scale === 1) {
      // Android keeps EditContext focused after Back closes the IME. Release
      // only this editor's focus so the next swipe cannot reopen the keyboard.
      const active = document.activeElement as HTMLElement | null
      if (active && container.contains(active)) active.blur()
    }
    keyboardVisible = keyboardNow
    container.style.maxHeight = keyboardNow
      ? Math.max(0, viewport.offsetTop + viewport.height - container.getBoundingClientRect().top) + "px"
      : originalMaxHeight
    editor.layout()
    if (editor.hasTextFocus() && (opened || (viewport.scale === 1 && revealInput))) {
      const position = editor.getPosition()
      if (position) editor.revealPositionInCenterIfOutsideViewport(position, 1)
    }
    revealInput = false
  }
  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(layout)
  }
  const followInput = () => {
    revealInput = editor.hasTextFocus()
    schedule()
  }
  const input = editor.onDidChangeModelContent(followInput)
  // Draft toolbars can change the workspace height after React commits input.
  // Observe the full-height wrapper, independent of our constrained container.
  const workspaceResize = new ResizeObserver(followInput)
  if (container.parentElement) workspaceResize.observe(container.parentElement)
  viewport.addEventListener("resize", schedule)
  viewport.addEventListener("scroll", schedule)
  window.addEventListener("resize", schedule)
  layout()
  return {
    dispose() {
      input.dispose()
      workspaceResize.disconnect()
      viewport.removeEventListener("resize", schedule)
      viewport.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
      if (frame) window.cancelAnimationFrame(frame)
      container.style.maxHeight = originalMaxHeight
    },
  }
}
