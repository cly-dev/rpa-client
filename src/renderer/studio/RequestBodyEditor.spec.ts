import { expect, it } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import type { NodeConfig } from '@graph/types.ts'
import { availableVariables } from './RequestBodyEditor.tsx'

it('lists declared, nested, response, code, and loop variables for request bodies', () => {
  const start = createNode('start', { x: 0, y: 0 })
  const request = createNode('api-request', { x: 0, y: 0 })
  const loop = createNode('for-each', { x: 0, y: 0 })
  const code = createNode('code', { x: 0, y: 0 })
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
      target,
      { ...later, config: { ...requestConfig, outputName: 'laterResponse' } },
      { ...disconnected, config: { ...requestConfig, outputName: 'disconnectedResponse' } },
    ],
    edges: [createEdge(start.id, 'default', request.id), createEdge(request.id, 'default', loop.id), createEdge(loop.id, 'body', code.id), createEdge(code.id, 'default', target.id), createEdge(target.id, 'default', later.id)],
  }, target.id, ['childPaymentTime'])

  expect(names).toEqual(expect.arrayContaining(['inputs.order', 'inputs.order.customer.id', 'token', 'responseData', 'rawResponseData', 'total', 'row', 'rowIndex', 'sku', 'normalized', 'currentItem', 'childPaymentTime']))
  expect(names).not.toContain('laterResponse')
  expect(names).not.toContain('disconnectedResponse')
})
