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

it('offers the declared approval name and its fields to a downstream node', () => {
  const start = createNode('start', { x: 0, y: 0 })
  const review = createNode('approval', { x: 100, y: 0 })
  const action = createNode('condition', { x: 200, y: 0 })
  const graph: WorkflowGraph = { workflowId: 'review-options', name: '审核变量', version: 1, entryNodeId: start.id, nodes: [start, { ...review, name: '人工确认', config: { type: 'approval', outputName: 'approvedReply', title: '确认', description: '', fields: [], timeoutMinutes: 30, requireCommentOnReject: false } }, action], edges: [createEdge(start.id, 'default', review.id), createEdge(review.id, 'approved', action.id)] }
  const html = renderToStaticMarkup(createElement(Properties, { graph, node: action, onChange() {}, onBatchSubflowVersion: async () => {}, batchSubflowBusy: false, onImport() {}, onRun() {}, onPick() {} }))
  expect(html).toContain('人工确认.approvedReply')
  expect(html).toContain('approvedReply.content')
  expect(html).toContain('approvedReply.plainText')
  expect(html).not.toContain('人工确认.reviewResult')
})

it('renders custom approval fields inside the notification variable selector', () => {
  const start = createNode('start', { x: 0, y: 0 })
  const approval = createNode('approval', { x: 100, y: 0 })
  const notify = createNode('handoff', { x: 200, y: 0 })
  const end = createNode('end', { x: 300, y: 0 })
  const graph: WorkflowGraph = { workflowId: 'notice-options', name: '审批通知', version: 1, entryNodeId: start.id,
    nodes: [start, { ...approval, config: { type: 'approval', title: '确认', description: '', fields: [], timeoutMinutes: 30, requireCommentOnReject: false, outputName: 'approvedReply' } }, notify, end],
    edges: [createEdge(start.id, 'default', approval.id), createEdge(approval.id, 'approved', notify.id), createEdge(notify.id, 'default', end.id)] }
  const html = renderToStaticMarkup(createElement(Properties, { graph, node: notify, onChange() {}, onBatchSubflowVersion: async () => {}, batchSubflowBusy: false, onImport() {}, onRun() {}, onPick() {} }))
  expect(html).toContain('aria-label="插入通知变量"')
  for (const field of ['approvedReply', 'approvedReply.content', 'approvedReply.plainText', 'approvedReply.modified', 'approvedReply.comment']) expect(html).toContain(`<option value="${field}">${field}</option>`)
})
