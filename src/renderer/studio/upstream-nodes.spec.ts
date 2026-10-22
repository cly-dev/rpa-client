import { describe, expect, it } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { upstreamNodes } from './upstream-nodes.ts'

describe('upstreamNodes', () => {
  it('includes connected predecessors, not successors or disconnected nodes', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const before = createNode('api-request', { x: 100, y: 0 })
    const selected = createNode('condition', { x: 200, y: 0 })
    const after = createNode('api-request', { x: 300, y: 0 })
    const unconnected = createNode('api-request', { x: -100, y: 0 })
    const orphan = createNode('set-variable', { x: -200, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: 'scope', name: 'Scope', version: 1, entryNodeId: start.id,
      nodes: [start, before, selected, after, unconnected, orphan],
      edges: [createEdge(start.id, 'default', before.id), createEdge(before.id, 'default', selected.id), createEdge(selected.id, 'matched', after.id), createEdge(orphan.id, 'default', selected.id)],
    }

    expect(upstreamNodes(graph, selected.id).map(node => node.id)).toEqual([start.id, before.id])
  })

  it('makes loop variables available inside the body without treating body nodes as predecessors of the loop', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const loop = createNode('for-each', { x: 100, y: 0 })
    const body = createNode('set-variable', { x: 200, y: 0 })
    const endItem = createNode('continue-loop', { x: 300, y: 0 })
    const after = createNode('end', { x: 200, y: 100 })
    const graph: WorkflowGraph = {
      workflowId: 'loop-scope', name: 'Loop scope', version: 1, entryNodeId: start.id,
      nodes: [start, loop, body, endItem, after],
      edges: [createEdge(start.id, 'default', loop.id), createEdge(loop.id, 'body', body.id), createEdge(body.id, 'default', endItem.id), createEdge(loop.id, 'done', after.id), createEdge(endItem.id, 'default', loop.id)],
    }

    expect(upstreamNodes(graph, body.id).map(node => node.id)).toEqual([start.id, loop.id])
    expect(upstreamNodes(graph, loop.id).map(node => node.id)).toEqual([start.id])
    expect(upstreamNodes(graph, after.id).map(node => node.id)).toEqual([start.id, loop.id])
  })
})
