import { expect, it } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { variableOptions } from './CodeNodeEditor.tsx'

it('offers code inputs only from connected predecessors and workflow context', () => {
  const start = createNode('start', { x: 0, y: 0 })
  const before = createNode('set-variable', { x: 100, y: 0 })
  const aiSwitch = createNode('switch', { x: 150, y: 0 })
  const code = createNode('code', { x: 200, y: 0 })
  const after = createNode('set-variable', { x: 300, y: 0 })
  const graph: WorkflowGraph = {
    workflowId: 'code-scope', name: 'Code scope', version: 1, entryNodeId: start.id,
    context: { inputs: [{ name: 'requestId', type: 'string' }], variables: [{ name: 'shared', type: 'string' }] },
    nodes: [start, { ...before, config: { type: 'set-variable', name: 'earlier', value: { kind: 'literal', value: '' }, path: '' } }, { ...aiSwitch, config: { type: 'switch', mode: 'ai', left: { kind: 'literal', value: '' }, path: '', cases: ['场景'], casePrompts: ['判断要求'], reasonOutputName: 'routeReason' } }, code, { ...after, config: { type: 'set-variable', name: 'later', value: { kind: 'literal', value: '' }, path: '' } }],
    edges: [createEdge(start.id, 'default', before.id), createEdge(before.id, 'default', aiSwitch.id), createEdge(aiSwitch.id, 'case-0', code.id), createEdge(code.id, 'default', after.id)],
  }

  const names = variableOptions(graph, code.id, []).map(option => option.binding.kind === 'workflow-input' || option.binding.kind === 'variable' ? option.binding.name : '')
  expect(names).toEqual(expect.arrayContaining(['requestId', 'shared', 'earlier', 'routeReason']))
  expect(names).not.toContain('later')
})
