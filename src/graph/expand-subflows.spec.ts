import { describe, expect, it } from 'vitest'
import { createEdge, createNode } from './mutate.ts'
import { expandSubflows } from './expand-subflows.ts'
import type { WorkflowGraph } from './types.ts'
import { runDry } from '../runner/dry-run.ts'

function graph(workflowId: string, nodes: WorkflowGraph['nodes'], edges: WorkflowGraph['edges'], entryNodeId: string, version = 1, context: WorkflowGraph['context'] = { inputs: [], variables: [] }): WorkflowGraph {
  return { workflowId, name: workflowId, version, entryNodeId, nodes, edges, context }
}

describe('expandSubflows', () => {
  it('splices child nodes into the parent chain and injects parent values through child inputs', async () => {
    const parentStart = createNode('start', { x: 0, y: 0 })
    const call = createNode('call-subflow', { x: 200, y: 0 })
    const readChildValue = createNode('set-variable', { x: 400, y: 0 })
    const parentEnd = createNode('end', { x: 600, y: 0 })
    const childStart = createNode('start', { x: 0, y: 0 })
    const childWrite = createNode('set-variable', { x: 200, y: 0 })
    const childEnd = createNode('end', { x: 400, y: 0 })
    const parent = graph('parent', [
      { ...parentStart, config: { type: 'start', url: 'https://parent.example' } },
      { ...call, config: { type: 'call-subflow', workflowId: 'child', workflowVersion: 3, inputMappings: [{ inputName: 'message', source: { kind: 'workflow-input', name: 'payload' } }] } },
      { ...readChildValue, config: { type: 'set-variable', name: 'result', value: { kind: 'variable', name: 'childValue' }, path: '' } },
      parentEnd,
    ], [
      createEdge(parentStart.id, 'default', call.id),
      createEdge(call.id, 'default', readChildValue.id),
      createEdge(readChildValue.id, 'default', parentEnd.id),
    ], parentStart.id, 1, { inputs: [{ name: 'payload', type: 'string', required: true }], variables: [] })
    const child = graph('child', [
      { ...childStart, config: { type: 'start', url: 'https://child.example' } },
      { ...childWrite, config: { type: 'set-variable', name: 'childValue', value: { kind: 'workflow-input', name: 'message' }, path: '' } },
      childEnd,
    ], [createEdge(childStart.id, 'default', childWrite.id), createEdge(childWrite.id, 'default', childEnd.id)], childStart.id, 3, {
      inputs: [{ name: 'message', type: 'string', required: true }],
      variables: [{ name: 'childValue', type: 'string', defaultValue: 'child-default' }],
    })

    const expanded = expandSubflows(parent, [child])
    const injected = expanded.nodes.find(node => node.name === '注入 message')
    const childValue = expanded.nodes.find(node => node.name === 'child · Set variable')
    const returnedEnd = expanded.nodes.find(node => node.name === 'child · 返回父流程')

    expect(injected?.config.type).toBe('set-variable')
    expect(childValue?.id).not.toBe(childWrite.id)
    expect(returnedEnd?.config.type).toBe('page-action')
    expect(expanded.edges.some(edge => edge.sourceNodeId === returnedEnd?.id && edge.targetNodeId === readChildValue.id)).toBe(true)
    expect(expanded.nodes.find(node => node.id === readChildValue.id)).toBeDefined()
    expect(expanded.context?.variables.some(item => item.name === 'childValue')).toBe(true)
  })

  it('rejects required child inputs with no mapping', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const call = createNode('call-subflow', { x: 200, y: 0 })
    const end = createNode('end', { x: 400, y: 0 })
    const childStart = createNode('start', { x: 0, y: 0 })
    const childEnd = createNode('end', { x: 200, y: 0 })
    const parent = graph('parent', [start, { ...call, config: { type: 'call-subflow', workflowId: 'child', workflowVersion: 1 } }, end], [createEdge(start.id, 'default', call.id), createEdge(call.id, 'default', end.id)], start.id)
    const child = graph('child', [childStart, childEnd], [createEdge(childStart.id, 'default', childEnd.id)], childStart.id, 1, { inputs: [{ name: 'token', type: 'string', required: true }], variables: [] })

    expect(() => expandSubflows(parent, [child])).toThrow('必填输入「token」尚未映射')
  })

  it('rejects recursive subflow calls', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const call = createNode('call-subflow', { x: 200, y: 0 })
    const end = createNode('end', { x: 400, y: 0 })
    const root = graph('root', [start, { ...call, config: { type: 'call-subflow', workflowId: 'child', workflowVersion: 1 } }, end], [createEdge(start.id, 'default', call.id), createEdge(call.id, 'default', end.id)], start.id)
    const childStart = createNode('start', { x: 0, y: 0 })
    const childCall = createNode('call-subflow', { x: 200, y: 0 })
    const childEnd = createNode('end', { x: 400, y: 0 })
    const child = graph('child', [childStart, { ...childCall, config: { type: 'call-subflow', workflowId: 'root', workflowVersion: 1 } }, childEnd], [createEdge(childStart.id, 'default', childCall.id), createEdge(childCall.id, 'default', childEnd.id)], childStart.id)

    expect(() => expandSubflows(root, [child, { ...root, version: 1 }])).toThrow('循环调用')
  })

  it('expands and executes more than 500 call sites without an arbitrary expansion limit', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const end = createNode('end', { x: 600, y: 0 })
    const calls = Array.from({ length: 501 }, (_, index) => {
      const node = createNode('call-subflow', { x: index * 200, y: 0 })
      return { ...node, config: { type: 'call-subflow' as const, workflowId: 'child', workflowVersion: 1 } }
    })
    const sequence = [start, ...calls, end]
    const parent = graph('parent', sequence, sequence.slice(0, -1).map((node, index) => createEdge(node.id, 'default', sequence[index + 1]!.id)), start.id)
    const childStart = createNode('start', { x: 0, y: 0 })
    const childEnd = createNode('end', { x: 200, y: 0 })
    const child = graph('child', [childStart, childEnd], [createEdge(childStart.id, 'default', childEnd.id)], childStart.id)

    const expanded = expandSubflows(parent, [child])

    expect(expanded.nodes).toHaveLength(sequence.length + calls.length * child.nodes.length)
    expect(expanded.nodes.filter(node => node.name === 'child · 返回父流程')).toHaveLength(calls.length)
    const result = await runDry(parent, { onUpdate() {}, wait: async () => {} }, [child])
    expect(result.status).toBe('succeeded')
  })
})
