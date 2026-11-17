import { NODE_CATALOG } from './catalog.ts'
import { approvalDataOutputs, approvalVariablePaths } from './approval-outputs.ts'
import { upstreamNodes } from './upstream-nodes.ts'
import type { JsonValue, WorkflowGraph, WorkflowNode } from './types.ts'

export interface NodeOutputDefinition {
  readonly name: string
  readonly label: string
  readonly type: string
  readonly variableName?: string
  readonly declared?: boolean
  readonly aliases?: readonly string[]
}
const unique = (names: readonly (string | undefined)[]): string[] => [...new Set(names.filter((name): name is string => typeof name === 'string' && name.trim() !== '').map(name => name.trim()))]

/** Single definition of configured output ports, types and runtime variable targets. */
export function nodeOutputDefinitions(node: WorkflowNode): NodeOutputDefinition[] {
  const c = node.config
  const result: NodeOutputDefinition[] = []
  const output = (name: string | undefined, label: string, type = 'any', variableName = name, declared = false): void => {
    if (name?.trim()) result.push({ name, label, type, variableName: variableName?.trim(), declared })
  }
  const primary = (name: string, label: string, type: string): void => {
    const target = 'outputMode' in c && (c.outputMode === 'declare' || c.outputMode === 'update') && c.updateVariable?.trim() ? c.updateVariable : name
    output(name, label, type, target, 'outputMode' in c && c.outputMode === 'declare')
  }
  if (c.type === 'approval') return approvalDataOutputs(c).map((item, index) => ({ ...item, variableName: index === 0 ? item.name : undefined, declared: index === 0, aliases: index === 0 && item.name !== 'reviewResult' ? ['reviewResult'] : [] }))
  if (c.type === 'extract') primary(c.outputName || 'text', '抽取结果', c.mode === 'list' ? 'array' : 'string')
  else if (c.type === 'transform') primary(c.outputName || 'result', '处理结果', 'any')
  else if (c.type === 'image-recognition') primary(c.outputName || 'imageResult', '图片识别结果', 'object')
  else if (c.type === 'list-row-action') output(c.outputName || 'listOperationResult', '列表操作结果', 'object')
  else if (c.type === 'switch') { if (c.mode === 'ai') output(c.reasonOutputName?.trim() || 'reason', 'AI 判断依据', 'string') }
  else if (c.type === 'agent' || c.type === 'code') {
    for (const item of c.outputs ?? []) {
      const target = (item.outputMode === 'declare' || item.outputMode === 'update') && item.updateVariable?.trim() ? item.updateVariable : item.name
      output(item.name, 'description' in item && typeof item.description === 'string' ? item.description || 'AI 结果' : '代码结果', item.valueType || 'any', target, item.outputMode === 'declare')
    }
    if (c.type === 'code' && result.length === 0) primary(c.outputName || 'result', '代码结果', 'object')
  } else if (c.type === 'api-request' || c.type === 'api-listen') {
    const type = c.responseType === 'json' ? 'object/array' : 'string'
    primary(c.outputName || (c.type === 'api-request' ? 'responseData' : 'tableData'), '接口数据', type)
    output(c.rawOutputName, '原始响应', type)
    for (const item of c.fields ?? []) output(item.name, item.path || '字段变量')
  } else if (c.type === 'page-action') {
    for (const step of c.steps) if (step.type === 'extract') {
      const target = (step.outputMode === 'declare' || step.outputMode === 'update') && step.updateVariable?.trim() ? step.updateVariable : step.outputName
      output(step.outputName || 'text', '抽取结果', step.ai?.enabled ? 'array' : 'string', target, step.outputMode === 'declare')
    }
  } else if (c.type === 'for-each') {
    output('item', '当前项'); output('index', '当前索引', 'number')
    output(c.itemVar || 'item', '当前项'); output(c.indexVar || 'index', '当前索引', 'number')
    for (const name of c.declaredVariables ?? []) output(name, '当前项字段')
  } else for (const port of NODE_CATALOG[node.type].dataOutputs) output(port.name, port.label)
  return result.filter((item, index, all) => all.findIndex(other => other.name === item.name) === index)
}

export function nodeDeclaredVariables(node: WorkflowNode): { name: string; type: string }[] {
  if (node.config.type === 'set-variable') return node.config.name.trim() ? [{ name: node.config.name.trim(), type: node.config.valueType || '自动' }] : []
  return nodeOutputDefinitions(node).filter(item => item.declared && item.variableName).map(item => ({ name: item.variableName!, type: item.type }))
}

/** Names actually registered in the shared execution context, including known object fields. */
export function nodeVariableNames(node: WorkflowNode): string[] {
  const c = node.config
  if (c.type === 'approval') return approvalVariablePaths(c)
  if (c.type === 'set-variable') return unique([c.name])
  return unique([...nodeOutputDefinitions(node).map(item => item.variableName), ...(c.type === 'for-each' ? ['currentItem', 'currentIndex'] : [])])
}
function nestedNames(root: string, value: JsonValue | undefined, depth = 0): string[] {
  if (value === null || value === undefined || depth >= 3 || typeof value !== 'object') return []
  const entries = Array.isArray(value) ? value.slice(0, 1).map((item, index) => [`[${index}]`, item] as const) : Object.entries(value).filter(([key]) => !/[.[\]]/.test(key))
  return entries.flatMap(([key, item]) => { const path = key.startsWith('[') ? `${root}${key}` : `${root}.${key}`; return [path, ...nestedNames(path, item, depth + 1)] })
}

/** All pickers use this collector; nodeId restricts results to reachable predecessors. */
export function availableVariableNames(graph: WorkflowGraph, nodeId: string, extras: readonly string[] = [], options: { includeInputs?: boolean } = {}): string[] {
  const before = upstreamNodes(graph, nodeId)
  return unique([
    ...(options.includeInputs === false ? [] : (graph.context?.inputs ?? []).flatMap(item => [`inputs.${item.name}`, ...nestedNames(`inputs.${item.name}`, item.defaultValue)])),
    ...(graph.context?.variables ?? []).flatMap(item => [item.name, ...nestedNames(item.name, item.defaultValue)]),
    ...before.flatMap(nodeVariableNames),
    'failureCount', 'successCount',
    ...before.filter(node => node.type === 'for-each').flatMap(node => [`failureCount_${node.id}`, `successCount_${node.id}`]),
    ...extras,
  ])
}
