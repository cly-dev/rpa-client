import { describe, expect, it } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import { newId } from '@graph/catalog.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { runBrowser, type BrowserDriver, type ListRowOperationRequest } from './browser-run.ts'
import { listRowValuesMatch } from './list-row-match.ts'

function baseDriver(observe: (request: ListRowOperationRequest) => void): BrowserDriver {
  return {
    async openPage() {},
    async click() {},
    async type() {},
    async extract() { return '' },
    async waitFor() {},
    async operateListRows(request) {
      observe(request)
      request.trace?.('驱动明细：首次扫描页面找到 3 行')
      return { totalPageRows: 3, targetDataCount: 2, matchedCount: 2, updatedCount: 2, deletedCount: 1, finalPageRows: 2, missingItems: [], duplicateItems: [], deletedKeys: ['SKU-X'] }
    },
  }
}

describe('list-row-action', () => {
  it('supports exact and page-value-contains matching without treating an empty target as a wildcard', () => {
    expect(listRowValuesMatch(
      [{ matchMode: 'contains', trim: true, ignoreCase: true }],
      [' 商品编码：sku-a（套装） '],
      ['SKU-A'],
    )).toBe(true)
    expect(listRowValuesMatch(
      [{ matchMode: 'exact', trim: true, ignoreCase: true }],
      ['商品编码：SKU-A'],
      ['SKU-A'],
    )).toBe(false)
    expect(listRowValuesMatch(
      [{ matchMode: 'contains', trim: true, ignoreCase: false }],
      ['任意页面内容'],
      [''],
    )).toBe(false)
  })

  it('resolves item templates and passes row-scoped operations to the browser driver', async () => {
    let observed: ListRowOperationRequest | undefined
    const start = createNode('start', { x: 0, y: 0 })
    const action = createNode('list-row-action', { x: 120, y: 0 })
    const end = createNode('end', { x: 240, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'list rows', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...action, config: {
          type: 'list-row-action', source: { kind: 'literal', value: [{ sku: 'SKU-A', quantity: 2 }, { sku: 'SKU-B', quantity: 5 }] }, sourcePath: '', containerSelector: '#items', rowSelectorMode: 'css', rowSelector: '.row',
          matchFields: [{ rowSelector: '.sku', dataPath: 'sku', matchMode: 'contains', readMode: 'text', trim: true, ignoreCase: true }],
          matchedActions: [{ type: 'type', selector: 'input.qty', value: '{{item.quantity}}-{{suffix}}', inputMode: 'replace' }],
          unmatchedMode: 'delete', deleteSelector: 'button.delete', confirmSelector: '.confirm', waitAfterDeleteMs: 100, maxDeleteCount: 10,
          missingMatchAction: 'stop', duplicateMatchAction: 'all', emptySourceAction: 'stop', outputName: 'syncResult',
        } },
        end,
      ],
      edges: [createEdge(start.id, 'default', action.id), createEdge(action.id, 'default', end.id)],
    }

    const state = await runBrowser(graph, baseDriver(request => { observed = request }), { onUpdate() {}, wait: async () => {} }, { variables: { suffix: '件' } })

    expect(state.status).toBe('succeeded')
    expect(observed?.items).toEqual([
      { index: 0, matchValues: ['SKU-A'], actionValues: ['2-件'] },
      { index: 1, matchValues: ['SKU-B'], actionValues: ['5-件'] },
    ])
    expect(observed?.actions).toEqual([{ type: 'type', selector: 'input.qty', inputMode: 'replace' }])
    expect(observed?.matchFields[0]?.matchMode).toBe('contains')
    expect(state.logs.some(log => log.message.includes('驱动明细：首次扫描页面找到 3 行'))).toBe(true)
    expect(state.logs.some(log => log.message.includes('列表作用域：容器=#items'))).toBe(true)
    expect(state.outputs[action.id]?.syncResult).toMatchObject({ updatedCount: 2, deletedCount: 1 })
  })

  it('fills type actions from a configured item field name', async () => {
    let observed: ListRowOperationRequest | undefined
    const start = createNode('start', { x: 0, y: 0 })
    const action = createNode('list-row-action', { x: 120, y: 0 })
    const end = createNode('end', { x: 240, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'list rows by field', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...action, config: {
          type: 'list-row-action', source: { kind: 'literal', value: [{ sku: 'SKU-A', qty: 1 }, { sku: 'SKU-B', qty: 3 }] }, sourcePath: '', containerSelector: '#items', rowSelectorMode: 'css', rowSelector: '.row',
          matchFields: [{ rowSelector: '.sku', dataPath: 'sku', readMode: 'text', trim: true, ignoreCase: false }],
          matchedActions: [{ type: 'type', selector: 'input.qty', value: '', dataPath: 'qty', inputMode: 'replace' }],
          unmatchedMode: 'keep', deleteSelector: '', confirmSelector: '', waitAfterDeleteMs: 0, maxDeleteCount: 10,
          missingMatchAction: 'stop', duplicateMatchAction: 'all', emptySourceAction: 'stop', outputName: 'syncResult',
        } },
        end,
      ],
      edges: [createEdge(start.id, 'default', action.id), createEdge(action.id, 'default', end.id)],
    }

    const state = await runBrowser(graph, baseDriver(request => { observed = request }), { onUpdate() {}, wait: async () => {} })

    expect(state.status).toBe('succeeded')
    expect(observed?.items).toEqual([
      { index: 0, matchValues: ['SKU-A'], actionValues: ['1'] },
      { index: 1, matchValues: ['SKU-B'], actionValues: ['3'] },
    ])
  })
})
