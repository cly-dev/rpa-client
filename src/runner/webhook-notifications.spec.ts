import { describe, expect, it } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import { parseWorkflow } from '@graph/parse.ts'
import { validateGraph } from '@graph/validate.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { walkGraph } from './walk.ts'
import { runBrowser } from './browser-run.ts'

function graph(): WorkflowGraph {
  const start = createNode('start', { x: 0, y: 0 })
  const end = createNode('end', { x: 200, y: 0 })
  return {
    workflowId: 'webhook-test', name: '通知测试', version: 1, entryNodeId: start.id,
    nodes: [{ ...start, notifications: { onSuccess: true, onFailure: true, messageTemplates: { onSuccess: '成功：{{event.message}}', onFailure: '失败：{{event.message}}' } } }, end],
    edges: [createEdge(start.id, 'default', end.id)],
    webhook: { url: 'https://example.com/hooks/rpa', onFinished: true, bodyTemplate: '{"type":"{{event.eventType}}","version":"{{event.workflowVersion}}"}' },
  }
}

describe('workflow webhook notifications', () => {
  it('round-trips workflow and node settings and requires an address', () => {
    const original = graph()
    const parsed = parseWorkflow(JSON.parse(JSON.stringify(original)))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.graph.webhook).toEqual({ ...original.webhook, provider: 'generic' })
      expect(parsed.graph.nodes[0]?.notifications).toMatchObject({ onSuccess: true, onFailure: true, messageTemplates: { onSuccess: '成功：{{event.message}}', onFailure: '失败：{{event.message}}' } })
    }
    expect(validateGraph(original)).toEqual([])
    expect(validateGraph({ ...original, webhook: { url: '', onFinished: true } }).map(issue => issue.code)).toContain('webhook-url-missing')
    expect(validateGraph({ ...original, webhook: { url: 'https://example.com', bodyTemplate: '{"event":"{{event.unknown}}"}' } }).map(issue => issue.code)).toContain('webhook-body-invalid')
  })

  it('marks only configured final node outcomes as structured notification events', async () => {
    const original = graph()
    const handlers = { onUpdate() {}, wait: async () => {} }
    const success = await walkGraph(original, handlers, async () => ({ message: '完成' }))
    expect(success.logs.filter(line => line.notificationEvent).map(line => line.notificationEvent)).toEqual(['node.succeeded'])
    const failed = await walkGraph(original, handlers, async () => { throw new Error('测试失败') })
    expect(failed.logs.filter(line => line.notificationEvent).map(line => line.notificationEvent)).toEqual(['node.failed'])
  })

  it('captures referenced runtime values for server delivery without secret variables', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const workflow: WorkflowGraph = {
      workflowId: 'notification-values', name: '通知变量', version: 1, entryNodeId: start.id,
      context: {
        inputs: [{ name: 'orderId', type: 'string' }],
        variables: [{ name: 'total', type: 'number', defaultValue: 12 }, { name: 'secretToken', type: 'string', secret: true, defaultValue: 'hidden' }],
      },
      nodes: [{ ...start, config: { type: 'start', url: '' }, notifications: { onSuccess: true, onFailure: true, messageTemplate: '{{secretToken}}', messageTemplates: { onSuccess: '{{inputs.orderId}}', onFailure: '{{total}}' } } }],
      edges: [],
    }
    const state = await runBrowser(workflow, {}, { onUpdate() {}, wait: async () => {} }, { inputs: { orderId: 'A-1' }, stopAfterNodeId: start.id })
    expect(state.status).toBe('succeeded')
    expect(state.logs.find(line => line.notificationEvent === 'node.succeeded')?.notificationValues).toEqual({ 'inputs.orderId': 'A-1' })
  })

  it('uses the failure-specific template when a node fails', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const workflow: WorkflowGraph = {
      workflowId: 'notification-failure-values', name: '失败通知变量', version: 1, entryNodeId: start.id,
      context: { inputs: [], variables: [{ name: 'total', type: 'number', defaultValue: 12 }] },
      nodes: [{ ...start, config: { type: 'start', url: 'https://example.com' }, notifications: { onFailure: true, messageTemplates: { onSuccess: '{{unused}}', onFailure: '{{total}}' } } }],
      edges: [],
    }
    const state = await runBrowser(workflow, {
      async openPage() { throw new Error('打开失败') }, async click() {}, async type() {}, async extract() { return '' }, async waitFor() {},
    }, { onUpdate() {}, wait: async () => {} })
    expect(state.status).toBe('failed')
    expect(state.logs.find(line => line.notificationEvent === 'node.failed')?.notificationValues).toEqual({ total: 12 })
  })

  it('keeps webhook settings but does not notify or require an address when disabled', async () => {
    const original = graph()
    const disabled: WorkflowGraph = {
      ...original,
      nodes: [{ ...original.nodes[0]!, notifications: { enabled: false, onSuccess: true, messageTemplate: '{{unclosed' } }, ...original.nodes.slice(1)],
      webhook: { url: '' },
    }
    const parsed = parseWorkflow(JSON.parse(JSON.stringify(disabled)))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.graph.nodes[0]?.notifications?.enabled).toBe(false)
    expect(validateGraph(disabled).map(issue => issue.code)).not.toContain('webhook-url-missing')
    expect(validateGraph(disabled).map(issue => issue.code)).not.toContain('webhook-body-invalid')
    const result = await walkGraph(disabled, { onUpdate() {}, wait: async () => {} }, async () => ({ message: '完成' }))
    expect(result.logs.some(line => line.notificationEvent)).toBe(false)
  })
})
