export const WEBHOOK_BODY_FIELDS = [
  'event.eventId', 'event.eventType', 'event.executionId',
  'event.workflowId', 'event.workflowName', 'event.workflowVersion',
  'event.executor.id', 'event.executor.name',
  'event.node.id', 'event.node.name', 'event.approvalId',
  'event.status', 'event.message', 'event.occurredAt',
] as const

const FIELD_SET = new Set<string>(['event', ...WEBHOOK_BODY_FIELDS])

/** An empty template keeps the original structured webhook payload. */
export function webhookBodyTemplateError(template: string, provider: 'generic' | 'dingtalk' = 'generic'): string | undefined {
  if (template.trim() === '') return undefined
  if (template.length > 32_768) return 'Webhook 消息体不能超过 32 KB'
  let parsed: unknown
  try { parsed = JSON.parse(template) }
  catch { return 'Webhook 消息体必须是有效的 JSON 对象；变量需写在 JSON 字符串中' }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'Webhook 消息体顶层必须是 JSON 对象'
  const check = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
      const references = [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)]
      for (const reference of references) {
        if (!FIELD_SET.has(reference[1].trim())) return `Webhook 消息体引用了不支持的字段：${reference[1].trim()}`
      }
      const remainder = value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, '')
      if (remainder.includes('{{') || remainder.includes('}}')) return 'Webhook 消息体包含未闭合的变量引用'
      return undefined
    }
    if (Array.isArray(value)) return value.map(check).find(Boolean)
    if (value && typeof value === 'object') return Object.values(value).map(check).find(Boolean)
    return undefined
  }
  const fieldError = check(parsed)
  if (fieldError !== undefined) return fieldError
  if (provider === 'dingtalk') {
    const body = parsed as Record<string, unknown>
    if (body.msgtype === 'text') {
      const content = body.text && typeof body.text === 'object' && !Array.isArray(body.text) ? (body.text as Record<string, unknown>).content : undefined
      if (typeof content !== 'string' || content.trim() === '') return '钉钉文本消息需要 text.content'
    } else if (body.msgtype === 'markdown') {
      const markdown = body.markdown && typeof body.markdown === 'object' && !Array.isArray(body.markdown) ? body.markdown as Record<string, unknown> : undefined
      if (typeof markdown?.title !== 'string' || !markdown.title.trim() || typeof markdown.text !== 'string' || !markdown.text.trim()) return '钉钉 Markdown 消息需要 markdown.title 和 markdown.text'
    } else return '钉钉消息体 msgtype 目前支持 text 或 markdown'
  }
  return undefined
}

export function validDingTalkRobotUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'oapi.dingtalk.com' && url.pathname === '/robot/send' && !!url.searchParams.get('access_token')
  } catch { return false }
}

const CONTENT_REFERENCE = /\{\{\s*([^{}]+?)\s*\}\}/g

export function notificationContentReferences(template: string): string[] {
  return [...template.matchAll(CONTENT_REFERENCE)].map(match => match[1].trim())
}

export function notificationContentError(template: string): string | undefined {
  if (template.length > 4_096) return '通知内容不能超过 4096 字'
  const remainder = template.replace(CONTENT_REFERENCE, '')
  if (remainder.includes('{{') || remainder.includes('}}')) return '通知内容存在未闭合的变量引用'
  for (const path of notificationContentReferences(template)) {
    if (FIELD_SET.has(path)) continue
    if (/^(?:inputs|variables|outputs)\.[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.\[\]-]*$/.test(path)) continue
    if (/^[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.\[\]-]*$/.test(path)) continue
    return `不支持的通知变量：${path}`
  }
  return undefined
}
