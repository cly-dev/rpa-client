import { expect, it } from 'vitest'
import { approvalDataOutputs, approvalOutputName, validApprovalOutputName } from './approval-outputs.ts'
import { reviewOutputs } from './approval-review.ts'

it('defaults old approval configurations and emits custom names with a compatible old port', () => {
  expect(approvalOutputName({})).toBe('reviewResult')
  expect(approvalDataOutputs({ outputName: ' checkedReply ' })[0]?.name).toBe('checkedReply')
  const result = { content: '确定', plainText: '确定', modified: true, comment: '' }
  expect(reviewOutputs(result, 'checkedReply')).toMatchObject({ checkedReply: result, reviewResult: result })
})
it('rejects invalid names and names that collide with builtin outputs', () => {
  for (const name of ['2name', 'a.b', '__proto__', 'approved', 'content', 'successCount']) {
    expect(validApprovalOutputName(name)).toBe(false)
    expect(() => reviewOutputs(undefined, name)).toThrow('变量名')
  }
})
