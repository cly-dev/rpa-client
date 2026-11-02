/** Keep execution-center and scheduled-run logs consistent and bounded. */
import type { JsonValue } from '@graph/types.ts'

export function redactExecutionJson(value: JsonValue, secrets: readonly string[]): JsonValue {
  if (typeof value === 'string') return secrets.reduce((result, secret) => secret ? result.split(secret).join('••••••') : result, value)
  if (typeof value === 'number' || typeof value === 'boolean') return secrets.includes(String(value)) ? '******' : value
  if (Array.isArray(value)) return value.map(item => redactExecutionJson(item, secrets))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /password|secret|token/i.test(key) ? '******' : redactExecutionJson(item, secrets),
  ]))
  return value
}

export function safeEventMessage(message: string, secrets: readonly string[] = []): string {
  if (message.startsWith('变量已更新：')) return '变量已更新（具体值不写入执行日志）'
  const produced = /^产出变量 (.+?) = /.exec(message)
  const safe = produced !== null ? `产出变量 ${produced[1]}（具体值不写入执行日志）` : message
  const redacted = secrets.reduce((result, secret) => secret.length > 0 ? result.split(secret).join('••••••') : result, safe)
  return redacted.length > 4_800 ? `${redacted.slice(0, 4_780)}…（日志已截断）` : redacted
}
