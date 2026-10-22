import { describe, expect, it } from 'vitest'
import { createDefaultTemplate } from '@graph/template.ts'
import { createEdge, createNode } from '@graph/mutate.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { runDry } from './dry-run.ts'

describe('runDry', () => {
  it('walks the example line through type and submit', async () => {
    const graph = createDefaultTemplate()
    const state = await runDry(graph, {
      onUpdate() {},
      wait: async () => {},
    })
    expect(state.status).toBe('succeeded')
    const agent = graph.nodes.find(node => node.type === 'agent')
    const typed = graph.nodes.find(node => node.type === 'type')
    const waiting = graph.nodes.find(node => node.type === 'wait')
    expect(agent !== undefined && state.outputs[agent.id]?.json).toMatchObject({ intent: 'reply' })
    expect(typed !== undefined && state.nodes[typed.id] === 'succeeded').toBe(true)
    expect(waiting !== undefined && state.nodes[waiting.id] === 'pending').toBe(true)
  })

  it('dry-runs every array item when the loop has no condition', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const loop = createNode('for-each', { x: 80, y: 0 })
    const next = createNode('continue-loop', { x: 160, y: 0 })
    const end = createNode('end', { x: 240, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: 'dry-full-loop', name: 'dry full loop', version: 1, entryNodeId: start.id,
      nodes: [
        start,
        { ...loop, config: { ...loop.config, type: 'for-each', collection: { kind: 'literal', value: ['A', 'B', 'C'] }, condition: '', conditionClauses: [], maxItems: 1 } },
        next,
        end,
      ],
      edges: [
        createEdge(start.id, 'default', loop.id),
        createEdge(loop.id, 'body', next.id),
        createEdge(loop.id, 'done', end.id),
      ],
    }

    const state = await runDry(graph, { onUpdate() {}, wait: async () => {} })

    expect(state.status).toBe('succeeded')
    expect(state.logs.filter(log => log.nodeId === loop.id && log.message.startsWith('试运行第 ')).map(log => log.message)).toEqual([
      '试运行第 1/3 项',
      '试运行第 2/3 项',
      '试运行第 3/3 项',
    ])
  })
})
