import type { JsonValue, SetVariableConfig } from '@graph/types.ts'

export function convertSetVariableValue(value: JsonValue, type: SetVariableConfig['valueType'], name: string): JsonValue {
  if (type === undefined) return value
  const invalid = (): never => { throw new Error(`设置变量「${name}」需要${type}类型的值`) }
  if (type === 'string') {
    if (value === null) return invalid()
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  if (type === 'number') {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
    return typeof number === 'number' && Number.isFinite(number) ? number : invalid()
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (normalized === 'true') return true
      if (normalized === 'false') return false
    }
    return invalid()
  }
  let parsed: JsonValue = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as JsonValue }
    catch { return invalid() }
  }
  if (type === 'array') return Array.isArray(parsed) ? parsed : invalid()
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : invalid()
}
