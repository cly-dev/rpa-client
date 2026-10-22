import { expect, it } from 'vitest'
import type { DryRunState } from '@runner/dry-run.ts'
import { failedRunReason, readableRunError } from './execution-message.ts'

it('shows the workflow failure instead of the Electron IPC wrapper', () => {
  expect(readableRunError(new Error("Error invoking remote method 'workflow:run': Error: 子流程未发布"))).toBe('子流程未发布')
})

it('uses the final failed node log as the execution failure reason', () => {
  const state: DryRunState = {
    status: 'failed', nodes: {}, outputs: {},
    logs: [{ at: 1, nodeId: 'node-1', nodeName: '条件', message: '节点「条件」执行失败：变量缺失' }],
  }
  expect(failedRunReason(state)).toBe('节点「条件」执行失败：变量缺失')
})
