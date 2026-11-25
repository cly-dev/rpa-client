import type { ElkNode } from 'elkjs/lib/elk-api.js'
import type { NodePosition, WorkflowGraph } from './types.ts'
import { NODE_CATALOG } from './catalog.ts'
import { structuredLayoutSeeds } from './layout-structure.ts'

export interface LayoutNodeSize {
  readonly width?: number
  readonly height?: number
  /** Handle endpoints relative to the card, measured from React Flow. */
  readonly sourceHandles?: Readonly<Record<string, NodePosition>>
  readonly targetHandle?: NodePosition
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

function flowPorts(node: WorkflowGraph['nodes'][number]): readonly string[] {
  if (node.config.type === 'switch') return [...node.config.cases.map((_, index) => `case-${index}`), 'else']
  if (node.config.type === 'image-recognition') return [...node.config.cases.map(item => `case-${item.id}`), 'else']
  return NODE_CATALOG[node.type].flowOutputs.map(port => port.name)
}

function portId(nodeId: string, direction: 'input' | 'output', port = ''): string {
  return JSON.stringify([nodeId, direction, port])
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
    return [node.id, {
      width: size?.width !== undefined && Number.isFinite(size.width) && size.width > 0 ? size.width : fallback.width,
      height: size?.height !== undefined && Number.isFinite(size.height) && size.height > 0 ? size.height : fallback.height,
    }] as const
  }))
  const sourcePorts = new Map(graph.nodes.map(node => {
    const configured = flowPorts(node)
    const used = graph.edges.filter(edge => edge.sourceNodeId === node.id).map(edge => edge.sourcePort)
    return [node.id, [...new Set([...configured, ...used])]] as const
  }))
  const model: ElkNode = {
    id: 'workflow',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '72',
      'elk.spacing.componentComponent': '120',
      'elk.layered.spacing.edgeNodeBetweenLayers': '24',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '18',
      'elk.layered.spacing.nodeNodeBetweenLayers': '160',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.nodePlacement.favorStraightEdges': 'true',
      'elk.layered.cycleBreaking.strategy': 'GREEDY',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.considerModelOrder.portModelOrder': 'true',
      'elk.layered.thoroughness': '30',
      'elk.separateConnectedComponents': 'true',
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    },
    children: graph.nodes.map(node => {
      const ports = sourcePorts.get(node.id) ?? []
      const size = sizes.get(node.id)!
      const measurement = measured.get(node.id)
      const expanded = node.config.type === 'switch' || node.config.type === 'image-recognition'
      return {
        id: node.id,
        ...size,
        // ELK must route from the same handles the canvas actually renders.
        layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
        ports: [
          { id: portId(node.id, 'input'), width: 0, height: 0,
            x: measurement?.targetHandle?.x ?? 0,
            y: measurement?.targetHandle?.y ?? size.height / 2,
            layoutOptions: { 'elk.port.side': 'WEST', 'elk.port.borderOffset': String(-(measurement?.targetHandle?.x ?? 0)) } },
          ...ports.map((port, index) => ({
            id: portId(node.id, 'output', port), width: 0, height: 0,
            x: measurement?.sourceHandles?.[port]?.x ?? size.width,
            y: measurement?.sourceHandles?.[port]?.y
              ?? (expanded ? size.height - (ports.length - index - 0.5) * 55 : ports.length > 1 ? 28 + index * 18 : size.height / 2),
            layoutOptions: { 'elk.port.side': 'EAST', 'elk.port.index': String(index),
              'elk.port.borderOffset': String((measurement?.sourceHandles?.[port]?.x ?? size.width) - size.width) },
          })),
        ],
      }
    }),
    edges: graph.edges.map(edge => ({ id: edge.id,
      sources: [portId(edge.sourceNodeId, 'output', edge.sourcePort)],
      targets: [portId(edge.targetNodeId, 'input')],
    })),
  }
  // ELK mutates its input, including edge sections. Never feed first-pass
  // routes back into the final pass after changing the placement constraints.
  const initial = await elk.layout(structuredClone(model))
  const initialPositions = new Map((initial.children ?? []).map(node => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]))
  const seeds = structuredLayoutSeeds(graph, initialPositions, sizes, sourcePorts)
  const layout = await elk.layout({
    ...model,
    layoutOptions: {
      ...model.layoutOptions,
      'elk.layered.layering.strategy': 'INTERACTIVE',
      'elk.layered.crossingMinimization.strategy': 'INTERACTIVE',
      'elk.layered.nodePlacement.strategy': 'INTERACTIVE',
      'elk.layered.interactiveReferencePoint': 'CENTER',
      'elk.separateConnectedComponents': 'false',
    },
    children: model.children?.map(node => ({ ...node, ...seeds.get(node.id) })),
  })

  // Preserve ELK's node placement AND routing as one result. Moving individual
  // nodes afterwards breaks obstacle avoidance and crossing minimization.
  const positions = new Map((layout.children ?? []).map(node => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]))
  const entry = graph.nodes.find(node => node.id === graph.entryNodeId)
  const arrangedEntry = positions.get(graph.entryNodeId)
  const offsetX = entry === undefined || arrangedEntry === undefined ? 0 : entry.position.x - arrangedEntry.x
  const offsetY = entry === undefined || arrangedEntry === undefined ? 0 : entry.position.y - arrangedEntry.y
  const edgeRoutes = new Map((layout.edges ?? []).map(edge => [edge.id, (edge.sections ?? []).flatMap(section => [
    section.startPoint, ...(section.bendPoints ?? []), section.endPoint,
  ]).map(point => ({ x: point.x + offsetX, y: point.y + offsetY }))]))

  return {
    ...graph,
    nodes: graph.nodes.map(node => {
      const position = positions.get(node.id)
      return position === undefined ? node : { ...node, position: { x: position.x + offsetX, y: position.y + offsetY } }
    }),
    edges: graph.edges.map(edge => ({ ...edge, layoutPoints: edgeRoutes.get(edge.id) ?? [] })),
  }
}
