import { describe, expect, it } from 'vitest'
import { createDefaultTemplate } from './template.ts'
import { createNode } from './mutate.ts'
import { validateGraph } from './validate.ts'
import type { WorkflowNode } from './types.ts'

describe('subflow input validation', () => {
  it('flags missing required inputs once the selected revision is loaded', () => {
    const parent = createDefaultTemplate()
    const child = { ...createDefaultTemplate(), workflowId: 'child', version: 2, context: { inputs: [{ name: 'account', type: 'string' as const, required: true }], variables: [] } }
    const call = createNode('call-subflow', { x: 200, y: 100 })
    const configured: WorkflowNode = { ...call, config: { type: 'call-subflow', workflowId: 'child', workflowVersion: 2, inputMappings: [] } }
    const graph = { ...parent, nodes: [...parent.nodes, configured] }

    expect(validateGraph(graph, [child]).some(item => item.nodeId === call.id && item.code === 'subflow-required-input')).toBe(true)

    const mapped: WorkflowNode = { ...configured, config: { type: 'call-subflow', workflowId: 'child', workflowVersion: 2, inputMappings: [{ inputName: 'account', source: { kind: 'workflow-input', name: 'account' } }] } }
    expect(validateGraph({ ...graph, nodes: [...parent.nodes, mapped] }, [child]).some(item => item.nodeId === call.id && item.code === 'subflow-required-input')).toBe(false)
  })

  it('flags a definite incompatible mapped value on the call node', () => {
    const parent = createDefaultTemplate()
    const child = { ...createDefaultTemplate(), workflowId: 'child', version: 2, context: { inputs: [{ name: 'enabled', type: 'boolean' as const, required: true }], variables: [] } }
    const call = createNode('call-subflow', { x: 200, y: 100 })
    const configured: WorkflowNode = { ...call, config: { type: 'call-subflow', workflowId: 'child', workflowVersion: 2, inputMappings: [{ inputName: 'enabled', source: { kind: 'literal', value: 3 } }] } }
    const issue = validateGraph({ ...parent, nodes: [...parent.nodes, configured] }, [child]).find(item => item.nodeId === call.id && item.code === 'subflow-input-type-mismatch')
    expect(issue?.message).toContain('布尔值')
    expect(issue?.message).toContain('数字')
  })
})
