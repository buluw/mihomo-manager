import Editor, { loader, type Monaco, type OnMount } from "@monaco-editor/react"
import { useCallback, useEffect, useRef, useState } from "react"

import { getSystemTheme, useTheme } from "@/components/theme-provider"
import { disableMonacoCommandPalette, registerMonacoEditorShortcuts } from "./monacoActions"
import { registerMonacoYamlFormatting } from "./monacoYaml"
import { registerMonacoTouch } from "./monacoTouch"
import { registerMonacoViewport } from "./monacoViewport"

const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)"
const MOBILE_EDITOR_QUERY = "(max-width: 767px)"
// Keep the editor version aligned with the official locale loaded by index.html.
loader.config({ paths: { vs: "/assets/monaco-editor/0.55.1/vs" } })

export type EditorIssue = {
  line: number
  column: number
  endLine?: number
  endColumn?: number
  message: string
  severity: "error" | "warning"
}

type EditorLanguage = "yaml" | "json"

export function MonacoWorkspace({
  value,
  onChange,
  issues = [],
  ariaLabel,
  readOnly = false,
  language = "yaml",
  path,
  transientModels = false,
  onSave,
}: {
  value: string
  onChange?: (value: string) => void
  issues?: readonly EditorIssue[]
  ariaLabel: string
  readOnly?: boolean
  language?: EditorLanguage
  path?: string
  transientModels?: boolean
  onSave?: () => void
}) {
  const { theme } = useTheme()
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const syncingValueRef = useRef(false)
  const currentPropsRef = useRef({ readOnly, language, onSave, onChange, path, value })
  currentPropsRef.current = { readOnly, language, onSave, onChange, path, value }
  const [systemTheme, setSystemTheme] = useState(() => getSystemTheme())
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_EDITOR_QUERY).matches)
  const isDark = theme === "dark" || (theme === "system" && systemTheme === "dark")

  const handleChange = useCallback((nextValue: string | undefined) => {
    const current = currentPropsRef.current
    const model = editorRef.current?.getModel()
    if (syncingValueRef.current || current.readOnly || !model || nextValue === current.value) return
    if (current.path && model.uri.toString() !== monacoRef.current?.Uri.parse(current.path).toString()) return
    current.onChange?.(nextValue ?? "")
  }, [])

  // The wrapper resets read-only models even for equal values, losing restored scroll.
  const syncValue = useCallback(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    const monaco = monacoRef.current
    const current = currentPropsRef.current
    if (!editor || !model || !monaco || model.getValue() === current.value) return
    if (current.path && model.uri.toString() !== monacoRef.current?.Uri.parse(current.path).toString()) return
    const viewState = editor.saveViewState()
    const eol = current.value.includes("\r\n") ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF
    syncingValueRef.current = true
    try {
      // executeEdits preserves the model's EOL; align it before inserting source text.
      if (current.readOnly) model.setEOL(eol)
      else {
        editor.pushUndoStop()
        model.pushEOL(eol)
      }
      if (model.getValue() !== current.value) {
        if (current.readOnly) model.setValue(current.value)
        else editor.executeEdits("", [{ range: model.getFullModelRange(), text: current.value, forceMoveMarkers: true }])
      }
      if (!current.readOnly) editor.pushUndoStop()
    } finally {
      syncingValueRef.current = false
      if (viewState) editor.restoreViewState(viewState)
    }
  }, [])

  useEffect(() => { syncValue() }, [path, value, syncValue])

  useEffect(() => {
    const query = window.matchMedia(MOBILE_EDITOR_QUERY)
    const sync = () => setMobile(query.matches)
    query.addEventListener("change", sync)
    return () => query.removeEventListener("change", sync)
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia(SYSTEM_THEME_QUERY)
    const syncSystemTheme = () =>
      setSystemTheme(mediaQuery.matches ? "dark" : "light")
    syncSystemTheme()
    mediaQuery.addEventListener("change", syncSystemTheme)
    return () => mediaQuery.removeEventListener("change", syncSystemTheme)
  }, [])

  const applyMarkers = useCallback(
    (monaco: Monaco) => {
      const model = editorRef.current?.getModel()
      if (!model) return
      monaco.editor.setModelMarkers(
        model,
        "mihomo-manager",
        issues.map((issue) => ({
          startLineNumber: issue.line,
          startColumn: issue.column,
          endLineNumber: issue.endLine ?? issue.line,
          endColumn: issue.endColumn ?? issue.column + 8,
          message: issue.message,
          severity:
            issue.severity === "error"
              ? monaco.MarkerSeverity.Error
              : monaco.MarkerSeverity.Warning,
        }))
      )
    },
    [issues]
  )

  useEffect(() => {
    if (monacoRef.current) applyMarkers(monacoRef.current)
  }, [applyMarkers, path])

  return (
    <div className="h-full min-h-0 w-full overflow-hidden" aria-label={ariaLabel}>
      <Editor
        width="100%"
        height="100%"
        language={language}
        path={path}
        keepCurrentModel={Boolean(path)}
        defaultValue={value}
        theme={isDark ? "vs-dark" : "light"}
        onMount={(editor, monaco) => {
          editorRef.current = editor
          monacoRef.current = monaco
          syncValue()
          applyMarkers(monaco)
          const shortcuts = registerMonacoEditorShortcuts(editor, monaco, () => currentPropsRef.current)
          const commandPalette = disableMonacoCommandPalette(editor, monaco)
          const formatting = registerMonacoYamlFormatting(editor, monaco, () => currentPropsRef.current.readOnly)
          // Monaco can replace its inner view when loading a model. The host
          // container survives, keeping short-drag classification registered.
          const touch = registerMonacoTouch(editor.getContainerDomNode())
          const viewport = registerMonacoViewport(editor)
          const models = new Set<NonNullable<ReturnType<typeof editor.getModel>>>()
          const trackModel = () => {
            const model = editor.getModel()
            if (model && transientModels) models.add(model)
          }
          trackModel()
          const listener = editor.onDidChangeModel(() => {
            if (window.matchMedia("(pointer: coarse)").matches && editor.hasTextFocus()) {
              (document.activeElement as HTMLElement | null)?.blur()
            }
            trackModel(); syncValue(); applyMarkers(monaco)
          })
          editor.onDidDispose(() => {
            shortcuts.dispose()
            commandPalette.dispose()
            formatting.dispose()
            touch.dispose()
            viewport.dispose()
            listener.dispose()
            models.forEach((model) => { if (!model.isDisposed()) model.dispose() })
            editorRef.current = null
          })
        }}
        onChange={handleChange}
        options={{
          automaticLayout: true,
          fontSize: 13,
          lineHeight: 20,
          minimap: {
            enabled: !mobile,
            side: "right",
            showSlider: "mouseover",
            renderCharacters: true,
            maxColumn: 120,
          },
          lineNumbersMinChars: mobile ? 3 : 5,
          lineDecorationsWidth: mobile ? 8 : 10,
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
          },
          scrollBeyondLastLine: false,
          smoothScrolling: false,
          padding: { top: 10, bottom: 10 },
          renderValidationDecorations: "on",
          fixedOverflowWidgets: true,
          useShadowDOM: false,
          multiCursorModifier: "alt",
          readOnly,
          readOnlyMessage: { value: "只读内容，无法编辑" },
        }}
      />
    </div>
  )
}
