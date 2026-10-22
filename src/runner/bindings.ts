import type { JsonValue, NodeOutputs, ValueBinding } from '@graph/types.ts'

export function asText(value: JsonValue): string {
  if (typeof value === 'string') return value
  if (value === null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export function resolveBinding(outputs: Readonly<Record<string, NodeOutputs>>, binding: ValueBinding): JsonValue {
  if (binding.kind === 'literal') return binding.value
  if (binding.kind === 'workflow-input') return ''
  const nodeOut = outputs[binding.nodeId]
  if (nodeOut === undefined) return null
  return nodeOut[binding.port] ?? null
}

export function walkPath(value: JsonValue, path: string): string {
  return asText(walkJsonPath(value, path))
}

/** Read nested object and array paths such as data.records[0].id. */
export function walkJsonPath(value: JsonValue, path: string): JsonValue {
  if (path.trim() === '') return value
  let current: JsonValue = value
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  for (const part of parts) {
    if (current !== null && typeof current === 'object') {
      current = Array.isArray(current) ? current[Number(part)] ?? null : current[part] ?? null
    } else return null
  }
  return current
}
