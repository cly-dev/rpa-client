import { describe, expect, it } from 'vitest'
import { approvalReviewResult, readReviewResult } from './approval-review.ts'

describe('approval review contract', () => {
  const review = { content: '原文', format: 'text' as const, editable: true }
  const edited = { content: '修改后', plainText: '修改后', modified: false, comment: '伪造意见' }
  it('computes modification and comment instead of trusting submitted flags', () => {
    expect(approvalReviewResult(review, 'approved', edited, '同意')).toEqual({ content: '修改后', plainText: '修改后', modified: true, comment: '同意' })
  })
  it.each(['rejected', 'timeout'])('does not publish edits on %s', decision => {
    expect(approvalReviewResult(review, decision, edited, '')).toMatchObject({ content: '原文', modified: false })
  })
  it('preserves unchanged structured content and rejects type changes', () => {
    const r = { content: [{ qty: 1 }], format: 'json' as const, editable: true }
    expect(approvalReviewResult(r, 'approved', undefined, '')?.content).toEqual([{ qty: 1 }])
    expect(() => approvalReviewResult(r, 'approved', edited, '')).toThrow('数据类型')
  })
  it('never changes read-only content and keeps legacy approval compatible', () => {
    expect(approvalReviewResult({ ...review, editable: false }, 'approved', edited, '')?.content).toBe('原文')
    expect(approvalReviewResult(undefined, 'approved', undefined, '')).toBeUndefined()
  })
  it('rejects unsafe object keys, invalid values and oversized submissions', () => {
    expect(() => readReviewResult({ ...edited, content: JSON.parse('{"__proto__": {"x":1}}') })).toThrow()
    expect(() => readReviewResult({ ...edited, content: Infinity })).toThrow()
    expect(() => readReviewResult({ ...edited, content: 'x'.repeat(200001) })).toThrow()
  })
})

it('provides editable rich content for legacy approvals without a review payload', async () => {
  const { approvalReviewFromPrompt } = await import('./approval-review.ts')
  expect(approvalReviewFromPrompt({ fields: [{ label: '工单ID', value: 123 }, { label: '客户回复内容', value: '<p>原回复</p>' }], description: '请审核' })).toMatchObject({ content: '<p>原回复</p>', format: 'rich-text', editable: true, label: '客户回复内容' })
  expect(approvalReviewFromPrompt({ fields: [], description: '原审批说明' })).toMatchObject({ content: '原审批说明', editable: true, label: '审批说明' })
  const explicit = { content: '只读内容', format: 'text' as const, editable: false }
  expect(approvalReviewFromPrompt({ review: explicit, description: '说明' })).toBe(explicit)
})
