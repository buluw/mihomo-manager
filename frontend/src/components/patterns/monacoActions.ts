type ShortcutEditor = {
  addAction: (action: {
    id: string; label: string; keybindings: number[]; keybindingContext: string; run: () => void
    contextMenuGroupId?: string; contextMenuOrder?: number
  }) => { dispose: () => void }
  getAction: (id: string) => { run: () => unknown } | null
  getRawOptions: () => { wordWrap?: "off" | "on" | "wordWrapColumn" | "bounded" }
  updateOptions: (options: { wordWrap: "off" | "on" }) => void
  onDidChangeConfiguration: (listener: () => void) => { dispose: () => void }
}

export function disableMonacoCommandPalette(
  editor: Pick<ShortcutEditor, "addAction"> & { getContribution: (id: string) => unknown },
  monaco: { KeyCode: { F1: number } },
) {
  // Monaco 0.55.1 has no public API for removing one built-in context-menu item.
  // Filter its native contribution; keep native grouping, labels and menu behavior.
  const contextMenu = editor.getContribution("editor.contrib.contextmenu") as {
    _getMenuActions: (...args: unknown[]) => { id: string }[]
  }
  const getMenuActions = contextMenu._getMenuActions
  contextMenu._getMenuActions = function (...args) {
    const actions = getMenuActions.apply(this, args).filter((action) => action.id !== "editor.action.quickCommand")
    while (actions.at(-1)?.id === "vs.actions.separator") actions.pop()
    return actions
  }
  const action = editor.addAction({
    id: "editor.action.quickCommand", label: "命令面板",
    keybindings: [monaco.KeyCode.F1], keybindingContext: "editorFocus", run: () => {},
  })
  return { dispose: () => { contextMenu._getMenuActions = getMenuActions; action.dispose() } }
}

export function registerMonacoWordWrapShortcut(
  editor: ShortcutEditor,
  monaco: { KeyMod: { Alt: number }; KeyCode: { KeyZ: number } },
) {
  let action: { dispose: () => void } | undefined
  let enabled: boolean | undefined
  const syncAction = () => {
    const next = (editor.getRawOptions().wordWrap ?? "off") !== "off"
    if (next === enabled) return
    enabled = next
    action?.dispose()
    action = editor.addAction({
      id: "mihomo.wordWrap", label: next ? "自动换行（已开启）" : "自动换行（已关闭）",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ], keybindingContext: "editorTextFocus",
      contextMenuGroupId: "2_view", contextMenuOrder: 1,
      run: () => editor.updateOptions({ wordWrap: (editor.getRawOptions().wordWrap ?? "off") === "off" ? "on" : "off" }),
    })
  }
  syncAction()
  const listener = editor.onDidChangeConfiguration(syncAction)
  return { dispose: () => { listener.dispose(); action?.dispose() } }
}

export function registerMonacoEditorShortcuts(
  editor: ShortcutEditor,
  monaco: {
    KeyMod: { CtrlCmd: number; Alt: number; Shift: number; chord: (a: number, b: number) => number }
    KeyCode: Record<string, number> & { KeyZ: number }
  },
  getOptions: () => {
    readOnly?: boolean
    language?: string
    onSave?: () => void
  } = () => ({}),
) {
  const actions = [registerMonacoWordWrapShortcut(editor, monaco)]
  const register = (keybinding: number, run: () => void) => {
    actions.push(editor.addAction({
      id: `mihomo.shortcut.${keybinding}`, label: "编辑器快捷键",
      keybindings: [keybinding], keybindingContext: "editorTextFocus", run,
    }))
  }
  register(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    if (!getOptions().readOnly) getOptions().onSave?.()
  })

  const runAction = (id: string) => void editor.getAction(id)?.run()
  const addCommand = (keybinding: number, action: string | (() => string), editsContent = false) => {
    register(keybinding, () => {
      if (editsContent && getOptions().readOnly) return
      runAction(typeof action === "function" ? action() : action)
    })
  }

  // 只读和可编辑均可用的浏览/搜索/跳转动作
  addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, "actions.find")
  addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, "editor.action.gotoLine")
  addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD, "editor.action.addSelectionToNextFindMatch")
  addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL, "editor.action.selectHighlights")
  addCommand(monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit0), "editor.foldAll")
  addCommand(monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ), "editor.unfoldAll")

  // Register once; the active model's current options decide whether editing runs.
  addCommand(monaco.KeyCode.Tab, "editor.action.indentLines", true)
  addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Tab, "editor.action.outdentLines", true)
  addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, "editor.action.copyLinesUpAction", true)
  addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, "editor.action.copyLinesDownAction", true)
  addCommand(monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, "editor.action.moveLinesUpAction", true)
  addCommand(monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, "editor.action.moveLinesDownAction", true)
  addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyK, "editor.action.deleteLines", true)
  addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, "editor.action.insertLineAfter", true)
  addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, "editor.action.insertLineBefore", true)
  addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash, "editor.action.commentLine", true)
  addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyA,
    () => getOptions().language === "yaml" ? "editor.action.commentLine" : "editor.action.blockComment", true)
  addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyU, "cursorUndo")
  addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH, "editor.action.startFindReplaceAction", true)
  addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.BracketLeft, "editor.action.outdentLines", true)
  addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.BracketRight, "editor.action.indentLines", true)

  return { dispose: () => actions.forEach((action) => action.dispose()) }
}
