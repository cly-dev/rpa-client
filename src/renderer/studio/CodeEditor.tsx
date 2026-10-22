import { useEffect, useRef } from 'react'
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { javascript } from '@codemirror/lang-javascript'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'

export function CodeEditor({ value, onChange, variables, inputs = [], height = 260, insert }: { value: string; onChange: (value: string) => void; variables: readonly string[]; inputs?: readonly string[]; height?: number; insert?: { readonly id: number; readonly text: string } }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>()
  const callback = useRef(onChange)
  callback.current = onChange
  const variableList = useRef(variables)
  const inputList = useRef(inputs)
  variableList.current = variables
  inputList.current = inputs

  useEffect(() => {
    if (!host.current) return
    const variableCompletion = autocompletion({ override: [(context: CompletionContext): CompletionResult | null => {
      const word = context.matchBefore(/[\w$]*/)
      if (!word || (word.from === word.to && !context.explicit)) return null
      const prefix = word.text.toLowerCase()
      const prefixText = context.state.doc.sliceString(Math.max(0, word.from - 10), word.from)
      const inVariables = prefixText.endsWith('variables.')
      const inInput = prefixText.endsWith('input.')
      const options: Completion[] = inVariables
        ? variableList.current.map(name => ({ label: name, type: 'variable', apply: name }))
        : inInput
          ? inputList.current.map(name => ({ label: name, type: 'property', apply: name }))
          : [
              ...variableList.current.map(name => ({ label: name, type: 'variable', apply: `variables.${name}` })),
              ...inputList.current.map(name => ({ label: `input.${name}`, type: 'property', apply: `input.${name}` })),
            ]
        .filter(option => option.label.toLowerCase().includes(prefix))
      return { from: word.from, options }
    }] })
    const theme = EditorView.theme({
      '&': { height: `${height}px`, fontSize: '13px', border: '1px solid #d9e2ec', borderRadius: '8px', overflow: 'hidden' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      '.cm-focused': { outline: '2px solid #a5b4fc' },
      '.cm-gutters': { backgroundColor: '#f7f9fc', borderRight: '1px solid #e5eaf1', color: '#8291a6' },
    })
    const state = EditorState.create({ doc: value, extensions: [lineNumbers(), javascript(), variableCompletion, theme, EditorView.updateListener.of(update => { if (update.docChanged) callback.current(update.state.doc.toString()) })] })
    view.current = new EditorView({ state, parent: host.current })
    return () => { view.current?.destroy(); view.current = undefined }
  }, [])

  useEffect(() => {
    const current = view.current
    if (current && current.state.doc.toString() !== value) current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } })
  }, [value])

  useEffect(() => {
    const current = view.current
    if (current === undefined || insert === undefined) return
    const position = current.state.selection.main.head
    current.dispatch({ changes: { from: position, insert: insert.text }, selection: { anchor: position + insert.text.length } })
    current.focus()
  }, [insert?.id])

  return <div className="code-editor" ref={host} />
}
