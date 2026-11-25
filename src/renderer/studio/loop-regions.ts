import type { WorkflowGraph } from '@graph/types.ts'
import type { NodeSize } from './flow-nodes.ts'

export function loopRegions(graph: WorkflowGraph, measured: ReadonlyMap<string, NodeSize>): readonly {
  id: string; name: string; x: number; y: number; width: number; height: number
}[] {
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const outgoing = new Map<string, string[]>()
  for (const edge of graph.edges) outgoing.set(edge.sourceNodeId, [...(outgoing.get(edge.sourceNodeId) ?? []), edge.targetNodeId])
  const collect = (start: string, blocked: ReadonlySet<string>): Set<string> => {
    const seen = new Set<string>()
    const pending = [start]
    while (pending.length) {
      const id = pending.pop()!
      if (blocked.has(id) || seen.has(id) || !byId.has(id)) continue
      seen.add(id)
      pending.push(...(outgoing.get(id) ?? []))
    }
    return seen
  }
  return graph.nodes.filter(node => node.type === 'for-each').flatMap(loop => {
    const edges = graph.edges.filter(edge => edge.sourceNodeId === loop.id)
    const body = edges.find(edge => edge.sourcePort === 'body')?.targetNodeId
    const done = edges.find(edge => edge.sourcePort === 'done')?.targetNodeId
    if (!body) return []
    const excluded = done ? collect(done, new Set([loop.id])) : new Set<string>()
    excluded.add(loop.id)
    const ids = [...collect(body, excluded)]
    if (!ids.length) return []
    const boxes = ids.map(id => {
      const node = byId.get(id)!
      const expanded = node.config.type === 'switch' || node.config.type === 'image-recognition' ? node.config : undefined
      const size = measured.get(id)
      return { ...node.position, width: size?.width ?? (expanded ? 248 : 184), height: size?.height ?? (expanded ? 92 + (expanded.cases.length + 1) * 55 : 96) }
    })
    const left = Math.min(...boxes.map(box => box.x))
    const top = Math.min(...boxes.map(box => box.y))
    return [{ id: loop.id, name: loop.name, x: left - 24, y: top - 32,
      width: Math.max(...boxes.map(box => box.x + box.width)) - left + 48,
      height: Math.max(...boxes.map(box => box.y + box.height)) - top + 52,
    }]
  })
}
