import { describe, expect, it } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import { parseWorkflow } from '@graph/parse.ts'
import { normalizeNotificationNodes } from '@graph/notification-node.ts'
import { validateGraph } from '@graph/validate.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { walkGraph } from './walk.ts'
import { runBrowser } from './browser-run.ts'
import { selectedWebhookDestinations } from '@graph/webhook-destinations.ts'

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

  it('round-trips multiple Webhook targets and validates each trigger selection', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const end = createNode('end', { x: 100, y: 0 })
    const webhook = {
      url: 'https://oapi.dingtalk.com/robot/send?access_token=one', provider: 'dingtalk' as const,
      destinations: [
        { id: 'first', name: '客服', url: 'https://oapi.dingtalk.com/robot/send?access_token=one' },
        { id: 'second', name: '运营', url: 'https://oapi.dingtalk.com/robot/send?access_token=two' },
      ], onFinished: true, onFinishedDestinationIds: ['second'],
    }
    const workflow: WorkflowGraph = {
      workflowId: 'multi-webhook', name: '多目标通知', version: 1, entryNodeId: start.id,
      nodes: [{ ...start, notifications: { enabled: true, onSuccess: true, destinationIds: { onSuccess: ['first', 'second'] } } }, end],
      edges: [createEdge(start.id, 'default', end.id)], webhook,
    }
    const parsed = parseWorkflow(JSON.parse(JSON.stringify(workflow)))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.graph.webhook?.destinations).toEqual(webhook.destinations)
      expect(parsed.graph.nodes[0]?.notifications?.destinationIds?.onSuccess).toEqual(['first', 'second'])
      expect(selectedWebhookDestinations(parsed.graph.webhook, parsed.graph.webhook?.onFinishedDestinationIds).map(item => item.id)).toEqual(['second'])
      expect(validateGraph(parsed.graph)).toEqual([])
      expect(validateGraph({ ...parsed.graph, nodes: [{ ...parsed.graph.nodes[0]!, notifications: { ...parsed.graph.nodes[0]!.notifications, destinationIds: { onSuccess: ['missing'] } } }, end] }).map(issue => issue.code)).toContain('webhook-url-invalid')
    }
  })

  it('attaches the actual failure reason to result-based node notifications', async () => {
    const original = graph()
    const failed = await walkGraph(original, { onUpdate() {}, wait: async () => {} }, async () => ({ message: '页面按钮不可见', halt: 'failed' }))
    const event = failed.logs.find(line => line.notificationEvent === 'node.failed')
    expect(event?.message).toContain('节点「开始」(start)执行失败：页面按钮不可见')
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

  it('captures the failed loop item variables for every Webhook event', async () => {
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
    expect(events).toHaveLength(2)
    expect(events[0]?.message).toContain('第 1 轮执行失败')
    expect(events[0]?.message).toContain('节点「输入」：失败，已停下来等人：输入框不可用')
    expect(events[0]?.notificationValues).toEqual({ currentIndex: 0 })
    expect(events[1]?.message).toContain('第 2 轮执行失败')
    expect(events[1]?.notificationValues).toEqual({ currentIndex: 1 })
  })

  it('reports completed loop item counts in a notification on the done exit', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const loop = createNode('for-each', { x: 100, y: 0 })
    const action = createNode('type', { x: 200, y: 0 })
    const continueLoop = createNode('continue-loop', { x: 300, y: 0 })
    const notification = createNode('handoff', { x: 400, y: 0 })
    const end = createNode('end', { x: 500, y: 0 })
    const workflow: WorkflowGraph = {
      workflowId: 'loop-done-counts', name: '循环完成统计', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...loop, config: { ...loop.config, type: 'for-each', collection: { kind: 'literal', value: ['A', 'B', 'C'] }, onItemError: 'skip' } },
        { ...action, config: { type: 'type', selector: '#field', text: { kind: 'literal', value: '{{currentItem}}' }, path: '' } },
        continueLoop,
        { ...notification, notifications: { enabled: true, onSuccess: true, messageTemplate: '本轮共成功{{successCount}}条，失败{{failureCount}}条' } },
        end,
      ],
      edges: [
        createEdge(start.id, 'default', loop.id), createEdge(loop.id, 'body', action.id),
        createEdge(action.id, 'default', continueLoop.id), createEdge(loop.id, 'done', notification.id),
        createEdge(notification.id, 'default', end.id),
      ],
      webhook: { url: 'https://oapi.dingtalk.com/robot/send?access_token=test', provider: 'dingtalk' },
    }
    const run = (failOnB: boolean) => runBrowser(workflow, {
      ...noPageDriver,
      async type(_selector: string, value: string) { if (failOnB && value === 'B') throw new Error('输入失败') },
    }, { onUpdate() {}, wait: async () => {} })

    const partiallyFailed = await run(true)
    expect(partiallyFailed.status).toBe('succeeded')
    expect(partiallyFailed.variables?.[`successCount_${loop.id}`]).toBe(2)
    expect(partiallyFailed.variables?.[`failureCount_${loop.id}`]).toBe(1)
    expect(partiallyFailed.logs.find(line => line.nodeId === notification.id && line.notificationEvent === 'node.succeeded')?.notificationValues)
      .toEqual({ successCount: 2, failureCount: 1 })

    const allSucceeded = await run(false)
    expect(allSucceeded.status).toBe('succeeded')
    expect(allSucceeded.variables?.[`failureCount_${loop.id}`]).toBe(0)
    expect(allSucceeded.logs.find(line => line.nodeId === notification.id && line.notificationEvent === 'node.succeeded')?.notificationValues)
      .toEqual({ successCount: 3, failureCount: 0 })
  })

  it('notifies a call-subflow node only after its child finishes, and reports child failure', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const call = createNode('call-subflow', { x: 100, y: 0 })
    const end = createNode('end', { x: 200, y: 0 })
    const childStart = createNode('start', { x: 0, y: 0 })
    const childAction = createNode('type', { x: 100, y: 0 })
    const childEnd = createNode('end', { x: 200, y: 0 })
    const parent: WorkflowGraph = {
      workflowId: 'notify-call-parent', name: 'Parent', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...call, config: { type: 'call-subflow', workflowId: 'notify-call-child', workflowVersion: 1, inputMappings: [] }, notifications: { enabled: true, onSuccess: true, onFailure: true, messageTemplate: '子流程状态：{{event.status}}' } },
        end,
      ],
      edges: [createEdge(start.id, 'default', call.id), createEdge(call.id, 'default', end.id)],
      webhook: { url: 'https://oapi.dingtalk.com/robot/send?access_token=test', provider: 'dingtalk' },
    }
    const child: WorkflowGraph = {
      workflowId: 'notify-call-child', name: 'Child', version: 1, entryNodeId: childStart.id,
      nodes: [
        { ...childStart, config: { type: 'start', url: '' } },
        { ...childAction, config: { type: 'type', selector: '#field', text: { kind: 'literal', value: 'hello' }, path: '' } },
        childEnd,
      ],
      edges: [createEdge(childStart.id, 'default', childAction.id), createEdge(childAction.id, 'default', childEnd.id)],
    }
    const run = (fails: boolean) => runBrowser(parent, {
      ...noPageDriver,
      async type() { if (fails) throw new Error('子流程输入失败') },
    }, { onUpdate() {}, wait: async () => {} }, { subflows: [child] })

    const succeeded = await run(false)
    expect(succeeded.status).toBe('succeeded')
    const successEventIndex = succeeded.logs.findIndex(line => line.nodeId === call.id && line.notificationEvent === 'node.succeeded')
    const childReturnIndex = succeeded.logs.findIndex(line => line.nodeId.endsWith(`::${childEnd.id}`) && line.message.includes('状态：succeeded'))
    expect(successEventIndex).toBeGreaterThan(childReturnIndex)

    const failed = await run(true)
    expect(failed.status).toBe('failed')
    expect(failed.nodes[call.id]).toBe('failed')
    expect(failed.logs.some(line => line.nodeId === call.id && line.notificationEvent === 'node.succeeded')).toBe(false)
    expect(failed.logs.some(line => line.nodeId === call.id && line.notificationEvent === 'node.failed')).toBe(true)
  })

  it('notifies every successful child call made by a loop', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const loop = createNode('for-each', { x: 100, y: 0 })
    const call = createNode('call-subflow', { x: 200, y: 0 })
    const continueLoop = createNode('continue-loop', { x: 300, y: 0 })
    const end = createNode('end', { x: 400, y: 0 })
    const childStart = createNode('start', { x: 0, y: 0 })
    const childCall = createNode('call-subflow', { x: 100, y: 0 })
    const childEnd = createNode('end', { x: 200, y: 0 })
    const grandchildStart = createNode('start', { x: 0, y: 0 })
    const grandchildEnd = createNode('end', { x: 100, y: 0 })
    const parent: WorkflowGraph = {
      workflowId: 'loop-call-notify-parent', name: 'Parent', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: '' } },
        { ...loop, config: { ...loop.config, type: 'for-each', collection: { kind: 'literal', value: ['A', 'B'] } } },
        { ...call, config: { type: 'call-subflow', workflowId: 'loop-call-notify-child', workflowVersion: 1, inputMappings: [] }, notifications: { enabled: true, onSuccess: true } },
        continueLoop, end,
      ],
      edges: [
        createEdge(start.id, 'default', loop.id), createEdge(loop.id, 'body', call.id),
        createEdge(call.id, 'default', continueLoop.id), createEdge(loop.id, 'done', end.id),
      ],
      webhook: { url: 'https://oapi.dingtalk.com/robot/send?access_token=test', provider: 'dingtalk' },
    }
    const child: WorkflowGraph = {
      workflowId: 'loop-call-notify-child', name: 'Child', version: 1, entryNodeId: childStart.id,
      nodes: [
        { ...childStart, config: { type: 'start', url: '' } },
        { ...childCall, config: { type: 'call-subflow', workflowId: 'loop-call-notify-grandchild', workflowVersion: 1, inputMappings: [] }, notifications: { enabled: true, onSuccess: true } },
        childEnd,
      ],
      edges: [createEdge(childStart.id, 'default', childCall.id), createEdge(childCall.id, 'default', childEnd.id)],
      webhook: { url: 'https://oapi.dingtalk.com/robot/send?access_token=child', provider: 'dingtalk' },
    }
    const grandchild: WorkflowGraph = {
      workflowId: 'loop-call-notify-grandchild', name: 'Grandchild', version: 1, entryNodeId: grandchildStart.id,
      nodes: [{ ...grandchildStart, config: { type: 'start', url: '' } }, grandchildEnd],
      edges: [createEdge(grandchildStart.id, 'default', grandchildEnd.id)],
    }
    const state = await runBrowser(parent, noPageDriver, { onUpdate() {}, wait: async () => {} }, { subflows: [child, grandchild] })
    expect(state.status).toBe('succeeded')
    expect(state.logs.filter(line => line.nodeId === call.id && line.notificationEvent === 'node.succeeded')).toHaveLength(2)
    expect(state.logs.filter(line => line.nodeId.endsWith(`::${childCall.id}`) && line.notificationEvent === 'node.succeeded')).toHaveLength(2)
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
