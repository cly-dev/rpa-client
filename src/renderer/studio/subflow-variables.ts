import type { WorkflowGraph, WorkflowNode } from '@graph/types.ts'
import { upstreamNodes } from './upstream-nodes.ts'

function variableNamesFromNode(node: WorkflowNode): string[] {
  const config = node.config
  const names: string[] = []
  if (config.type === 'set-variable') names.push(config.name)
  if (config.type === 'for-each') names.push('currentItem', 'currentIndex', config.itemVar || 'item', config.indexVar || 'index', ...(config.declaredVariables ?? []))
  if (config.type === 'switch' && config.mode === 'ai') names.push(config.reasonOutputName?.trim() || 'reason')
  if (config.type === 'code') {
    names.push(...(config.outputs?.length ? config.outputs.map(item => item.name) : [config.outputName || 'result']))
    names.push(...(config.outputs ?? []).map(item => item.updateVariable ?? ''))
  } else if (config.type === 'agent') {
    names.push(...(config.outputs ?? []).map(item => item.name), ...(config.outputs ?? []).map(item => item.updateVariable ?? ''))
  } else if ('outputName' in config && typeof config.outputName === 'string') names.push(config.outputName)
  if ('updateVariable' in config && typeof config.updateVariable === 'string') names.push(config.updateVariable)
  if (config.type === 'api-request' || config.type === 'api-listen') {
    names.push(config.rawOutputName ?? '', ...(config.fields ?? []).map(field => field.name))
  }
  if (config.type === 'page-action') {
    for (const step of config.steps) if (step.type === 'extract') names.push(step.outputName, step.updateVariable ?? '')
  }
  return names
}

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
      for (const name of variableNamesFromNode(node)) names.add(name.trim())
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
