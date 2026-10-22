import type { JsonValue, WorkflowContextDefinition, WorkflowContextVariable } from '@graph/types.ts'
import type { ReactNode } from 'react'

interface Props { readonly context: WorkflowContextDefinition; readonly onChange: (context: WorkflowContextDefinition) => void; readonly onClose: () => void }
type Scope = 'inputs' | 'variables'

function defaultText(value: JsonValue | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
}

function parseDefault(value: string, type: WorkflowContextVariable['type']): JsonValue | undefined {
  if (value === '') return undefined
  if (type === 'number') {
    const number = Number(value)
    return Number.isFinite(number) ? number : value
  }
  if (type === 'boolean') return value === 'true'
  if (type === 'object' || type === 'array') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (type === 'array' && Array.isArray(parsed)) return parsed as JsonValue
      if (type === 'object' && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as JsonValue
    } catch { /* Keep an editable draft until the JSON is valid. */ }
    return value
  }
  return value
}

export function ContextPanel({ context, onChange, onClose }: Props): ReactNode {
  const add = (scope: Scope): void => {
    const item: WorkflowContextVariable = { name: scope === 'inputs' ? 'input' : 'constant', type: 'string', required: scope === 'inputs' }
    onChange({ ...context, [scope]: [...context[scope], item] })
  }
  const update = (scope: Scope, index: number, patch: Partial<WorkflowContextVariable>): void => {
    onChange({ ...context, [scope]: context[scope].map((item, i) => i === index ? { ...item, ...patch } : item) })
  }
  const remove = (scope: Scope, index: number): void => {
    onChange({ ...context, [scope]: context[scope].filter((_, i) => i !== index) })
  }

  return <aside className="context-panel" onClick={event => { event.stopPropagation() }}><header className="context-panel-header"><div><h2>全局变量</h2><p>在流程节点中统一引用。运行时输入由每次执行的用户填写；固定变量随流程保存。</p></div><button type="button" aria-label="关闭全局变量" onClick={onClose}>×</button></header>
    {(['inputs', 'variables'] as const).map(scope => <section className="context-scope" key={scope}>
      <div className="context-heading"><div><strong>{scope === 'inputs' ? '运行时输入' : '固定变量'}</strong><small>{scope === 'inputs' ? '启动流程时填写' : '开发人员预先配置'}</small></div><button type="button" onClick={() => { add(scope) }}>＋ 添加</button></div>
      {context[scope].length === 0 ? <span className="context-empty">{scope === 'inputs' ? '暂无运行时输入' : '暂无固定变量'}</span> : null}
      {context[scope].map((item, index) => <article className="context-variable-card" key={`${scope}-${index}`}>
        <div className="context-row"><input aria-label="变量名" value={item.name} onChange={event => { update(scope, index, { name: event.target.value }) }} placeholder="变量名" /><select aria-label="变量类型" value={item.type} onChange={event => { const type = event.target.value as WorkflowContextVariable['type']; update(scope, index, { type, defaultValue: undefined }) }}><option value="string">文本</option><option value="number">数字</option><option value="boolean">布尔</option><option value="object">对象</option><option value="array">数组</option></select><button type="button" aria-label="删除变量" onClick={() => { remove(scope, index) }}>×</button></div>
        {item.type === 'boolean' ? <label className="context-default">{scope === 'inputs' ? '默认值（可选）' : '固定值'}<select value={item.defaultValue === undefined ? '' : String(item.defaultValue)} onChange={event => { update(scope, index, { defaultValue: event.target.value === '' ? undefined : event.target.value === 'true' }) }}><option value="">未设置</option><option value="true">是</option><option value="false">否</option></select></label> : <label className="context-default">{scope === 'inputs' ? '默认值（可选）' : '固定值'}<input type={item.secret ? 'password' : 'text'} value={defaultText(item.defaultValue)} onChange={event => { update(scope, index, { defaultValue: parseDefault(event.target.value, item.type) }) }} placeholder={item.type === 'object' ? '{"key":"value"}' : item.type === 'array' ? '["value"]' : '未设置'} /></label>}
        <input className="context-description" aria-label="变量说明" value={item.description ?? ''} onChange={event => { update(scope, index, { description: event.target.value }) }} placeholder="说明（可选）" />
        <div className="context-options">{scope === 'inputs' ? <label><input type="checkbox" checked={item.required === true} onChange={event => { update(scope, index, { required: event.target.checked }) }} />必填</label> : null}<label><input type="checkbox" checked={item.secret === true} onChange={event => { update(scope, index, { secret: event.target.checked }) }} />敏感值</label></div>
      </article>)}
    </section>)}
  </aside>
}
