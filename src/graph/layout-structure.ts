import type { NodePosition, WorkflowEdge, WorkflowGraph, WorkflowNode } from './types.ts'

interface Size { readonly width: number; readonly height: number }
interface Block {
  readonly centers: Map<string, number>
  readonly top: number
  readonly bottom: number
}

const BRANCH_GAP = 96
const COMPONENT_GAP = 180

/** Supply readable branch lanes to ELK before its final placement and routing. */
export function structuredLayoutSeeds(
  graph: WorkflowGraph,
  positions: ReadonlyMap<string, NodePosition>,
  sizes: ReadonlyMap<string, Size>,
  ports: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, NodePosition> {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const outgoing = new Map<string, WorkflowGraph['edges'][number][]>()
  const neighbors = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!nodes.has(edge.sourceNodeId) || !nodes.has(edge.targetNodeId)) continue
    neighbors.set(edge.sourceNodeId, [...(neighbors.get(edge.sourceNodeId) ?? []), edge.targetNodeId])
    neighbors.set(edge.targetNodeId, [...(neighbors.get(edge.targetNodeId) ?? []), edge.sourceNodeId])
    // ELK's first pass identifies feedback edges. They cannot own a branch lane.
    if ((positions.get(edge.targetNodeId)?.x ?? 0) <= (positions.get(edge.sourceNodeId)?.x ?? 0)) continue
    outgoing.set(edge.sourceNodeId, [...(outgoing.get(edge.sourceNodeId) ?? []), edge])
  }
  for (const [id, edges] of outgoing) {
    const order = ports.get(id) ?? []
    edges.sort((a, b) => order.indexOf(a.sourcePort) - order.indexOf(b.sourcePort) || a.targetNodeId.localeCompare(b.targetNodeId))
  }
  const reachableCache = new Map<string, Set<string>>()
  const reachable = (id: string): Set<string> => {
    const cached = reachableCache.get(id)
    if (cached) return cached
    const seen = new Set<string>()
    const pending = [id]
    while (pending.length) {
      const next = pending.pop()!
      if (seen.has(next)) continue
      seen.add(next)
      pending.push(...(outgoing.get(next) ?? []).map(edge => edge.targetNodeId))
    }
    reachableCache.set(id, seen)
    return seen
  }
  const findJoin = (targets: readonly string[]): string | undefined => {
    const counts = new Map<string, number>()
    for (const target of targets) for (const id of reachable(target)) counts.set(id, (counts.get(id) ?? 0) + 1)
    // A terminal exit need not join the other branches. Prefer the earliest
    // shared continuation among the remaining branches instead of duplicating it.
    return [...counts.keys()].filter(id => counts.get(id)! >= 2)
      .sort((a, b) => counts.get(b)! - counts.get(a)! || positions.get(a)!.x - positions.get(b)!.x || a.localeCompare(b))[0]
  }

  const build = (start: string, stop?: string, ancestors: ReadonlySet<string> = new Set()): Block | undefined => {
    const centers = new Map<string, number>()
    let top = 0
    let bottom = 0
    let current: string | undefined = start
    const add = (block: Block, shift: number): boolean => {
      for (const id of block.centers.keys()) if (centers.has(id) || ancestors.has(id)) return false
      for (const [id, y] of block.centers) centers.set(id, y + shift)
      top = Math.min(top, block.top + shift)
      bottom = Math.max(bottom, block.bottom + shift)
      return true
    }
    const separate = (block: Block, below: boolean): number => {
      let shift = below ? BRANCH_GAP : -BRANCH_GAP
      for (const [id, center] of block.centers) {
        const position = positions.get(id)!
        const size = sizes.get(id)!
        for (const [otherId, otherCenter] of centers) {
          const other = positions.get(otherId)!
          const otherSize = sizes.get(otherId)!
          if (position.x >= other.x + otherSize.width + 48 || position.x + size.width + 48 <= other.x) continue
          const distance = (size.height + otherSize.height) / 2 + BRANCH_GAP
          shift = below ? Math.max(shift, otherCenter + distance - center) : Math.min(shift, otherCenter - distance - center)
        }
      }
      return shift
    }
    while (current !== undefined && current !== stop) {
      if (ancestors.has(current) || centers.has(current)) return undefined
      const node: WorkflowNode | undefined = nodes.get(current)
      if (!node) return undefined
      const half = sizes.get(current)!.height / 2
      centers.set(current, 0)
      top = Math.min(top, -half)
      bottom = Math.max(bottom, half)
      const edges: readonly WorkflowEdge[] = outgoing.get(current) ?? []
      const blocked = new Set([...ancestors, ...centers.keys()])
      if (node.type === 'for-each') {
        const body: string | undefined = edges.find(edge => edge.sourcePort === 'body')?.targetNodeId
        const done: string | undefined = edges.find(edge => edge.sourcePort === 'done')?.targetNodeId
        if (body && body !== done && body !== stop) {
          const block = build(body, done ?? stop, blocked)
          if (!block || !add(block, Math.max(half + BRANCH_GAP - block.top, separate(block, true)))) return undefined
        }
        current = done
        continue
      }
      const targets = [...new Set(edges.map(edge => edge.targetNodeId))]
      if (targets.length < 2) {
        current = targets[0]
        continue
      }
      const join = findJoin(targets)
      const branches = targets.map(target => build(target, join ?? stop, blocked))
      const branchIds = branches.flatMap(branch => [...(branch?.centers.keys() ?? [])])
      if (branches.some(branch => branch === undefined) || new Set(branchIds).size !== branchIds.length) {
        if (!join) return undefined
        // A cross-linked subgraph may not form a branch tree. Keep ELK's
        // geometry inside that region while preserving its surrounding main line.
        const region = new Set<string>()
        const pending = [...targets]
        while (pending.length) {
          const id = pending.pop()!
          if (id === join || region.has(id)) continue
          if (blocked.has(id)) return undefined
          region.add(id)
          pending.push(...(outgoing.get(id) ?? []).map(edge => edge.targetNodeId))
        }
        const regionTop = Math.min(...[...region].map(id => positions.get(id)!.y))
        const regionBottom = Math.max(...[...region].map(id => positions.get(id)!.y + sizes.get(id)!.height))
        const midpoint = (regionTop + regionBottom) / 2
        const fallback: Block = {
          centers: new Map([...region].map(id => [id, positions.get(id)!.y + sizes.get(id)!.height / 2 - midpoint])),
          top: regionTop - midpoint, bottom: regionBottom - midpoint,
        }
        if (!add(fallback, 0)) return undefined
        current = join
        continue
      }
      const blocks = branches as Block[]
      const heights = blocks.map(block => block.bottom - block.top)
      if (join) {
        const visible = heights.filter(height => height > 0)
        let laneTop = -(visible.reduce((sum, height) => sum + height, 0) + BRANCH_GAP * Math.max(0, visible.length - 1)) / 2
        for (const block of blocks) {
          if (block.centers.size === 0) continue
          if (!add(block, laneTop - block.top)) return undefined
          laneTop += block.bottom - block.top + BRANCH_GAP
        }
        current = join
      } else {
        // With early exits, the longest continuation is the main line. Other
        // exits stay above/below it in output-port order.
        let main = 0
        for (let index = 1; index < blocks.length; index += 1) {
          if (blocks[index]!.centers.size > blocks[main]!.centers.size) main = index
        }
        if (!add(blocks[main]!, 0)) return undefined
        for (let index = main - 1; index >= 0; index -= 1) {
          const block = blocks[index]!
          const shift = separate(block, false)
          if (!add(block, shift)) return undefined
        }
        for (let index = main + 1; index < blocks.length; index += 1) {
          const block = blocks[index]!
          const shift = separate(block, true)
          if (!add(block, shift)) return undefined
        }
        current = undefined
      }
    }
    return { centers, top, bottom }
  }

  const result = new Map<string, NodePosition>()
  const visited = new Set<string>()
  let componentTop = 0
  const ordered = [...graph.nodes].sort((a, b) => a.id === graph.entryNodeId ? -1 : b.id === graph.entryNodeId ? 1 : a.id.localeCompare(b.id))
  for (const root of ordered) {
    if (visited.has(root.id)) continue
    const component = new Set<string>()
    const pending = [root.id]
    while (pending.length) {
      const id = pending.pop()!
      if (component.has(id)) continue
      component.add(id)
      visited.add(id)
      pending.push(...(neighbors.get(id) ?? []))
    }
    const ids = [...component]
    const entry = component.has(graph.entryNodeId) ? graph.entryNodeId
      : ids.sort((a, b) => positions.get(a)!.x - positions.get(b)!.x || a.localeCompare(b))[0]!
    const block = build(entry)
    const structured = block && block.centers.size === component.size
    const left = Math.min(...ids.map(id => positions.get(id)!.x))
    const top = structured ? block.top : Math.min(...ids.map(id => positions.get(id)!.y))
    const bottom = structured ? block.bottom : Math.max(...ids.map(id => positions.get(id)!.y + sizes.get(id)!.height))
    for (const id of ids) {
      const initial = positions.get(id)!
      const y = structured ? block.centers.get(id)! - sizes.get(id)!.height / 2 : initial.y
      result.set(id, { x: initial.x - left, y: y - top + componentTop })
    }
    componentTop += bottom - top + COMPONENT_GAP
  }
  return result
}
