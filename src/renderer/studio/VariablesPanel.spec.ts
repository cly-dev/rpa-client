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
