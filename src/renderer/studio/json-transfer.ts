import { parseWorkflow, validateGraph } from '@graph/index.ts'
import type { WorkflowGraph, WorkflowNode } from '@graph/types.ts'

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown }
  catch (error) { throw new Error(`JSON 格式错误：${error instanceof Error ? error.message : '无法解析'}`) }
}

export function importWorkflowJson(text: string, current: WorkflowGraph): WorkflowGraph {
  const parsed = parseWorkflow(parseJson(text))
  if (!parsed.ok) throw new Error(`流程 JSON 无效：${parsed.error}`)
  const next = { ...parsed.graph, workflowId: current.workflowId, version: current.version }
  const issue = validateGraph(next)[0]
  if (issue !== undefined) throw new Error(`流程校验失败：${issue.message}`)
  return next
}

export function importNodeJson(text: string, current: WorkflowNode): WorkflowNode {
  const raw = parseJson(text)
  const parsed = parseWorkflow({ workflowId: 'node-json-import', name: '节点 JSON 导入', version: 1, entryNodeId: current.id, nodes: [raw], edges: [] })
  if (!parsed.ok) throw new Error(`节点 JSON 无效：${parsed.error}`)
  const imported = parsed.graph.nodes[0]
  if (imported === undefined) throw new Error('节点 JSON 无效：缺少节点数据')
  if (imported.type !== current.type) throw new Error(`节点类型不一致：当前为 ${current.type}，导入内容为 ${imported.type}`)
  return { ...imported, id: current.id, position: current.position }
}

export function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function safeJsonFilename(name: string): string {
  const safe = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 80)
  return safe || 'workflow'
}
