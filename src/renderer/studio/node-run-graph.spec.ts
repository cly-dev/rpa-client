import { describe, expect, it } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import { expandSubflows } from '@graph/expand-subflows.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { flowNodeRunGraph, initialNodeRunMode, isolatedNodeRunGraph, nodeRunGraph } from './node-run-graph.ts'

describe('nodeRunGraph', () => {
  it('defaults subflow calls to the current-page mode', () => {
    expect(initialNodeRunMode('call-subflow')).toBe('direct')
    expect(initialNodeRunMode('click')).toBe('flow')
  })

  it('lets an isolated subflow call return to a temporary end without changing the canvas graph', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const call = { ...createNode('call-subflow', { x: 200, y: 0 }), config: { type: 'call-subflow' as const, workflowId: 'child', workflowVersion: 1 } }
    const next = createNode('set-variable', { x: 400, y: 0 })
    const realEnd = createNode('end', { x: 600, y: 0 })
    const parent: WorkflowGraph = {
      workflowId: 'parent', name: 'Parent', version: 1, entryNodeId: start.id,
      nodes: [start, call, next, realEnd],
      edges: [createEdge(start.id, 'default', call.id), createEdge(call.id, 'default', next.id), createEdge(next.id, 'default', realEnd.id)],
    }
    const childStart = createNode('start', { x: 0, y: 0 })
    const childEnd = createNode('end', { x: 200, y: 0 })
    const child: WorkflowGraph = {
      workflowId: 'child', name: 'Child', version: 1, entryNodeId: childStart.id,
      nodes: [childStart, childEnd], edges: [createEdge(childStart.id, 'default', childEnd.id)],
    }

    const isolated = nodeRunGraph(parent, call.id)
    const temporaryEnd = isolated.nodes.find(node => node.name === '单节点运行结束')
    expect(temporaryEnd?.type).toBe('end')
    expect(isolated.nodes.some(node => node.id === next.id)).toBe(false)
    expect(isolated.edges.some(edge => edge.sourceNodeId === call.id && edge.targetNodeId === temporaryEnd?.id)).toBe(true)
    expect(parent.nodes).toHaveLength(4)
    expect(parent.edges[1]?.targetNodeId).toBe(next.id)

    const expanded = expandSubflows(isolated, [child])
    const childReturn = expanded.nodes.find(node => node.name === 'Child · 返回父流程')
    expect(expanded.edges.some(edge => edge.sourceNodeId === childReturn?.id && edge.targetNodeId === temporaryEnd?.id)).toBe(true)
  })

  it('does not add a temporary end for other nodes', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const end = createNode('end', { x: 200, y: 0 })
    const graph: WorkflowGraph = { workflowId: 'plain', name: 'Plain', version: 1, entryNodeId: start.id, nodes: [start, end], edges: [createEdge(start.id, 'default', end.id)] }
    const isolated = nodeRunGraph(graph, end.id)
    expect(isolated.nodes).toHaveLength(2)
    expect(isolated.edges).toHaveLength(1)
  })

  it('preserves condition routes in flow mode but starts at the target in direct mode', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const condition = createNode('condition', { x: 100, y: 0 })
    const target = createNode('set-variable', { x: 200, y: 0 })
    const other = createNode('end', { x: 200, y: 100 })
    const graph: WorkflowGraph = { workflowId: 'routes', name: 'Routes', version: 1, entryNodeId: start.id, nodes: [start, condition, target, other], edges: [createEdge(start.id, 'default', condition.id), createEdge(condition.id, 'matched', target.id), createEdge(condition.id, 'else', other.id)] }

    expect(flowNodeRunGraph(graph, target.id)).toBe(graph)
    expect(isolatedNodeRunGraph(graph, target.id)).toMatchObject({ entryNodeId: target.id, nodes: [target], edges: [] })
  })

  it('redirects a selected subflow call to a temporary end in either mode', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const call = createNode('call-subflow', { x: 100, y: 0 })
    const next = createNode('end', { x: 200, y: 0 })
    const graph: WorkflowGraph = { workflowId: 'call', name: 'Call', version: 1, entryNodeId: start.id, nodes: [start, call, next], edges: [createEdge(start.id, 'default', call.id), createEdge(call.id, 'default', next.id)] }
    for (const runnable of [flowNodeRunGraph(graph, call.id), isolatedNodeRunGraph(graph, call.id)]) {
      expect(runnable.edges.some(edge => edge.sourceNodeId === call.id && edge.targetNodeId === next.id)).toBe(false)
      expect(runnable.edges.some(edge => edge.sourceNodeId === call.id && runnable.nodes.find(node => node.id === edge.targetNodeId)?.type === 'end')).toBe(true)
    }
    expect(graph.edges[1]?.targetNodeId).toBe(next.id)
  })
})
