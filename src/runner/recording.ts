import { literalBinding } from '@graph/catalog.ts'
import { connectOrRewire, createEdge, createNode } from '@graph/mutate.ts'
import type { PageActionStep, WorkflowContextVariable, WorkflowGraph } from '@graph/types.ts'

export interface RecordedPageEvent {
  readonly type: 'click' | 'input' | 'select'
  readonly selector: string
  readonly value?: string
  readonly sensitive?: boolean
  readonly likelySubmit?: boolean
  readonly included?: boolean
  readonly confidence: 'high' | 'low'
  readonly label?: string
  readonly url: string
}

function sensitiveInputBaseName(label: string): string {
  const words = label.match(/[a-z0-9]+/gi) ?? []
  const suffix = words.map(word => word[0]!.toUpperCase() + word.slice(1)).join('')
  return `recorded${suffix || 'Secret'}Input`
}

export function recordedEventsToSteps(events: readonly RecordedPageEvent[], existingInputs: readonly WorkflowContextVariable[] = []): { steps: PageActionStep[]; runtimeInputs: WorkflowContextVariable[] } {
  const includedEvents = events.filter(event => event.included !== false && event.selector.trim() !== '')
  const usedNames = new Set(existingInputs.map(input => input.name))
  const sensitiveNames = new Map<number, string>()
  const runtimeInputs: WorkflowContextVariable[] = []
  includedEvents.forEach((event, index) => {
    if (event.sensitive !== true) return
    const base = sensitiveInputBaseName(event.label ?? '')
    let name = base
    let suffix = 2
    while (usedNames.has(name)) name = `${base}${suffix++}`
    usedNames.add(name)
    sensitiveNames.set(index, name)
    runtimeInputs.push({ name, type: 'string', required: true, secret: true, description: event.label ? `录制字段：${event.label}` : '录制时识别到的敏感输入' })
  })
  const steps = includedEvents.map((event, index): PageActionStep => event.type === 'click'
    ? { type: 'click', selector: event.selector, ...(event.likelySubmit ? { waitForLoading: true } : {}) }
    : event.type === 'select'
      ? { type: 'click', selector: event.selector, optionValue: event.value ?? '' }
      : { type: 'type', selector: event.selector, value: event.sensitive ? { kind: 'workflow-input', name: sensitiveNames.get(index)! } : literalBinding(event.value ?? '') })
  return { steps, runtimeInputs }
}

export function insertRecordedSteps(graph: WorkflowGraph, initialUrl: string, steps: readonly PageActionStep[], runtimeInputs: readonly WorkflowContextVariable[] = []): WorkflowGraph {
  if (steps.length === 0) throw new Error('没有可生成的页面操作步骤')
  const start = graph.nodes.find(node => node.id === graph.entryNodeId)
  if (start?.config.type !== 'start') throw new Error('流程开始节点不存在，无法插入录制结果')

  let inserted = createNode('page-action', { x: start.position.x + 280, y: start.position.y })
  while (graph.nodes.some(node => Math.abs(node.position.x - inserted.position.x) < 220 && Math.abs(node.position.y - inserted.position.y) < 140)) {
    inserted = { ...inserted, position: { ...inserted.position, y: inserted.position.y + 160 } }
  }
  inserted = { ...inserted, name: '录制的页面操作', config: { type: 'page-action', steps: [...steps] } }

  const next = graph.edges.find(edge => edge.sourceNodeId === start.id && edge.sourcePort === 'default')
  const withNode: WorkflowGraph = {
    ...graph,
    nodes: [...graph.nodes, inserted],
    edges: graph.edges.filter(edge => edge !== next),
    context: {
      inputs: [...(graph.context?.inputs ?? []), ...runtimeInputs],
      variables: graph.context?.variables ?? [],
    },
  }
  const updatedStart = { ...start, config: { ...start.config, url: initialUrl } }
  const withStart = { ...withNode, nodes: withNode.nodes.map(node => node.id === start.id ? updatedStart : node) }
  const linked = connectOrRewire(withStart, createEdge(start.id, 'default', inserted.id))
  return next === undefined ? linked : { ...linked, edges: [...linked.edges, createEdge(inserted.id, 'default', next.targetNodeId)] }
}
