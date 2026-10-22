import { describe, expect, it } from 'vitest'
import { createEdge, createNode } from './mutate.ts'
import { createDefaultTemplate } from './template.ts'
import { firstPublishIssue, validatePublishConnections } from './validate.ts'

describe('publish connection validation', () => {
  it('accepts a fully connected workflow', () => {
    expect(firstPublishIssue(createDefaultTemplate())).toBeUndefined()
  })

  it('requires every condition exit to be connected', () => {
    const graph = createDefaultTemplate()
    const start = graph.nodes.find(node => node.type === 'start')!
    const end = graph.nodes.find(node => node.type === 'end')!
    const condition = createNode('condition', { x: 300, y: 0 })
    const partial = {
      ...graph,
      nodes: [start, condition, end],
      edges: [createEdge(start.id, 'default', condition.id), createEdge(condition.id, 'matched', end.id)],
    }
    expect(firstPublishIssue(partial)).toMatchObject({ code: 'unconnected-output', nodeId: condition.id })
    expect(firstPublishIssue({ ...partial, edges: [...partial.edges, createEdge(condition.id, 'else', end.id)] })).toBeUndefined()
  })

  it('rejects a disconnected group even when each node has incoming and outgoing lines', () => {
    const graph = createDefaultTemplate()
    const first = createNode('set-variable', { x: 0, y: 400 })
    const second = createNode('set-variable', { x: 200, y: 400 })
    const disconnected = {
      ...graph,
      nodes: [...graph.nodes, first, second],
      edges: [...graph.edges, createEdge(first.id, 'default', second.id), createEdge(second.id, 'default', first.id)],
    }
    expect(firstPublishIssue(disconnected)).toMatchObject({ code: 'unreachable-node', nodeId: first.id })
  })

  it('rejects a connection pointing into the start node', () => {
    const graph = createDefaultTemplate()
    const end = graph.nodes.find(node => node.type === 'end')!
    expect(validatePublishConnections({ ...graph, edges: [...graph.edges, createEdge(end.id, 'default', graph.entryNodeId)] }))
      .toContainEqual(expect.objectContaining({ code: 'invalid-target', nodeId: graph.entryNodeId }))
  })

  it('requires both loop exits while accepting the continue-loop terminal', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const loop = createNode('for-each', { x: 120, y: 0 })
    const continueLoop = createNode('continue-loop', { x: 240, y: 0 })
    const end = createNode('end', { x: 360, y: 0 })
    const graph = {
      ...createDefaultTemplate(),
      entryNodeId: start.id,
      nodes: [start, loop, continueLoop, end],
      edges: [
        createEdge(start.id, 'default', loop.id),
        createEdge(loop.id, 'body', continueLoop.id),
        createEdge(loop.id, 'done', end.id),
      ],
    }
    expect(validatePublishConnections(graph)).toEqual([])
    expect(validatePublishConnections({ ...graph, edges: graph.edges.filter(edge => edge.sourcePort !== 'done') }))
      .toContainEqual(expect.objectContaining({ code: 'unconnected-output', nodeId: loop.id }))
  })
})
