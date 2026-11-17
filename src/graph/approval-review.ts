import { validApprovalOutputName } from './approval-outputs.ts'
import type { JsonValue } from './types.ts'

export interface ApprovalReview {
  readonly label?: string
  readonly content: JsonValue
  readonly format: 'text' | 'rich-text' | 'json'
  readonly editable: boolean
}
export interface ApprovalReviewResult {
  readonly content: JsonValue
  readonly plainText: string
  readonly modified: boolean
  readonly comment: string
}
function jsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 30) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => jsonValue(item, depth + 1))
  return typeof value === 'object' && Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && jsonValue(item, depth + 1))
}
export function readReviewResult(value: unknown): ApprovalReviewResult | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new Error('审核内容格式无效')
  const result = value as ApprovalReviewResult
  if (!jsonValue(result.content) || typeof result.plainText !== 'string' || typeof result.modified !== 'boolean' || typeof result.comment !== 'string' || JSON.stringify(result).length > 200000) throw new Error('审核内容无效或超过长度限制')
  return { content: result.content, plainText: result.plainText, modified: result.modified, comment: result.comment }
}
export function approvalReviewResult(review: ApprovalReview | undefined, decision: string, submitted: unknown, comment: string): ApprovalReviewResult | undefined {
  if (!review) return undefined
  const candidate = readReviewResult(submitted)
  const useEdit = decision === 'approved' && review.editable && candidate !== undefined
  const content = useEdit ? candidate.content : review.content
  const kind = (v: JsonValue): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
  if (kind(content) !== kind(review.content)) throw new Error('审核内容的数据类型必须与原内容一致')
  const plainText = useEdit ? candidate.plainText : typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  return { content, plainText, modified: JSON.stringify(content) !== JSON.stringify(review.content), comment }
}
export function reviewOutputs(result: ApprovalReviewResult | undefined, outputName = 'reviewResult'): Record<string, JsonValue> {
  if (!validApprovalOutputName(outputName)) throw new Error('审核结果变量名无效或使用了保留名称')
  return result ? { reviewResult: { ...result }, [outputName]: { ...result }, content: result.content, plainText: result.plainText, modified: result.modified } : {}
}

/** Old published flows/queued tasks have display fields but no dedicated review payload. */
export function approvalReviewFromPrompt(prompt: { readonly review?: ApprovalReview; readonly fields?: readonly { readonly label: string; readonly value: unknown }[]; readonly description?: string }): ApprovalReview {
  if (prompt.review) return prompt.review
  const fields = prompt.fields ?? []
  const field = fields.find(item => /回复|文案|邮件|内容|reply|message|content/i.test(item.label)) ?? (fields.length === 1 ? fields[0] : undefined)
  const content = field && jsonValue(field.value) ? field.value : prompt.description ?? ''
  return { content, format: typeof content === 'string' ? 'rich-text' : 'json', editable: true, label: field?.label || '审批说明' }
}
