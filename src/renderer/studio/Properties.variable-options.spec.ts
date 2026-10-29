import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { Properties } from './Properties.tsx'

it('shows an upstream output only as nodeName.variableName when the runtime variable has the same name', () => {
  const start = createNode('start', { x: 0, y: 0 })
  const extract = createNode('extract', { x: 100, y: 0 })
  const condition = createNode('condition', { x: 200, y: 0 })
  const end = createNode('end', { x: 300, y: 0 })
  const source = { ...extract, name: '订单抽取', config: { type: 'extract' as const, selector: 'h1', outputName: 'orderId', mode: 'text' as const } }
  const graph: WorkflowGraph = {
    workflowId: 'variable-options', name: '变量选择', version: 1, entryNodeId: start.id,
    context: { inputs: [], variables: [{ name: 'orderId', type: 'string' }] },
    nodes: [start, source, condition, end],
    edges: [
      createEdge(start.id, 'default', source.id),
      createEdge(source.id, 'default', condition.id),
      createEdge(condition.id, 'matched', end.id),
      createEdge(condition.id, 'else', end.id),
    ],
  }

  const html = renderToStaticMarkup(createElement(Properties, {
    graph,
    node: condition,
    onChange: () => {},
    onBatchSubflowVersion: async () => {},
    batchSubflowBusy: false,
    onImport: () => {},
    onRun: () => {},
    onPick: () => {},
  }))

  expect(html).toContain('订单抽取.orderId')
  expect(html).not.toContain('全局变量 · orderId')
  expect(html).not.toContain('变量 · orderId')
})
