import { defaultBindings, defaultConfig, defaultExecution, defaultName, newId } from './catalog.ts'
import type { NodeConfig, NodePosition, NodeType, WorkflowEdge, WorkflowGraph, WorkflowNode } from './types.ts'
import { remapSwitchEdges } from './switch-cases.ts'

export function createNode(type: NodeType, position: NodePosition): WorkflowNode {
  return {
    id: newId(type),
    type,
    name: defaultName(type),
    position,
    inputBindings: defaultBindings(type),
    config: defaultConfig(type),
    execution: defaultExecution(),
  }
}

export function createEdge(sourceNodeId: string, sourcePort: string, targetNodeId: string): WorkflowEdge {
  return { id: newId('edge'), sourceNodeId, sourcePort, targetNodeId }
}

/** Make an unconnected copy beside the source without sharing editable config objects. */
export function duplicateNode(graph: WorkflowGraph, sourceId: string): WorkflowNode | undefined {
  const source = graph.nodes.find(node => node.id === sourceId)
  if (source === undefined || source.type === 'start') return undefined
  let position = { x: source.position.x + 250, y: source.position.y }
  while (graph.nodes.some(node => Math.abs(node.position.x - position.x) < 220 && Math.abs(node.position.y - position.y) < 140)) {
    position = { x: position.x, y: position.y + 160 }
  }
  return { ...structuredClone(source), id: newId(source.type), name: `${source.name} 副本`, position }
}

export function replaceNode(graph: WorkflowGraph, next: WorkflowNode): WorkflowGraph {
  return { ...graph, nodes: graph.nodes.map(node => (node.id === next.id ? next : node)) }
}

export function addNode(graph: WorkflowGraph, node: WorkflowNode): WorkflowGraph {
  return { ...graph, nodes: [...graph.nodes, node] }
}

export function moveNode(graph: WorkflowGraph, id: string, position: NodePosition): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map(node => (node.id === id ? { ...node, position } : node)),
  }
}

export function removeNodes(graph: WorkflowGraph, ids: readonly string[]): WorkflowGraph {
  const blocked = new Set(ids.filter(id => graph.nodes.find(node => node.id === id)?.type === 'start'))
  const drop = new Set(ids.filter(id => !blocked.has(id)))
  return {
    ...graph,
    nodes: graph.nodes.filter(node => !drop.has(node.id)),
    edges: graph.edges.filter(edge => !drop.has(edge.sourceNodeId) && !drop.has(edge.targetNodeId)),
  }
}

export function addEdgeToGraph(graph: WorkflowGraph, edge: WorkflowEdge): WorkflowGraph {
  const occupied = graph.edges.some(existing => existing.sourceNodeId === edge.sourceNodeId && existing.sourcePort === edge.sourcePort)
  if (occupied) return graph
  return { ...graph, edges: [...graph.edges, edge] }
}

/** Rewire an occupied outlet instead of creating a second edge from it. */
export function connectOrRewire(graph: WorkflowGraph, edge: WorkflowEdge): WorkflowGraph {
  const previous = graph.edges.find(existing => existing.sourceNodeId === edge.sourceNodeId && existing.sourcePort === edge.sourcePort)
  if (previous === undefined) return addEdgeToGraph(graph, edge)
  if (previous.targetNodeId === edge.targetNodeId) return graph
  return { ...graph, edges: graph.edges.map(existing => existing.id === previous.id ? { ...existing, targetNodeId: edge.targetNodeId } : existing) }
}

export function removeEdges(graph: WorkflowGraph, ids: readonly string[]): WorkflowGraph {
  const drop = new Set(ids)
  return { ...graph, edges: graph.edges.filter(edge => !drop.has(edge.id)) }
}

export function patchNode(
  graph: WorkflowGraph,
  id: string,
  patch: Partial<Pick<WorkflowNode, 'name' | 'config' | 'execution' | 'inputBindings' | 'notifications'>>,
): WorkflowGraph {
  const previous = graph.nodes.find(node => node.id === id)
  const edges = previous?.config.type === 'switch' && patch.config?.type === 'switch'
    ? remapSwitchEdges(graph.edges, id, previous.config, patch.config)
    : graph.edges
  return {
    ...graph,
    edges,
    nodes: graph.nodes.map(node => {
      if (node.id !== id) return node
      const config = patch.config === undefined ? node.config : alignConfig(node.type, patch.config)
      return { ...node, ...patch, config }
    }),
  }
}

function alignConfig(type: NodeType, config: NodeConfig): NodeConfig {
  return config.type === type ? config : defaultConfig(type)
}

export function renameWorkflow(graph: WorkflowGraph, name: string): WorkflowGraph {
  return { ...graph, name }
}
