import { describe, expect, it } from 'vitest'
import { createDefaultTemplate } from './template.ts'
import { autoLayoutGraph } from './layout.ts'
import { createEdge, createNode } from './mutate.ts'

describe('autoLayoutGraph', () => {
  it.each([
    ['condition', ['matched', 'else']],
    ['approval', ['approved', 'rejected', 'timeout']],
  ] as const)('orders %s branches by their output ports, independent of creation order', async (type, ports) => {
    const base = createDefaultTemplate()
    const start = base.nodes.find(node => node.id === base.entryNodeId)!
    const decision = createNode(type, { x: 250, y: 0 })
    const targets = ports.map(() => createNode('page-action', { x: 600, y: 0 }))
    const graph = {
      ...base,
      nodes: [start, decision, ...[...targets].reverse()],
      edges: [createEdge(start.id, 'default', decision.id), ...ports.map((port, index) => createEdge(decision.id, port, targets[index]!.id)).reverse()],
    }
    const arranged = await autoLayoutGraph(graph)
    const centers = targets.map(target => arranged.nodes.find(node => node.id === target.id)!.position.y + 48)
    expect(centers).toEqual([...centers].sort((a, b) => a - b))
    for (let index = 1; index < centers.length; index += 1) expect(centers[index]! - centers[index - 1]!).toBeGreaterThanOrEqual(96 + 72)
    expect((await autoLayoutGraph(arranged)).nodes.map(node => node.position)).toEqual(arranged.nodes.map(node => node.position))
  })

  it('keeps the loop completion on the main line and its body underneath', async () => {
    const base = createDefaultTemplate()
    const start = base.nodes[0]!
    const loop = createNode('for-each', { x: 0, y: 0 })
    const body = createNode('page-action', { x: 0, y: 0 })
    const tail = createNode('continue-loop', { x: 0, y: 0 })
    const done = createNode('page-action', { x: 0, y: 0 })
    const end = createNode('end', { x: 0, y: 0 })
    const graph = { ...base, nodes: [start, loop, body, tail, done, end], edges: [
      createEdge(start.id, 'default', loop.id), createEdge(loop.id, 'body', body.id),
      createEdge(body.id, 'default', tail.id), createEdge(loop.id, 'done', done.id), createEdge(done.id, 'default', end.id),
    ] }
    const arranged = await autoLayoutGraph(graph)
    const byId = (id: string) => arranged.nodes.find(node => node.id === id)!
    for (const node of [loop, done, end]) expect(byId(node.id).position.y).toBeCloseTo(start.position.y)
    expect(byId(body.id).position.y).toBeGreaterThan(byId(loop.id).position.y + 96)
    expect(byId(tail.id).position.y).toBeCloseTo(byId(body.id).position.y)
    assertClearRoutes(arranged)
  })

  it('puts disconnected draft nodes below the connected main workflow', async () => {
    const base = createDefaultTemplate()
    const isolated = createNode('page-action', { x: 0, y: 0 })
    const graph = { ...base, nodes: [...base.nodes, isolated] }
    const arranged = await autoLayoutGraph(graph)
    const mainBottom = Math.max(...arranged.nodes.filter(node => node.id !== isolated.id).map(node => node.position.y + 96))
    expect(arranged.nodes.find(node => node.id === isolated.id)!.position.y).toBeGreaterThanOrEqual(mainBottom + 120)
  })

  it('keeps shared continuations on the main line when other branches exit early', async () => {
    const base = createDefaultTemplate()
    const start = base.nodes[0]!
    const outer = createNode('condition', { x: 0, y: 0 })
    const decision = createNode('switch', { x: 0, y: 0 })
    if (decision.config.type !== 'switch') throw new Error('Expected switch config')
    const split = { ...decision, config: { ...decision.config, cases: ['A', 'B'] } }
    const a = createNode('page-action', { x: 0, y: 0 })
    const b = createNode('page-action', { x: 0, y: 0 })
    const merge = createNode('transform', { x: 0, y: 0 })
    const exit = createNode('end', { x: 0, y: 0 })
    const earlyExit = createNode('end', { x: 0, y: 0 })
    const graph = { ...base, nodes: [start, outer, split, a, b, merge, exit, earlyExit], edges: [
      createEdge(start.id, 'default', outer.id), createEdge(outer.id, 'matched', split.id),
      createEdge(outer.id, 'else', earlyExit.id), createEdge(split.id, 'case-0', a.id),
      createEdge(split.id, 'case-1', b.id), createEdge(split.id, 'else', exit.id),
      createEdge(a.id, 'default', merge.id), createEdge(b.id, 'default', merge.id),
    ] }
    const arranged = await autoLayoutGraph(graph)
    const byId = (id: string) => arranged.nodes.find(node => node.id === id)!
    expect(byId(merge.id).position.y).toBeCloseTo(start.position.y)
    expect(byId(split.id).position.y + (92 + 3 * 55) / 2).toBeCloseTo(start.position.y + 48)
    expect(byId(earlyExit.id).position.y - start.position.y).toBeLessThan(400)
    assertClearRoutes(arranged)
  })

  it('preserves the surrounding main line around cross-linked branch regions', async () => {
    const base = createDefaultTemplate()
    const start = base.nodes[0]!
    const decision = createNode('approval', { x: 0, y: 0 })
    const [a, b, c, shared, merge, end] = Array.from({ length: 6 }, () => createNode('page-action', { x: 0, y: 0 }))
    const graph = { ...base, nodes: [start, decision, a!, b!, c!, shared!, merge!, end!], edges: [
      createEdge(start.id, 'default', decision.id), createEdge(decision.id, 'approved', a!.id),
      createEdge(decision.id, 'rejected', b!.id), createEdge(decision.id, 'timeout', c!.id),
      createEdge(a!.id, 'default', shared!.id), createEdge(b!.id, 'default', shared!.id),
      createEdge(shared!.id, 'default', merge!.id), createEdge(c!.id, 'default', merge!.id), createEdge(merge!.id, 'default', end!.id),
    ] }
    const arranged = await autoLayoutGraph(graph)
    for (const id of [decision.id, merge!.id, end!.id]) expect(arranged.nodes.find(node => node.id === id)!.position.y).toBeCloseTo(start.position.y)
    assertClearRoutes(arranged)
  })

  it('uses safe fallback dimensions for nodes that have not been measured yet', async () => {
    const graph = createDefaultTemplate()
    const measured = new Map(graph.nodes.map(node => [node.id, { width: NaN, height: 0 }]))
    const arranged = await autoLayoutGraph(graph, measured)
    const expected = await autoLayoutGraph(graph)
    expect(arranged.nodes.map(node => node.position)).toEqual(expected.nodes.map(node => node.position))
  })

  it('separates nested branches with different card sizes and keeps their merge downstream', async () => {
    const base = createDefaultTemplate()
    const start = base.nodes.find(node => node.id === base.entryNodeId)!
    const outer = createNode('condition', { x: 0, y: 0 })
    const inner = createNode('approval', { x: 0, y: 0 })
    const targets = Array.from({ length: 4 }, () => createNode('page-action', { x: 0, y: 0 }))
    const merge = createNode('end', { x: 0, y: 0 })
    const graph = {
      ...base,
      nodes: [start, outer, inner, ...targets, merge],
      edges: [
        createEdge(start.id, 'default', outer.id),
        createEdge(outer.id, 'matched', inner.id),
        createEdge(outer.id, 'else', targets[3]!.id),
        ...['approved', 'rejected', 'timeout'].map((port, index) => createEdge(inner.id, port, targets[index]!.id)),
        ...targets.map(target => createEdge(target.id, 'default', merge.id)),
      ],
    }
    const sizes = new Map(graph.nodes.map((node, index) => [node.id, { width: 200 + index * 12, height: 100 + index * 35 }]))
    const arranged = await autoLayoutGraph(graph, sizes)
    for (const left of arranged.nodes) {
      for (const right of arranged.nodes) {
        if (left.id === right.id) continue
        expect(left.position.x + sizes.get(left.id)!.width <= right.position.x
          || right.position.x + sizes.get(right.id)!.width <= left.position.x
          || left.position.y + sizes.get(left.id)!.height <= right.position.y
          || right.position.y + sizes.get(right.id)!.height <= left.position.y,
        `${left.type} overlaps ${right.type}`).toBe(true)
      }
    }
    for (const edge of arranged.edges) {
      expect(arranged.nodes.find(node => node.id === edge.targetNodeId)!.position.x)
        .toBeGreaterThan(arranged.nodes.find(node => node.id === edge.sourceNodeId)!.position.x)
    }
    expect(arranged.nodes.find(node => node.id === start.id)!.position).toEqual(start.position)
  })

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
    const arranged = await autoLayoutGraph(cyclic)
    expect(arranged.nodes).toHaveLength(graph.nodes.length)
    assertClearRoutes(arranged)
  })

  it('routes from the measured canvas handles rather than guessed card centers', async () => {
    const graph = createDefaultTemplate()
    const sizes = new Map(graph.nodes.map(node => [node.id, {
      width: 210, height: 130,
      sourceHandles: { default: { x: 215, y: 37 } }, targetHandle: { x: -5, y: 65 },
    }]))
    const arranged = await autoLayoutGraph(graph, sizes)
    for (const edge of arranged.edges) {
      const source = arranged.nodes.find(node => node.id === edge.sourceNodeId)!
      const target = arranged.nodes.find(node => node.id === edge.targetNodeId)!
      expect(edge.layoutPoints![0]).toEqual({ x: source.position.x + 215, y: source.position.y + 37 })
      expect(edge.layoutPoints!.at(-1)).toEqual({ x: target.position.x - 5, y: target.position.y + 65 })
    }
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

  it('keeps decision branches in source-port order with room for each card', async () => {
    const base = createDefaultTemplate()
    const start = base.nodes.find(node => node.id === base.entryNodeId)!
    const decision = createNode('switch', { x: 260, y: 100 })
    if (decision.config.type !== 'switch') throw new Error('Expected switch config')
    const configuredDecision = { ...decision, config: { ...decision.config, cases: ['A', 'B', 'C'] } }
    const targets = ['page-action', 'page-action', 'page-action', 'page-action'].map((type, index) => createNode(type as 'page-action', { x: 600, y: index * 100 }))
    const ports = ['case-0', 'case-1', 'case-2', 'else']
    const graph = {
      ...base,
      nodes: [start, configuredDecision, ...targets],
      edges: [createEdge(start.id, 'default', decision.id), ...targets.map((target, index) => createEdge(decision.id, ports[index]!, target.id))],
    }
    const arranged = await autoLayoutGraph(graph)
    const targetCenters = targets.map(target => {
      const node = arranged.nodes.find(candidate => candidate.id === target.id)!
      return node.position.y + 48
    })

    expect(targetCenters).toEqual([...targetCenters].sort((left, right) => left - right))
    for (let index = 1; index < targetCenters.length; index += 1) expect(targetCenters[index]! - targetCenters[index - 1]!).toBeGreaterThanOrEqual(168)
  })

  it('places decision subtrees in separate lanes and preserves orthogonal merge routes', async () => {
    const base = createDefaultTemplate()
    const start = base.nodes.find(node => node.id === base.entryNodeId)!
    const decision = createNode('switch', { x: 240, y: 100 })
    if (decision.config.type !== 'switch') throw new Error('Expected switch config')
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
    const upperCenter = (byId(upper.id).position.y + byId(upperTail.id).position.y + 96) / 2
    const lowerCenter = (byId(lower.id).position.y + byId(lowerTail.id).position.y + 96) / 2

    expect(upperCenter).toBeLessThan(lowerCenter)
    expect(byId(upper.id).position.y + 48).toBeCloseTo(byId(upperTail.id).position.y + 48, 0)
    expect(byId(lower.id).position.y + 48).toBeCloseTo(byId(lowerTail.id).position.y + 48, 0)
    expect(byId(merge.id).position.x).toBeGreaterThan(byId(lowerTail.id).position.x)
    const sourceCenter = byId(decision.id).position.y + (92 + 2 * 55) / 2
    expect((upperCenter + lowerCenter) / 2).toBeCloseTo(sourceCenter)
    expect(byId(merge.id).position.y + 48).toBeCloseTo(sourceCenter)
    expect(byId(start.id).position.y + 48).toBeCloseTo(sourceCenter)
    const upperBottom = Math.max(byId(upper.id).position.y, byId(upperTail.id).position.y) + 96
    const lowerTop = Math.min(byId(lower.id).position.y, byId(lowerTail.id).position.y)
    expect(lowerTop - upperBottom).toBeGreaterThanOrEqual(72)
    assertClearRoutes(arranged)
  })
})

function assertClearRoutes(graph: Awaited<ReturnType<typeof autoLayoutGraph>>): void {
  for (const edge of graph.edges) {
    const points = edge.layoutPoints!
    expect(points.length).toBeGreaterThanOrEqual(2)
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1]!
      const b = points[index]!
      expect(a.x === b.x || a.y === b.y, 'ELK route must stay orthogonal').toBe(true)
      for (const node of graph.nodes) {
        if (node.id === edge.sourceNodeId || node.id === edge.targetNodeId) continue
        const width = node.config.type === 'switch' ? 248 : 184
        const height = node.config.type === 'switch' ? 92 + (node.config.cases.length + 1) * 55 : 96
        const crosses = a.x === b.x
          ? a.x > node.position.x && a.x < node.position.x + width && Math.max(a.y, b.y) > node.position.y && Math.min(a.y, b.y) < node.position.y + height
          : a.y > node.position.y && a.y < node.position.y + height && Math.max(a.x, b.x) > node.position.x && Math.min(a.x, b.x) < node.position.x + width
        expect(crosses, `edge ${edge.id} crosses card ${node.id}`).toBe(false)
      }
    }
  }
}
