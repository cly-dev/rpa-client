import vm from 'node:vm'
import type { JsonValue } from '@graph/types.ts'

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return typeof value === 'object' && value !== null && Object.values(value).every(isJsonValue)
}

/**
 * Runs workflow code in a capability-limited context with a hard synchronous timeout.
 * Node documents vm as not being a security boundary; workflow authors must be trusted.
 */
export function runWorkflowCode(code: string, input: JsonValue, variables: Readonly<Record<string, JsonValue>>, timeoutMs = 1000): JsonValue {
  const sandbox = Object.create(null) as Record<string, unknown>
  sandbox.input = structuredClone(input)
  sandbox.variables = structuredClone(variables)
  const script = new vm.Script(`'use strict'; (() => { ${code}\n })()`)
  const result = script.runInNewContext(sandbox, { timeout: Math.max(1, Math.min(timeoutMs, 5000)), contextCodeGeneration: { strings: false, wasm: false } })
  if (!isJsonValue(result)) throw new Error('代码必须返回 JSON 值')
  return JSON.parse(JSON.stringify(result)) as JsonValue
}
