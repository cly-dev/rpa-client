import { describe, expect, it } from 'vitest'
import type { SwitchConfig, WorkflowEdge } from './types.ts'
import { findSwitchCaseIndex, remapSwitchEdges, reorderSwitchCase, switchCaseValue } from './switch-cases.ts'
import { createDefaultTemplate } from './template.ts'
import { createNode, patchNode } from './mutate.ts'
import { parseWorkflow } from './parse.ts'
import { validateGraph } from './validate.ts'
import { runDry } from '../runner/dry-run.ts'
import { runBrowser, type BrowserDriver } from '../runner/browser-run.ts'

const config: SwitchConfig = {
  type: 'switch',
  left: { kind: 'literal', value: '' },
  path: '',
  cases: ['90', '90', 'true', 'false', 'null', ' approved '],
  caseTypes: ['number', 'string', 'boolean', 'boolean', 'null', 'string'],
  caseIds: ['a', 'b', 'c', 'd', 'e', 'f'],
}

describe('exact switch cases', () => {
  it('matches values by type without coercing text', () => {
    expect(findSwitchCaseIndex(config, 90)).toBe(0)
    expect(findSwitchCaseIndex(config, '90')).toBe(1)
    expect(findSwitchCaseIndex(config, true)).toBe(2)
    expect(findSwitchCaseIndex(config, false)).toBe(3)
    expect(findSwitchCaseIndex(config, null)).toBe(4)
    expect(findSwitchCaseIndex(config, ' approved ')).toBe(5)
    expect(findSwitchCaseIndex(config, 'approved')).toBe(-1)
  })

  it('preserves legacy string-only workflows and rejects incomplete numbers', () => {
    expect(findSwitchCaseIndex({ ...config, cases: ['true'], caseTypes: undefined }, true)).toBe(-1)
    expect(findSwitchCaseIndex({ ...config, cases: ['true'], caseTypes: undefined }, 'true')).toBe(0)
    expect(switchCaseValue({ ...config, cases: [''], caseTypes: ['number'] }, 0)).toBeUndefined()
    expect(switchCaseValue({ ...config, cases: ['1e999'], caseTypes: ['number'] }, 0)).toBeUndefined()
  })

  it('removes a deleted branch edge and keeps later edges on their original branches', () => {
    const previous: SwitchConfig = { ...config, cases: ['A', 'B', 'C'], caseTypes: ['string', 'string', 'string'], caseIds: ['a', 'b', 'c'] }
    const next: SwitchConfig = { ...previous, cases: ['A', 'C'], caseTypes: ['string', 'string'], caseIds: ['a', 'c'] }
    const edges: WorkflowEdge[] = [
      { id: 'edge-a', sourceNodeId: 'switch', sourcePort: 'case-0', targetNodeId: 'target-a' },
      { id: 'edge-b', sourceNodeId: 'switch', sourcePort: 'case-1', targetNodeId: 'target-b' },
      { id: 'edge-c', sourceNodeId: 'switch', sourcePort: 'case-2', targetNodeId: 'target-c' },
      { id: 'edge-else', sourceNodeId: 'switch', sourcePort: 'else', targetNodeId: 'target-else' },
    ]
    expect(remapSwitchEdges(edges, 'switch', previous, next)).toEqual([
      edges[0],
      { ...edges[2], sourcePort: 'case-1' },
      edges[3],
    ])
  })

  it('moves an AI scene together with its prompt and preserves its connected target', () => {
    const previous: SwitchConfig = { ...config, mode: 'ai', cases: ['问候', '投诉', '感谢'], caseIds: ['a', 'b', 'c'], casePrompts: ['打招呼', '辱骂或投诉', '表示感谢'], caseTypes: undefined }
    const next = reorderSwitchCase(previous, 1, 0)
    expect(next.cases).toEqual(['投诉', '问候', '感谢'])
    expect(next.casePrompts).toEqual(['辱骂或投诉', '打招呼', '表示感谢'])
    expect(next.caseIds).toEqual(['b', 'a', 'c'])
    const edges: WorkflowEdge[] = [{ id: 'complaint', sourceNodeId: 'switch', sourcePort: 'case-1', targetNodeId: 'complaint-handler' }]
    expect(remapSwitchEdges(edges, 'switch', previous, next)[0]?.sourcePort).toBe('case-0')
  })

  it('keeps typed values after loading a saved workflow', () => {
    const graph = createDefaultTemplate()
    const node = createNode('switch', { x: 300, y: 300 })
    const saved = { ...graph, nodes: [...graph.nodes, { ...node, config }] }
    const parsed = parseWorkflow(JSON.parse(JSON.stringify(saved)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const loaded = parsed.graph.nodes.find(item => item.id === node.id)
    expect(loaded?.config).toMatchObject({ caseTypes: config.caseTypes, caseIds: config.caseIds })
  })

  it('reports duplicate or invalid typed values before saving', () => {
    const base = createDefaultTemplate()
    const node = createNode('switch', { x: 300, y: 300 })
    const invalid = { ...base, nodes: [...base.nodes, { ...node, config: { ...config, cases: ['not-a-number'], caseTypes: ['number'] as const } }] }
    expect(validateGraph(invalid).some(item => item.code === 'switch-invalid-case')).toBe(true)
    const duplicate = { ...base, nodes: [...base.nodes, { ...node, config: { ...config, cases: ['90', '90'], caseTypes: ['number', 'number'] as const } }] }
    expect(validateGraph(duplicate).some(item => item.code === 'switch-duplicate-case')).toBe(true)
  })

  it('remaps connected output ports through patchNode when a middle branch is removed', () => {
    const base = createDefaultTemplate()
    const node = createNode('switch', { x: 300, y: 300 })
    const previous: SwitchConfig = { ...config, cases: ['A', 'B', 'C'], caseTypes: ['string', 'string', 'string'], caseIds: ['a', 'b', 'c'] }
    const next: SwitchConfig = { ...previous, cases: ['A', 'C'], caseTypes: ['string', 'string'], caseIds: ['a', 'c'] }
    const connected = { ...base, nodes: [...base.nodes, { ...node, config: previous }], edges: [...base.edges, { id: 'switch-edge', sourceNodeId: node.id, sourcePort: 'case-2', targetNodeId: 'target' }] }
    expect(patchNode(connected, node.id, { config: next }).edges.at(-1)?.sourcePort).toBe('case-1')
  })

  it('routes a numeric input through the numeric branch in a real dry run', async () => {
    const base = createDefaultTemplate()
    const start = base.nodes.find(node => node.type === 'start')!
    const noNavigationStart = { ...start, config: { type: 'start' as const, url: '' } }
    const decision = createNode('switch', { x: 300, y: 100 })
    const matched = createNode('end', { x: 600, y: 50 })
    const otherwise = createNode('end', { x: 600, y: 160 })
    const graph = {
      ...base,
      nodes: [noNavigationStart, { ...decision, config: { ...config, left: { kind: 'literal' as const, value: 90 }, cases: ['90'], caseTypes: ['number' as const] } }, matched, otherwise],
      edges: [
        { id: 'in', sourceNodeId: start.id, sourcePort: 'default', targetNodeId: decision.id },
        { id: 'match', sourceNodeId: decision.id, sourcePort: 'case-0', targetNodeId: matched.id },
        { id: 'else', sourceNodeId: decision.id, sourcePort: 'else', targetNodeId: otherwise.id },
      ],
    }
    const state = await runDry(graph, { onUpdate() {}, wait: async () => {} })
    expect(state.nodes[matched.id]).toBe('succeeded')
    expect(state.nodes[otherwise.id]).not.toBe('succeeded')
    const actual = await runBrowser(graph, {} as BrowserDriver, { onUpdate() {}, wait: async () => {} })
    expect(actual.nodes[matched.id]).toBe('succeeded')
    expect(actual.nodes[otherwise.id]).not.toBe('succeeded')
  })
})
