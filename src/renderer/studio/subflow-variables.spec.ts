import { describe, expect, it } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { availableSubflowVariableNames } from './subflow-variables.ts'

describe('availableSubflowVariableNames', () => {
  it('offers child variables only after the call is connected and includes nested child outputs', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const call = { ...createNode('call-subflow', { x: 100, y: 0 }), config: { type: 'call-subflow' as const, workflowId: 'child', workflowVersion: 2 } }
    const after = createNode('condition', { x: 200, y: 0 })
    const parent: WorkflowGraph = { workflowId: 'parent', name: 'Parent', version: 1, entryNodeId: start.id, nodes: [start, call, after], edges: [createEdge(start.id, 'default', call.id), createEdge(call.id, 'default', after.id)] }
    const childStart = createNode('start', { x: 0, y: 0 })
    const childSet = { ...createNode('set-variable', { x: 100, y: 0 }), config: { type: 'set-variable' as const, name: 'orderId', value: { kind: 'literal' as const, value: 'A1' }, path: '' } }
    const childCall = { ...createNode('call-subflow', { x: 200, y: 0 }), config: { type: 'call-subflow' as const, workflowId: 'nested', workflowVersion: 1 } }
    const child: WorkflowGraph = { workflowId: 'child', name: 'Child', version: 2, entryNodeId: childStart.id, nodes: [childStart, childSet, childCall], edges: [], context: { inputs: [], variables: [{ name: 'token', type: 'string' }] } }
    const nestedStart = createNode('start', { x: 0, y: 0 })
    const nestedRequest = { ...createNode('api-request', { x: 100, y: 0 }), config: { type: 'api-request' as const, url: '', method: 'GET', body: '', responseType: 'json' as const, jsonPath: '', outputName: 'payment', fields: [{ name: 'paymentTime', path: 'data.time' }], timeoutMs: 15000 } }
    const nested: WorkflowGraph = { workflowId: 'nested', name: 'Nested', version: 1, entryNodeId: nestedStart.id, nodes: [nestedStart, nestedRequest], edges: [] }

    expect(availableSubflowVariableNames(parent, [child, nested], call.id)).toEqual([])
    expect(availableSubflowVariableNames(parent, [child, nested], after.id)).toEqual(expect.arrayContaining(['token', 'orderId', 'payment', 'paymentTime']))
    expect(availableSubflowVariableNames({ ...parent, edges: parent.edges.slice(0, 1) }, [child, nested], after.id)).toEqual([])
  })
})
