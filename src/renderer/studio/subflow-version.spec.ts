import { expect, it } from 'vitest'
import type { CallSubflowInputMapping, WorkflowGraph } from '@graph/types.ts'
import { createNode } from '@graph/mutate.ts'
import { createDefaultTemplate } from '@graph/template.ts'
import { planBulkSubflowVersionUpdate, reconcileSubflowMappings } from './subflow-version.ts'

function flow(inputs: NonNullable<WorkflowGraph['context']>['inputs']): WorkflowGraph {
  return { workflowId: 'child', name: 'Child', version: 1, entryNodeId: 'start', nodes: [], edges: [], context: { inputs, variables: [] } }
}

it('preserves compatible mappings and requires changed or new inputs to be mapped again', () => {
  const current = flow([
    { name: 'orderId', type: 'string', required: true },
    { name: 'amount', type: 'number', required: true },
    { name: 'legacy', type: 'string' },
  ])
  const next = flow([
    { name: 'orderId', type: 'string', required: true },
    { name: 'amount', type: 'string', required: true },
    { name: 'newRequired', type: 'string', required: true },
  ])
  const mappings: CallSubflowInputMapping[] = [
    { inputName: 'orderId', source: { kind: 'variable', name: 'id' } },
    { inputName: 'amount', source: { kind: 'variable', name: 'total' } },
    { inputName: 'legacy', source: { kind: 'literal', value: 'old' } },
  ]

  expect(reconcileSubflowMappings(current, next, mappings)).toEqual({
    retained: [mappings[0]],
    removed: ['amount', 'legacy'],
    missingRequired: ['amount', 'newRequired'],
  })
})

it('plans one version change for every matching call while preserving each node’s compatible mappings', () => {
  const oldOne = { ...flow([{ name: 'id', type: 'string' }, { name: 'legacy', type: 'string' }]), version: 1 }
  const oldTwo = { ...flow([{ name: 'id', type: 'string' }, { name: 'amount', type: 'number' }]), version: 2 }
  const target = { ...flow([{ name: 'id', type: 'string' }, { name: 'amount', type: 'number', required: true }, { name: 'newRequired', type: 'string', required: true }]), version: 3 }
  const first = createNode('call-subflow', { x: 0, y: 0 })
  const second = createNode('call-subflow', { x: 100, y: 0 })
  const alreadyCurrent = createNode('call-subflow', { x: 200, y: 0 })
  const unrelated = createNode('call-subflow', { x: 300, y: 0 })
  const graph = {
    ...createDefaultTemplate(),
    nodes: [
      { ...first, config: { type: 'call-subflow' as const, workflowId: 'child', workflowVersion: 1, inputMappings: [{ inputName: 'id', source: { kind: 'literal' as const, value: 'A' } }, { inputName: 'legacy', source: { kind: 'literal' as const, value: 'old' } }] } },
      { ...second, config: { type: 'call-subflow' as const, workflowId: 'child', workflowVersion: 2, inputMappings: [{ inputName: 'id', source: { kind: 'literal' as const, value: 'B' } }, { inputName: 'amount', source: { kind: 'literal' as const, value: 10 } }] } },
      { ...alreadyCurrent, config: { type: 'call-subflow' as const, workflowId: 'child', workflowVersion: 3, inputMappings: [] } },
      { ...unrelated, config: { type: 'call-subflow' as const, workflowId: 'other', workflowVersion: 1, inputMappings: [] } },
    ],
  }

  const plan = planBulkSubflowVersionUpdate(graph, 'child', target, [oldOne, oldTwo])
  expect([...plan.updates.keys()]).toEqual([first.id, second.id])
  expect(plan.updates.get(first.id)?.inputMappings?.map(item => item.inputName)).toEqual(['id'])
  expect(plan.updates.get(second.id)?.inputMappings?.map(item => item.inputName)).toEqual(['id', 'amount'])
  expect(plan.removedMappings).toBe(1)
  expect(plan.nodesMissingRequired).toBe(2)
  expect(plan.missingRequiredNames).toEqual(['amount', 'newRequired'])
})
