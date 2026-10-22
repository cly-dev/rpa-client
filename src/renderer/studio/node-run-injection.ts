import type { JsonValue, WorkflowNode } from '@graph/types.ts'

export type InjectionType = 'string' | 'number' | 'boolean' | 'json'
export interface InjectionRow {
  readonly key: string
  readonly name: string
  readonly type: InjectionType
  readonly value: string
  readonly source?: 'variable' | 'output'
  readonly nodeId?: string
  readonly port?: string
}

export function referencedInjections(node: WorkflowNode): InjectionRow[] {
  const found = new Map<string, InjectionRow>()
  const addVariable = (name: string): void => {
    if (!name || name.startsWith('page.') || name.startsWith('runtime.')) return
    const key = `variable:${name}`
    if (!found.has(key)) found.set(key, { key, name, type: 'string', value: '', source: 'variable' })
  }
  const addOutput = (nodeId: string, port: string): void => {
    if (!nodeId || !port) return
    const key = `output:${nodeId}:${port}`
    if (!found.has(key)) found.set(key, { key, name: `${nodeId}.${port}`, type: 'string', value: '', source: 'output', nodeId, port })
  }
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
        const path = match[1]?.trim() ?? ''
        if (path.startsWith('outputs.')) {
          const parts = path.slice('outputs.'.length).split('.')
          addOutput(parts[0] ?? '', parts[1] ?? '')
        } else if (path.startsWith('inputs.') || path.startsWith('page.') || path.startsWith('runtime.')) {
          continue
        } else addVariable(path.replace(/^variables\./, ''))
      }
    } else if (Array.isArray(value)) value.forEach(scan)
    else if (value !== null && typeof value === 'object') {
      const binding = value as Record<string, unknown>
      if (binding.kind === 'variable' && typeof binding.name === 'string') addVariable(binding.name)
      else if (binding.kind === 'node-output' && typeof binding.nodeId === 'string' && typeof binding.port === 'string') addOutput(binding.nodeId, binding.port)
      else Object.values(binding).forEach(scan)
    }
  }
  scan(node.inputBindings)
  scan(node.config)
  return [...found.values()]
}

function parseValue(row: InjectionRow): JsonValue {
  if (row.type === 'string') return row.value
  if (row.type === 'number') {
    const value = Number(row.value)
    if (!Number.isFinite(value)) throw new Error(`「${row.name}」需要填写有效数字`)
    return value
  }
  if (row.type === 'boolean') {
    if (row.value !== 'true' && row.value !== 'false') throw new Error(`请选择「${row.name}」的布尔值`)
    return row.value === 'true'
  }
  try { return JSON.parse(row.value) as JsonValue }
  catch { throw new Error(`「${row.name}」需要填写有效 JSON`) }
}

export function parseInjections(rows: readonly InjectionRow[]): {
  variables: Record<string, JsonValue>
  outputs: Record<string, Record<string, JsonValue>>
} {
  const variables: Record<string, JsonValue> = {}
  const outputs: Record<string, Record<string, JsonValue>> = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (!name && row.value.trim() === '') continue
    if (row.source !== 'output' && (!name || name.split('.').some(part => !part || part === '__proto__' || part === 'constructor' || part === 'prototype'))) throw new Error(`变量名无效：「${name}」`)
    if (row.value.trim() === '') continue
    const value = parseValue(row)
    if (row.source === 'output') {
      if (!row.nodeId || !row.port) continue
      outputs[row.nodeId] ??= {}
      outputs[row.nodeId][row.port] = value
    } else {
      const parts = name.split('.')
      let current: Record<string, JsonValue> = variables
      for (const part of parts.slice(0, -1)) {
        const existing = current[part]
        if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) current[part] = {}
        current = current[part] as Record<string, JsonValue>
      }
      current[parts.at(-1) as string] = value
    }
  }
  return { variables, outputs }
}
