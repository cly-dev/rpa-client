import type { CallSubflowConfig, CallSubflowInputMapping, WorkflowGraph } from '@graph/types.ts'

export interface MappingReconciliation {
  readonly retained: readonly CallSubflowInputMapping[]
  readonly removed: readonly string[]
  readonly missingRequired: readonly string[]
}

/** Keep only mappings whose input name and type still exist in the selected revision. */
export function reconcileSubflowMappings(
  current: WorkflowGraph,
  next: WorkflowGraph,
  mappings: readonly CallSubflowInputMapping[],
): MappingReconciliation {
  const currentInputs = new Map((current.context?.inputs ?? []).map(input => [input.name, input]))
  const nextInputs = new Map((next.context?.inputs ?? []).map(input => [input.name, input]))
  const retained = mappings.filter(mapping => {
    const oldInput = currentInputs.get(mapping.inputName)
    const newInput = nextInputs.get(mapping.inputName)
    return oldInput !== undefined && newInput !== undefined && oldInput.type === newInput.type
  })
  const retainedNames = new Set(retained.map(mapping => mapping.inputName))
  return {
    retained,
    removed: mappings.filter(mapping => !retainedNames.has(mapping.inputName)).map(mapping => mapping.inputName),
    missingRequired: (next.context?.inputs ?? [])
      .filter(input => input.required && input.defaultValue === undefined && !retainedNames.has(input.name))
      .map(input => input.description || input.name),
  }
}

export interface BulkSubflowVersionPlan {
  readonly updates: ReadonlyMap<string, CallSubflowConfig>
  readonly removedMappings: number
  readonly nodesMissingRequired: number
  readonly missingRequiredNames: readonly string[]
}

/** Previews a canvas-wide version change without mutating any call node. */
export function planBulkSubflowVersionUpdate(
  graph: WorkflowGraph,
  workflowId: string,
  target: WorkflowGraph,
  previousRevisions: readonly WorkflowGraph[],
): BulkSubflowVersionPlan {
  const updates = new Map<string, CallSubflowConfig>()
  let removedMappings = 0
  let nodesMissingRequired = 0
  const missingRequiredNames = new Set<string>()
  for (const node of graph.nodes) {
    if (node.config.type !== 'call-subflow' || node.config.workflowId !== workflowId || node.config.workflowVersion === target.version) continue
    const config = node.config
    const previous = previousRevisions.find(item => item.workflowId === workflowId && item.version === config.workflowVersion)
    const reconciliation = previous === undefined
      ? {
        retained: [] as readonly CallSubflowInputMapping[],
        removed: (config.inputMappings ?? []).map(item => item.inputName),
        missingRequired: (target.context?.inputs ?? []).filter(input => input.required && input.defaultValue === undefined).map(input => input.description || input.name),
      }
      : reconcileSubflowMappings(previous, target, config.inputMappings ?? [])
    removedMappings += reconciliation.removed.length
    if (reconciliation.missingRequired.length > 0) {
      nodesMissingRequired += 1
      reconciliation.missingRequired.forEach(name => { missingRequiredNames.add(name) })
    }
    updates.set(node.id, { ...config, workflowVersion: target.version, inputMappings: reconciliation.retained })
  }
  return { updates, removedMappings, nodesMissingRequired, missingRequiredNames: [...missingRequiredNames] }
}
