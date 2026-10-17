import type { Monaco, OnMount } from "@monaco-editor/react"
import { parseAllDocuments } from "yaml"

export function formatYaml(content: string, indent = 2): { text: string; issue?: { offset: number; message: string } } {
  const documents = parseAllDocuments(content, { intAsBigInt: true })
  const error = documents.flatMap((document) => document.errors)[0]
  if (error) return { text: content, issue: { offset: error.pos[0], message: "YAML 存在语法错误，请修正后再格式化" } }
  try {
    return { text: documents.length ? documents.map((document) => document.toString({ indent, lineWidth: 0, collectionStyle: "block" })).join("") : content }
  } catch {
    return { text: content, issue: { offset: 0, message: "YAML 无法格式化，请检查引用和标签" } }
  }
}

export function registerMonacoYamlFormatting(editor: Parameters<OnMount>[0], monaco: Monaco, isReadOnly: () => boolean) {
  const owner = "mihomo-yaml-format"
  let markedModel: ReturnType<typeof editor.getModel> = null
  const clearMarkers = () => {
    if (markedModel && !markedModel.isDisposed()) monaco.editor.setModelMarkers(markedModel, owner, [])
    markedModel = null
  }
  const action = editor.addAction({
    id: "mihomo.formatYaml", label: "格式化代码",
    keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
    keybindingContext: "editorTextFocus", precondition: "editorLangId == yaml && !editorReadonly",
    contextMenuGroupId: "1_modification", contextMenuOrder: 1.3,
    run: () => {
      const model = editor.getModel()
      if (!model || model.getLanguageId() !== "yaml" || isReadOnly() || editor.getOption(monaco.editor.EditorOption.readOnly)) return
      clearMarkers()
      const result = formatYaml(model.getValue(), model.getOptions().tabSize)
      if (result.issue) {
        const position = model.getPositionAt(result.issue.offset)
        markedModel = model
        monaco.editor.setModelMarkers(model, owner, [{ message: result.issue.message, severity: monaco.MarkerSeverity.Error,
          startLineNumber: position.lineNumber, startColumn: position.column,
          endLineNumber: position.lineNumber, endColumn: position.column + 1 }])
        editor.revealLineInCenterIfOutsideViewport(position.lineNumber)
        return
      }
      if (result.text === model.getValue()) return
      editor.pushUndoStop()
      editor.executeEdits("mihomo.formatYaml", [{ range: model.getFullModelRange(), text: result.text, forceMoveMarkers: true }])
      editor.pushUndoStop()
    },
  })
  const contentListener = editor.onDidChangeModelContent(clearMarkers)
  const modelListener = editor.onDidChangeModel(clearMarkers)
  return { dispose: () => { action.dispose(); contentListener.dispose(); modelListener.dispose(); clearMarkers() } }
}
