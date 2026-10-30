import { describe, expect, it } from 'vitest'
import { defaultConfig } from './catalog.ts'
import { parseWorkflow } from './parse.ts'

describe('list-row-action config', () => {
  it('creates a safe default configuration', () => {
    expect(defaultConfig('list-row-action')).toMatchObject({
      type: 'list-row-action',
      rowSelectorMode: 'css',
      unmatchedMode: 'keep',
      duplicateMatchAction: 'all',
      emptySourceAction: 'stop',
      maxDeleteCount: 20,
      outputName: 'listOperationResult',
    })
  })

  it('normalizes imported configuration', () => {
    const config = defaultConfig('list-row-action')
    const parsed = parseWorkflow({
      workflowId: 'wf', name: 'rows', version: 1, entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, inputBindings: {}, execution: { timeoutMs: 30000, maxAttempts: 1, onError: 'fail-run' }, config: { type: 'start', url: '' } },
        { id: 'rows', type: 'list-row-action', name: '列表行操作', position: { x: 100, y: 0 }, inputBindings: {}, execution: { timeoutMs: 30000, maxAttempts: 1, onError: 'fail-run' }, config },
        { id: 'end', type: 'end', name: '结束', position: { x: 200, y: 0 }, inputBindings: {}, execution: { timeoutMs: 30000, maxAttempts: 1, onError: 'fail-run' }, config: { type: 'end' } },
      ],
      edges: [
        { id: 'e1', sourceNodeId: 'start', sourcePort: 'default', targetNodeId: 'rows' },
        { id: 'e2', sourceNodeId: 'rows', sourcePort: 'default', targetNodeId: 'end' },
      ],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.graph.nodes.find(node => node.id === 'rows')?.config).toMatchObject({ type: 'list-row-action', maxDeleteCount: 20 })
  })

  it('lets duplicate page-row matches through instead of stopping', () => {
    const config = { ...defaultConfig('list-row-action'), duplicateMatchAction: 'stop' as 'all' }
    const parsed = parseWorkflow({
      workflowId: 'wf', name: 'rows', version: 1, entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, inputBindings: {}, execution: { timeoutMs: 30000, maxAttempts: 1, onError: 'fail-run' }, config: { type: 'start', url: '' } },
        { id: 'rows', type: 'list-row-action', name: '列表行操作', position: { x: 100, y: 0 }, inputBindings: {}, execution: { timeoutMs: 30000, maxAttempts: 1, onError: 'fail-run' }, config },
        { id: 'end', type: 'end', name: '结束', position: { x: 200, y: 0 }, inputBindings: {}, execution: { timeoutMs: 30000, maxAttempts: 1, onError: 'fail-run' }, config: { type: 'end' } },
      ],
      edges: [
        { id: 'e1', sourceNodeId: 'start', sourcePort: 'default', targetNodeId: 'rows' },
        { id: 'e2', sourceNodeId: 'rows', sourcePort: 'default', targetNodeId: 'end' },
      ],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.graph.nodes.find(node => node.id === 'rows')?.config).toMatchObject({ type: 'list-row-action', duplicateMatchAction: 'all' })
  })

  it('keeps type-action dataPath for row fill-back', () => {
    const config = defaultConfig('list-row-action')
    const parsed = parseWorkflow({
      workflowId: 'wf', name: 'rows', version: 1, entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, inputBindings: {}, execution: { timeoutMs: 30000, maxAttempts: 1, onError: 'fail-run' }, config: { type: 'start', url: '' } },
        { id: 'rows', type: 'list-row-action', name: '列表行操作', position: { x: 100, y: 0 }, inputBindings: {}, execution: { timeoutMs: 30000, maxAttempts: 1, onError: 'fail-run' }, config: { ...config, matchedActions: [{ type: 'type', selector: 'input.qty', value: '', dataPath: 'qty', inputMode: 'replace' }] } },
        { id: 'end', type: 'end', name: '结束', position: { x: 200, y: 0 }, inputBindings: {}, execution: { timeoutMs: 30000, maxAttempts: 1, onError: 'fail-run' }, config: { type: 'end' } },
      ],
      edges: [
        { id: 'e1', sourceNodeId: 'start', sourcePort: 'default', targetNodeId: 'rows' },
        { id: 'e2', sourceNodeId: 'rows', sourcePort: 'default', targetNodeId: 'end' },
      ],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.graph.nodes.find(node => node.id === 'rows')?.config).toMatchObject({
      type: 'list-row-action',
      matchedActions: [{ type: 'type', selector: 'input.qty', dataPath: 'qty' }],
    })
  })
})
