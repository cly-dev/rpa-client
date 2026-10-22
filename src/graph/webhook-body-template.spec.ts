import { describe, expect, it } from 'vitest'
import { notificationContentError, notificationContentReferences, webhookBodyTemplateError } from './webhook-body-template.ts'

describe('Webhook message template validation', () => {
  it('keeps an empty template as the default payload', () => {
    expect(webhookBodyTemplateError('')).toBeUndefined()
  })

  it('accepts supported fields inside a JSON object', () => {
    expect(webhookBodyTemplateError('{"type":"{{event.eventType}}","payload":"{{event}}"}')).toBeUndefined()
  })

  it('rejects malformed JSON, unknown fields, and unfinished references', () => {
    expect(webhookBodyTemplateError('{"type":"{{event.eventType}}"}}')).toContain('JSON')
    expect(webhookBodyTemplateError('{"type":"{{inputs.secret}}"}')).toContain('不支持的字段')
    expect(webhookBodyTemplateError('{"type":"{{event.eventType}} {{event.node"}')).toContain('未闭合')
  })

  it('checks DingTalk text and markdown payload shapes', () => {
    expect(webhookBodyTemplateError('{"msgtype":"text","text":{"content":"{{event.message}}"}}', 'dingtalk')).toBeUndefined()
    expect(webhookBodyTemplateError('{"msgtype":"markdown","markdown":{"title":"RPA","text":"{{event.message}}"}}', 'dingtalk')).toBeUndefined()
    expect(webhookBodyTemplateError('{"eventId":"{{event.eventId}}"}', 'dingtalk')).toContain('msgtype')
  })

  it('accepts plain notification text with runtime variables', () => {
    const content = '订单 {{inputs.orderId}}，金额 {{amount}}，节点 {{event.node.name}}'
    expect(notificationContentError(content)).toBeUndefined()
    expect(notificationContentReferences(content)).toEqual(['inputs.orderId', 'amount', 'event.node.name'])
    expect(notificationContentError('订单 {{inputs.orderId}')).toContain('未闭合')
  })
})
