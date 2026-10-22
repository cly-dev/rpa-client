import { describe, expect, it } from 'vitest'
import { createDefaultTemplate } from './template.ts'
import { subflowInputTypeWarning } from './subflow-input-types.ts'

const graph = {
  ...createDefaultTemplate(),
  context: {
    inputs: [{ name: 'account', type: 'string' as const }, { name: 'amount', type: 'number' as const }],
    variables: [{ name: 'enabled', type: 'boolean' as const }],
  },
}

describe('subflow input type hints', () => {
  it('reports definite mismatches in literal and typed parent sources', () => {
    const numberInput = { name: 'amount', type: 'number' as const, required: true }
    expect(subflowInputTypeWarning(graph, numberInput, { kind: 'literal', value: true })).toContain('布尔值')
    expect(subflowInputTypeWarning(graph, numberInput, { kind: 'literal', value: 'abc' })).toContain('文本')
    expect(subflowInputTypeWarning(graph, { name: 'flag', type: 'boolean' }, { kind: 'workflow-input', name: 'account' })).toContain('文本')
    expect(subflowInputTypeWarning(graph, { name: 'rows', type: 'array' }, { kind: 'literal', value: { id: 1 } })).toContain('对象')
  })

  it('accepts runtime-supported coercions and leaves dynamic numeric text unresolved', () => {
    expect(subflowInputTypeWarning(graph, { name: 'amount', type: 'number', required: true }, { kind: 'literal', value: '123' })).toBeUndefined()
    expect(subflowInputTypeWarning(graph, { name: 'account', type: 'string', required: true }, { kind: 'literal', value: 123 })).toBeUndefined()
    expect(subflowInputTypeWarning(graph, { name: 'amount', type: 'number', required: true }, { kind: 'workflow-input', name: 'account' })).toBeUndefined()
    expect(subflowInputTypeWarning(graph, { name: 'amount', type: 'number', required: true }, { kind: 'literal', value: '{{inputs.account}}' })).toBeUndefined()
    expect(subflowInputTypeWarning(graph, { name: 'amount', type: 'number', required: true }, { kind: 'literal', value: '￥{{inputs.amount}}' })).toContain('文本')
  })

  it('does not claim a type for unknown outputs', () => {
    expect(subflowInputTypeWarning(graph, { name: 'flag', type: 'boolean' }, { kind: 'node-output', nodeId: 'unknown', port: 'result' })).toBeUndefined()
  })
})
