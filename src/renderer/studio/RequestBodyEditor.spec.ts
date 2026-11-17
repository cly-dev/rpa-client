import { expect, it } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import type { NodeConfig } from '@graph/types.ts'
import { availableVariables } from './RequestBodyEditor.tsx'

it('lists declared, nested, response, code, and loop variables for request bodies', () => {
  const start = createNode('start', { x: 0, y: 0 })
  const request = createNode('api-request', { x: 0, y: 0 })
  const loop = createNode('for-each', { x: 0, y: 0 })
  const code = createNode('code', { x: 0, y: 0 })
  const aiSwitch = createNode('switch', { x: 0, y: 0 })
  const target = createNode('api-request', { x: 0, y: 0 })
  const later = createNode('api-request', { x: 0, y: 0 })
  const disconnected = createNode('api-request', { x: 0, y: 0 })
  const requestConfig = request.config as Extract<NodeConfig, { type: 'api-request' }>
  const loopConfig = loop.config as Extract<NodeConfig, { type: 'for-each' }>
  const codeConfig = code.config as Extract<NodeConfig, { type: 'code' }>
  const names = availableVariables({
    workflowId: 'request-body-scope', name: 'Request body scope', version: 1, entryNodeId: start.id,
    context: { inputs: [{ name: 'order', type: 'object', defaultValue: { customer: { id: 'A-1' } } }], variables: [{ name: 'token', type: 'string' }] },
    nodes: [
      start,
      { ...request, config: { ...requestConfig, outputName: 'responseData', rawOutputName: 'rawResponseData', fields: [{ name: 'total', path: 'data.total' }] } },
      { ...loop, config: { ...loopConfig, itemVar: 'row', indexVar: 'rowIndex', declaredVariables: ['sku'] } },
      { ...code, config: { ...codeConfig, outputs: [{ name: 'normalized', valueType: 'object' }] } },
      { ...aiSwitch, config: { type: 'switch', mode: 'ai', left: { kind: 'literal', value: '' }, path: '', cases: ['场景'], casePrompts: ['判断要求'], reasonOutputName: 'routeReason' } },
      target,
      { ...later, config: { ...requestConfig, outputName: 'laterResponse' } },
      { ...disconnected, config: { ...requestConfig, outputName: 'disconnectedResponse' } },
    ],
    edges: [createEdge(start.id, 'default', request.id), createEdge(request.id, 'default', loop.id), createEdge(loop.id, 'body', code.id), createEdge(code.id, 'default', aiSwitch.id), createEdge(aiSwitch.id, 'case-0', target.id), createEdge(target.id, 'default', later.id)],
  }, target.id, ['childPaymentTime'])

  expect(names).toEqual(expect.arrayContaining(['inputs.order', 'inputs.order.customer.id', 'token', 'responseData', 'rawResponseData', 'total', 'row', 'rowIndex', 'sku', 'normalized', 'routeReason', 'currentItem', 'childPaymentTime']))
  expect(names).not.toContain('laterResponse')
  expect(names).not.toContain('disconnectedResponse')
})

it.each([undefined, 'approvedReply'])('offers approval result fields to notifications and request bodies (%s)', outputName => {
  const start = createNode('start', { x: 0, y: 0 })
  const approval = createNode('approval', { x: 100, y: 0 })
  const notify = createNode('handoff', { x: 200, y: 0 })
  const later = createNode('approval', { x: 300, y: 0 })
  const name = outputName ?? 'reviewResult'
  const graph = { workflowId: 'approval-notice', name: '审批通知', version: 1, entryNodeId: start.id,
    nodes: [start, { ...approval, config: { ...approval.config, type: 'approval' as const, title: '确认', description: '', fields: [], timeoutMinutes: 30, requireCommentOnReject: false, outputName } }, notify, { ...later, config: { ...later.config, type: 'approval' as const, title: '稍后确认', description: '', fields: [], timeoutMinutes: 30, requireCommentOnReject: false, outputName: 'laterResult' } }],
    edges: [createEdge(start.id, 'default', approval.id), createEdge(approval.id, 'approved', notify.id), createEdge(notify.id, 'default', later.id)] }
  const names = availableVariables(graph, notify.id)
  expect(names).toEqual(expect.arrayContaining([name, `${name}.content`, `${name}.plainText`, `${name}.modified`, `${name}.comment`]))
  expect(names).not.toContain('laterResult')
  expect(availableVariables(graph, approval.id)).not.toContain(name)
})
