import { useMemo, useState, type ReactNode } from 'react'
import type { CodeConfig, JsonValue, ValueBinding, WorkflowGraph } from '@graph/types.ts'
import { CodeEditor } from './CodeEditor.tsx'
import { upstreamNodes } from './upstream-nodes.ts'

interface VariableOption { readonly key: string; readonly label: string; readonly binding: ValueBinding }

export function variableOptions(graph: WorkflowGraph, nodeId: string, subflowVariableNames: readonly string[]): VariableOption[] {
  const options: VariableOption[] = []
  for (const item of graph.context?.inputs ?? []) options.push({ key: `input:${item.name}`, label: `流程输入 / ${item.name}`, binding: { kind: 'workflow-input', name: item.name } })
  for (const item of graph.context?.variables ?? []) options.push({ key: `variable:${item.name}`, label: `全局变量 / ${item.name}`, binding: { kind: 'variable', name: item.name } })
  for (const node of upstreamNodes(graph, nodeId)) {
    const names: string[] = []
    const config = node.config
    if (config.type === 'for-each') names.push(config.itemVar || 'item', config.indexVar || 'index', ...(config.declaredVariables ?? []))
    if (config.type === 'set-variable' && config.name.trim()) names.push(config.name)
    if (config.type === 'switch' && config.mode === 'ai') names.push(config.reasonOutputName?.trim() || 'reason')
    if (config.type === 'code') names.push(...(config.outputs ?? []).map(output => output.name))
    else if (config.type === 'agent') names.push(...(config.outputs ?? []).map(output => output.name))
    else if ((config.type === 'api-request' || config.type === 'api-listen') && config.outputName.trim()) names.push(config.outputName, ...(config.fields ?? []).map(field => field.name))
    else if ('outputName' in config && config.outputName.trim()) names.push(config.outputName)
    for (const name of names.filter(Boolean)) options.push({ key: `variable:${name}`, label: `${node.name} / ${name}`, binding: { kind: 'variable', name } })
  }
  const known = new Set(options.map(option => option.key))
  for (const name of subflowVariableNames) {
    const key = `variable:${name}`
    if (!name.trim() || known.has(key)) continue
    options.push({ key, label: `子流程变量 / ${name}`, binding: { kind: 'variable', name } })
    known.add(key)
  }
  return [...new Map(options.map(option => [option.key, option])).values()]
}

function bindingKey(binding: ValueBinding): string {
  if (binding.kind === 'workflow-input') return `input:${binding.name}`
  if (binding.kind === 'variable') return `variable:${binding.name}`
  return ''
}

function aliasFrom(option: VariableOption | undefined): string {
  const raw = option?.binding.kind === 'workflow-input' || option?.binding.kind === 'variable' ? option.binding.name : 'value'
  const alias = raw.replace(/[^A-Za-z0-9_$]/g, '_')
  return /^[A-Za-z_$]/.test(alias) ? alias : `value_${alias}`
}

const DEFAULT_OUTPUT: NonNullable<CodeConfig['outputs']>[number] = { name: 'result', valueType: 'any', outputMode: 'produce' }

function propertyAccess(root: 'input' | 'variables', name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `${root}.${name}` : `${root}[${JSON.stringify(name)}]`
}

function fixtureFor(names: readonly string[]): string {
  return JSON.stringify(Object.fromEntries(names.filter(Boolean).map(name => [name, null])), null, 2)
}

export function CodeNodeEditor({ graph, nodeId, subflowVariableNames, config, onChange }: { graph: WorkflowGraph; nodeId: string; subflowVariableNames: readonly string[]; config: CodeConfig; onChange: (config: CodeConfig) => void }): ReactNode {
  const [fixture, setFixture] = useState('{\n  "value": "示例内容"\n}')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; value?: JsonValue; message?: string }>()
  const [variableFixture, setVariableFixture] = useState('{}')
  const [insert, setInsert] = useState<{ id: number; text: string }>()
  const options = useMemo(() => variableOptions(graph, nodeId, subflowVariableNames), [graph, nodeId, subflowVariableNames])
  const inputs = config.inputs ?? []
  const outputs = config.outputs ?? (config.outputName ? [{ ...DEFAULT_OUTPUT, name: config.outputName, outputMode: config.outputMode ?? 'produce', updateVariable: config.updateVariable }] : [DEFAULT_OUTPUT])
  const updateInput = (index: number, patch: Partial<(typeof inputs)[number]>): void => onChange({ ...config, inputs: inputs.map((item, i) => i === index ? { ...item, ...patch } : item) })
  const updateOutput = (index: number, patch: Partial<(typeof outputs)[number]>): void => {
    const nextOutputs = outputs.map((item, i) => i === index ? { ...item, ...patch } : item)
    onChange({ ...config, outputs: nextOutputs, outputName: nextOutputs[0]?.name ?? config.outputName })
  }
  const addInput = (): void => onChange({ ...config, inputs: [...inputs, { name: '', binding: { kind: 'literal', value: null } }] })
  const addOutput = (): void => onChange({ ...config, outputs: [...outputs, { name: '', valueType: 'any', outputMode: 'produce' }] })
  const inputNames = inputs.map(item => item.name).filter(Boolean)
  const availableNames = options.filter(option => option.binding.kind === 'variable').map(option => option.binding.kind === 'variable' ? option.binding.name : '').filter(Boolean)
  const insertCode = (text: string): void => { setInsert(current => ({ id: (current?.id ?? 0) + 1, text })) }
  const applyTemplate = (kind: 'basic' | 'text' | 'list' | 'condition'): void => {
    if (config.code.trim() && !window.confirm('使用模板会替换当前代码，确定继续吗？')) return
    const inputName = inputNames[0] ?? 'value'
    const source = propertyAccess('input', inputName)
    const outputName = outputs[0]?.name || 'result'
    const outputKey = JSON.stringify(outputName)
    const code = kind === 'text' ? `const text = String(${source} ?? '').trim();\n\nreturn {\n  ${outputKey}: text\n};`
      : kind === 'list' ? `const items = Array.isArray(${source}) ? ${source} : [];\nconst processed = items.map((item, index) => ({\n  ...item,\n  index\n}));\n\nreturn {\n  ${outputKey}: processed\n};`
        : kind === 'condition' ? `const matched = Boolean(${source});\n\nreturn {\n  ${outputKey}: matched\n};`
          : `const value = ${source};\n\nreturn {\n  ${outputs.map(item => `${JSON.stringify(item.name || 'result')}: value`).join(',\n  ')}\n};`
    onChange({ ...config, preset: 'custom', code })
  }
  const test = async (): Promise<void> => {
    setTesting(true); setTestResult(undefined)
    try {
      const parsed = JSON.parse(fixture) as JsonValue
      const parsedVariables = JSON.parse(variableFixture) as JsonValue
      if (parsedVariables === null || typeof parsedVariables !== 'object' || Array.isArray(parsedVariables)) throw new Error('全局变量测试值必须是 JSON 对象')
      const result = await window.studio?.testCode(config.code, parsed, parsedVariables as Readonly<Record<string, JsonValue>>)
      setTestResult(result?.ok ? { ok: true, value: result.result } : { ok: false, message: result?.message ?? '测试服务不可用' })
    } catch (error) { setTestResult({ ok: false, message: error instanceof Error ? error.message : String(error) }) }
    finally { setTesting(false) }
  }

  return <section className="code-node-config code-node-dify">
    <section className="code-guide-card">
      <div className="code-guide-step"><span>1</span><label>先映射输入变量<small>上游数据不会自动出现在代码中；在“输入变量”里选择后，通过 <code>input.名称</code> 使用。</small></label></div>
      <div className="code-guide-step"><span>2</span><label>编写同步 JavaScript<small>全局流程变量通过 <code>variables.变量名</code> 读取。输入 <code>input.</code> 或 <code>variables.</code> 会出现自动补全。</small></label></div>
      <div className="code-guide-step"><span>3</span><label>返回声明的输出对象<small>必须执行 <code>return {'{'} result: 值 {'}'}</code>；字段名应与“输出变量”中的声明一致。</small></label></div>
      <p className="code-guide-help">代码在受限环境中执行：可以使用数组、对象、字符串、数字和 JSON 方法；不能使用 DOM、网络请求、文件、<code>require</code> 或异步任务。</p>
    </section>
    <section className="code-dify-section">
      <div className="code-dify-heading"><div><strong>输入变量</strong><p>选择上游变量，并为代码中的输入起一个名称。</p></div><button type="button" onClick={addInput}>＋添加变量</button></div>
      {inputs.length === 0 ? <div className="code-dify-empty">还没有输入变量。点击“添加变量”，选择一个流程变量后，就能在代码里读取它。</div> : inputs.map((item, index) => {
        const selected = options.find(option => bindingKey(item.binding) === option.key)
        const selectedKey = bindingKey(item.binding)
        return <div className="code-dify-input" key={`code-input-${index}`}><select aria-label="选择上游变量" value={bindingKey(item.binding)} onChange={event => {
          const option = options.find(candidate => candidate.key === event.target.value)
          if (option) updateInput(index, { binding: option.binding, name: item.name.trim() || aliasFrom(option) })
        }}><option value="">选择上游变量…</option>{selectedKey && !selected ? <option value={selectedKey} disabled>当前引用不在前置节点中</option> : null}{options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select><span className="code-dify-arrow">作为</span><input aria-label="代码输入变量名" value={item.name} placeholder={selected ? aliasFrom(selected) : '代码中的名称'} onChange={event => { updateInput(index, { name: event.target.value.replace(/[^A-Za-z0-9_$]/g, '_') }) }} /><code>input.{item.name || '变量名'}</code><button type="button" aria-label="删除输入变量" onClick={() => { onChange({ ...config, inputs: inputs.filter((_, i) => i !== index) }) }}>×</button></div>
      })}
    </section>

    <section className="code-dify-section code-dify-editor-section">
      <div className="code-dify-heading"><div><strong>代码</strong><p>使用 <code>input.变量名</code> 读取上方映射的值，并返回一个对象。</p></div><span className="code-language-badge">JavaScript</span></div>
      <div className="code-editor-tools"><span>插入变量</span>{inputNames.map(name => <button type="button" key={`input-${name}`} onClick={() => { insertCode(propertyAccess('input', name)) }}>{propertyAccess('input', name)}</button>)}{availableNames.slice(0, 12).map(name => <button type="button" key={`variable-${name}`} onClick={() => { insertCode(propertyAccess('variables', name)) }}>{propertyAccess('variables', name)}</button>)}{inputNames.length === 0 && availableNames.length === 0 ? <em>先在上方添加输入变量</em> : null}</div>
      <div className="code-template-tools"><span>从模板开始</span><button type="button" onClick={() => { applyTemplate('basic') }}>基础处理</button><button type="button" onClick={() => { applyTemplate('text') }}>文本清洗</button><button type="button" onClick={() => { applyTemplate('list') }}>列表处理</button><button type="button" onClick={() => { applyTemplate('condition') }}>布尔判断</button></div>
      <CodeEditor value={config.code} onChange={code => { onChange({ ...config, preset: 'custom', code }) }} variables={availableNames} inputs={inputNames} height={380} insert={insert} />
      <div className="code-contract-preview"><strong>当前返回格式</strong><code>{`return { ${outputs.map(item => `${item.name || '未命名输出'}: ...`).join(', ')} };`}</code></div>
    </section>

    <section className="code-dify-section">
      <div className="code-dify-heading"><div><strong>输出变量</strong><p>代码返回对象中的字段名，必须和这里声明的名称一致。</p></div><button type="button" onClick={addOutput}>＋添加输出</button></div>
      <div className="code-output-table-heading"><span>变量名</span><span>类型</span><span>变量保存方式</span><span /></div>
      {outputs.map((item, index) => <div className="code-output-row code-dify-output" key={`code-output-${index}`}><input aria-label="输出变量名" value={item.name} placeholder="例如 result" onChange={event => { updateOutput(index, { name: event.target.value, outputMode: item.outputMode ?? 'produce' }) }} /><select aria-label="输出变量类型" value={item.valueType ?? 'any'} onChange={event => { updateOutput(index, { valueType: event.target.value as NonNullable<typeof item.valueType> }) }}><option value="any">自动</option><option value="string">文本</option><option value="number">数字</option><option value="boolean">布尔值</option><option value="object">对象</option><option value="array">数组</option></select><select aria-label="输出变量保存方式" value={item.outputMode ?? 'produce'} onChange={event => { const outputMode = event.target.value as NonNullable<typeof item.outputMode>; updateOutput(index, { outputMode, updateVariable: outputMode === 'update' ? item.updateVariable ?? '' : undefined }) }}><option value="produce">产出变量</option><option value="declare">声明并持续更新</option><option value="update">覆盖已有变量</option></select><button type="button" aria-label="删除输出变量" onClick={() => { onChange({ ...config, outputs: outputs.filter((_, i) => i !== index) }) }}>×</button>{item.outputMode === 'update' ? <select className="code-output-target" aria-label="选择覆盖变量" value={item.updateVariable ?? ''} onChange={event => { updateOutput(index, { updateVariable: event.target.value }) }}><option value="">选择要覆盖的变量…</option>{options.filter(option => option.binding.kind === 'variable').map(option => <option key={option.key} value={option.binding.kind === 'variable' ? option.binding.name : ''}>{option.label}</option>)}</select> : null}</div>)}
    </section>

    <details className="code-dify-test"><summary>测试代码</summary><p>测试不会改动流程变量。输入对象字段名应与上方代码输入名称一致。</p><div className="code-test-heading"><strong>input 测试值</strong><button type="button" onClick={() => { setFixture(fixtureFor(inputNames)) }}>根据输入生成</button></div><textarea rows={5} value={fixture} onChange={event => { setFixture(event.target.value) }} spellCheck={false} /><div className="code-test-heading"><strong>variables 测试值</strong><span>仅填写代码中使用到的全局变量</span></div><textarea rows={4} value={variableFixture} onChange={event => { setVariableFixture(event.target.value) }} spellCheck={false} /><button type="button" disabled={testing} onClick={() => { void test() }}>{testing ? '运行中…' : '▶ 运行测试'}</button>{testResult ? <div className={`code-test-result ${testResult.ok ? 'is-success' : 'is-error'}`}><strong>{testResult.ok ? '运行结果' : '运行失败'}</strong><pre>{testResult.ok ? JSON.stringify(testResult.value, null, 2) : testResult.message}</pre></div> : null}</details>
    <p className="properties-hint">代码必须返回 JSON 对象，例如 <code>return {'{'} result: 123 {'}'}</code>。只运行可信来源的代码。</p>
  </section>
}
