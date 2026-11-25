import { expect, it } from 'vitest'
import { createNode, createEdge } from '../graph/mutate.ts'
import { completeOverwriteOutput } from '../graph/output-saving.ts'
import { validateGraph } from '../graph/validate.ts'
import type { WorkflowGraph } from '../graph/types.ts'
import { runBrowser, type BrowserDriver } from './browser-run.ts'

it('overwrites the selected variable without a separately entered output name', async () => {
  const start = { ...createNode('start', { x: 0, y: 0 }), config: { type: 'start' as const, url: '' } }
  const agent = createNode('agent', { x: 100, y: 0 })
  const code = createNode('code', { x: 200, y: 0 })
  const end = createNode('end', { x: 300, y: 0 })
  const output = completeOverwriteOutput({ name: '', valueType: 'string' as const, description: '最终客户方案', outputMode: 'update' as const, updateVariable: 'customerSolution' }, [])
  const graph: WorkflowGraph = { workflowId: 'overwrite', name: '覆盖', version: 1, entryNodeId: start.id,
    llm: { id: 'test', name: 'test', enabled: true, model: 'test', baseUrl: 'https://example.com', chatPath: '/chat/completions', apiKey: '', maxTokens: 100 },
    context: { inputs: [], variables: [{ name: 'customerSolution', type: 'string', defaultValue: 'exchange' }] },
    nodes: [start, { ...agent, config: { type: 'agent', systemPrompt: '提取方案', task: '提取', outputs: [output], dryAction: 'note' } }, { ...code, config: { type: 'code', input: { kind: 'literal', value: '' }, inputs: [{ name: 'solution', binding: { kind: 'variable', name: 'customerSolution' } }], code: 'return { final: input.solution };', outputName: 'final', outputs: [{ name: 'final', valueType: 'string' }] } }, end],
    edges: [createEdge(start.id, 'default', agent.id), createEdge(agent.id, 'default', code.id), createEdge(code.id, 'default', end.id)] }
  expect(validateGraph(graph)).toEqual([])
  const driver: BrowserDriver = { async openPage() {}, async click() {}, async type() {}, async extract() { return '' }, async waitFor() {}, async generateAgent(_task, _system, fields) { return { [fields[0]!.name]: 'refund' } } }
  const state = await runBrowser(graph, driver, { onUpdate() {}, wait: async () => {} })
  expect(state.status).toBe('succeeded')
  expect(state.outputs[code.id]?.final).toBe('refund')
  const invalid = { ...graph, nodes: graph.nodes.map(n => n.id === agent.id ? { ...n, config: { type: 'agent' as const, systemPrompt: '提取', task: '提取', outputs: [{ ...output, updateVariable: '' }], dryAction: 'note' as const } } : n) }
  expect(validateGraph(invalid)).toEqual(expect.arrayContaining([expect.objectContaining({ message: '覆盖已有变量时，请选择要覆盖的变量' })]))
})
