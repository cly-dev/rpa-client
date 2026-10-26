import { describe, expect, it } from 'vitest'
import type { RunState } from '@runner/walk.ts'
import { mergePickerRunState, pendingPickerSteps } from './picker-progress.ts'

describe('picker progress', () => {
  it('executes only unfinished steps before the target', () => {
    expect(pendingPickerSteps(3, 1)).toEqual([1, 2])
  })

  it('does not execute the stale selector when repicking the failed step', () => {
    expect(pendingPickerSteps(1, 1)).toEqual([])
  })

  it('keeps outputs, variables and logs from completed picker steps', () => {
    const base: RunState = {
      status: 'succeeded', nodes: { action: 'succeeded' }, outputs: { action: { first: 'a' } },
      variables: { token: 'saved' }, logs: [{ at: 1, nodeId: 'action', nodeName: '页面操作', message: '步骤 1 完成' }],
    }
    const next: RunState = {
      status: 'succeeded', nodes: { action: 'succeeded' }, outputs: { action: { second: 'b' } },
      variables: { token: 'saved', id: 2 }, logs: [{ at: 2, nodeId: 'action', nodeName: '页面操作', message: '步骤 2 完成' }],
    }

    expect(mergePickerRunState(base, next)).toMatchObject({
      outputs: { action: { first: 'a', second: 'b' } },
      variables: { token: 'saved', id: 2 },
      logs: [{ message: '步骤 1 完成' }, { message: '步骤 2 完成' }],
    })
  })
})
