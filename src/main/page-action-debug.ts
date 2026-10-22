import type { RunState } from '@runner/walk.ts'

/** Only open the debug browser for a page-action node that actually failed. */
export function failedAtPageAction(state: RunState): boolean {
  return state.status === 'failed'
    && state.currentNodeId !== undefined
    && state.logs.some(line => line.nodeId === state.currentNodeId && line.message.includes('(page-action)执行失败：'))
}
