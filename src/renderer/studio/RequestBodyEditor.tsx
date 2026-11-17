import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { WorkflowGraph } from '@graph/types.ts'
import { formatJsonRequestBodyTemplate } from '@graph/json-request-template.ts'
import { availableVariableNames as availableVariables } from '@graph/workflow-variables.ts'
export { availableVariableNames as availableVariables } from '@graph/workflow-variables.ts'

export function RequestBodyEditor({ graph, nodeId, subflowVariableNames = [], value, method, onChange }: { graph: WorkflowGraph; nodeId: string; subflowVariableNames?: readonly string[]; value: string; method: string; onChange: (value: string) => void }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [feedback, setFeedback] = useState<string>()
  const [customPath, setCustomPath] = useState('')
  const inlineRef = useRef<HTMLTextAreaElement>(null)
  const expandedRef = useRef<HTMLTextAreaElement>(null)
  const variables = availableVariables(graph, nodeId, subflowVariableNames)
  const activeEditor = (): HTMLTextAreaElement | null => expanded ? expandedRef.current : inlineRef.current

  useEffect(() => {
    if (expanded) expandedRef.current?.focus()
  }, [expanded])

  const update = (next: string): void => {
    setFeedback(undefined)
    onChange(next)
  }

  const insert = (text: string): void => {
    const editor = activeEditor()
    const start = editor?.selectionStart ?? value.length
    const end = editor?.selectionEnd ?? start
    update(value.slice(0, start) + text + value.slice(end))
    requestAnimationFrame(() => {
      const current = activeEditor()
      current?.focus()
      current?.setSelectionRange(start + text.length, start + text.length)
    })
  }

  const insertVariable = (name: string): void => {
    const position = activeEditor()?.selectionStart ?? value.length
    let insideString = false
    for (let index = 0; index < position; index += 1) {
      if (value[index] === '"' && (index === 0 || value[index - 1] !== '\\')) insideString = !insideString
    }
    const reference = `{{${name}}}`
    insert(insideString ? reference : `"${reference}"`)
  }

  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Tab') return
    event.preventDefault()
    insert('  ')
  }

  const formatJson = (): void => {
    if (value.trim() === '') return
    try {
      update(formatJsonRequestBodyTemplate(value))
      setFeedback('JSON 已格式化')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '请求体 JSON 格式错误')
    }
  }

  const toolbar = (large: boolean): ReactNode => <div className="request-body-toolbar">
    <select aria-label="插入请求体变量" value="" onChange={event => { if (event.target.value) insertVariable(event.target.value) }}>
      <option value="">＋ 插入变量</option>
      {variables.map(name => <option key={name} value={name}>{name}</option>)}
    </select>
    <input aria-label="自定义变量字段路径" value={customPath} onChange={event => { setCustomPath(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter' && customPath.trim()) { event.preventDefault(); insertVariable(customPath.trim()) } }} placeholder="变量名.字段名" />
    <button type="button" disabled={customPath.trim() === ''} onClick={() => { insertVariable(customPath.trim()) }}>插入路径</button>
    <button type="button" onClick={formatJson} disabled={value.trim() === ''}>格式化 JSON</button>
    {!large ? <button type="button" onClick={() => { setExpanded(true) }}>放大编辑</button> : null}
  </div>

  const help = <p className="request-body-help">对象字段写 <code>{'{{订单.编号}}'}</code>，数组字段写 <code>{'{{订单列表[0].编号}}'}</code>。字符串变量放在引号内；数字、布尔值、对象和数组变量不要加引号。“格式化 JSON”会保留变量并检查括号、逗号等语法。</p>

  return <>
    {toolbar(false)}
    <textarea ref={inlineRef} className="request-body-textarea" rows={11} spellCheck={false} value={value} onChange={event => { update(event.target.value) }} onKeyDown={onEditorKeyDown} placeholder={'{\n  "username": "{{inputs.用户名}}",\n  "orderId": "{{orderId}}"\n}'} aria-label="请求体内容" />
    {feedback ? <p className="request-body-feedback" role="status">{feedback}</p> : null}
    {['GET', 'HEAD'].includes(method.toUpperCase()) ? <p className="request-body-feedback">{method.toUpperCase()} 请求不会发送请求体。</p> : null}
    {help}
    {expanded ? createPortal(<div className="request-body-dialog-backdrop" role="presentation" onClick={() => { setExpanded(false) }}>
      <section className="request-body-dialog" role="dialog" aria-modal="true" aria-label="编辑请求体" onClick={event => { event.stopPropagation() }}>
        <header><div><h2>编辑请求体</h2><p>可粘贴完整 JSON 或其他原始文本</p></div><button type="button" aria-label="关闭请求体编辑" onClick={() => { setExpanded(false) }}>×</button></header>
        {toolbar(true)}
        <textarea ref={expandedRef} className="request-body-textarea is-expanded" spellCheck={false} value={value} onChange={event => { update(event.target.value) }} onKeyDown={onEditorKeyDown} placeholder={'{\n  "username": "{{inputs.用户名}}"\n}'} aria-label="放大编辑请求体" />
        {feedback ? <p className="request-body-feedback" role="status">{feedback}</p> : null}
        {help}
        <footer><button type="button" onClick={() => { setExpanded(false) }}>完成</button></footer>
      </section>
    </div>, document.body) : null}
  </>
}
