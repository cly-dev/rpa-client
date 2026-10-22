import type { ElkNode } from 'elkjs/lib/elk-api.js'
import type { WorkflowGraph } from './types.ts'
import { NODE_CATALOG } from './catalog.ts'

export interface LayoutNodeSize {
  readonly width?: number
  readonly height?: number
}

let elkPromise: Promise<{ layout(graph: ElkNode): Promise<ElkNode> }> | undefined

function loadElk(): Promise<{ layout(graph: ElkNode): Promise<ElkNode> }> {
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then(({ default: ELK }) => new ELK())
  return elkPromise
}

function fallbackSize(node: WorkflowGraph['nodes'][number]): { width: number; height: number } {
  if (node.config.type === 'switch' || node.config.type === 'image-recognition') {
    return { width: 248, height: 92 + (node.config.cases.length + 1) * 55 }
  }
  return { width: 184, height: 96 }
}

const COLLISION_GAP = 48
const GROUP_GAP = 72

function flowPorts(node: WorkflowGraph['nodes'][number]): readonly string[] {
  if (node.config.type === 'switch') return [...node.config.cases.map((_, index) => `case-${index}`), 'else']
  if (node.config.type === 'image-recognition') return [...node.config.cases.map(item => `case-${item.id}`), 'else']
  return NODE_CATALOG[node.type].flowOutputs.map(port => port.name)
}

function elkPortId(nodeId: string, port: string): string {
  return `${nodeId}::${port}`
}

function removeNodeOverlaps(
  graph: WorkflowGraph,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
): Map<string, { x: number; y: number }> {
  const placed: { id: string; x: number; y: number; width: number; height: number }[] = []
  const ordered = [...graph.nodes].sort((left, right) => {
    if (left.id === graph.entryNodeId) return -1
    if (right.id === graph.entryNodeId) return 1
    const a = positions.get(left.id) ?? left.position
    const b = positions.get(right.id) ?? right.position
    return a.x - b.x || a.y - b.y || left.id.localeCompare(right.id)
  })
  const adjusted = new Map<string, { x: number; y: number }>()

  for (const node of ordered) {
    const position = positions.get(node.id) ?? node.position
    const size = sizes.get(node.id) ?? fallbackSize(node)
    let y = position.y
    while (true) {
      const conflicts = placed.filter(other => {
        const horizontal = position.x < other.x + other.width + COLLISION_GAP && position.x + size.width + COLLISION_GAP > other.x
        const vertical = y < other.y + other.height + COLLISION_GAP && y + size.height + COLLISION_GAP > other.y
        return horizontal && vertical
      })
      if (conflicts.length === 0) break
      y = Math.max(...conflicts.map(other => other.y + other.height + COLLISION_GAP))
    }
    adjusted.set(node.id, { x: position.x, y })
    placed.push({ id: node.id, x: position.x, y, ...size })
  }
  return adjusted
}

function symmetrizeDecisionBranches(
  graph: WorkflowGraph,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
): Map<string, { x: number; y: number }> {
  const adjusted = new Map(positions)
  const outgoingByNode = new Map<string, string[]>()
  for (const edge of graph.edges) outgoingByNode.set(edge.sourceNodeId, [...(outgoingByNode.get(edge.sourceNodeId) ?? []), edge.targetNodeId])
  const decisions = graph.nodes
    .filter(node => node.config.type === 'switch' || node.config.type === 'image-recognition')
    .sort((left, right) => (adjusted.get(left.id)?.x ?? left.position.x) - (adjusted.get(right.id)?.x ?? right.position.x))

  for (const source of decisions) {
    if (source.config.type !== 'switch' && source.config.type !== 'image-recognition') continue
    const portOrder = flowPorts(source)
    const outgoing = graph.edges
      .filter(edge => edge.sourceNodeId === source.id)
      .sort((left, right) => portOrder.indexOf(left.sourcePort) - portOrder.indexOf(right.sourcePort))
    if (outgoing.length < 2) continue

    const reachableByBranch = outgoing.map(edge => {
      const reachable = new Set<string>()
      const pending = [edge.targetNodeId]
      while (pending.length > 0) {
        const nodeId = pending.shift()!
        if (nodeId === source.id || reachable.has(nodeId)) continue
        reachable.add(nodeId)
        pending.push(...(outgoingByNode.get(nodeId) ?? []))
      }
      return reachable
    })
    const memberships = new Map<string, number>()
    for (const reachable of reachableByBranch) {
      for (const nodeId of reachable) memberships.set(nodeId, (memberships.get(nodeId) ?? 0) + 1)
    }
    const groups = reachableByBranch.map(reachable => [...reachable]
      .filter(nodeId => memberships.get(nodeId) === 1)
      .map(nodeId => graph.nodes.find(node => node.id === nodeId))
      .filter((node): node is WorkflowGraph['nodes'][number] => node !== undefined))
    if (groups.filter(group => group.length > 0).length < 2) continue

    const sourcePosition = adjusted.get(source.id) ?? source.position
    const sourceSize = sizes.get(source.id) ?? fallbackSize(source)
    const boxes = groups.map(group => {
      if (group.length === 0) return undefined
      const top = Math.min(...group.map(node => (adjusted.get(node.id) ?? node.position).y))
      const bottom = Math.max(...group.map(node => {
        const position = adjusted.get(node.id) ?? node.position
        return position.y + (sizes.get(node.id) ?? fallbackSize(node)).height
      }))
      return { top, height: bottom - top }
    })
    const visibleBoxes = boxes.filter((box): box is { top: number; height: number } => box !== undefined)
    const branchGap = 96
    const totalHeight = visibleBoxes.reduce((sum, box) => sum + box.height, 0) + branchGap * (visibleBoxes.length - 1)
    let top = sourcePosition.y + sourceSize.height / 2 - totalHeight / 2
    for (let index = 0; index < groups.length; index += 1) {
      const box = boxes[index]
      if (box === undefined) continue
      const deltaY = top - box.top
      for (const node of groups[index]!) {
        const position = adjusted.get(node.id) ?? node.position
        adjusted.set(node.id, { x: position.x, y: position.y + deltaY })
      }
      top += box.height + branchGap
    }

    const common = graph.nodes
      .filter(node => memberships.get(node.id) === reachableByBranch.length)
      .sort((left, right) => (adjusted.get(left.id)?.x ?? left.position.x) - (adjusted.get(right.id)?.x ?? right.position.x))
    const merge = common[0]
    if (merge !== undefined) {
      const mergePosition = adjusted.get(merge.id) ?? merge.position
      const mergeSize = sizes.get(merge.id) ?? fallbackSize(merge)
      const deltaY = sourcePosition.y + sourceSize.height / 2 - (mergePosition.y + mergeSize.height / 2)
      for (const node of common) {
        const position = adjusted.get(node.id) ?? node.position
        adjusted.set(node.id, { x: position.x, y: position.y + deltaY })
      }
    }
  }
  return adjusted
}

function symmetrizeMergeInputs(
  graph: WorkflowGraph,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
): Map<string, { x: number; y: number }> {
  const adjusted = new Map(positions)
  const incomingByNode = new Map<string, string[]>()
  for (const edge of graph.edges) incomingByNode.set(edge.targetNodeId, [...(incomingByNode.get(edge.targetNodeId) ?? []), edge.sourceNodeId])
  const merges = graph.nodes
    .filter(node => (incomingByNode.get(node.id)?.length ?? 0) > 1)
    .sort((left, right) => (adjusted.get(right.id)?.x ?? right.position.x) - (adjusted.get(left.id)?.x ?? left.position.x))

  for (const target of merges) {
    const incoming = graph.edges
      .filter(edge => edge.targetNodeId === target.id)
      .sort((left, right) => {
        const leftNode = graph.nodes.find(node => node.id === left.sourceNodeId)
        const rightNode = graph.nodes.find(node => node.id === right.sourceNodeId)
        return (leftNode === undefined ? 0 : (adjusted.get(leftNode.id) ?? leftNode.position).y)
          - (rightNode === undefined ? 0 : (adjusted.get(rightNode.id) ?? rightNode.position).y)
      })
    const reachableByInput = incoming.map(edge => {
      const reachable = new Set<string>()
      const pending = [edge.sourceNodeId]
      while (pending.length > 0) {
        const nodeId = pending.shift()!
        if (nodeId === target.id || reachable.has(nodeId)) continue
        reachable.add(nodeId)
        pending.push(...(incomingByNode.get(nodeId) ?? []))
      }
      return reachable
    })
    const memberships = new Map<string, number>()
    for (const reachable of reachableByInput) {
      for (const nodeId of reachable) memberships.set(nodeId, (memberships.get(nodeId) ?? 0) + 1)
    }
    const groups = reachableByInput.map(reachable => [...reachable]
      .filter(nodeId => memberships.get(nodeId) === 1)
      .map(nodeId => graph.nodes.find(node => node.id === nodeId))
      .filter((node): node is WorkflowGraph['nodes'][number] => node !== undefined))
    if (groups.filter(group => group.length > 0).length < 2) continue

    const targetPosition = adjusted.get(target.id) ?? target.position
    const targetSize = sizes.get(target.id) ?? fallbackSize(target)
    const boxes = groups.map(group => {
      if (group.length === 0) return undefined
      const top = Math.min(...group.map(node => (adjusted.get(node.id) ?? node.position).y))
      const bottom = Math.max(...group.map(node => {
        const position = adjusted.get(node.id) ?? node.position
        return position.y + (sizes.get(node.id) ?? fallbackSize(node)).height
      }))
      return { top, height: bottom - top }
    })
    const visibleBoxes = boxes.filter((box): box is { top: number; height: number } => box !== undefined)
    const inputGap = 96
    const totalHeight = visibleBoxes.reduce((sum, box) => sum + box.height, 0) + inputGap * (visibleBoxes.length - 1)
    let top = targetPosition.y + targetSize.height / 2 - totalHeight / 2
    for (let index = 0; index < groups.length; index += 1) {
      const box = boxes[index]
      if (box === undefined) continue
      const deltaY = top - box.top
      for (const node of groups[index]!) {
        const position = adjusted.get(node.id) ?? node.position
        adjusted.set(node.id, { x: position.x, y: position.y + deltaY })
      }
      top += box.height + inputGap
    }
  }
  return adjusted
}

function linearGroups(graph: WorkflowGraph): string[][] {
  const parent = new Map(graph.nodes.map(node => [node.id, node.id]))
  const find = (id: string): string => {
    const current = parent.get(id) ?? id
    if (current === id) return id
    const root = find(current)
    parent.set(id, root)
    return root
  }
  const union = (left: string, right: string): void => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot)
  }
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()
  for (const edge of graph.edges) {
    outgoing.set(edge.sourceNodeId, (outgoing.get(edge.sourceNodeId) ?? 0) + 1)
    incoming.set(edge.targetNodeId, (incoming.get(edge.targetNodeId) ?? 0) + 1)
  }
  for (const edge of graph.edges) {
    if (outgoing.get(edge.sourceNodeId) === 1 && incoming.get(edge.targetNodeId) === 1) union(edge.sourceNodeId, edge.targetNodeId)
  }
  const groups = new Map<string, string[]>()
  for (const node of graph.nodes) groups.set(find(node.id), [...(groups.get(find(node.id)) ?? []), node.id])
  return [...groups.values()]
}

function alignLinearChains(
  graph: WorkflowGraph,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
): Map<string, { x: number; y: number }> {
  const adjusted = new Map(positions)
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]))
  for (const group of linearGroups(graph)) {
    if (group.length < 2) continue
    const ordered = group
      .map(id => nodeById.get(id))
      .filter((node): node is WorkflowGraph['nodes'][number] => node !== undefined)
      .sort((left, right) => (adjusted.get(left.id)?.x ?? left.position.x) - (adjusted.get(right.id)?.x ?? right.position.x))
    const anchor = ordered[0]
    if (anchor === undefined) continue
    const anchorPosition = adjusted.get(anchor.id) ?? anchor.position
    const centerY = anchorPosition.y + (sizes.get(anchor.id) ?? fallbackSize(anchor)).height / 2
    for (const node of ordered) {
      const position = adjusted.get(node.id) ?? node.position
      const size = sizes.get(node.id) ?? fallbackSize(node)
      adjusted.set(node.id, { x: position.x, y: centerY - size.height / 2 })
    }
  }
  return adjusted
}

function removeGroupedOverlaps(
  graph: WorkflowGraph,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
): Map<string, { x: number; y: number }> {
  const adjusted = new Map(positions)
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]))
  const groups = linearGroups(graph)
    .map(ids => ids.map(id => nodeById.get(id)).filter((node): node is WorkflowGraph['nodes'][number] => node !== undefined))
    .sort((left, right) => {
      const leftTop = Math.min(...left.map(node => (adjusted.get(node.id) ?? node.position).y))
      const rightTop = Math.min(...right.map(node => (adjusted.get(node.id) ?? node.position).y))
      return leftTop - rightTop
    })
  const placed: WorkflowGraph['nodes'][number][][] = []

  for (const group of groups) {
    let shiftY = 0
    while (true) {
      let requiredShift = 0
      for (const node of group) {
        const position = adjusted.get(node.id) ?? node.position
        const size = sizes.get(node.id) ?? fallbackSize(node)
        for (const otherGroup of placed) {
          for (const other of otherGroup) {
            const otherPosition = adjusted.get(other.id) ?? other.position
            const otherSize = sizes.get(other.id) ?? fallbackSize(other)
            const horizontal = position.x < otherPosition.x + otherSize.width + GROUP_GAP
              && position.x + size.width + GROUP_GAP > otherPosition.x
            const vertical = position.y + shiftY < otherPosition.y + otherSize.height + GROUP_GAP
              && position.y + shiftY + size.height + GROUP_GAP > otherPosition.y
            if (horizontal && vertical) requiredShift = Math.max(requiredShift, otherPosition.y + otherSize.height + GROUP_GAP - (position.y + shiftY))
          }
        }
      }
      if (requiredShift <= 0) break
      shiftY += requiredShift
    }
    if (shiftY > 0) {
      for (const node of group) {
        const position = adjusted.get(node.id) ?? node.position
        adjusted.set(node.id, { x: position.x, y: position.y + shiftY })
      }
    }
    placed.push(group)
  }
  return adjusted
}

/** Arrange workflow nodes with ELK's layered left-to-right data-flow layout. */
export async function autoLayoutGraph(
  graph: WorkflowGraph,
  measured: ReadonlyMap<string, LayoutNodeSize> = new Map(),
): Promise<WorkflowGraph> {
  if (graph.nodes.length < 2) return graph

  const elk = await loadElk()
  const sizes = new Map(graph.nodes.map(node => {
    const fallback = fallbackSize(node)
    const size = measured.get(node.id)
    return [node.id, { width: size?.width ?? fallback.width, height: size?.height ?? fallback.height }] as const
  }))
  const sourcePorts = new Map(graph.nodes.map(node => {
    const configured = flowPorts(node)
    const used = graph.edges.filter(edge => edge.sourceNodeId === node.id).map(edge => edge.sourcePort)
    return [node.id, [...new Set([...configured, ...used])]] as const
  }))
  const layout = await elk.layout({
    id: 'workflow',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '88',
      'elk.layered.spacing.nodeNodeBetweenLayers': '160',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.nodePlacement.favorStraightEdges': 'true',
      'elk.layered.cycleBreaking.strategy': 'GREEDY',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.considerModelOrder.portModelOrder': 'true',
      'elk.layered.thoroughness': '30',
      'elk.separateConnectedComponents': 'true',
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    },
    children: graph.nodes.map(node => {
      const ports = sourcePorts.get(node.id) ?? []
      return {
        id: node.id,
        ...sizes.get(node.id)!,
        layoutOptions: ports.length > 1 ? { 'elk.portConstraints': 'FIXED_ORDER' } : undefined,
        ports: ports.map((port, index) => ({
          id: elkPortId(node.id, port),
          width: 1,
          height: 1,
          layoutOptions: { 'elk.port.side': 'EAST', 'elk.port.index': String(index) },
        })),
      }
    }),
    edges: graph.edges.map(edge => ({ id: edge.id, sources: [elkPortId(edge.sourceNodeId, edge.sourcePort)], targets: [edge.targetNodeId] })),
  })

  const elkPositions = new Map((layout.children ?? []).map(node => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]))
  const positions = removeGroupedOverlaps(
    graph,
    alignLinearChains(graph, symmetrizeMergeInputs(graph, symmetrizeDecisionBranches(graph, removeNodeOverlaps(graph, elkPositions, sizes), sizes), sizes), sizes),
    sizes,
  )
  const entry = graph.nodes.find(node => node.id === graph.entryNodeId)
  const arrangedEntry = positions.get(graph.entryNodeId)
  const offsetX = entry === undefined || arrangedEntry === undefined ? 0 : entry.position.x - arrangedEntry.x
  const offsetY = entry === undefined || arrangedEntry === undefined ? 0 : entry.position.y - arrangedEntry.y
  const edgeRoutes = new Map<string, readonly { x: number; y: number }[]>()
  for (const edge of layout.edges ?? []) {
    if (edge.id === undefined) continue
    const workflowEdge = graph.edges.find(candidate => candidate.id === edge.id)
    const sourceElk = workflowEdge === undefined ? undefined : elkPositions.get(workflowEdge.sourceNodeId)
    const targetElk = workflowEdge === undefined ? undefined : elkPositions.get(workflowEdge.targetNodeId)
    const sourceFinal = workflowEdge === undefined ? undefined : positions.get(workflowEdge.sourceNodeId)
    const targetFinal = workflowEdge === undefined ? undefined : positions.get(workflowEdge.targetNodeId)
    const sourceShiftY = sourceElk === undefined || sourceFinal === undefined ? 0 : sourceFinal.y - sourceElk.y
    const targetShiftY = targetElk === undefined || targetFinal === undefined ? 0 : targetFinal.y - targetElk.y
    const sourceX = sourceElk?.x ?? 0
    const targetX = targetElk?.x ?? sourceX
    const span = targetX - sourceX
    const points = (edge.sections ?? []).flatMap(section => section.bendPoints ?? []).map(point => {
      const ratio = span === 0 ? 0.5 : Math.max(0, Math.min(1, (point.x - sourceX) / span))
      return { x: point.x + offsetX, y: point.y + sourceShiftY + (targetShiftY - sourceShiftY) * ratio + offsetY }
    })
    edgeRoutes.set(edge.id, points)
  }
  for (const source of graph.nodes) {
    if (source.config.type !== 'switch' && source.config.type !== 'image-recognition') continue
    const sourcePosition = positions.get(source.id) ?? source.position
    const sourceSize = sizes.get(source.id) ?? fallbackSize(source)
    const portOrder = flowPorts(source)
    const outgoing = graph.edges.filter(edge => edge.sourceNodeId === source.id)
    for (const edge of outgoing) {
      const target = graph.nodes.find(node => node.id === edge.targetNodeId)
      if (target === undefined) continue
      const targetPosition = positions.get(target.id) ?? target.position
      const targetSize = sizes.get(target.id) ?? fallbackSize(target)
      const portIndex = Math.max(0, portOrder.indexOf(edge.sourcePort))
      edgeRoutes.set(edge.id, [{
        x: sourcePosition.x + sourceSize.width + 36 + portIndex * 16 + offsetX,
        y: targetPosition.y + targetSize.height / 2 + offsetY,
      }])
    }
  }
  for (const target of graph.nodes) {
    const incoming = graph.edges
      .filter(edge => edge.targetNodeId === target.id)
      .sort((left, right) => {
        const leftNode = graph.nodes.find(node => node.id === left.sourceNodeId)
        const rightNode = graph.nodes.find(node => node.id === right.sourceNodeId)
        const leftPosition = leftNode === undefined ? undefined : positions.get(leftNode.id)
        const rightPosition = rightNode === undefined ? undefined : positions.get(rightNode.id)
        return (leftPosition?.y ?? leftNode?.position.y ?? 0) - (rightPosition?.y ?? rightNode?.position.y ?? 0)
      })
    if (incoming.length < 2) continue
    const targetPosition = positions.get(target.id) ?? target.position
    const targetSize = sizes.get(target.id) ?? fallbackSize(target)
    const targetCenterY = targetPosition.y + targetSize.height / 2 + offsetY
    incoming.forEach((edge, index) => {
      const source = graph.nodes.find(node => node.id === edge.sourceNodeId)
      if (source === undefined) return
      const sourcePosition = positions.get(source.id) ?? source.position
      const sourceSize = sizes.get(source.id) ?? fallbackSize(source)
      const laneX = targetPosition.x - 42 - index * 18 + offsetX
      edgeRoutes.set(edge.id, [
        { x: laneX, y: sourcePosition.y + sourceSize.height / 2 + offsetY },
        { x: laneX, y: targetCenterY },
        { x: targetPosition.x - 24 + offsetX, y: targetCenterY },
      ])
    })
  }

  return {
    ...graph,
    nodes: graph.nodes.map(node => {
      const position = positions.get(node.id)
      return position === undefined ? node : { ...node, position: { x: position.x + offsetX, y: position.y + offsetY } }
    }),
    edges: graph.edges.map(edge => ({ ...edge, layoutPoints: edgeRoutes.get(edge.id) ?? [] })),
  }
}
