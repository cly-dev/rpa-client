import { nodeOutputDefinitions, nodeDeclaredVariables, nodeVariableNames } from '@graph/workflow-variables.ts'
import { useState, type ReactNode } from 'react'
import { NODE_CATALOG } from '@graph/catalog.ts'
import type { JsonValue, NodeOutputs, WorkflowGraph, WorkflowNode } from '@graph/types.ts'
import { copyTextToClipboard } from './clipboard.ts'

export function serializeAllVariables(graph: WorkflowGraph, outputs?: Readonly<Record<string, NodeOutputs>>, runtimeInputs?: Readonly<Record<string, JsonValue>>, runtimeVariables?: Readonly<Record<string, JsonValue>>, page?: { readonly url: string; readonly title?: string }): string {
  const inputs = Object.fromEntries((graph.context?.inputs ?? []).map(input => [input.name, runtimeInputs?.[input.name] ?? input.defaultValue ?? null]))
  const configuredVariables = Object.fromEntries([...(graph.context?.variables ?? []).map(variable => [variable.name, runtimeVariables?.[variable.name] ?? variable.defaultValue ?? null]), ...graph.nodes.flatMap(node => nodeDeclaredVariables(node).map(item => [item.name, runtimeVariables?.[item.name] ?? outputs?.[node.id]?.[nodeOutputDefinitions(node).find(port => port.variableName === item.name)?.name ?? ''] ?? null]))])
  const nodeOutputs = graph.nodes
    .filter(node => outputs?.[node.id] !== undefined)
    .map(node => ({ nodeId: node.id, nodeName: node.name, values: outputs?.[node.id] ?? {} }))
  return JSON.stringify({
    inputs: { ...inputs, ...(runtimeInputs ?? {}) },
    variables: { ...configuredVariables, ...(runtimeVariables ?? {}) },
    nodeOutputs,
    page: { url: page?.url ?? '', title: page?.title ?? '' },
  }, (_key, value: unknown) => value === undefined ? null : value, 2)
}

export function VariablesPanel({ graph, subflows = [], outputs, inputs: runtimeInputs, variables: runtimeVariables, page }: { graph: WorkflowGraph; subflows?: readonly WorkflowGraph[]; outputs?: Readonly<Record<string, NodeOutputs>>; inputs?: Readonly<Record<string, JsonValue>>; variables?: Readonly<Record<string, JsonValue>>; page?: { readonly url: string; readonly title?: string } }): ReactNode {
  const [collapsed, setCollapsed] = useState(true)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const globalVariables = graph.context?.variables ?? []
  const declared = graph.nodes.flatMap(nodeDeclaredVariables)
  const globals = [...globalVariables.map(item => ({ ...item, value: runtimeVariables?.[item.name] })), ...declared.filter(item => !globalVariables.some(global => global.name === item.name)).map(item => ({ ...item, value: runtimeVariables?.[item.name] }))]
  const inputs = graph.context?.inputs ?? []
  const grouped = groupNodeVariables(graph.nodes, outputs)
  const special = graph.nodes.filter(node => node.type === 'for-each').flatMap(node => [
    { path: `failureCount_${node.id}`, type: `${node.name} · 失败轮数` },
    { path: `successCount_${node.id}`, type: `${node.name} · 成功轮数` },
  ])
  const knownRuntimeNames = new Set([
    ...globals.map(item => item.name),
    ...grouped.flatMap(group => group.items.map(item => item.path.split('.').at(-1) ?? '')),
    ...special.map(item => item.path),
    'successCount', 'failureCount', 'currentItem', 'currentIndex',
  ])
  const subflowNames = new Set(subflows.flatMap(subflow => [
    ...(subflow.context?.variables ?? []).map(item => item.name),
    ...subflow.nodes.flatMap(nodeVariableNames),
  ]).filter(Boolean))
  const subflowItems = [...subflowNames]
    .filter(name => !knownRuntimeNames.has(name))
    .map(name => ({ path: `variables.${name}`, type: '子流程变量', value: runtimeVariables?.[name] }))
  const runtimeOnly = Object.entries(runtimeVariables ?? {})
    .filter(([name]) => !knownRuntimeNames.has(name) && !subflowNames.has(name) && !/^(successCount|failureCount)(_|$)/.test(name))
    .map(([name, value]) => ({ path: `variables.${name}`, type: '运行时变量', value }))
  return <aside className={`variables-panel${collapsed ? ' is-collapsed' : ''}`}>{collapsed ? <button type="button" className="variables-toggle variables-icon-button" aria-label="展开变量面板" onClick={() => { setCollapsed(false) }}>ƒx</button> : <><button type="button" className="variables-toggle" aria-label="收起变量面板" onClick={() => { setCollapsed(true) }}>‹</button><div className="variables-panel-heading"><h2>变量</h2><div className="variables-panel-actions"><span>{inputs.length + globals.length + grouped.reduce((count, group) => count + group.items.length, 0) + special.length + runtimeOnly.length + subflowItems.length}</span><button type="button" onClick={() => { void copyTextToClipboard(serializeAllVariables(graph, outputs, runtimeInputs, runtimeVariables, page)).then(() => { setCopyStatus('copied') }).catch(() => { setCopyStatus('failed') }) }}>{copyStatus === 'copied' ? '已复制' : copyStatus === 'failed' ? '复制失败' : '复制全部变量'}</button></div></div><p>点击变量查看完整值</p><VariableGroup title="流程输入" defaultOpen items={inputs.map(item => ({ path: `inputs.${item.name}`, type: item.type, value: runtimeInputs?.[item.name] }))} /><VariableGroup title="全局变量" defaultOpen items={globals.map(item => ({ path: `variables.${item.name}`, type: item.type, value: item.value }))} />{grouped.map(group => <VariableGroup key={group.type} title={`${group.title}变量`} items={group.items} />)}{subflowItems.length > 0 ? <VariableGroup title="子流程变量" items={subflowItems} /> : null}{runtimeOnly.length > 0 ? <VariableGroup title="运行时变量" items={runtimeOnly} /> : null}{special.length > 0 ? <VariableGroup title="循环计数" variant="special" items={special.map(item => ({ ...item, value: runtimeVariables?.[item.path] }))} /> : null}<VariableGroup title="页面环境" items={[{ path: 'page.url', type: 'string（只读）', value: page?.url }, { path: 'page.title', type: 'string（只读）', value: page?.title }]} /></>}</aside>
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
  const configured = nodeOutputDefinitions(node)
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
