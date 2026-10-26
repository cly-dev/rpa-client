import type { RunState } from '@runner/walk.ts'

/** Zero-based node-internal steps still required before the target can be picked. */
export function pendingPickerSteps(targetStepIndex: number, completedStepCount: number): readonly number[] {
  const target = Math.max(0, Math.trunc(targetStepIndex))
  const completed = Math.max(0, Math.min(target, Math.trunc(completedStepCount)))
  return Array.from({ length: target - completed }, (_, index) => completed + index)
}

/** Carry execution context and history forward while preparing one picker step at a time. */
export function mergePickerRunState(base: RunState, next: RunState): RunState {
  const outputs = { ...base.outputs }
  for (const [nodeId, values] of Object.entries(next.outputs)) outputs[nodeId] = { ...outputs[nodeId], ...values }
  return {
    ...next,
    nodes: { ...base.nodes, ...next.nodes },
    outputs,
    inputs: next.inputs ?? base.inputs,
    variables: next.variables ?? base.variables,
    page: next.page ?? base.page,
    logs: [...base.logs, ...next.logs],
  }
}
