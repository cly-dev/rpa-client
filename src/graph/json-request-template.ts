interface Placeholder {
  readonly marker: string
  readonly expression: string
}

function maskPlaceholders(template: string, forFormatting: boolean): { text: string; placeholders: Placeholder[] } {
  const placeholders: Placeholder[] = []
  let text = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < template.length;) {
    if (template.startsWith('{{', index)) {
      const end = template.indexOf('}}', index + 2)
      if (end !== -1) {
        const expression = template.slice(index, end + 2)
        if (inString) text += expression
        else if (forFormatting) {
          let marker = `__RPA_JSON_VARIABLE_${placeholders.length}__`
          while (template.includes(marker)) marker += '_'
          placeholders.push({ marker, expression })
          text += JSON.stringify(marker)
        } else text += `0${' '.repeat(expression.length - 1)}`
        index = end + 2
        escaped = false
        continue
      }
    }
    const char = template[index]
    text += char
    if (char === '"' && !escaped) inString = !inString
    if (char === '\\') escaped = !escaped
    else escaped = false
    index += 1
  }
  return { text, placeholders }
}

function syntaxMessage(error: unknown, template: string): string {
  const detail = error instanceof Error ? error.message : String(error)
  const match = /position (\d+)/i.exec(detail)
  if (match === null) return `请求体 JSON 格式错误：${detail}`
  const position = Math.min(Number(match[1]), template.length)
  const before = template.slice(0, position)
  const line = before.split('\n').length
  const column = before.length - before.lastIndexOf('\n')
  return `请求体 JSON 格式错误（第 ${line} 行，第 ${column} 列）：${detail}`
}

export function isJsonRequestBodyTemplate(template: string): boolean {
  const trimmed = template.trim()
  // A raw GraphQL body also starts with "{"; leave non-JSON payloads alone.
  return /^\{\s*(?:"|\}|\{\{)/.test(trimmed)
    || /^\[\s*(?:"|\{|\[|\]|\{\{|true\b|false\b|null\b|-?\d)/.test(trimmed)
}

/** Check the JSON shape without requiring unquoted {{variable}} values to exist yet. */
export function jsonRequestBodyTemplateError(template: string): string | undefined {
  if (!isJsonRequestBodyTemplate(template)) return undefined
  try {
    JSON.parse(maskPlaceholders(template, false).text)
    return undefined
  } catch (error) {
    return syntaxMessage(error, template)
  }
}

/** Format JSON while preserving unquoted variable expressions as typed values. */
export function formatJsonRequestBodyTemplate(template: string): string {
  const error = jsonRequestBodyTemplateError(template)
  if (error !== undefined) throw new Error(error)
  const { text, placeholders } = maskPlaceholders(template, true)
  let formatted: string
  try { formatted = JSON.stringify(JSON.parse(text), null, 2) }
  catch (cause) { throw new Error(syntaxMessage(cause, template), { cause }) }
  for (const { marker, expression } of placeholders) formatted = formatted.split(JSON.stringify(marker)).join(expression)
  return formatted
}
