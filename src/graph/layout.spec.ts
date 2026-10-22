import { describe, expect, it } from 'vitest'
import { createDefaultTemplate } from './template.ts'
import { autoLayoutGraph } from './layout.ts'
import { createEdge, createNode } from './mutate.ts'

describe('autoLayoutGraph', () => {
  it('keeps the entry in place and lays out connected nodes in execution order', async () => {
    const graph = createDefaultTemplate()
    const start = graph.nodes.find(node => node.id === graph.entryNodeId)!
    const formatted = await autoLayoutGraph(graph)
    const formattedStart = formatted.nodes.find(node => node.id === graph.entryNodeId)!
    const pageAction = formatted.nodes.find(node => node.type === 'page-action')!
    const end = formatted.nodes.find(node => node.type === 'end')!

    expect(formattedStart.position).toEqual(start.position)
    expect(pageAction.position.x).toBeGreaterThan(formattedStart.position.x)
    expect(end.position.x).toBeGreaterThan(pageAction.position.x)
    expect(pageAction.position.y + 48).toBeCloseTo(formattedStart.position.y + 48, 0)
    expect(end.position.y + 48).toBeCloseTo(formattedStart.position.y + 48, 0)
    expect(formatted.edges.every(edge => edge.layoutPoints !== undefined)).toBe(true)
  })

  it('handles a graph containing a loop-back edge', async () => {
    const graph = createDefaultTemplate()
    const pageAction = graph.nodes.find(node => node.type === 'page-action')!
    const end = graph.nodes.find(node => node.type === 'end')!
    const cyclic = { ...graph, edges: [...graph.edges, createEdge(end.id, 'default', pageAction.id)] }

    await expect(autoLayoutGraph(cyclic)).resolves.toMatchObject({ nodes: expect.any(Array) })
    expect((await autoLayoutGraph(cyclic)).nodes).toHaveLength(graph.nodes.length)
  })

  it('leaves vertical room for a multi-way decision with several visible branches', async () => {
    const graph = createDefaultTemplate()
    const first = createNode('switch', { x: 300, y: 100 })
    const second = createNode('switch', { x: 300, y: 200 })
    const start = graph.nodes.find(node => node.id === graph.entryNodeId)!
    const expanded = { ...graph,
      nodes: [...graph.nodes, { ...first, config: { type: 'switch' as const, left: { kind: 'literal' as const, value: '' }, path: '', cases: ['A', 'B', 'C', 'D'] } }, second],
      edges: [...graph.edges, createEdge(start.id, 'default', first.id), createEdge(start.id, 'default', second.id)],
    }
    const arranged = await autoLayoutGraph(expanded)
    const firstY = arranged.nodes.find(node => node.id === first.id)?.position.y ?? 0
    const secondY = arranged.nodes.find(node => node.id === second.id)?.position.y ?? 0
    expect(Math.abs(secondY - firstY)).toBeGreaterThan(250)
  })

  it('keeps measured node rectangles from overlapping after formatting', async () => {
    const graph = createDefaultTemplate()
    const sizes = new Map(graph.nodes.map((node, index) => [node.id, { width: 260 + index * 20, height: 180 + index * 30 }]))
    const arranged = await autoLayoutGraph(graph, sizes)

    for (let leftIndex = 0; leftIndex < arranged.nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < arranged.nodes.length; rightIndex += 1) {
        const left = arranged.nodes[leftIndex]!
        const right = arranged.nodes[rightIndex]!
        const leftSize = sizes.get(left.id)!
        const rightSize = sizes.get(right.id)!
        const overlaps = left.position.x < right.position.x + rightSize.width
          && left.position.x + leftSize.width > right.position.x
          && left.position.y < right.position.y + rightSize.height
          && left.position.y + leftSize.height > right.position.y
        expect(overlaps, `${left.id} overlaps ${right.id}`).toBe(false)
      }
    }
  })

  it('keeps decision branches in source-port order around the decision center', async () => {
    const base = createDefaultTemplate()
    const start = base.nodes.find(node => node.id === base.entryNodeId)!
    const decision = createNode('switch', { x: 260, y: 100 })
    const configuredDecision = { ...decision, config: { ...decision.config, cases: ['A', 'B', 'C'] } }
    const targets = ['page-action', 'page-action', 'page-action', 'page-action'].map((type, index) => createNode(type as 'page-action', { x: 600, y: index * 100 }))
    const ports = ['case-0', 'case-1', 'case-2', 'else']
    const graph = {
      ...base,
      nodes: [start, configuredDecision, ...targets],
      edges: [createEdge(start.id, 'default', decision.id), ...targets.map((target, index) => createEdge(decision.id, ports[index]!, target.id))],
    }
    const arranged = await autoLayoutGraph(graph)
    const laidOutDecision = arranged.nodes.find(node => node.id === decision.id)!
    const targetCenters = targets.map(target => {
      const node = arranged.nodes.find(candidate => candidate.id === target.id)!
      return node.position.y + 48
    })

    expect(targetCenters).toEqual([...targetCenters].sort((left, right) => left - right))
    expect((targetCenters[0]! + targetCenters.at(-1)!) / 2).toBeCloseTo(laidOutDecision.position.y + fallbackDecisionHeight(configuredDecision) / 2, 0)
  })

  it('places complete decision subtrees in separate symmetric lanes', async () => {
    const base = createDefaultTemplate()
    const start = base.nodes.find(node => node.id === base.entryNodeId)!
    const decision = createNode('switch', { x: 240, y: 100 })
    const configuredDecision = { ...decision, config: { ...decision.config, cases: ['A'] } }
    const upper = createNode('page-action', { x: 500, y: 100 })
    const upperTail = createNode('transform', { x: 760, y: 100 })
    const lower = createNode('page-action', { x: 500, y: 240 })
    const lowerTail = createNode('transform', { x: 760, y: 240 })
    const merge = createNode('page-action', { x: 1020, y: 180 })
    const graph = {
      ...base,
      nodes: [start, configuredDecision, upper, upperTail, lower, lowerTail, merge],
      edges: [
        createEdge(start.id, 'default', decision.id),
        createEdge(decision.id, 'case-0', upper.id),
        createEdge(upper.id, 'default', upperTail.id),
        createEdge(decision.id, 'else', lower.id),
        createEdge(lower.id, 'default', lowerTail.id),
        createEdge(upperTail.id, 'default', merge.id),
        createEdge(lowerTail.id, 'default', merge.id),
      ],
    }
    const arranged = await autoLayoutGraph(graph)
    const byId = (id: string) => arranged.nodes.find(node => node.id === id)!
    const sourceCenter = byId(decision.id).position.y + fallbackDecisionHeight(configuredDecision) / 2
    const upperCenter = (byId(upper.id).position.y + byId(upperTail.id).position.y + 96) / 2
    const lowerCenter = (byId(lower.id).position.y + byId(lowerTail.id).position.y + 96) / 2

    expect(upperCenter).toBeLessThan(sourceCenter)
    expect(lowerCenter).toBeGreaterThan(sourceCenter)
    expect(byId(upper.id).position.y + 48).toBeCloseTo(byId(upperTail.id).position.y + 48, 0)
    expect(byId(lower.id).position.y + 48).toBeCloseTo(byId(lowerTail.id).position.y + 48, 0)
    expect((upperCenter + lowerCenter) / 2).toBeCloseTo(sourceCenter, 0)
    expect(byId(merge.id).position.y + 48).toBeCloseTo(sourceCenter, 0)
    const upperBottom = Math.max(byId(upper.id).position.y, byId(upperTail.id).position.y) + 96
    const lowerTop = Math.min(byId(lower.id).position.y, byId(lowerTail.id).position.y)
    expect(lowerTop - upperBottom).toBeGreaterThanOrEqual(96)
    const mergeRoutes = arranged.edges.filter(edge => edge.targetNodeId === merge.id).map(edge => edge.layoutPoints?.[0]?.x)
    expect(new Set(mergeRoutes).size).toBe(2)
  })
})

function fallbackDecisionHeight(node: { config: { cases: readonly unknown[] } }): number {
  return 92 + (node.config.cases.length + 1) * 55
}
