import type { JsonValue, NodeOutputs, ValueBinding, WorkflowContextVariable, WorkflowLlmConfig } from '@graph/types.ts'
import { jsonRequestBodyTemplateError } from '@graph/json-request-template.ts'

export interface WorkflowContext {
  readonly inputs: Readonly<Record<string, JsonValue>>
  readonly variables: Record<string, JsonValue>
  readonly failures: Record<string, JsonValue>
  readonly successes: Record<string, JsonValue>
  readonly outputs: Record<string, NodeOutputs>
  readonly page: { url: string; title?: string }
  readonly runtime: { executionId: string; workflowId: string; deviceId?: string }
  readonly llm?: WorkflowLlmConfig
  readonly llms?: Readonly<Record<string, WorkflowLlmConfig>>
}

export type ContextPath = 'inputs' | 'variables' | 'outputs' | 'page' | 'runtime'

export function initialContextValues(definitions: readonly WorkflowContextVariable[] | undefined): Record<string, JsonValue> {
  return Object.fromEntries((definitions ?? []).map(definition => [definition.name, definition.defaultValue ?? null]))
}

/** Merge values supplied for this run without letting null erase a declared default. */
export function runtimeInputValues(
  definitions: readonly WorkflowContextVariable[] | undefined,
  supplied: Readonly<Record<string, JsonValue>> | undefined,
): Record<string, JsonValue> {
  const values = initialContextValues(definitions)
  const definitionByName = new Map((definitions ?? []).map(definition => [definition.name, definition]))
  for (const [name, value] of Object.entries(supplied ?? {})) {
    const definition = definitionByName.get(name)
    if (value === null && definition?.defaultValue !== undefined) continue
    values[name] = value
  }
  return values
}

function getPath(root: unknown, path: string): JsonValue {
  let current: unknown = root
  for (const part of path.split('.')) {
    if (part === '') continue
    const match = /^(.*?)(?:\[(\d+)\])?$/.exec(part)
    if (match === null || current === null || typeof current !== 'object') return null
    const key = match[1]
    current = Array.isArray(current) ? current[Number(key)] : (current as Record<string, unknown>)[key]
    if (match[2] !== undefined) current = Array.isArray(current) ? current[Number(match[2])] : undefined
  }
  return isJsonValue(current) ? current : null
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value === 'object') return Object.values(value).every(isJsonValue)
  return false
}

export function resolveExpression(expression: string, context: WorkflowContext): JsonValue {
  const trimmed = expression.trim()
  const exact = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(trimmed)
  const resolvePath = (path: string): JsonValue => {
    const direct = getPath(context, path)
    return direct !== null ? direct : getPath(context.variables, path)
  }
  if (exact !== null) return resolvePath(exact[1])
  return expression.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => stringify(resolvePath(path)))
}

/** Interpolate a request body for execution or diagnostic logging without validating its JSON syntax. */
export function resolveRequestBodyPreview(template: string, context: WorkflowContext): string {
  const trimmed = template.trim()
  if (/^\{\{\s*[^}]+?\s*\}\}$/.test(trimmed)) {
    const value = resolveExpression(trimmed, context)
    return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return String(resolveExpression(template, context))

  let result = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < template.length;) {
    if (template.startsWith('{{', index)) {
      const end = template.indexOf('}}', index + 2)
      if (end !== -1) {
        const value = resolveExpression(template.slice(index, end + 2), context)
        const replacement = inString
          ? JSON.stringify(value === null ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)).slice(1, -1)
          : JSON.stringify(value)
        result += replacement
        index = end + 2
        escaped = false
        continue
      }
    }
    const char = template[index]
    result += char
    if (char === '"' && !escaped) inString = !inString
    if (char === '\\') escaped = !escaped
    else escaped = false
    index += 1
  }
  return result
}

/** Interpolate JSON request bodies without breaking quoted string values. */
export function resolveRequestBody(template: string, context: WorkflowContext): string {
  const templateError = jsonRequestBodyTemplateError(template)
  if (templateError !== undefined) throw new Error(templateError)
  const result = resolveRequestBodyPreview(template, context)
  const trimmed = template.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return result
  const resolvedError = jsonRequestBodyTemplateError(result)
  if (resolvedError !== undefined) throw new Error(resolvedError)
  return result
}

function stringify(value: JsonValue): string {
  if (value === null) return ''
  if (typeof value === 'string') return value
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

export function resolveBindingInContext(binding: ValueBinding, context: WorkflowContext): JsonValue {
  if (binding.kind === 'literal') return binding.value
  if (binding.kind === 'workflow-input') return context.inputs[binding.name] ?? null
  if (binding.kind === 'variable') return getPath(context.variables, binding.name)
  if (binding.kind === 'runtime') {
    if (binding.path === 'page.url') return context.page.url
    if (binding.path === 'page.title') return context.page.title ?? ''
    return context.runtime.executionId
  }
  return context.outputs[binding.nodeId]?.[binding.port] ?? null
}

export function assignVariable(context: WorkflowContext, name: string, value: JsonValue): void {
  const clean = name.trim()
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(clean)) throw new Error(`变量名无效：${name}`)
  const parts = clean.split('.')
  let target = context.variables
  for (const part of parts.slice(0, -1)) {
    const current = target[part]
    if (current === null || typeof current !== 'object' || Array.isArray(current)) target[part] = {}
    target = target[part] as Record<string, JsonValue>
  }
  target[parts.at(-1) as string] = value
}
