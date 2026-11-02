import { describe, expect, it } from 'vitest'
import { createNode } from '@graph/mutate.ts'
import { parseWorkflow } from '@graph/parse.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { runBrowser, type BrowserDriver } from './browser-run.ts'
import { convertSetVariableValue } from './set-variable-type.ts'

describe('设置变量类型', () => {
  it('keeps legacy values unchanged when no type is selected', () => {
    expect(convertSetVariableValue('123', undefined, 'amount')).toBe('123')
  })

  it('converts supported text and validates incompatible values', () => {
    expect(convertSetVariableValue(' 12.5 ', 'number', 'amount')).toBe(12.5)
    expect(convertSetVariableValue('FALSE', 'boolean', 'enabled')).toBe(false)
    expect(convertSetVariableValue('{"id":1}', 'object', 'order')).toEqual({ id: 1 })
    expect(convertSetVariableValue('[1,2]', 'array', 'items')).toEqual([1, 2])
    expect(() => convertSetVariableValue('oops', 'number', 'amount')).toThrow('设置变量「amount」需要number类型')
    expect(() => convertSetVariableValue('{}', 'array', 'items')).toThrow('设置变量「items」需要array类型')
  })

  it('persists the selected type and writes the converted value at runtime', async () => {
    const node = createNode('set-variable', { x: 0, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: 'typed-variable', name: '类型测试', version: 1, entryNodeId: node.id,
      nodes: [{ ...node, config: { type: 'set-variable', name: 'amount', value: { kind: 'literal', value: '123' }, path: '', valueType: 'number' } }], edges: [],
    }
    const parsed = parseWorkflow(JSON.parse(JSON.stringify(graph)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const restored = parsed.graph.nodes[0].config
    expect(restored.type === 'set-variable' && restored.valueType).toBe('number')
    const state = await runBrowser(parsed.graph, {} as BrowserDriver, { onUpdate() {}, wait: async () => {} }, { stopAfterNodeId: node.id })
    expect(state.status).toBe('succeeded')
    expect(state.variables?.amount).toBe(123)
  })
})
