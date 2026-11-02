import type { WorkflowGraph, WorkflowNode } from './types.ts'

/** Keep the persisted handoff type so existing workflow edges and server revisions remain readable. */
export function normalizeNotificationNode(node: WorkflowNode): WorkflowNode {
  if (node.type !== 'handoff') return node
  const content = node.notifications?.messageTemplate
    || node.notifications?.messageTemplates?.onSuccess
    || (node.config.type === 'handoff' ? node.config.note : '')
  const name = node.name === '人工接管' ? '通知' : node.name
  if (name === node.name && node.notifications?.enabled === true && node.notifications.onSuccess === true
    && node.notifications.onFailure !== true && node.notifications.messageTemplate === content
    && node.notifications.messageTemplates === undefined) return node
  return {
    ...node,
    name,
    notifications: { enabled: true, onSuccess: true, onFailure: false, messageTemplate: content },
  }
}

export function normalizeNotificationNodes(graph: WorkflowGraph): WorkflowGraph {
  const nodes = graph.nodes.map(normalizeNotificationNode)
  return nodes.every((node, index) => node === graph.nodes[index]) ? graph : { ...graph, nodes }
}
