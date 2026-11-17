import { describe, expect, it } from 'vitest'
import { createNode, createEdge } from '../graph/mutate.ts'
import { parseWorkflow } from '../graph/parse.ts'
import { validateGraph } from '../graph/validate.ts'
import { runBrowser, type BrowserDriver } from './browser-run.ts'
import type { WorkflowGraph, ApprovalPrompt } from '../graph/types.ts'

function fixture(loop = false, outputName = 'reviewResult'): WorkflowGraph {
  const start = { ...createNode('start', { x: 0, y: 0 }), id: 'start' }
  const approval = { ...createNode('approval', { x: 0, y: 0 }), id: 'approval' }
  const action = { ...createNode('set-variable', { x: 0, y: 0 }), id: 'action' }
  const end = { ...createNode('end', { x: 0, y: 0 }), id: 'end' }
  const loopNode = { ...createNode('for-each', { x: 0, y: 0 }), id: 'loop' }
  const cont = { ...createNode('continue-loop', { x: 0, y: 0 }), id: 'cont' }
  return { workflowId: 'review', name: 'review', version: 1, entryNodeId: start.id,
    nodes: [start, { ...approval, config: { type: 'approval', title: '确认', description: '', fields: [], timeoutMinutes: 30, requireCommentOnReject: false, outputName, content: { kind: 'variable', name: loop ? 'currentItem' : 'original' }, contentFormat: loop ? 'json' : 'rich-text', editable: true } },
      { ...action, type: 'code', config: { type: 'code', input: { kind: 'literal', value: '' }, inputs: [{ name: 'value', binding: { kind: 'variable', name: `${outputName}.content` } }], code: 'return { final: input.value };', outputName: 'final', outputs: [{ name: 'final', valueType: 'string' }] } }, end,
      ...(loop ? [{ ...loopNode, config: { type: 'for-each' as const, collection: { kind: 'literal' as const, value: ['A', 'B'] }, maxItems: 100, itemVar: 'currentItem', indexVar: 'currentIndex', retryCount: 0, onItemError: 'stop' as const } }, cont] : [])],
    edges: [createEdge('start', 'default', loop ? 'loop' : 'approval'), createEdge('approval', 'approved', 'action'), createEdge('approval', 'rejected', loop ? 'cont' : 'end'), createEdge('approval', 'timeout', loop ? 'cont' : 'end'), createEdge('action', 'default', loop ? 'cont' : 'end'), ...(loop ? [createEdge('loop', 'body', 'approval'), createEdge('loop', 'done', 'end')] : [])],
    context: { inputs: [], variables: [{ name: 'original', type: 'string', defaultValue: '<p>原文</p>' }] } }
}
const driver: BrowserDriver = { async openPage() {}, async click() {}, async type() {}, async extract() { return '' }, async waitFor() {} }
const handlers = { onUpdate() {}, wait: async () => {} }
const decision = { decision: 'approved' as const, comment: '确认', approverName: '执行人', decidedAt: new Date().toISOString() }

describe('editable approval flow', () => {
  it('roundtrips configuration and exposes output bindings', () => {
    const parsed = parseWorkflow(fixture())
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(validateGraph(parsed.graph)).toEqual([])
  })
  it('passes rich edits to subsequent nodes while retaining upstream content', async () => {
    const state = await runBrowser(fixture(), driver, { ...handlers, requestApproval: async prompt => {
      expect(prompt.review?.content).toBe('<p>原文</p>')
      return { ...decision, reviewResult: { content: '<p><b>修改后</b></p>', plainText: '修改后', modified: true, comment: '' } }
    } })
    expect(state.status).toBe('succeeded')
    expect(state.outputs.approval?.reviewResult).toMatchObject({ content: '<p><b>修改后</b></p>', comment: '确认' })
    expect(state.outputs.action?.final).toBe('<p><b>修改后</b></p>')
  })
  it('uses node-output binding without relying on a global variable', async () => {
    const graph = fixture()
    const bound = { ...graph, nodes: graph.nodes.map(n => n.id === 'action' ? { ...n, config: { type: 'code' as const, input: { kind: 'literal' as const, value: '' }, inputs: [{ name: 'value', binding: { kind: 'node-output' as const, nodeId: 'approval', port: 'content' } }], code: 'return { final: input.value };', outputName: 'final', outputs: [{ name: 'final', valueType: 'string' as const }] } } : n) }
    const state = await runBrowser(bound, driver, { ...handlers, requestApproval: async () => ({ ...decision, reviewResult: { content: '新版', plainText: '新版', modified: true, comment: '' } }) })
    expect(state.outputs.action?.final).toBe('新版')
  })
  it('freezes separate loop inputs and resumes with only that approval result', async () => {
    const graph = fixture(true, 'approvedReply')
    const queued: ApprovalPrompt[] = []
    const scanned = await runBrowser(graph, driver, { ...handlers, queueApproval: async prompt => { queued.push(prompt) } }, { executionId: 'execution' })
    expect(scanned.status, JSON.stringify(scanned.logs)).toBe('succeeded')
    expect(queued.map(p => p.review?.content)).toEqual(['A', 'B'])
    const first = queued[0]!
    const resumed = await runBrowser(graph, driver, handlers, { variables: first.continuation!.variables, inputs: first.continuation!.inputs, outputs: first.continuation!.outputs, resumeApproval: { ...decision, nodeId: 'approval', reviewResult: { content: 'A编辑', plainText: 'A编辑', modified: true, comment: '确认' } } })
    expect(resumed.status).toBe('succeeded')
    expect(resumed.outputs.action?.final).toBe('A编辑')
    expect(resumed.outputs.approval?.approvedReply).toMatchObject({ content: 'A编辑' })
    expect(queued[1]?.review?.content).toBe('B')
  })
})

it('registers a custom result variable after blocking approval and preserves configuration on import', async () => {
  const graph = fixture(false, 'approvedReply')
  const parsed = parseWorkflow(graph)
  expect(parsed.ok && parsed.graph.nodes.find(n => n.id === 'approval')?.config).toMatchObject({ outputName: 'approvedReply' })
  let variables: Record<string, unknown> = {}
  const state = await runBrowser(graph, driver, { ...handlers, onUpdate: next => { variables = (next as unknown as { variables: Record<string, unknown> }).variables }, requestApproval: async () => ({ ...decision, reviewResult: { content: '确认的新内容', plainText: '确认的新内容', modified: true, comment: '' } }) })
  expect(state.status).toBe('succeeded')
  expect(state.outputs.action?.final).toBe('确认的新内容')
  expect(state.outputs.approval?.approvedReply).toMatchObject({ content: '确认的新内容' })
  expect(variables.approvedReply).toMatchObject({ content: '确认的新内容' })
  expect(variables).not.toHaveProperty('reviewResult')
})

it('captures the edited approval value for a following notification', async () => {
  const graph = fixture(false, 'approvedReply')
  const notify = { ...createNode('handoff', { x: 400, y: 0 }), id: 'notify', notifications: { enabled: true, onSuccess: true, messageTemplate: '{{approvedReply.plainText}}' } }
  const withNotice = { ...graph, nodes: [...graph.nodes, notify], edges: [...graph.edges.filter(e => e.sourceNodeId !== 'action'), createEdge('action', 'default', 'notify'), createEdge('notify', 'default', 'end')] }
  let latest: any
  const state = await runBrowser(withNotice, driver, { ...handlers, onUpdate: next => { latest = next }, requestApproval: async () => ({ ...decision, reviewResult: { content: '<p>审核后的回复</p>', plainText: '审核后的回复', modified: true, comment: '' } }) })
  expect(state.status).toBe('succeeded')
  const event = latest.logs.find((log: any) => log.nodeId === 'notify' && log.notificationEvent === 'node.succeeded')
  expect(event?.notificationValues).toMatchObject({ 'approvedReply.plainText': '审核后的回复' })
})

it('opens legacy published approval nodes with editable content and passes the edits downstream', async () => {
  const graph = fixture()
  const legacy = { ...graph, nodes: graph.nodes.map(n => n.config.type === 'approval' ? { ...n, config: { ...n.config, content: undefined, fields: [{ label: '回复内容', value: { kind: 'literal' as const, value: '旧版原文' } }] } } : n) }
  const state = await runBrowser(legacy, driver, { ...handlers, requestApproval: async prompt => {
    expect(prompt.review).toMatchObject({ content: '旧版原文', editable: true, format: 'rich-text' })
    return { ...decision, reviewResult: { content: '<p>旧审批修改后</p>', plainText: '旧审批修改后', modified: true, comment: '' } }
  } })
  expect(state.status).toBe('succeeded')
  expect(state.outputs.action?.final).toBe('<p>旧审批修改后</p>')
})
