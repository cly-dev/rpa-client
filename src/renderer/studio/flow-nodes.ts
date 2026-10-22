import type { Node, NodeChange } from '@xyflow/react'
import type { NodeRunStatus, ValidationIssue, WorkflowGraph, WorkflowNode } from '@graph/types.ts'
import type { FlowNodeData } from './FlowNode.tsx'

export type NodeSize = { readonly width?: number; readonly height?: number }

export function recordNodeMeasurements(changes: readonly NodeChange[], measured: Map<string, NodeSize>): boolean {
  let changed = false
  for (const change of changes) {
    if (change.type === 'dimensions' && change.dimensions !== undefined) {
      const previous = measured.get(change.id)
      if (previous?.width !== change.dimensions.width || previous?.height !== change.dimensions.height) {
        measured.set(change.id, change.dimensions)
        changed = true
      }
    }
    if (change.type === 'remove' && measured.delete(change.id)) changed = true
  }
  return changed
}

export function toFlowNodes(
  graph: WorkflowGraph,
  statuses: Readonly<Record<string, NodeRunStatus>>,
  selectedId: string | undefined,
  onDelete: (id: string) => void,
  measured: ReadonlyMap<string, NodeSize>,
  issues: readonly ValidationIssue[] = [],
): Node[] {
  const connectedPorts = new Map<string, string[]>()
  const issuesByNode = new Map<string, string[]>()
  for (const issue of issues) {
    if (issue.nodeId === undefined) continue
    const messages = issuesByNode.get(issue.nodeId) ?? []
    if (!messages.includes(issue.message)) messages.push(issue.message)
    issuesByNode.set(issue.nodeId, messages)
  }
  for (const edge of graph.edges) {
    const ports = connectedPorts.get(edge.sourceNodeId) ?? []
    ports.push(edge.sourcePort)
    connectedPorts.set(edge.sourceNodeId, ports)
  }
  return graph.nodes.map(node => ({
    id: node.id,
    type: 'studio',
    position: node.position,
    measured: measured.get(node.id),
    selected: node.id === selectedId,
    deletable: node.type !== 'start',
    data: { type: node.type, name: node.name, config: node.config, bindings: nodeBindings(node), connectedPorts: connectedPorts.get(node.id) ?? [], issues: issuesByNode.get(node.id) ?? [], status: statuses[node.id] ?? 'pending', onDelete } satisfies FlowNodeData,
  }))
}

function nodeBindings(node: WorkflowNode): string[] {
  const bindings: string[] = []
  for (const [name, binding] of Object.entries(node.inputBindings ?? {})) {
    if (binding.kind === 'node-output') bindings.push(`${name} ← ${binding.nodeId}.${binding.port}`)
    if (binding.kind === 'workflow-input') bindings.push(`${name} ← inputs.${binding.name}`)
  }
  if (node.config.type === 'type' && node.config.text.kind === 'node-output') bindings.push(`text ← ${node.config.text.nodeId}.${node.config.text.port}`)
  if (node.config.type === 'condition' && node.config.mode !== 'url' && node.config.mode !== 'element' && node.config.left.kind === 'node-output') bindings.push(`判断 ← ${node.config.left.nodeId}.${node.config.left.port}`)
  if (node.config.type === 'image-recognition' && node.config.image.kind === 'node-output') bindings.push(`图片 ← ${node.config.image.nodeId}.${node.config.image.port}`)
  if (node.config.type === 'transform' && node.config.input.kind === 'node-output') bindings.push(`输入 ← ${node.config.input.nodeId}.${node.config.input.port}`)
  if (node.config.type === 'code' && node.config.input.kind === 'node-output') bindings.push(`输入 ← ${node.config.input.nodeId}.${node.config.input.port}`)
  return bindings
}
