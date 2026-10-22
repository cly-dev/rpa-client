import { createEdge, createNode } from '@graph/mutate.ts'
import type { NodeType, WorkflowEdge, WorkflowGraph, WorkflowNode } from '@graph/types.ts'

/** Prefer isolated execution so an empty child start can reuse the current page. */
export function initialNodeRunMode(type: NodeType): 'flow' | 'direct' {
  return type === 'call-subflow' ? 'direct' : 'flow'
}

export function prefixToNode(graph: WorkflowGraph, targetId: string): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const chain: string[] = []
  const edgeChain: WorkflowEdge[] = []
  let current = targetId
  const seen = new Set<string>()
  while (!seen.has(current)) {
    seen.add(current)
    chain.unshift(current)
    if (current === graph.entryNodeId) break
    const incoming = graph.edges.find(edge => edge.targetNodeId === current)
    if (incoming === undefined) break
    edgeChain.unshift(incoming)
    current = incoming.sourceNodeId
  }
  return { nodes: chain.map(id => byId.get(id)).filter((node): node is WorkflowNode => node !== undefined), edges: edgeChain }
}

export function nodeRunGraph(graph: WorkflowGraph, targetId: string): WorkflowGraph {
  const prefix = prefixToNode(graph, targetId)
  const target = prefix.nodes.find(node => node.id === targetId)
  const isolated: WorkflowGraph = { ...graph, entryNodeId: prefix.nodes[0]?.id ?? targetId, nodes: prefix.nodes, edges: prefix.edges }
  if (target?.type !== 'call-subflow') return isolated

  // The child flow must return somewhere, even when the call is the last node
  // in this temporary single-node run. This endpoint is never saved to canvas.
  const end = { ...createNode('end', { x: target.position.x + 240, y: target.position.y }), name: '单节点运行结束' }
  return {
    ...isolated,
    nodes: [...isolated.nodes, end],
    edges: [...isolated.edges, createEdge(target.id, 'default', end.id)],
  }
}

/** Keep the original routes, so conditions decide whether the target is reached. */
export function flowNodeRunGraph(graph: WorkflowGraph, targetId: string): WorkflowGraph {
  const target = graph.nodes.find(node => node.id === targetId)
  if (target?.type !== 'call-subflow') return graph
  return withTemporaryCallEnd(graph, target)
}

/** Start at the selected node without executing any predecessors. */
export function isolatedNodeRunGraph(graph: WorkflowGraph, targetId: string): WorkflowGraph {
  const target = graph.nodes.find(node => node.id === targetId)
  if (target === undefined) return graph
  const isolated = { ...graph, entryNodeId: targetId, nodes: [target], edges: [] }
  return target.type === 'call-subflow' ? withTemporaryCallEnd(isolated, target) : isolated
}

function withTemporaryCallEnd(graph: WorkflowGraph, target: WorkflowNode): WorkflowGraph {
  const end = { ...createNode('end', { x: target.position.x + 240, y: target.position.y }), name: '单节点运行结束' }
  return {
    ...graph,
    nodes: [...graph.nodes, end],
    edges: [...graph.edges.filter(edge => edge.sourceNodeId !== target.id), createEdge(target.id, 'default', end.id)],
  }
}
