import { describe, expect, it } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import { parseWorkflow } from '@graph/parse.ts'
import { normalizeNotificationNodes } from '@graph/notification-node.ts'
import { validateGraph } from '@graph/validate.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { walkGraph } from './walk.ts'
import { runBrowser } from './browser-run.ts'

const noPageDriver = {
  async openPage() {}, async click() {}, async type() {}, async extract() { return '' }, async waitFor() {},
}

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
  it('creates notification nodes with Webhook delivery enabled and requires a shared address', () => {
    const notification = createNode('handoff', { x: 100, y: 0 })
    expect(notification.name).toBe('通知')
    expect(notification.notifications).toMatchObject({ enabled: true, onSuccess: true })
    const start = createNode('start', { x: 0, y: 0 })
    const end = createNode('end', { x: 200, y: 0 })
    const workflow: WorkflowGraph = {
      workflowId: 'notify-node', name: '通知节点', version: 1, entryNodeId: start.id,
      nodes: [start, notification, end],
      edges: [createEdge(start.id, 'default', notification.id), createEdge(notification.id, 'default', end.id)],
    }
    expect(validateGraph(workflow).map(issue => issue.code)).toContain('webhook-url-missing')
  })

  it('migrates a legacy handoff note into notification content and emits a node event', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const legacy = createNode('handoff', { x: 100, y: 0 })
    const end = createNode('end', { x: 200, y: 0 })
    const workflow: WorkflowGraph = {
      workflowId: 'legacy-handoff', name: '旧流程', version: 1, entryNodeId: start.id,
      context: { inputs: [{ name: 'orderId', type: 'string' }], variables: [] },
      nodes: [start, { ...legacy, config: { type: 'handoff', note: '请处理订单 {{inputs.orderId}}' }, notifications: undefined }, end],
      edges: [createEdge(start.id, 'default', legacy.id), createEdge(legacy.id, 'default', end.id)],
      webhook: { url: 'https://oapi.dingtalk.com/robot/send?access_token=test', provider: 'dingtalk' },
    }
    const parsed = parseWorkflow(JSON.parse(JSON.stringify(workflow)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.graph.nodes[1]?.notifications).toMatchObject({ enabled: true, onSuccess: true, messageTemplate: '请处理订单 {{inputs.orderId}}' })
    const state = await runBrowser(parsed.graph, noPageDriver, { onUpdate() {}, wait: async () => {} }, { inputs: { orderId: 'A-123' } })
    expect(state.status).toBe('succeeded')
    const event = state.logs.find(line => line.nodeId === legacy.id && line.notificationEvent === 'node.succeeded')
    expect(event?.notificationValues).toEqual({ 'inputs.orderId': 'A-123' })
  })

  it('upgrades raw service graphs without exposing hidden success or failure settings', () => {
    const legacy = { ...createNode('handoff', { x: 0, y: 0 }), name: '人工接管', config: { type: 'handoff' as const, note: '请查看 {{inputs.orderId}}' }, notifications: { enabled: false, onFailure: true } }
    const workflow: WorkflowGraph = { workflowId: 'old', name: '旧流程', version: 1, entryNodeId: legacy.id, nodes: [legacy], edges: [] }
    const upgraded = normalizeNotificationNodes(workflow)
    expect(upgraded.nodes[0]?.name).toBe('通知')
    expect(upgraded.nodes[0]?.notifications).toEqual({ enabled: true, onSuccess: true, onFailure: false, messageTemplate: '请查看 {{inputs.orderId}}' })
    expect(normalizeNotificationNodes(upgraded)).toBe(upgraded)
    expect(validateGraph(workflow).map(issue => issue.code)).toContain('webhook-url-missing')
  })

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
    const state = await runBrowser(workflow, noPageDriver, { onUpdate() {}, wait: async () => {} }, { inputs: { orderId: 'A-1' }, stopAfterNodeId: start.id })
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

  it('captures the failed loop item variables for one Webhook event', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const loop = createNode('for-each', { x: 100, y: 0 })
    const action = createNode('type', { x: 200, y: 0 })
    const end = createNode('end', { x: 300, y: 0 })
    const workflow: WorkflowGraph = {
      workflowId: 'loop-failed-item', name: '循环失败通知', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...loop, config: { ...loop.config, type: 'for-each', collection: { kind: 'literal', value: ['A', 'B'] }, onItemError: 'skip' }, notifications: { onFailure: true, messageTemplates: { onFailure: '第 {{currentIndex}} 项：{{event.message}}' } } },
        { ...action, config: { type: 'type', selector: '#field', text: { kind: 'literal', value: 'x' }, path: '' } },
        end,
      ],
      edges: [createEdge(start.id, 'default', loop.id), createEdge(loop.id, 'body', action.id), createEdge(loop.id, 'done', end.id)],
      webhook: { url: 'https://oapi.dingtalk.com/robot/send?access_token=test', provider: 'dingtalk' },
    }
    const state = await runBrowser(workflow, {
      ...noPageDriver,
      async type() { throw new Error('输入框不可用') },
    }, { onUpdate() {}, wait: async () => {} })
    expect(state.status).toBe('succeeded')
    const events = state.logs.filter(line => line.nodeId === loop.id && line.notificationEvent === 'node.failed')
    expect(events).toHaveLength(1)
    expect(events[0]?.message).toContain('第 1 轮执行失败')
    expect(events[0]?.notificationValues).toEqual({ currentIndex: 0 })
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
