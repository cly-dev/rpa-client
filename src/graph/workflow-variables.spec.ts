import { expect, it } from 'vitest'
import { createNode, createEdge } from './mutate.ts'
import { availableVariableNames, nodeOutputDefinitions, nodeDeclaredVariables, nodeVariableNames } from './workflow-variables.ts'
import { availableVariables as notificationAndRequestVariables } from '../renderer/studio/RequestBodyEditor.tsx'
import { validateGraph } from './validate.ts'
import type { WorkflowGraph, WorkflowNode } from './types.ts'

it('uses exactly the same collector for notification and request-body pickers', () => {
  expect(notificationAndRequestVariables).toBe(availableVariableNames)
})

it('keeps output bindings separate from mapped runtime variable names', () => {
  const request: WorkflowNode = { ...createNode('api-request', { x: 0, y: 0 }), config: { type: 'api-request', url: 'https://example.com', method: 'GET', body: '', responseType: 'json', jsonPath: '', timeoutMs: 1000, outputName: 'response', outputMode: 'declare', updateVariable: 'order', rawOutputName: 'raw', fields: [{ name: 'total', path: 'data.total' }] } }
  expect(nodeOutputDefinitions(request)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'response', variableName: 'order', type: 'object/array' })]))
  expect(nodeDeclaredVariables(request)).toEqual([{ name: 'order', type: 'object/array' }])
  expect(nodeVariableNames(request)).toEqual(['order', 'raw', 'total'])
})

it('shows only reachable upstream variables and preserves configured object field paths', () => {
  const start = createNode('start', { x: 0, y: 0 })
  const approval: WorkflowNode = { ...createNode('approval', { x: 0, y: 0 }), config: { type: 'approval', title: '确认', description: '', fields: [], timeoutMinutes: 30, requireCommentOnReject: false, outputName: 'reply' } }
  const target = createNode('handoff', { x: 0, y: 0 })
  const later: WorkflowNode = { ...createNode('set-variable', { x: 0, y: 0 }), config: { type: 'set-variable', name: 'later', value: { kind: 'literal', value: '' }, path: '' } }
  const graph: WorkflowGraph = { workflowId: 'shared', name: 'shared', version: 1, entryNodeId: start.id, nodes: [start, approval, target, later], edges: [createEdge(start.id, 'default', approval.id), createEdge(approval.id, 'approved', target.id), createEdge(target.id, 'default', later.id)], context: { inputs: [{ name: 'order', type: 'object', defaultValue: { customer: { id: 1 } } }], variables: [] } }
  const names = availableVariableNames(graph, target.id)
  expect(names).toEqual(expect.arrayContaining(['inputs.order.customer.id', 'reply', 'reply.content', 'reply.plainText', 'reply.modified', 'reply.comment']))
  expect(names).not.toContain('later')
  expect(availableVariableNames(graph, approval.id)).not.toContain('reply')
  expect(availableVariableNames(graph, target.id, [], { includeInputs: false })).not.toContain('inputs.order')
})

it('validates bindings against the same custom output definitions while retaining old approval ports', () => {
  const start = createNode('start', { x: 0, y: 0 })
  const approval: WorkflowNode = { ...createNode('approval', { x: 0, y: 0 }), config: { type: 'approval', title: '确认', description: '', fields: [], timeoutMinutes: 30, requireCommentOnReject: false, outputName: 'reply' } }
  const action: WorkflowNode = { ...createNode('set-variable', { x: 0, y: 0 }), config: { type: 'set-variable', name: 'saved', value: { kind: 'node-output', nodeId: approval.id, port: 'reply' }, path: '' }, inputBindings: { value: { kind: 'node-output', nodeId: approval.id, port: 'reply' } } }
  const end = createNode('end', { x: 0, y: 0 })
  const graph: WorkflowGraph = { workflowId: 'binding', name: 'binding', version: 1, entryNodeId: start.id, nodes: [start, approval, action, end], edges: [createEdge(start.id, 'default', approval.id), createEdge(approval.id, 'approved', action.id), createEdge(approval.id, 'rejected', end.id), createEdge(approval.id, 'timeout', end.id), createEdge(action.id, 'default', end.id)] }
  expect(validateGraph(graph)).toEqual([])
  expect(nodeOutputDefinitions(approval)[0]?.aliases).toContain('reviewResult')
})
