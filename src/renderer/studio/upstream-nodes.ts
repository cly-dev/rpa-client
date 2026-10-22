import type { WorkflowGraph, WorkflowNode } from '@graph/types.ts'

/** Nodes that can execute before the selected node through incoming flow lines. */
export function upstreamNodes(graph: WorkflowGraph, nodeId: string): WorkflowNode[] {
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]))
  for (const edge of graph.edges) {
    // Older workflows may still contain this loop-back line. It is not a data-flow
    // predecessor: a loop can also finish without executing its body at all.
    if (nodesById.get(edge.sourceNodeId)?.type === 'continue-loop' && nodesById.get(edge.targetNodeId)?.type === 'for-each') continue
    const sources = incoming.get(edge.targetNodeId) ?? []
    sources.push(edge.sourceNodeId)
    incoming.set(edge.targetNodeId, sources)
    const targets = outgoing.get(edge.sourceNodeId) ?? []
    targets.push(edge.targetNodeId)
    outgoing.set(edge.sourceNodeId, targets)
  }
  const found = new Set<string>()
  const pending = [...(incoming.get(nodeId) ?? [])]
  while (pending.length > 0) {
    const sourceId = pending.pop()!
    if (sourceId === nodeId || found.has(sourceId)) continue
    found.add(sourceId)
    pending.push(...(incoming.get(sourceId) ?? []))
  }
  // A legacy back edge must not make a later loop-body node appear before its header.
  // Likewise, a predecessor in a disconnected island cannot have executed first.
  const reachable = new Set<string>()
  const forward = [graph.entryNodeId]
  while (forward.length > 0) {
    const currentId = forward.pop()!
    if (currentId === nodeId || reachable.has(currentId)) continue
    reachable.add(currentId)
    forward.push(...(outgoing.get(currentId) ?? []))
  }
  return graph.nodes.filter(node => found.has(node.id) && reachable.has(node.id))
}
