import type { ApprovalConfig } from './types.ts'

export function approvalOutputName(config: Pick<ApprovalConfig, 'outputName'>): string {
  return config.outputName?.trim() || 'reviewResult'
}
const reserved = new Set(['content', 'plainText', 'modified', 'comment', 'approved', 'decision', 'approverId', 'approverName', 'decidedAt', '__proto__', 'constructor', 'prototype', 'successCount', 'failureCount', 'currentItem', 'currentIndex'])
export function validApprovalOutputName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !reserved.has(name)
}
export function approvalVariablePaths(config: Pick<ApprovalConfig, 'outputName'>): string[] {
  const name = approvalOutputName(config)
  return [name, ...['content', 'plainText', 'modified', 'comment'].map(field => `${name}.${field}`)]
}
export function approvalDataOutputs(config: Pick<ApprovalConfig, 'outputName'>): { name: string; label: string; type: string }[] {
  return [{ name: approvalOutputName(config), label: '审核结果对象', type: 'object' },
    { name: 'content', label: '审核后内容', type: 'any' }, { name: 'plainText', label: '审核后纯文本', type: 'string' },
    { name: 'modified', label: '是否修改', type: 'boolean' }, { name: 'approved', label: '是否通过', type: 'boolean' },
    { name: 'decision', label: '审批结果', type: 'string' }, { name: 'comment', label: '审批意见', type: 'string' }]
}
