import { describe, expect, it } from 'vitest'
import { parseWorkflow } from './parse.ts'
import { createDefaultTemplate } from './template.ts'
import { firstIssue, validateGraph } from './validate.ts'
import { createEdge, createNode } from './mutate.ts'

describe('createDefaultTemplate', () => {
  it('passes structural validation', () => {
    expect(validateGraph(createDefaultTemplate())).toEqual([])
  })
})

describe('validateGraph', () => {
  it('rejects a missing start', () => {
    const graph = createDefaultTemplate()
    const next = { ...graph, nodes: graph.nodes.filter(node => node.type !== 'start'), entryNodeId: 'missing' }
    expect(firstIssue(next)?.code).toBe('entry-count')
  })

  it('allows a blank start URL to be saved for use as a subflow', () => {
    const graph = createDefaultTemplate()
    const nodes = graph.nodes.map(node => node.config.type === 'start' ? { ...node, config: { ...node.config, url: '' } } : node)
    expect(validateGraph({ ...graph, nodes })).toEqual([])
  })

  it('rejects an empty agent prompt', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const agent = createNode('agent', { x: 100, y: 0 })
    const end = createNode('end', { x: 200, y: 0 })
    const graph = {
      ...createDefaultTemplate(),
      entryNodeId: start.id,
      nodes: [start, { ...agent, config: { ...agent.config, type: 'agent' as const, systemPrompt: '   ' } }, end],
      edges: [createEdge(start.id, 'default', agent.id), createEdge(agent.id, 'default', end.id)],
    }
    expect(firstIssue(graph)?.code).toBe('agent-prompt-empty')
  })

  it('reports an incomplete Agent draft instead of crashing when structured fields are missing', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const agent = createNode('agent', { x: 100, y: 0 })
    const end = createNode('end', { x: 200, y: 0 })
    const incomplete = { ...agent, config: { type: 'agent', systemPrompt: '系统规则', dryAction: 'note' } as unknown as typeof agent.config }
    const graph = {
      ...createDefaultTemplate(), entryNodeId: start.id,
      nodes: [start, incomplete, end],
      edges: [createEdge(start.id, 'default', agent.id), createEdge(agent.id, 'default', end.id)],
    }

    expect(() => validateGraph(graph)).not.toThrow()
    expect(firstIssue(graph)?.code).toBe('agent-prompt-empty')
  })

  it('rejects a binding to a missing port', () => {
    const graph = createDefaultTemplate()
    const nodes = graph.nodes.map(node =>
      node.config.type === 'condition'
        ? { ...node, config: { ...node.config, left: { kind: 'node-output', nodeId: node.id, port: 'missing' } } }
        : node,
    )
    expect(firstIssue({ ...graph, nodes })?.code).toBe('unknown-binding')
  })

  it('allows downstream nodes to bind to the configured AI switch reason output', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const aiSwitch = createNode('switch', { x: 120, y: 0 })
    const condition = createNode('condition', { x: 240, y: 0 })
    const end = createNode('end', { x: 360, y: 0 })
    const graph = {
      ...createDefaultTemplate(), entryNodeId: start.id,
      nodes: [
        start,
        { ...aiSwitch, config: { ...aiSwitch.config, type: 'switch' as const, mode: 'ai' as const, cases: ['场景'], casePrompts: ['判断要求'], reasonOutputName: 'routeReason' } },
        { ...condition, config: { ...condition.config, type: 'condition' as const, left: { kind: 'node-output' as const, nodeId: aiSwitch.id, port: 'routeReason' } } },
        end,
      ],
      edges: [
        createEdge(start.id, 'default', aiSwitch.id),
        createEdge(aiSwitch.id, 'case-0', condition.id),
        createEdge(aiSwitch.id, 'else', condition.id),
        createEdge(condition.id, 'matched', end.id),
        createEdge(condition.id, 'else', end.id),
      ],
    }
    expect(validateGraph(graph)).toEqual([])
  })

  it('allows a continue-loop node without an outgoing edge', () => {
    const graph = createDefaultTemplate()
    const start = graph.nodes.find(node => node.type === 'start')!
    const end = graph.nodes.find(node => node.type === 'end')!
    const condition = createNode('condition', { x: 360, y: 240 })
    const continueLoop = createNode('continue-loop', { x: 540, y: 360 })
    const next = {
      ...graph,
      nodes: [start, condition, continueLoop, end],
      edges: [
        createEdge(start.id, 'default', condition.id),
        createEdge(condition.id, 'matched', end.id),
        createEdge(condition.id, 'else', continueLoop.id),
      ],
    }
    expect(validateGraph(next)).toEqual([])
  })

  it('accepts a loop ended by continue-loop', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const loop = createNode('for-each', { x: 120, y: 0 })
    const action = createNode('set-variable', { x: 240, y: 0 })
    const continueLoop = createNode('continue-loop', { x: 360, y: 0 })
    const end = createNode('end', { x: 480, y: 0 })
    const graph = {
      ...createDefaultTemplate(),
      entryNodeId: start.id,
      nodes: [start, loop, action, continueLoop, end],
      edges: [
        createEdge(start.id, 'default', loop.id),
        createEdge(loop.id, 'body', action.id),
        createEdge(action.id, 'default', continueLoop.id),
        createEdge(loop.id, 'done', end.id),
      ],
    }
    expect(validateGraph(graph)).toEqual([])
  })

  it('accepts multiple incoming lines but still rejects multiple lines from one output', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const condition = createNode('condition', { x: 120, y: 0 })
    const merged = createNode('set-variable', { x: 240, y: 0 })
    const end = createNode('end', { x: 360, y: 0 })
    const graph = {
      ...createDefaultTemplate(),
      entryNodeId: start.id,
      nodes: [start, condition, merged, end],
      edges: [
        createEdge(start.id, 'default', condition.id),
        createEdge(condition.id, 'matched', merged.id),
        createEdge(condition.id, 'else', merged.id),
        createEdge(merged.id, 'default', end.id),
      ],
    }
    expect(validateGraph(graph)).toEqual([])

    const duplicateOutput = { ...graph, edges: [...graph.edges, createEdge(condition.id, 'matched', end.id)] }
    expect(validateGraph(duplicateOutput).map(item => item.code)).toContain('occupied-output')
  })
})

describe('parseWorkflow', () => {
  it('round-trips the default template', () => {
    const graph = createDefaultTemplate()
    const parsed = parseWorkflow(JSON.parse(JSON.stringify(graph)))
    expect(parsed).toEqual({ ok: true, graph })
  })

  it('preserves runtime input and fixed-variable metadata', () => {
    const graph = { ...createDefaultTemplate(), context: {
      inputs: [{ name: 'account', type: 'string' as const, required: true, description: '执行时填写' }],
      variables: [{ name: 'baseUrl', type: 'string' as const, defaultValue: 'https://example.com', description: '测试环境地址' }],
    } }
    const parsed = parseWorkflow(JSON.parse(JSON.stringify(graph)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.graph.context).toEqual({
      inputs: [{ name: 'account', type: 'string', required: true, defaultValue: undefined, secret: false, description: '执行时填写' }],
      variables: [{ name: 'baseUrl', type: 'string', required: false, defaultValue: 'https://example.com', secret: false, description: '测试环境地址' }],
    })
  })

  it('defaults legacy page-action input steps to replace mode', () => {
    const graph = createDefaultTemplate()
    const legacy = {
      ...graph,
      nodes: graph.nodes.map(node => node.type === 'page-action'
        ? { ...node, config: { type: 'page-action' as const, steps: [{ type: 'type' as const, selector: '#name', value: { kind: 'literal' as const, value: 'Alice' } }] } }
        : node),
    }

    const parsed = parseWorkflow(JSON.parse(JSON.stringify(legacy)))

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error)
    const action = parsed.graph.nodes.find(node => node.type === 'page-action')
    expect(action?.config.type === 'page-action' ? action.config.steps[0] : undefined).toMatchObject({ inputMode: 'replace' })
  })

  it('rejects a file without nodes', () => {
    const parsed = parseWorkflow({ workflowId: 'wf', name: 'x', entryNodeId: 'a' })
    expect(parsed.ok).toBe(false)
  })

  it('rejects legacy ticket node types', () => {
    const parsed = parseWorkflow({
      workflowId: 'wf',
      name: 'old',
      entryNodeId: 'a',
      nodes: [{ id: 'a', type: 'list-tickets', name: '拉列表', position: { x: 0, y: 0 }, config: { type: 'list-tickets' } }],
      edges: [],
    })
    expect(parsed.ok).toBe(false)
  })

  it('accepts nodes from older files without input bindings', () => {
    const graph = createDefaultTemplate()
    const legacy = { ...graph, nodes: graph.nodes.map(node => ({ ...node, inputBindings: undefined })) }
    expect(() => validateGraph(legacy)).not.toThrow()
  })
})
