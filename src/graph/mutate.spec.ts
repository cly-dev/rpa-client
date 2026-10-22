import { describe, expect, it } from 'vitest'
import { createDefaultTemplate } from './template.ts'
import { addEdgeToGraph, addNode, connectOrRewire, createEdge, createNode, duplicateNode } from './mutate.ts'

describe('addEdgeToGraph', () => {
  it('keeps each output single-line while allowing multiple lines into one input', () => {
    const graph = createDefaultTemplate()
    const start = graph.nodes.find(node => node.type === 'start')!
    const action = graph.nodes.find(node => node.type === 'page-action')!
    const end = graph.nodes.find(node => node.type === 'end')!
    const extraEnd = createNode('end', { x: 900, y: 400 })
    const extraAction = createNode('page-action', { x: 500, y: 400 })
    const expanded = { ...graph, nodes: [...graph.nodes, extraAction, extraEnd] }

    expect(addEdgeToGraph(expanded, createEdge(start.id, 'default', extraEnd.id))).toBe(expanded)
    expect(addEdgeToGraph(expanded, createEdge(extraAction.id, 'default', end.id)).edges).toHaveLength(graph.edges.length + 1)
    expect(addEdgeToGraph(expanded, createEdge(extraAction.id, 'default', extraEnd.id)).edges).toHaveLength(graph.edges.length + 1)
    expect(action).toBeDefined()
  })
})

describe('connectOrRewire', () => {
  it('lets the start outlet be dragged to a new node without adding a second line', () => {
    const graph = createDefaultTemplate()
    const start = graph.nodes.find(node => node.type === 'start')!
    const target = createNode('page-action', { x: 600, y: 400 })
    const expanded = { ...graph, nodes: [...graph.nodes, target] }
    const previous = expanded.edges.find(edge => edge.sourceNodeId === start.id)!
    const rewired = connectOrRewire(expanded, createEdge(start.id, 'default', target.id))
    expect(rewired.edges).toHaveLength(expanded.edges.length)
    expect(rewired.edges.find(edge => edge.id === previous.id)?.targetNodeId).toBe(target.id)
    expect(expanded.edges.find(edge => edge.id === previous.id)?.targetNodeId).not.toBe(target.id)
  })

  it('can rewire an outlet to an input that already has another connection', () => {
    const graph = createDefaultTemplate()
    const start = graph.nodes.find(node => node.type === 'start')!
    const end = graph.nodes.find(node => node.type === 'end')!
    const previous = graph.edges.find(edge => edge.sourceNodeId === start.id)!
    const rewired = connectOrRewire(graph, createEdge(start.id, 'default', end.id))
    expect(rewired).not.toBe(graph)
    expect(rewired.edges.find(edge => edge.id === previous.id)?.targetNodeId).toBe(end.id)
    expect(rewired.edges.filter(edge => edge.targetNodeId === end.id)).toHaveLength(2)
  })
})

describe('duplicateNode', () => {
  it('copies configuration into a new unconnected node beside the source', () => {
    const graph = createDefaultTemplate()
    const source = graph.nodes.find(node => node.type === 'page-action')!
    const copy = duplicateNode(graph, source.id)!
    const next = addNode(graph, copy)

    expect(copy.id).not.toBe(source.id)
    expect(copy.type).toBe(source.type)
    expect(copy.name).toBe(`${source.name} 副本`)
    expect(copy.config).toEqual(source.config)
    expect(copy.config).not.toBe(source.config)
    expect(copy.inputBindings).not.toBe(source.inputBindings)
    expect(copy.position).not.toEqual(source.position)
    expect(next.edges).toBe(graph.edges)
    expect(next.nodes).toHaveLength(graph.nodes.length + 1)
    expect(graph.nodes).toHaveLength(next.nodes.length - 1)
  })

  it('does not duplicate the unique start node', () => {
    const graph = createDefaultTemplate()
    expect(duplicateNode(graph, graph.entryNodeId)).toBeUndefined()
  })
})
