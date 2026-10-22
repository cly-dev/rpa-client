import type { JsonValue, ValueBinding, WorkflowContextVariable, WorkflowGraph, WorkflowNode } from './types.ts'

type InputType = WorkflowContextVariable['type']
type InferredType = InputType | 'null' | 'unknown'

const TYPE_LABELS: Record<Exclude<InferredType, 'unknown'>, string> = {
  string: '文本',
  number: '数字',
  boolean: '布尔值',
  object: '对象',
  array: '数组',
  null: '空值',
}

function valueType(value: JsonValue): InferredType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value as InferredType
}

function outputType(node: WorkflowNode, port: string): InferredType {
  const config = node.config
  if (config.type === 'code') {
    const declared = config.outputs?.find(output => output.name === port)?.valueType
    return declared === undefined || declared === 'any' ? 'unknown' : declared
  }
  if (config.type === 'extract' && (config.outputName || 'text') === port) return config.mode === 'list' ? 'array' : 'string'
  if (config.type === 'page-action' && config.steps.some(step => step.type === 'extract' && step.outputName === port)) return 'string'
  if (config.type === 'api-request' && config.responseType === 'text' && (config.outputName || 'responseData') === port) return 'string'
  return 'unknown'
}

function referenceType(graph: WorkflowGraph, path: string): InferredType {
  if (path === 'page.url' || path === 'page.title' || path === 'runtime.executionId') return 'string'
  if (path.startsWith('inputs.')) return graph.context?.inputs.find(item => item.name === path.slice(7))?.type ?? 'unknown'
  if (path.startsWith('outputs.')) {
    const reference = path.slice(8)
    const node = graph.nodes.find(item => reference.startsWith(`${item.id}.`))
    return node === undefined ? 'unknown' : outputType(node, reference.slice(node.id.length + 1))
  }
  const name = path.startsWith('variables.') ? path.slice(10) : path
  return graph.context?.variables.find(item => item.name === name)?.type ?? 'unknown'
}

function bindingType(graph: WorkflowGraph, binding: ValueBinding): { type: InferredType; numericText: boolean } {
  if (binding.kind === 'workflow-input') return { type: graph.context?.inputs.find(item => item.name === binding.name)?.type ?? 'unknown', numericText: false }
  if (binding.kind === 'variable') return { type: referenceType(graph, binding.name), numericText: false }
  if (binding.kind === 'node-output') {
    const node = graph.nodes.find(item => item.id === binding.nodeId)
    return { type: node === undefined ? 'unknown' : outputType(node, binding.port), numericText: false }
  }
  if (binding.kind === 'runtime') return { type: 'string', numericText: false }
  if (typeof binding.value !== 'string') return { type: valueType(binding.value), numericText: false }
  const text = binding.value.trim()
  const exact = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(text)
  if (exact !== null) return { type: referenceType(graph, exact[1]), numericText: false }
  return { type: 'string', numericText: text !== '' && Number.isFinite(Number(text)) }
}

/** Returns only incompatibilities that can be established from the editor's known types. */
export function subflowInputTypeWarning(graph: WorkflowGraph, input: WorkflowContextVariable, source: ValueBinding): string | undefined {
  const inferred = bindingType(graph, source)
  if (inferred.type === 'unknown' || inferred.type === input.type) return undefined
  if (input.required && input.type === 'string' && inferred.type === 'number') return undefined
  const dynamicText = source.kind !== 'literal' || (typeof source.value === 'string' && /^\{\{\s*[^}]+?\s*\}\}$/.test(source.value.trim()))
  // 动态文本可能在运行时得到有效数字，不能提前断言其值一定错误。
  if (input.required && input.type === 'number' && inferred.type === 'string' && (inferred.numericText || dynamicText)) return undefined
  return `当前传入值为${TYPE_LABELS[inferred.type]}，子流程输入「${input.description || input.name}」需要${TYPE_LABELS[input.type]}。`
}
