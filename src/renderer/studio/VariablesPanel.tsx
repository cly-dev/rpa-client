import { useState, type ReactNode } from 'react'
import { NODE_CATALOG } from '@graph/catalog.ts'
import type { JsonValue, NodeOutputs, WorkflowGraph, WorkflowNode } from '@graph/types.ts'

export function VariablesPanel({ graph, subflows = [], outputs, inputs: runtimeInputs, variables: runtimeVariables, page }: { graph: WorkflowGraph; subflows?: readonly WorkflowGraph[]; outputs?: Readonly<Record<string, NodeOutputs>>; inputs?: Readonly<Record<string, JsonValue>>; variables?: Readonly<Record<string, JsonValue>>; page?: { readonly url: string; readonly title?: string } }): ReactNode {
  const [collapsed, setCollapsed] = useState(true)
  const globalVariables = graph.context?.variables ?? []
  const declared = graph.nodes.flatMap(node => {
    const config = node.config
    if (config.type === 'code') return (config.outputs ?? []).filter(item => item.outputMode === 'declare' && item.updateVariable?.trim()).map(item => ({ name: item.updateVariable!.trim(), type: item.valueType ?? 'any' }))
    if (config.type === 'agent') return (config.outputs ?? []).filter(item => item.outputMode === 'declare' && item.updateVariable?.trim()).map(item => ({ name: item.updateVariable!.trim(), type: item.valueType }))
    if (!('outputMode' in config) || config.outputMode !== 'declare' || !config.updateVariable?.trim()) return []
    const name = config.updateVariable.trim()
    const type = config.type === 'api-request' || config.type === 'api-listen' ? (config.responseType === 'json' ? 'object/array' : 'string') : config.type === 'code' ? 'object' : 'string'
    return [{ name, type }]
  })
  const globals = [...globalVariables.map(item => ({ ...item, value: runtimeVariables?.[item.name] })), ...declared.filter(item => !globalVariables.some(global => global.name === item.name)).map(item => ({ ...item, value: runtimeVariables?.[item.name] }))]
  const inputs = graph.context?.inputs ?? []
  const grouped = groupNodeVariables(graph.nodes, outputs)
  const special = graph.nodes.filter(node => node.type === 'for-each').flatMap(node => [
    { path: `failureCount_${node.id}`, type: `${node.name} · 失败次数` },
    { path: `successCount_${node.id}`, type: `${node.name} · 成功次数` },
  ])
  const knownRuntimeNames = new Set([
    ...globals.map(item => item.name),
    ...grouped.flatMap(group => group.items.map(item => item.path.split('.').at(-1) ?? '')),
    ...special.map(item => item.path),
    'successCount', 'failureCount', 'currentItem', 'currentIndex',
  ])
  const subflowNames = new Set(subflows.flatMap(subflow => [
    ...(subflow.context?.variables ?? []).map(item => item.name),
    ...subflow.nodes.flatMap(node => [
      ...nodeOutputs(node).map(item => item.path.split('.').at(-1) ?? ''),
      ...('name' in node.config && node.config.type === 'set-variable' ? [node.config.name] : []),
      ...('updateVariable' in node.config && node.config.updateVariable?.trim() ? [node.config.updateVariable.trim()] : []),
      ...(node.config.type === 'for-each' ? [node.config.itemVar || 'item', node.config.indexVar || 'index', ...(node.config.declaredVariables ?? [])] : []),
    ]),
  ]).filter(Boolean))
  const subflowItems = [...subflowNames]
    .filter(name => !knownRuntimeNames.has(name))
    .map(name => ({ path: `variables.${name}`, type: '子流程变量', value: runtimeVariables?.[name] }))
  const runtimeOnly = Object.entries(runtimeVariables ?? {})
    .filter(([name]) => !knownRuntimeNames.has(name) && !subflowNames.has(name) && !/^(successCount|failureCount)(_|$)/.test(name))
    .map(([name, value]) => ({ path: `variables.${name}`, type: '运行时变量', value }))
  return <aside className={`variables-panel${collapsed ? ' is-collapsed' : ''}`}>{collapsed ? <button type="button" className="variables-toggle variables-icon-button" aria-label="展开变量面板" onClick={() => { setCollapsed(false) }}>ƒx</button> : <><button type="button" className="variables-toggle" aria-label="收起变量面板" onClick={() => { setCollapsed(true) }}>‹</button><div className="variables-panel-heading"><h2>变量</h2><span>{inputs.length + globals.length + grouped.reduce((count, group) => count + group.items.length, 0) + special.length + runtimeOnly.length + subflowItems.length}</span></div><p>点击变量查看完整值</p><VariableGroup title="流程输入" defaultOpen items={inputs.map(item => ({ path: `inputs.${item.name}`, type: item.type, value: runtimeInputs?.[item.name] }))} /><VariableGroup title="全局变量" defaultOpen items={globals.map(item => ({ path: `variables.${item.name}`, type: item.type, value: item.value }))} />{grouped.map(group => <VariableGroup key={group.type} title={`${group.title}变量`} items={group.items} />)}{subflowItems.length > 0 ? <VariableGroup title="子流程变量" items={subflowItems} /> : null}{runtimeOnly.length > 0 ? <VariableGroup title="运行时变量" items={runtimeOnly} /> : null}{special.length > 0 ? <VariableGroup title="循环计数" variant="special" items={special.map(item => ({ ...item, value: runtimeVariables?.[item.path] }))} /> : null}<VariableGroup title="页面环境" items={[{ path: 'page.url', type: 'string（只读）', value: page?.url }, { path: 'page.title', type: 'string（只读）', value: page?.title }]} /></>}</aside>
}

function groupNodeVariables(nodes: readonly WorkflowNode[], outputs?: Readonly<Record<string, NodeOutputs>>): { type: string; title: string; items: { path: string; type: string; value?: unknown }[] }[] {
  const groups = new Map<string, { title: string; items: { path: string; type: string; value?: unknown }[] }>()
  for (const node of nodes) {
    const type = node.type
    const current = groups.get(type) ?? { title: NODE_CATALOG[type].title, items: [] }
    current.items.push(...nodeOutputs(node, outputs))
    groups.set(type, current)
  }
  return [...groups.entries()].map(([type, group]) => ({ type, ...group })).filter(group => group.items.length > 0)
}

function nodeOutputs(node: WorkflowNode, outputs?: Readonly<Record<string, NodeOutputs>>): { path: string; type: string; value?: unknown }[] {
  const configured: { name: string; type: string }[] = []
  if (node.config.type === 'extract') configured.push({ name: node.config.outputName, type: node.config.mode === 'list' ? 'array' : 'string' })
  if (node.config.type === 'transform') configured.push({ name: node.config.outputName, type: 'string' })
  if (node.config.type === 'code') {
    if (node.config.outputs && node.config.outputs.length > 0) configured.push(...node.config.outputs.filter(output => output.name.trim() !== '').map(output => ({ name: output.name, type: output.valueType ?? 'any' })))
    else configured.push({ name: node.config.outputName, type: 'object' })
  }
  if (node.config.type === 'agent') configured.push(...(node.config.outputs ?? []).filter(output => output.name.trim() !== '').map(output => ({ name: output.name, type: output.valueType })))
  if (node.config.type === 'image-recognition') configured.push({ name: node.config.outputName || 'imageResult', type: '图片识别结果' })
  if (node.config.type === 'api-listen') {
    configured.push({ name: node.config.outputName, type: node.config.responseType === 'json' ? 'object/array' : 'string' })
    if ((node.config.rawOutputName ?? '').trim() !== '') configured.push({ name: node.config.rawOutputName ?? 'responseData', type: node.config.responseType === 'json' ? 'object/array' : 'string' })
    for (const field of node.config.fields ?? []) if (field.name.trim() !== '') configured.push({ name: field.name, type: '字段值' })
  }
  if (node.config.type === 'api-request') {
    configured.push({ name: node.config.outputName, type: node.config.responseType === 'json' ? 'object/array' : 'string' })
    if ((node.config.rawOutputName ?? '').trim() !== '') configured.push({ name: node.config.rawOutputName ?? 'rawResponseData', type: node.config.responseType === 'json' ? 'object/array' : 'string' })
    for (const field of node.config.fields ?? []) if (field.name.trim() !== '') configured.push({ name: field.name, type: '字段值' })
  }
  if (node.config.type === 'page-action') {
    for (const step of node.config.steps) if (step.type === 'extract') configured.push({ name: step.outputName, type: 'string' })
  }
  if (node.config.type === 'for-each') {
    configured.push({ name: node.config.itemVar || 'item', type: '当前项' }, { name: node.config.indexVar || 'index', type: '当前索引' })
    for (const name of node.config.declaredVariables ?? []) {
      if (name.trim() !== '' && !configured.some(item => item.name === name)) configured.push({ name, type: '当前项' })
    }
  }
  return configured.map(item => ({ path: `nodes.${node.name}.${item.name}`, type: item.type, value: outputs?.[node.id]?.[item.name] }))
}

function VariableGroup({ title, items, defaultOpen = false, variant }: { title: string; items: { path: string; type: string; value?: unknown }[]; defaultOpen?: boolean; variant?: 'special' }): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  const [selected, setSelected] = useState<{ path: string; type: string; value?: unknown }>()
  return <><section className={`variables-group${open ? ' is-open' : ''}${variant === 'special' ? ' variables-group-special' : ''}`}><button className="variables-group-header" onClick={() => { setOpen(value => !value) }}><span>{title}</span><small>{items.length}</small><b>{open ? '−' : '+'}</b></button>{open ? (items.length === 0 ? <span className="variables-empty">暂无变量</span> : items.map(item => <button type="button" className="variable-item" key={item.path} onClick={() => { setSelected(item) }}><div className="variable-item-top"><span title={item.path}>{variableLabel(item.path)}</span><small>{item.type}</small></div><code title={preview(item.value)}>{item.value === undefined ? '等待运行值' : preview(item.value)}</code></button>)) : null}</section>{selected !== undefined ? <div className="variable-modal-backdrop" role="presentation" onClick={() => { setSelected(undefined) }}><section className="variable-modal" role="dialog" aria-modal="true" aria-label={`变量 ${selected.path}`} onClick={event => { event.stopPropagation() }}><header><div><strong>{selected.path}</strong><small>{selected.type}</small></div><button type="button" onClick={() => { setSelected(undefined) }}>关闭</button></header><pre>{selected.value === undefined ? '暂无运行值' : JSON.stringify(selected.value, (_key, value: unknown) => typeof value === 'string' && value.length > 16000 ? `${value.slice(0, 200)}…（长文本/图片数据已省略）` : value, 2)}</pre></section></div> : null}</>
}

function preview(value: unknown): string {
  if (typeof value === 'string') return value === '' ? '（空字符串）' : value.length > 58 ? `${value.slice(0, 55)}…` : value
  if (value === null) return 'null'
  if (value === undefined) return '等待运行值'
  const text = typeof value === 'object' ? JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' && item.length > 16000 ? '[长文本/图片数据]' : item) : String(value)
  return text.length > 58 ? `${text.slice(0, 55)}…` : text
}

function variableLabel(path: string): string {
  const parts = path.split('.')
  return parts.at(-1) ?? path
}
