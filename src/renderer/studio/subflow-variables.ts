import { nodeVariableNames } from '@graph/workflow-variables.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { upstreamNodes } from './upstream-nodes.ts'

/** Variables produced by configured published child flows in this editor. */
export function availableSubflowVariableNames(graph: WorkflowGraph, subflows: readonly WorkflowGraph[], nodeId: string): string[] {
  const byRevision = new Map(subflows.map(child => [`${child.workflowId}@${child.version}`, child]))
  const seenRevisions = new Set<string>()
  const names = new Set<string>()
  const visit = (child: WorkflowGraph): void => {
    const key = `${child.workflowId}@${child.version}`
    if (seenRevisions.has(key)) return
    seenRevisions.add(key)
    for (const variable of child.context?.variables ?? []) names.add(variable.name.trim())
    for (const node of child.nodes) {
      for (const name of nodeVariableNames(node)) names.add(name.trim())
      if (node.config.type !== 'call-subflow' || node.config.workflowVersion === undefined) continue
      const nested = byRevision.get(`${node.config.workflowId}@${node.config.workflowVersion}`)
      if (nested !== undefined) visit(nested)
    }
  }
  for (const node of upstreamNodes(graph, nodeId)) {
    if (node.config.type !== 'call-subflow' || node.config.workflowVersion === undefined) continue
    const child = byRevision.get(`${node.config.workflowId}@${node.config.workflowVersion}`)
    if (child !== undefined) visit(child)
  }
  names.delete('')
  return [...names]
}
