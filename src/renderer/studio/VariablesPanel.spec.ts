import { describe, expect, it } from 'vitest'
import { createNode } from '@graph/mutate.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { serializeAllVariables } from './VariablesPanel.tsx'

describe('VariablesPanel clipboard export', () => {
  it('serializes inputs, variables, node outputs, and page environment', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: 'wf-copy', name: '复制变量', version: 1, entryNodeId: start.id,
      nodes: [start], edges: [],
      context: {
        inputs: [{ name: 'orderId', type: 'string', defaultValue: 'default-order' }],
        variables: [{ name: 'shopId', type: 'string', defaultValue: 'default-shop' }],
      },
    }
    const copied = JSON.parse(serializeAllVariables(
      graph,
      { [start.id]: { token: 'abc' } },
      { orderId: 'ORDER-1' },
      { shopId: 'SHOP-1', runtimeOnly: 2 },
      { url: 'https://example.com', title: '订单' },
    )) as Record<string, any>
    expect(copied.inputs.orderId).toBe('ORDER-1')
    expect(copied.variables).toMatchObject({ shopId: 'SHOP-1', runtimeOnly: 2 })
    expect(copied.nodeOutputs[0]).toMatchObject({ nodeId: start.id, values: { token: 'abc' } })
    expect(copied.page.title).toBe('订单')
  })
})

it('includes a declared approval result before execution and serializes its runtime value', () => {
  const approval = createNode('approval', { x: 0, y: 0 })
  const graph: WorkflowGraph = { workflowId: 'review-vars', name: '审核变量', version: 1, entryNodeId: approval.id, edges: [], nodes: [{ ...approval, config: { ...approval.config, type: 'approval', title: '确认', description: '', fields: [], requireCommentOnReject: false, timeoutMinutes: 30, outputName: 'approvedReply' } }] }
  expect(JSON.parse(serializeAllVariables(graph)).variables).toHaveProperty('approvedReply', null)
  const result = { content: '<p>通过</p>', plainText: '通过', modified: true, comment: '' }
  expect(JSON.parse(serializeAllVariables(graph, { [approval.id]: { approvedReply: result } })).variables.approvedReply).toEqual(result)
})
