import type { JsonValue, WorkflowGraph } from '@graph/types.ts'
import type { ScheduledSecretDefaults } from '../workflow-api.ts'

export function hydrateScheduledSecrets(graph: WorkflowGraph, defaults: readonly ScheduledSecretDefaults[]): WorkflowGraph {
  const found = defaults.find(item => item.workflowId === graph.workflowId && item.version === graph.version)
  const context = graph.context
  if (!context) return graph
  const restore = (items: typeof context.inputs, values: Readonly<Record<string, JsonValue>> | undefined) => items.map(item => {
    if (!item.secret || item.defaultValue !== '******') return item
    if (!values || !Object.prototype.hasOwnProperty.call(values, item.name)) {
      throw new Error(`定时执行缺少敏感变量「${item.name}」；请更新服务端后重试`)
    }
    return { ...item, defaultValue: values[item.name] }
  })
  return { ...graph, context: {
    ...context,
    inputs: restore(context.inputs, found?.inputs),
    variables: restore(context.variables, found?.variables),
  } }
}

export function scheduledSecretStrings(graphs: readonly WorkflowGraph[], inputs: Readonly<Record<string, JsonValue>>): string[] {
  const strings = new Set<string>()
  const add = (value: JsonValue | undefined): void => {
    if ((typeof value === 'string' && value.length > 0) || typeof value === 'number' || typeof value === 'boolean') strings.add(String(value))
    else if (Array.isArray(value)) value.forEach(add)
    else if (value && typeof value === 'object') Object.values(value).forEach(add)
  }
  for (const graph of graphs) {
    for (const item of graph.context?.variables ?? []) if (item.secret) add(item.defaultValue)
    for (const item of graph.context?.inputs ?? []) if (item.secret) add(graph === graphs[0] ? inputs[item.name] ?? item.defaultValue : item.defaultValue)
  }
  return [...strings].sort((a, b) => b.length - a.length)
}
