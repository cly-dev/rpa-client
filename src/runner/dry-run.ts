import { NODE_CATALOG } from '@graph/catalog.ts'
import type { ElementLocator, NodeOutputs, WorkflowGraph, WorkflowNode } from '@graph/types.ts'
import { asText, resolveBinding, walkJsonPath, walkPath } from './bindings.ts'
import { walkGraph, type RunHandlers, type RunState, type StepResult } from './walk.ts'
import { expandSubflows } from '@graph/expand-subflows.ts'
import { missingStartUrl } from '@graph/validate.ts'
import { workflowNeedsBrowser } from './page-requirement.ts'
import { findSwitchCaseIndex } from '@graph/switch-cases.ts'
import { loopIterationTotal } from './loop.ts'

export type { RunHandlers as DryRunHandlers, RunLogLine, RunState, RunState as DryRunState } from './walk.ts'

const DRY_AGENT_JSON = {
  intent: 'reply',
  reply: '（试运行）已根据上游抽取结果生成回复，下一期才会调用模型。',
  confidence: 0.92,
  reason: 'dry-run',
} as const

export function dryAgentJson(): NodeOutputs {
  return { json: DRY_AGENT_JSON }
}

function selectorText(selector: string | ElementLocator): string {
  return typeof selector === 'string' ? selector : selector.value
}

function dryStep(
  node: WorkflowNode,
  outputs: Readonly<Record<string, NodeOutputs>>,
  loops: Map<string, { index: number; total: number }>,
): StepResult {
  if (node.config.type === 'call-subflow') {
    const name = /^调用 (.+) v\d+$/.exec(node.name)?.[1] ?? node.config.workflowId
    return { message: `进入子流程「${name}」（ID：${node.config.workflowId}，版本：${node.config.workflowVersion === undefined ? '未指定' : `v${node.config.workflowVersion}`}，试运行）` }
  }
  if (node.config.type === 'for-each') {
    const collection = resolveBinding(outputs, node.config.collection)
    const items = Array.isArray(collection) ? collection : []
    const state = loops.get(node.id) ?? { index: 0, total: loopIterationTotal(node.config, items.length) }
    if (state.index >= state.total) {
      loops.delete(node.id)
      return { message: `循环试运行完成，共处理 ${state.total} 项`, branch: 'done' }
    }
    const index = state.index
    const item = items[index] ?? null
    loops.set(node.id, { index: index + 1, total: state.total })
    return {
      message: `试运行第 ${index + 1}/${state.total} 项`,
      branch: 'body',
      outputs: { item, index, [node.config.itemVar || 'item']: item, [node.config.indexVar || 'index']: index },
    }
  }
  if (node.config.type === 'agent') {
    return { message: `试运行 JSON intent=${DRY_AGENT_JSON.intent}`, outputs: { ...dryAgentJson(), [node.config.outputName || 'json']: DRY_AGENT_JSON } }
  }
  if (node.config.type === 'image-recognition') {
    return { message: '图片识别仅在真实运行时调用视觉模型；试运行进入否则分支', branch: 'else', outputs: { [node.config.outputName || 'imageResult']: { branch: 'else', label: '否则', reason: '试运行未调用视觉模型' } } }
  }
  if (node.config.type === 'approval') {
    return { message: '人工审批（试运行自动通过）', branch: 'approved', outputs: { approved: true, decision: 'approved', comment: '', approverName: '试运行', decidedAt: new Date().toISOString() } }
  }
  if (node.config.type === 'extract') {
    return { message: `${NODE_CATALOG[node.type].title} → ${node.config.outputName || 'text'}（未操作网页）`, outputs: { [node.config.outputName || 'text']: '（试运行）示例文本' } }
  }
  if (node.config.type === 'open-page') {
    return { message: `打开 ${node.config.url || '（空 URL）'}（试运行）`, outputs: { url: node.config.url } }
  }
  if (node.config.type === 'type') {
    const text = walkPath(resolveBinding(outputs, node.config.text), node.config.path)
    return { message: `向元素输入 ${String(text).length} 字（内容不记录，试运行）` }
  }
  if (node.config.type === 'click') {
    return { message: `点击 ${selectorText(node.config.selector) || '（空选择器）'}（试运行）` }
  }
  if (node.config.type === 'wait') {
    const selector = selectorText(node.config.selector)
    const extra = selector.trim() === '' ? `${node.config.ms}ms` : `选择器 ${selector}`
    return { message: `等待 ${extra}（试运行）` }
  }
  if (node.config.type === 'condition') {
    if (node.config.mode === 'ai') return { message: 'AI 条件判断仅在真实运行时调用模型；试运行进入否则分支', branch: 'else' }
    if (node.config.clauses !== undefined && node.config.clauses.length > 0) {
      const results = node.config.clauses.map(clause => {
        const actual = walkJsonPath(resolveBinding(outputs, clause.binding), clause.path ?? '')
        const expected = clause.value ?? ''
        if (clause.operator === 'isEmpty') return actual === null || actual === '' || (Array.isArray(actual) && actual.length === 0)
        if (clause.operator === 'isNotEmpty') return !(actual === null || actual === '' || (Array.isArray(actual) && actual.length === 0))
        if (clause.operator === 'contains') return asText(actual).includes(String(expected))
        if (clause.operator === 'notEquals') return typeof expected === 'boolean' ? actual !== expected : actual !== expected && asText(actual) !== String(expected)
        if (clause.operator === 'greaterThan') return Number(asText(actual)) > Number(expected)
        if (clause.operator === 'lessThan') return Number(asText(actual)) < Number(expected)
        return typeof expected === 'boolean' ? actual === expected : actual === expected || asText(actual) === String(expected)
      })
      const matched = node.config.logic === 'or' ? results.some(Boolean) : results.every(Boolean)
      return { message: matched ? '多条件判断满足（试运行）' : '多条件判断不满足（试运行）', branch: matched ? 'matched' : 'else' }
    }
    const value = walkPath(resolveBinding(outputs, node.config.left), node.config.path)
    const matched = value === node.config.equals
    return {
      message: matched ? `走匹配分支（${value}）` : `走否则分支（${value}）`,
      branch: matched ? 'matched' : 'else',
    }
  }
  if (node.config.type === 'switch') {
    if (node.config.mode === 'ai') return { message: 'AI 场景判断仅在真实运行时调用模型；试运行进入否则分支', branch: 'else' }
    const value = walkJsonPath(resolveBinding(outputs, node.config.left), node.config.path)
    const index = findSwitchCaseIndex(node.config, value)
    return { message: index >= 0 ? `走分支 ${index + 1}（${value}）（试运行）` : `走否则分支（${value}）（试运行）`, branch: index >= 0 ? `case-${index}` : 'else' }
  }
  return { message: `${NODE_CATALOG[node.type].title}（试运行）` }
}

/**
 * Walk the saved graph without a browser. Nodes emit fixed sample outputs.
 * @param graph - current editor graph.
 * @param handlers - UI progress hooks.
 */
export async function runDry(graph: WorkflowGraph, handlers: RunHandlers, subflows: readonly WorkflowGraph[] = []): Promise<RunState> {
  const expanded = expandSubflows(graph, subflows)
  if (workflowNeedsBrowser([expanded]) && missingStartUrl(graph) && !expanded.nodes.some(node => node.id !== graph.entryNodeId && node.config.type === 'start' && node.config.url.trim() !== '')) {
    throw new Error('流程和子流程都没有配置开始 URL；请在开始节点填写一个初始地址')
  }
  const loops = new Map<string, { index: number; total: number }>()
  return walkGraph(expanded, handlers, async (node, outputs) => dryStep(node, outputs, loops))
}
