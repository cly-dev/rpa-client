import type { WorkflowNode } from '@graph/types.ts'

type ForEachConfig = Extract<WorkflowNode['config'], { type: 'for-each' }>

export function hasLoopCondition(config: ForEachConfig): boolean {
  return (config.conditionClauses?.length ?? 0) > 0 || (config.condition?.trim() ?? '') !== ''
}

export function loopIterationTotal(config: ForEachConfig, collectionLength: number): number {
  const length = Math.max(0, collectionLength)
  if (!hasLoopCondition(config)) return length
  return Math.min(length, Math.max(0, config.maxItems))
}
