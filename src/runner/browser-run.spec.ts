import { describe, expect, it } from 'vitest'
import { createDefaultTemplate } from '@graph/template.ts'
import { createEdge, createNode } from '@graph/mutate.ts'
import { newId } from '@graph/catalog.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { isEmptyValue, runBrowser, type BrowserDriver } from './browser-run.ts'
import { runDry } from './dry-run.ts'
import { isolatedNodeRunGraph } from '../renderer/studio/node-run-graph.ts'
import { reorderPageActionStep } from '@graph/page-action-steps.ts'

function fakeDriver(calls: string[]): BrowserDriver {
  return {
    async openPage(url) { calls.push(`open:${url}`) },
    async click(selector) { calls.push(`click:${selector}`) },
    async type(selector, text) { calls.push(`type:${selector}=${text}`) },
    async extract(selector) {
      calls.push(`extract:${selector}`)
      return 'Example Domain'
    },
    async waitFor(ms, selector) { calls.push(`wait:${ms}:${selector}`) },
  }
}

function line(url: string, selector: string): WorkflowGraph {
  const start = createNode('start', { x: 0, y: 0 })
  const open = createNode('open-page', { x: 80, y: 0 })
  const extract = createNode('extract', { x: 160, y: 0 })
  const end = createNode('end', { x: 240, y: 0 })
  return {
    workflowId: newId('wf'),
    name: 'live',
    version: 1,
    entryNodeId: start.id,
    nodes: [
      start,
      { ...open, config: { type: 'open-page', url } },
      { ...extract, config: { type: 'extract', selector } },
      end,
    ],
    edges: [
      createEdge(start.id, 'default', open.id),
      createEdge(open.id, 'default', extract.id),
      createEdge(extract.id, 'default', end.id),
    ],
  }
}

describe('runDry after walk extract', () => {
  it('still reaches the type node on the example template', async () => {
    const graph = createDefaultTemplate()
    const state = await runDry(graph, { onUpdate() {}, wait: async () => {} })
    expect(state.status).toBe('succeeded')
    const typed = graph.nodes.find(node => node.type === 'type')
    expect(typed !== undefined && state.nodes[typed.id] === 'succeeded').toBe(true)
  })
})

describe('runBrowser', () => {
  it('does not fail a completed start node when only the optional page title becomes unavailable', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: 'title-closed', name: 'Title unavailable', version: 1, entryNodeId: start.id,
      nodes: [{ ...start, config: { type: 'start', url: 'https://example.com' } }], edges: [],
    }
    const driver = fakeDriver([])
    driver.currentTitle = async () => { throw new Error('page.title: Target page, context or browser has been closed') }
    const state = await runBrowser(graph, driver, { onUpdate() {}, wait: async () => {} }, { stopAfterNodeId: start.id })
    expect(state.status).toBe('succeeded')
    expect(state.nodes[start.id]).toBe('succeeded')
  })

  it('runs only an isolated target using injected upstream output', async () => {
    const target = createNode('set-variable', { x: 0, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: 'injected-node', name: 'Injected node', version: 1, entryNodeId: target.id,
      nodes: [{ ...target, config: { type: 'set-variable', name: 'selectedValue', value: { kind: 'node-output', nodeId: 'source-node', port: 'data' }, path: '', interpolate: false } }], edges: [],
    }
    const state = await runBrowser(graph, fakeDriver([]), { onUpdate() {}, wait: async () => {} }, { outputs: { 'source-node': { data: 'from injection' } }, stopAfterNodeId: target.id })
    expect(state.status).toBe('succeeded')
    expect(state.variables?.selectedValue).toBe('from injection')
  })

  it('treats empty arrays and objects as empty values', () => {
    expect(isEmptyValue([])).toBe(true)
    expect(isEmptyValue({})).toBe(true)
    expect(isEmptyValue([null])).toBe(false)
    expect(isEmptyValue({ value: null })).toBe(false)
    expect(isEmptyValue('  ')).toBe(true)
    expect(isEmptyValue(false)).toBe(false)
    expect(isEmptyValue(0)).toBe(false)
  })

  it.each([
    { actual: true, expected: true, branch: 'matched' },
    { actual: false, expected: false, branch: 'matched' },
    { actual: 'true', expected: true, branch: 'else' },
  ] as const)('compares boolean condition values strictly: $actual equals $expected', async ({ actual, expected, branch }) => {
    const calls: string[] = []
    const start = createNode('start', { x: 0, y: 0 })
    const condition = createNode('condition', { x: 100, y: 0 })
    const matchedEnd = createNode('end', { x: 200, y: -40 })
    const elseEnd = createNode('end', { x: 200, y: 40 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'),
      name: 'boolean condition',
      version: 1,
      entryNodeId: start.id,
      nodes: [
        start,
        { ...condition, config: { ...condition.config, type: 'condition', mode: 'value', clauses: [{ binding: { kind: 'literal', value: actual }, operator: 'equals', value: expected }] } },
        matchedEnd,
        elseEnd,
      ],
      edges: [
        createEdge(start.id, 'default', condition.id),
        createEdge(condition.id, 'matched', matchedEnd.id),
        createEdge(condition.id, 'else', elseEnd.id),
      ],
    }

    const state = await runBrowser(graph, fakeDriver(calls), { onUpdate() {}, wait: async () => {} })

    expect(state.status).toBe('succeeded')
    expect(state.nodes[branch === 'matched' ? matchedEnd.id : elseEnd.id]).toBe('succeeded')
    expect(state.nodes[branch === 'matched' ? elseEnd.id : matchedEnd.id]).toBe('pending')
  })

  it.each([true, false])('allows condition branches to merge into the same node: %s', async actual => {
    const start = createNode('start', { x: 0, y: 0 })
    const condition = createNode('condition', { x: 100, y: 0 })
    const merged = createNode('set-variable', { x: 200, y: 0 })
    const end = createNode('end', { x: 300, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'merged branches', version: 1, entryNodeId: start.id,
      nodes: [
        start,
        { ...condition, config: { ...condition.config, type: 'condition', mode: 'value', clauses: [{ binding: { kind: 'literal', value: actual }, operator: 'equals', value: true }] } },
        { ...merged, config: { type: 'set-variable', name: 'mergedResult', value: { kind: 'literal', value: 'reached' }, path: '', interpolate: false } },
        end,
      ],
      edges: [
        createEdge(start.id, 'default', condition.id),
        createEdge(condition.id, 'matched', merged.id),
        createEdge(condition.id, 'else', merged.id),
        createEdge(merged.id, 'default', end.id),
      ],
    }

    const state = await runBrowser(graph, fakeDriver([]), { onUpdate() {}, wait: async () => {} })

    expect(state.status).toBe('succeeded')
    expect(state.nodes[merged.id]).toBe('succeeded')
    expect(state.variables?.mergedResult).toBe('reached')
  })

  it('drives open and extract through the driver', async () => {
    const calls: string[] = []
    const graph = line('https://example.com', 'h1')
    const state = await runBrowser(graph, fakeDriver(calls), { onUpdate() {}, wait: async () => {} })
    expect(state.status).toBe('succeeded')
    expect(calls).toEqual(['open:https://example.com', 'extract:h1'])
    const extract = graph.nodes.find(node => node.type === 'extract')
    expect(extract !== undefined && state.outputs[extract.id]?.text).toBe('Example Domain')
  })

  it('exposes declared loop fields directly by their names', async () => {
    const calls: string[] = []
    const start = createNode('start', { x: 0, y: 0 })
    const loop = createNode('for-each', { x: 80, y: 0 })
    const type = createNode('type', { x: 160, y: 0 })
    const call = createNode('call-subflow', { x: 240, y: 0 })
    const end = createNode('end', { x: 320, y: 0 })
    const childStart = createNode('start', { x: 0, y: 0 })
    const childSet = createNode('set-variable', { x: 80, y: 0 })
    const childEnd = createNode('end', { x: 160, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'loop direct variables', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...loop, config: { ...loop.config, type: 'for-each', collection: { kind: 'variable', name: 'rows' }, itemVar: 'item', indexVar: 'index', declaredVariables: ['id'], maxItems: 10, retryCount: 0, onItemError: 'stop', conditionClauses: [{ binding: { kind: 'variable', name: 'id' }, operator: 'isNotEmpty' }] } },
        { ...type, config: { type: 'type', selector: '#order', text: { kind: 'literal', value: '{{id}}' }, path: '' } },
        { ...call, config: { type: 'call-subflow', workflowId: 'loop-child', workflowVersion: 1, inputMappings: [{ inputName: 'childId', source: { kind: 'variable', name: 'id' } }] } },
        end,
      ],
      edges: [
        createEdge(start.id, 'default', loop.id),
        createEdge(loop.id, 'body', type.id),
        createEdge(type.id, 'default', call.id),
        createEdge(call.id, 'default', loop.id),
        createEdge(loop.id, 'done', end.id),
      ],
    }
    const child: WorkflowGraph = {
      workflowId: 'loop-child', name: '循环子流程', version: 1, entryNodeId: childStart.id,
      context: { inputs: [{ name: 'childId', type: 'string', required: true }], variables: [] },
      nodes: [
        { ...childStart, config: { type: 'start', url: '' } },
        { ...childSet, config: { type: 'set-variable', name: 'receivedId', value: { kind: 'workflow-input', name: 'childId' }, path: '' } },
        childEnd,
      ],
      edges: [createEdge(childStart.id, 'default', childSet.id), createEdge(childSet.id, 'default', childEnd.id)],
    }
    const state = await runBrowser(graph, fakeDriver(calls), { onUpdate() {}, wait: async () => {} }, { variables: { rows: [{ id: 'ORDER-7' }] }, subflows: [child] })
    expect(state.status).toBe('succeeded')
    expect(calls).toContain('type:#order=ORDER-7')
    expect(state.variables?.id).toBe('ORDER-7')
    expect(state.variables?.item).toEqual({ id: 'ORDER-7' })
    expect(state.variables?.receivedId).toBe('ORDER-7')
    expect(state.outputs[loop.id]?.item).toEqual({ id: 'ORDER-7' })
  })

  it('iterates the entire array when no loop condition is configured', async () => {
    const calls: string[] = []
    const start = createNode('start', { x: 0, y: 0 })
    const loop = createNode('for-each', { x: 80, y: 0 })
    const type = createNode('type', { x: 160, y: 0 })
    const end = createNode('end', { x: 240, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'unconditional full loop', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...loop, config: { ...loop.config, type: 'for-each', collection: { kind: 'variable', name: 'rows' }, condition: '', conditionClauses: [], maxItems: 1 } },
        { ...type, config: { type: 'type', selector: '#order', text: { kind: 'literal', value: '{{item}}' }, path: '' } },
        end,
      ],
      edges: [
        createEdge(start.id, 'default', loop.id),
        createEdge(loop.id, 'body', type.id),
        createEdge(type.id, 'default', loop.id),
        createEdge(loop.id, 'done', end.id),
      ],
    }

    const state = await runBrowser(graph, fakeDriver(calls), { onUpdate() {}, wait: async () => {} }, { variables: { rows: ['A', 'B', 'C'] } })

    expect(state.status).toBe('succeeded')
    expect(calls.filter(call => call.startsWith('type:#order='))).toEqual([
      'type:#order=A',
      'type:#order=B',
      'type:#order=C',
    ])
    expect(state.outputs[loop.id]?.index).toBe(2)
  })

  it('pushes a delayed history URL change to the live run state immediately', async () => {
    const calls: string[] = []
    const start = createNode('start', { x: 0, y: 0 })
    const action = createNode('page-action', { x: 80, y: 0 })
    const end = createNode('end', { x: 160, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'history route', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...action, config: { type: 'page-action', steps: [{ type: 'click', selector: '#login' }] } },
        end,
      ],
      edges: [createEdge(start.id, 'default', action.id), createEdge(action.id, 'default', end.id)],
    }
    const updates: string[] = []
    let reportUrl: ((url: string) => void) | undefined
    const driver: BrowserDriver = {
      ...fakeDriver(calls),
      onUrlChange(listener) { reportUrl = listener; return () => { reportUrl = undefined } },
      async click(selector) {
        calls.push(`click:${selector}`)
        reportUrl?.('https://example.com/#/dashboard')
      },
    }
    const state = await runBrowser(graph, driver, { onUpdate: update => { if (update.page?.url) updates.push(update.page.url) }, wait: async () => {} })
    expect(state.status).toBe('succeeded')
    expect(state.page?.url).toBe('https://example.com/#/dashboard')
    expect(updates).toContain('https://example.com/#/dashboard')
  })

  it('stops on an empty URL', async () => {
    const calls: string[] = []
    const graph = line('', 'h1')
    const state = await runBrowser(graph, fakeDriver(calls), { onUpdate() {}, wait: async () => {} })
    expect(state.status).toBe('failed')
    expect(calls).toEqual([])
    const open = graph.nodes.find(node => node.type === 'open-page')
    expect(open !== undefined && state.nodes[open.id] === 'waiting-user').toBe(true)
  })

  it('requires a start URL when running a workflow independently', async () => {
    const graph = createDefaultTemplate()
    const nodes = graph.nodes.map(node => node.config.type === 'start' ? { ...node, config: { ...node.config, url: '' } } : node)
    await expect(runBrowser({ ...graph, nodes }, fakeDriver([]), { onUpdate() {}, wait: async () => {} })).rejects.toThrow('流程和子流程都没有配置开始 URL')
  })

  it('runs only an empty-URL start without requiring or opening a browser', async () => {
    const graph = createDefaultTemplate()
    const nodes = graph.nodes.map(node => node.config.type === 'start' ? { ...node, config: { ...node.config, url: '' } } : node)
    const calls: string[] = []
    const state = await runBrowser({ ...graph, nodes }, fakeDriver(calls), { onUpdate() {}, wait: async () => {} }, { stopAfterNodeId: graph.entryNodeId })
    expect(state.status).toBe('succeeded')
    expect(calls).toEqual([])
    expect(state.logs.some(line => line.message.includes('跳过打开浏览器'))).toBe(true)
  })

  it('runs a child-style node prefix on an existing page instead of about:blank', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const click = createNode('click', { x: 100, y: 0 })
    const end = createNode('end', { x: 200, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'child node prefix', version: 1, entryNodeId: start.id,
      nodes: [{ ...start, config: { type: 'start', url: '' } }, { ...click, config: { type: 'click', selector: '#submit' } }, end],
      edges: [createEdge(start.id, 'default', click.id), createEdge(click.id, 'default', end.id)],
    }
    const calls: string[] = []
    const driver = { ...fakeDriver(calls), currentUrl: () => 'https://example.com/form' }
    const state = await runBrowser(graph, driver, { onUpdate() {}, wait: async () => {} }, { allowExistingPage: true })
    expect(state.status).toBe('succeeded')
    expect(calls).toEqual(['click:#submit'])
    await expect(runBrowser(graph, { ...driver, currentUrl: () => 'about:blank' }, { onUpdate() {}, wait: async () => {} }, { allowExistingPage: true })).rejects.toThrow('没有可沿用的浏览器页面')
  })

  it('uses declared variable defaults in a page action and exposes extract outputs directly', async () => {
    const calls: string[] = []
    const start = createNode('start', { x: 0, y: 0 })
    const action = createNode('page-action', { x: 80, y: 0 })
    const end = createNode('end', { x: 160, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'page action variables', version: 1, entryNodeId: start.id,
      context: { inputs: [{ name: 'orderId', type: 'string', required: true, defaultValue: 'default-order' }], variables: [{ name: 'username', type: 'string', defaultValue: 'demo-user' }] },
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...action, config: { type: 'page-action', steps: [
          { type: 'type', selector: '#username', value: { kind: 'variable', name: 'username' } },
          { type: 'extract', selector: 'h1', outputName: 'heading', mode: 'text' },
        ] } },
        end,
      ],
      edges: [createEdge(start.id, 'default', action.id), createEdge(action.id, 'default', end.id)],
    }
    const state = await runBrowser(graph, fakeDriver(calls), { onUpdate() {}, wait: async () => {} }, { executionId: 'exec-123', inputs: { orderId: 'ORDER-7' }, variables: { username: 'Alice' } })
    expect(state.status).toBe('succeeded')
    expect(calls).toEqual(['open:https://example.com', 'type:#username=Alice', 'extract:h1'])
    expect(state.outputs[action.id]).toEqual({ heading: 'Example Domain' })
    expect(state.variables?.username).toBe('Alice')
    expect(state.inputs?.orderId).toBe('ORDER-7')
    expect(state.variables?.heading).toBe('Example Domain')
  })

  it('executes page-action steps in their reordered sequence', async () => {
    const calls: string[] = []
    const start = createNode('start', { x: 0, y: 0 })
    const action = createNode('page-action', { x: 80, y: 0 })
    const end = createNode('end', { x: 160, y: 0 })
    const steps = reorderPageActionStep([
      { type: 'click', selector: '#submit' },
      { type: 'type', selector: '#name', value: { kind: 'literal', value: 'Alice' } },
    ], 1, 0)
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'reordered page actions', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...action, config: { type: 'page-action', steps } },
        end,
      ],
      edges: [createEdge(start.id, 'default', action.id), createEdge(action.id, 'default', end.id)],
    }

    const state = await runBrowser(graph, fakeDriver(calls), { onUpdate() {}, wait: async () => {} })

    expect(state.status).toBe('succeeded')
    expect(calls).toEqual(['open:https://example.com', 'type:#name=Alice', 'click:#submit'])
  })

  it('uses an AI condition result to choose the matched branch', async () => {
    const calls: string[] = []
    const start = createNode('start', { x: 0, y: 0 })
    const condition = createNode('condition', { x: 100, y: 0 })
    const matchedEnd = createNode('end', { x: 200, y: -40 })
    const elseEnd = createNode('end', { x: 200, y: 40 })
    const ai = {
      id: 'test-ai', name: '测试 AI', enabled: true, model: 'test', baseUrl: 'https://example.com',
      chatPath: '/v1/chat/completions', apiKey: '', maxTokens: 100,
    }
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'AI condition', version: 1, entryNodeId: start.id, llm: ai,
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...condition, config: { ...condition.config, type: 'condition', mode: 'ai', aiPrompt: '判断是否属于需要跟进的投诉。', left: { kind: 'literal', value: '客户表示商品破损，需要处理' } } },
        matchedEnd,
        elseEnd,
      ],
      edges: [
        createEdge(start.id, 'default', condition.id),
        createEdge(condition.id, 'matched', matchedEnd.id),
        createEdge(condition.id, 'else', elseEnd.id),
      ],
    }
    const driver = fakeDriver(calls)
    driver.generateCondition = async (content, requirement) => {
      calls.push(`ai:${requirement}:${content}`)
      return { matched: true, reason: '客户明确反馈商品破损并要求处理' }
    }
    const state = await runBrowser(graph, driver, { onUpdate() {}, wait: async () => {} })

    expect(state.status).toBe('succeeded')
    expect(state.nodes[matchedEnd.id]).toBe('succeeded')
    expect(state.nodes[elseEnd.id]).toBe('pending')
    expect(calls.some(call => call.includes('客户表示商品破损'))).toBe(true)
  })

  it('routes an AI switch using the structured branch ID instead of parsing free text', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const choice = createNode('switch', { x: 100, y: 0 })
    const matchedEnd = createNode('end', { x: 200, y: -40 })
    const elseEnd = createNode('end', { x: 200, y: 40 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'AI switch', version: 1, entryNodeId: start.id,
      llm: { id: 'test-ai', name: '测试 AI', enabled: true, model: 'test', baseUrl: 'https://example.com', chatPath: '/v1/chat/completions', apiKey: '', maxTokens: 100 },
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...choice, config: { type: 'switch', mode: 'ai', left: { kind: 'literal', value: '我去你的' }, path: '', cases: ['打招呼', '骂人的话'], casePrompts: ['打招呼的话', '骂人的话'] } },
        matchedEnd, elseEnd,
      ],
      edges: [createEdge(start.id, 'default', choice.id), createEdge(choice.id, 'case-1', matchedEnd.id), createEdge(choice.id, 'else', elseEnd.id)],
    }
    const driver = fakeDriver([])
    driver.generateSwitch = async (content, cases) => {
      expect(content).toBe('我去你的')
      expect(cases.map(item => item.id)).toEqual(['case-0', 'case-1'])
      return { branch: 'case-1', reason: '带有辱骂语气' }
    }
    const state = await runBrowser(graph, driver, { onUpdate() {}, wait: async () => {} })
    expect(state.status).toBe('succeeded')
    expect(state.nodes[matchedEnd.id]).toBe('succeeded')
    expect(state.nodes[elseEnd.id]).toBe('pending')
    expect(state.logs.some(item => item.message.includes('带有辱骂语气'))).toBe(true)
  })

  it('fails an AI switch that returns an unknown branch instead of silently taking else', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const choice = createNode('switch', { x: 100, y: 0 })
    const end = createNode('end', { x: 200, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'AI switch invalid', version: 1, entryNodeId: start.id,
      llm: { id: 'test-ai', name: '测试 AI', enabled: true, model: 'test', baseUrl: 'https://example.com', chatPath: '/v1/chat/completions', apiKey: '', maxTokens: 100 },
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...choice, config: { type: 'switch', mode: 'ai', left: { kind: 'literal', value: '测试' }, path: '', cases: ['场景一'], casePrompts: ['符合场景一'] } },
        end,
      ],
      edges: [createEdge(start.id, 'default', choice.id), createEdge(choice.id, 'else', end.id)],
    }
    const driver = fakeDriver([])
    driver.generateSwitch = async () => ({ branch: 'case-99', reason: '无效结果' })
    const state = await runBrowser(graph, driver, { onUpdate() {}, wait: async () => {} })
    expect(state.status).toBe('failed')
    expect(state.logs.some(item => item.message.includes('未知分支'))).toBe(true)
    expect(state.nodes[end.id]).toBe('pending')
  })

  it('resolves variables in the approval description before creating the approval', async () => {
    const calls: string[] = []
    const start = createNode('start', { x: 0, y: 0 })
    const approval = createNode('approval', { x: 100, y: 0 })
    const approvedEnd = createNode('end', { x: 200, y: -60 })
    const rejectedEnd = createNode('end', { x: 200, y: 0 })
    const timeoutEnd = createNode('end', { x: 200, y: 60 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'approval variables', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...approval, config: { ...approval.config, type: 'approval', title: '订单 {{orderId}} 审批', description: '订单 {{orderId}} 已超过 {{overdueDays}} 天，请确认是否继续。' } },
        approvedEnd,
        rejectedEnd,
        timeoutEnd,
      ],
      edges: [
        createEdge(start.id, 'default', approval.id),
        createEdge(approval.id, 'approved', approvedEnd.id),
        createEdge(approval.id, 'rejected', rejectedEnd.id),
        createEdge(approval.id, 'timeout', timeoutEnd.id),
      ],
    }
    let renderedDescription = ''
    const state = await runBrowser(graph, fakeDriver(calls), {
      onUpdate() {},
      wait: async () => {},
      requestApproval: async prompt => {
        renderedDescription = prompt.description
        return { decision: 'approved', comment: '', approverName: '当前执行人', decidedAt: '2026-10-08T00:00:00.000Z' }
      },
    }, { variables: { orderId: 'PAY-1001', overdueDays: 91 } })

    expect(state.status).toBe('succeeded')
    expect(renderedDescription).toBe('订单 PAY-1001 已超过 91 天，请确认是否继续。')
  })

  it('executes child nodes inline and shares their variables with the parent', async () => {
    const calls: string[] = []
    const parentStart = createNode('start', { x: 0, y: 0 })
    const subflow = createNode('call-subflow', { x: 100, y: 0 })
    const readValue = createNode('set-variable', { x: 300, y: 0 })
    const parentEnd = createNode('end', { x: 500, y: 0 })
    const childStart = createNode('start', { x: 0, y: 0 })
    const childSet = createNode('set-variable', { x: 100, y: 0 })
    const childEnd = createNode('end', { x: 200, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: 'parent', name: 'Parent', version: 1, entryNodeId: parentStart.id,
      context: { inputs: [{ name: 'message', type: 'number', required: true }], variables: [] },
      nodes: [
        { ...parentStart, config: { type: 'start', url: '' } },
        { ...subflow, config: { type: 'call-subflow', workflowId: 'child', workflowVersion: 2, inputMappings: [{ inputName: 'childMessage', source: { kind: 'workflow-input', name: 'message' } }] } },
        { ...readValue, config: { type: 'set-variable', name: 'parentResult', value: { kind: 'variable', name: 'childResult' }, path: '' } },
        parentEnd,
      ],
      edges: [createEdge(parentStart.id, 'default', subflow.id), createEdge(subflow.id, 'default', readValue.id), createEdge(readValue.id, 'default', parentEnd.id)],
    }
    const child: WorkflowGraph = {
      workflowId: 'child', name: 'Child flow', version: 2, entryNodeId: childStart.id,
      context: { inputs: [{ name: 'childMessage', type: 'string', required: true }], variables: [] },
      nodes: [
        { ...childStart, config: { type: 'start', url: 'https://child.example' } },
        { ...childSet, config: { type: 'set-variable', name: 'childResult', value: { kind: 'workflow-input', name: 'childMessage' }, path: '' } },
        childEnd,
      ],
      edges: [createEdge(childStart.id, 'default', childSet.id), createEdge(childSet.id, 'default', childEnd.id)],
    }
    const state = await runBrowser(graph, fakeDriver(calls), { onUpdate() {}, wait: async () => {} }, { inputs: { message: 12345 }, subflows: [child] })

    expect(state.status).toBe('succeeded')
    expect(calls).toContain('open:https://child.example')
    expect(calls).not.toContain('open:https://parent.example')
    expect(state.variables?.childResult).toBe('12345')
    expect(state.variables?.parentResult).toBe('12345')
    expect(state.logs.some(log => log.message === '进入子流程「Child flow」（ID：child，版本：v2）')).toBe(true)
    expect(state.logs.some(log => log.nodeName === 'Child flow · 设置变量')).toBe(true)

    const withEditedInput = (value: string): WorkflowGraph => ({
      ...graph,
      nodes: graph.nodes.map(node => node.id === subflow.id
        ? { ...node, config: { type: 'call-subflow' as const, workflowId: 'child', workflowVersion: 2, inputMappings: [{ inputName: 'childMessage', source: { kind: 'literal' as const, value } }] } }
        : node),
    })
    const edited = await runBrowser(withEditedInput('订单 {{inputs.message}} / {{prefix}}'), fakeDriver([]), { onUpdate() {}, wait: async () => {} }, { inputs: { message: 12345 }, variables: { prefix: 'VIP' }, subflows: [child] })
    expect(edited.status).toBe('succeeded')
    expect(edited.variables?.childResult).toBe('订单 12345 / VIP')

    const numericChild: WorkflowGraph = { ...child, context: { inputs: [{ name: 'childMessage', type: 'number', required: true }], variables: [] } }
    const exact = await runBrowser(withEditedInput('{{inputs.message}}'), fakeDriver([]), { onUpdate() {}, wait: async () => {} }, { inputs: { message: 12345 }, subflows: [numericChild] })
    expect(exact.status).toBe('succeeded')
    expect(exact.variables?.childResult).toBe(12345)

    const outputMapped = await runBrowser(withEditedInput('{{outputs.api-request_0c8d625f.paymentTime}}'), fakeDriver([]), { onUpdate() {}, wait: async () => {} }, { outputs: { 'api-request_0c8d625f': { paymentTime: '2026-10-08' } }, subflows: [child] })
    expect(outputMapped.status).toBe('succeeded')
    expect(outputMapped.variables?.childResult).toBe('2026-10-08')
  })

  it('resolves nested fields of an object injected into a child API request', async () => {
    const parentStart = createNode('start', { x: 0, y: 0 })
    const call = createNode('call-subflow', { x: 100, y: 0 })
    const parentEnd = createNode('end', { x: 200, y: 0 })
    const childStart = createNode('start', { x: 0, y: 0 })
    const request = createNode('api-request', { x: 100, y: 0 })
    const childEnd = createNode('end', { x: 200, y: 0 })
    const parent: WorkflowGraph = {
      workflowId: 'parent-object-input', name: 'Parent', version: 1, entryNodeId: parentStart.id,
      context: { inputs: [{ name: 'parentOrderId', type: 'string' }, { name: 'detailPayload', type: 'object', required: true }], variables: [] },
      nodes: [
        { ...parentStart, config: { type: 'start', url: '' } },
        { ...call, config: { type: 'call-subflow', workflowId: 'child-object-input', workflowVersion: 1, inputMappings: [
          { inputName: 'wordOrderId', source: { kind: 'workflow-input', name: 'parentOrderId' } },
          { inputName: 'workOrderDetail', source: { kind: 'workflow-input', name: 'detailPayload' } },
        ] } },
        parentEnd,
      ],
      edges: [createEdge(parentStart.id, 'default', call.id), createEdge(call.id, 'default', parentEnd.id)],
    }
    const child: WorkflowGraph = {
      workflowId: 'child-object-input', name: 'Child', version: 1, entryNodeId: childStart.id,
      context: { inputs: [{ name: 'wordOrderId', type: 'string' }, { name: 'workOrderDetail', type: 'object', required: true }], variables: [] },
      nodes: [
        { ...childStart, config: { type: 'start', url: '' } },
        { ...request, config: { ...request.config, type: 'api-request', url: 'https://example.com/api', method: 'POST', body: '{"id":"{{inputs.wordOrderId}}","shopId":{{inputs.workOrderDetail.shopId}},"title":"{{inputs.workOrderDetail.title}}","addressEditInfo":{{inputs.workOrderDetail.addressEditInfo}},"items":{{inputs.workOrderDetail.items}},"firstSku":"{{inputs.workOrderDetail.items[0].sku}}"}' } },
        childEnd,
      ],
      edges: [createEdge(childStart.id, 'default', request.id), createEdge(request.id, 'default', childEnd.id)],
    }
    let sentBody = ''
    const driver: BrowserDriver = { ...fakeDriver([]), async requestApi(config) {
      sentBody = config.body
      return { data: { ok: true }, url: config.url, status: 200 }
    } }

    const state = await runBrowser(parent, driver, { onUpdate() {}, wait: async () => {} }, {
      inputs: { parentOrderId: '150113', detailPayload: { shopId: 42, title: 'A "VIP"', addressEditInfo: { city: '上海' }, items: [{ sku: 'SKU-1' }] } },
      subflows: [child],
    })

    expect(state.status).toBe('succeeded')
    expect(JSON.parse(sentBody)).toEqual({ id: '150113', shopId: 42, title: 'A "VIP"', addressEditInfo: { city: '上海' }, items: [{ sku: 'SKU-1' }], firstSku: 'SKU-1' })
  })

  it('keeps the parent page when the child start URL is blank', async () => {
    const calls: string[] = []
    const parentStart = createNode('start', { x: 0, y: 0 })
    const call = createNode('call-subflow', { x: 100, y: 0 })
    const parentEnd = createNode('end', { x: 200, y: 0 })
    const childStart = createNode('start', { x: 0, y: 0 })
    const childClick = createNode('click', { x: 100, y: 0 })
    const childEnd = createNode('end', { x: 200, y: 0 })
    const parent: WorkflowGraph = {
      workflowId: 'parent-keep-page', name: 'Parent', version: 1, entryNodeId: parentStart.id,
      nodes: [
        { ...parentStart, config: { type: 'start', url: 'https://parent.example/page' } },
        { ...call, config: { type: 'call-subflow', workflowId: 'child-keep-page', workflowVersion: 1 } },
        parentEnd,
      ],
      edges: [createEdge(parentStart.id, 'default', call.id), createEdge(call.id, 'default', parentEnd.id)],
    }
    const child: WorkflowGraph = {
      workflowId: 'child-keep-page', name: 'Child', version: 1, entryNodeId: childStart.id,
      nodes: [
        { ...childStart, config: { type: 'start', url: '' } },
        { ...childClick, config: { type: 'click', selector: '#approve' } },
        childEnd,
      ],
      edges: [createEdge(childStart.id, 'default', childClick.id), createEdge(childClick.id, 'default', childEnd.id)],
    }

    const state = await runBrowser(parent, fakeDriver(calls), { onUpdate() {}, wait: async () => {} }, { subflows: [child] })
    expect(state.status).toBe('succeeded')
    expect(calls).toEqual(['open:https://parent.example/page', 'click:#approve'])
    expect(state.page?.url).toBe('https://parent.example/page')
  })

  it('runs an isolated subflow on the existing page without reopening the parent start URL', async () => {
    const parentStart = createNode('start', { x: 0, y: 0 })
    const call = createNode('call-subflow', { x: 100, y: 0 })
    const parent: WorkflowGraph = {
      workflowId: 'parent-existing-page', name: 'Parent', version: 1, entryNodeId: parentStart.id,
      nodes: [
        { ...parentStart, config: { type: 'start', url: 'https://example.com/' } },
        { ...call, config: { type: 'call-subflow', workflowId: 'child-existing-page', workflowVersion: 1 } },
      ],
      edges: [createEdge(parentStart.id, 'default', call.id)],
    }
    const childStart = createNode('start', { x: 0, y: 0 })
    const click = createNode('click', { x: 100, y: 0 })
    const childEnd = createNode('end', { x: 200, y: 0 })
    const child: WorkflowGraph = {
      workflowId: 'child-existing-page', name: 'Child', version: 1, entryNodeId: childStart.id,
      nodes: [
        { ...childStart, config: { type: 'start', url: '' } },
        { ...click, config: { type: 'click', selector: '#continue' } },
        childEnd,
      ],
      edges: [createEdge(childStart.id, 'default', click.id), createEdge(click.id, 'default', childEnd.id)],
    }
    const calls: string[] = []
    const driver = { ...fakeDriver(calls), currentUrl: () => 'https://existing.example/account' }

    const state = await runBrowser(isolatedNodeRunGraph(parent, call.id), driver, { onUpdate() {}, wait: async () => {} }, { subflows: [child], allowExistingPage: true })

    expect(state.status).toBe('succeeded')
    expect(state.page?.url).toBe('https://existing.example/account')
    expect(calls).toEqual(['click:#continue'])
  })

  it('coerces digit-only text for numeric required subflow inputs', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const inject = createNode('set-variable', { x: 100, y: 0 })
    const end = createNode('end', { x: 200, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'numeric subflow input', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...inject, config: { type: 'set-variable', name: 'userAccount', value: { kind: 'literal', value: '12345' }, path: '', requiredInput: { name: '用户账号', type: 'number' } } },
        end,
      ],
      edges: [createEdge(start.id, 'default', inject.id), createEdge(inject.id, 'default', end.id)],
    }

    const state = await runBrowser(graph, fakeDriver([]), { onUpdate() {}, wait: async () => {} })

    expect(state.status).toBe('succeeded')
    expect(state.variables?.userAccount).toBe(12345)
  })

  it('continues page actions on the existing page without reopening the start URL', async () => {
    const calls: string[] = []
    const start = createNode('start', { x: 0, y: 0 })
    const action = createNode('page-action', { x: 100, y: 0 })
    const end = createNode('end', { x: 200, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'picker continuation', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...action, config: { type: 'page-action', steps: [] } },
        end,
      ],
      edges: [createEdge(start.id, 'default', action.id), createEdge(action.id, 'default', end.id)],
    }
    const driver = fakeDriver(calls)
    const prepared = await runBrowser(graph, driver, { onUpdate() {}, wait: async () => {} })
    const resumed: WorkflowGraph = {
      ...graph,
      nodes: [
        { ...start, config: { type: 'start', url: '' } },
        { ...action, config: { type: 'page-action', steps: [{ type: 'click', selector: '#next' }] } },
        end,
      ],
    }
    const continued = await runBrowser(resumed, driver, { onUpdate() {}, wait: async () => {} }, {
      allowExistingPage: true, variables: prepared.variables, outputs: prepared.outputs,
    })

    expect(continued.status).toBe('succeeded')
    expect(calls).toEqual(['open:https://example.com', 'click:#next'])
  })

  it('logs resolved request query, body, and response without logging headers or secrets', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const request = createNode('api-request', { x: 100, y: 0 })
    const end = createNode('end', { x: 200, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'request logs', version: 1, entryNodeId: start.id,
      context: { inputs: [], variables: [{ name: 'order', type: 'object', defaultValue: { id: 'A-1001', password: 'private' } }] },
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...request, config: { type: 'api-request', url: 'https://example.com/api?token=private', method: 'POST', queryParams: [{ name: 'orderId', value: '{{order.id}}' }], headers: [{ name: 'Authorization', value: 'Bearer private' }], body: '{"orderId":"{{order.id}}","password":"{{order.password}}"}', responseType: 'json', jsonPath: '', outputName: 'responseData', rawOutputName: '', fields: [], timeoutMs: 1000 } },
        end,
      ],
      edges: [createEdge(start.id, 'default', request.id), createEdge(request.id, 'default', end.id)],
    }
    let sentBody = ''
    const driver: BrowserDriver = {
      ...fakeDriver([]),
      async requestApi(config) {
        sentBody = config.body
        return { data: { ok: true, receipt: { id: 'R-1' }, token: 'response-secret' }, url: 'https://example.com/api?token=private', status: 200 }
      },
    }
    const state = await runBrowser(graph, driver, { onUpdate() {}, wait: async () => {} })
    const logs = state.logs.map(line => line.message).join('\n')

    expect(state.status).toBe('succeeded')
    expect(sentBody).toContain('A-1001')
    expect(logs).toContain('请求接口：POST')
    expect(logs).toContain('请求参数（Query）：')
    expect(logs).toContain('请求参数（Body）：')
    expect(logs).toContain('响应结果：HTTP 200')
    expect(logs).toContain('R-1')
    expect(logs).not.toContain('Authorization')
    expect(logs).not.toContain('private')
    expect(logs).not.toContain('response-secret')
  })

  it('keeps request parameters and retry reasons when an API request fails', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const request = createNode('api-request', { x: 100, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'failed request logs', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: '' } },
        { ...request, execution: { ...request.execution, maxAttempts: 2 }, config: { type: 'api-request', url: 'https://example.com/api?token=private', method: 'POST', queryParams: [{ name: 'id', value: '123' }], headers: [{ name: 'Authorization', value: 'Bearer private' }], body: '{"id":"123","password":"private"}', responseType: 'json', jsonPath: '', outputName: 'responseData', rawOutputName: '', fields: [], timeoutMs: 1000 } },
      ],
      edges: [createEdge(start.id, 'default', request.id)],
    }
    let attempts = 0
    const driver: BrowserDriver = { ...fakeDriver([]), async requestApi() { attempts += 1; throw new Error('HTTP 503') } }

    const state = await runBrowser(graph, driver, { onUpdate() {}, wait: async () => {} })
    const logs = state.logs.map(line => line.message).join('\n')

    expect(state.status).toBe('failed')
    expect(attempts).toBe(2)
    expect(logs).toContain('请求参数（Query）：')
    expect(logs).toContain('请求参数（Body）：')
    expect(logs).toContain('响应结果：（未收到接口响应）')
    expect(logs).toContain('第 1/2 次尝试失败：HTTP 503')
    expect(logs).toContain('第 2/2 次尝试失败：HTTP 503')
    expect(logs).not.toContain('Authorization')
    expect(logs).not.toContain('private')
  })

  it('logs and fails a non-success HTTP response with its response body', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const request = createNode('api-request', { x: 100, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'failed HTTP response logs', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: '' } },
        { ...request, config: { ...request.config, type: 'api-request', url: 'https://example.com/orders', method: 'POST', body: '{"id":"WO-1"}' } },
      ],
      edges: [createEdge(start.id, 'default', request.id)],
    }
    const driver: BrowserDriver = {
      ...fakeDriver([]),
      async requestApi() { return { data: { message: '工单不存在', token: 'response-secret' }, url: 'https://example.com/orders', status: 400 } },
    }

    const state = await runBrowser(graph, driver, { onUpdate() {}, wait: async () => {} })
    const logs = state.logs.map(line => line.message).join('\n')

    expect(state.status).toBe('failed')
    expect(logs).toContain('响应结果：HTTP 400 https://example.com/orders')
    expect(logs).toContain('工单不存在')
    expect(logs).toContain('接口返回 HTTP 400')
    expect(logs).not.toContain('response-secret')
  })

  it('rejects malformed templated JSON before sending an API request', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const request = createNode('api-request', { x: 100, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'invalid request body', version: 1, entryNodeId: start.id,
      context: { inputs: [{ name: 'wordOrderId', type: 'string', defaultValue: 'WO-1' }], variables: [] },
      nodes: [
        { ...start, config: { type: 'start', url: '' } },
        { ...request, config: { ...request.config, type: 'api-request', url: 'https://example.com/api?token=private', method: 'POST', queryParams: [{ name: 'workOrderId', value: '{{inputs.wordOrderId}}' }], body: '{"id":"{{inputs.wordOrderId}}","password":"private"}}' } },
      ],
      edges: [createEdge(start.id, 'default', request.id)],
    }
    let sent = false
    const driver: BrowserDriver = { ...fakeDriver([]), async requestApi() { sent = true; return { data: null, url: 'https://example.com/api', status: 200 } } }

    const state = await runBrowser(graph, driver, { onUpdate() {}, wait: async () => {} })
    const logs = state.logs.map(line => line.message).join('\n')
    expect(state.status).toBe('failed')
    expect(logs).toContain('请求体 JSON 格式错误')
    expect(logs).toContain('请求接口：POST https://example.com/api?token=******')
    expect(logs).toContain('workOrderId')
    expect(logs).toContain('WO-1')
    expect(logs).toContain('请求参数（Body）：')
    expect(logs).toContain('"id":"WO-1"')
    expect(logs).not.toContain('private')
    expect(sent).toBe(false)
  })

  it('reports the exact failing page-action step', async () => {
    const calls: string[] = []
    const start = createNode('start', { x: 0, y: 0 })
    const action = createNode('page-action', { x: 80, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: newId('wf'), name: 'failed action', version: 1, entryNodeId: start.id,
      nodes: [
        { ...start, config: { type: 'start', url: 'https://example.com' } },
        { ...action, config: { type: 'page-action', steps: [
          { type: 'type', selector: '#username', value: { kind: 'literal', value: 'demo' } },
          { type: 'click', selector: '#missing' },
        ] } },
      ],
      edges: [createEdge(start.id, 'default', action.id)],
    }
    const driver = fakeDriver(calls)
    driver.click = async () => { throw new Error('元素不存在') }
    const state = await runBrowser(graph, driver, { onUpdate() {}, wait: async () => {} })
    expect(state.status).toBe('failed')
    expect(state.logs.some(line => line.message.includes('第 2 步 click 失败：元素不存在'))).toBe(true)
    expect(state.logs.some(line => line.message.includes('页面步骤 1/2 完成：type'))).toBe(true)
    expect(state.logs.some(line => line.message.includes('页面步骤 2/2 开始：click'))).toBe(true)
  })
})
