import { describe, expect, it } from 'vitest'
import type { RunState } from '@runner/walk.ts'
import { failedAtPageAction } from './page-action-debug.ts'

function state(status: RunState['status'], nodeId: string, message: string): RunState {
  return { status, currentNodeId: nodeId, nodes: {}, outputs: {}, logs: [{ at: 1, nodeId, nodeName: '页面操作', message }] }
}

describe('failedAtPageAction', () => {
  it('recognizes page-action failure including human handoff', () => {
    expect(failedAtPageAction(state('failed', 'action', '节点「页面操作」(page-action)执行失败：失败，已停下来等人'))).toBe(true)
  })

  it('ignores other failures and successful runs', () => {
    expect(failedAtPageAction(state('failed', 'click', '节点「点击」(click)执行失败：超时'))).toBe(false)
    expect(failedAtPageAction(state('succeeded', 'action', '节点「页面操作」(page-action)执行失败：示例'))).toBe(false)
  })
})
