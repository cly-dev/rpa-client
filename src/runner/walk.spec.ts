import { describe, expect, it } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { walkGraph, type RunState, type StepResult } from './walk.ts'

function handlers() {
  return {
    onUpdate: (_state: RunState): void => {},
    wait: async (_ms: number): Promise<void> => {},
  }
}

describe('walkGraph loop control', () => {
  it('stops after the selected node without executing its successor', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const target = createNode('set-variable', { x: 100, y: 0 })
    const successor = createNode('set-variable', { x: 200, y: 0 })
    const graph: WorkflowGraph = { workflowId: 'stop-at-target', name: 'Stop', version: 1, entryNodeId: start.id, nodes: [start, target, successor], edges: [createEdge(start.id, 'default', target.id), createEdge(target.id, 'default', successor.id)] }
    const visited: string[] = []
    const state = await walkGraph(graph, handlers(), async node => { visited.push(node.id); return { message: node.name } }, { stopAfterNodeId: target.id })
    expect(state.status).toBe('succeeded')
    expect(visited).toEqual([start.id, target.id])
    expect(state.nodes[successor.id]).toBe('pending')
  })

  it('leaves the target pending when a condition routes elsewhere', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const condition = createNode('condition', { x: 100, y: 0 })
    const target = createNode('set-variable', { x: 200, y: -50 })
    const other = createNode('end', { x: 200, y: 50 })
    const graph: WorkflowGraph = { workflowId: 'conditional-target', name: 'Conditional', version: 1, entryNodeId: start.id, nodes: [start, condition, target, other], edges: [createEdge(start.id, 'default', condition.id), createEdge(condition.id, 'matched', target.id), createEdge(condition.id, 'else', other.id)] }
    const state = await walkGraph(graph, handlers(), async node => ({ message: node.name, branch: node.id === condition.id ? 'else' : undefined }), { stopAfterNodeId: target.id })
    expect(state.status).toBe('succeeded')
    expect(state.nodes[target.id]).toBe('pending')
    expect(state.nodes[other.id]).toBe('succeeded')
  })

  it('continues with the next item when a continue-loop node is reached', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const loop = createNode('for-each', { x: 100, y: 0 })
    const continueLoop = createNode('continue-loop', { x: 200, y: 0 })
    const end = createNode('end', { x: 300, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: 'wf-continue',
      name: 'continue loop',
      version: 1,
      entryNodeId: start.id,
      nodes: [start, loop, continueLoop, end],
      edges: [
        createEdge(start.id, 'default', loop.id),
        createEdge(loop.id, 'body', continueLoop.id),
        createEdge(loop.id, 'done', end.id),
      ],
    }
    let loopVisits = 0

    const state = await walkGraph(graph, handlers(), async node => {
      if (node.type === 'for-each') {
        loopVisits += 1
        return { message: 'loop', branch: loopVisits <= 2 ? 'body' : 'done' }
      }
      return { message: node.name } satisfies StepResult
    })

    expect(state.status).toBe('succeeded')
    expect(loopVisits).toBe(3)
    expect(state.logs.some(line => line.message.includes('判断下一轮'))).toBe(true)
  })

  it('finishes each multi-step loop body through continue-loop without a back edge', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const loop = createNode('for-each', { x: 100, y: 0 })
    const action = createNode('set-variable', { x: 200, y: 0 })
    const continueLoop = createNode('continue-loop', { x: 300, y: 0 })
    const end = createNode('end', { x: 400, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: 'wf-multi-step-loop',
      name: 'multi-step loop',
      version: 1,
      entryNodeId: start.id,
      nodes: [start, loop, action, continueLoop, end],
      edges: [
        createEdge(start.id, 'default', loop.id),
        createEdge(loop.id, 'body', action.id),
        createEdge(action.id, 'default', continueLoop.id),
        createEdge(loop.id, 'done', end.id),
      ],
    }
    const visited: string[] = []
    let loopVisits = 0

    const state = await walkGraph(graph, handlers(), async node => {
      visited.push(node.type)
      if (node.type === 'for-each') {
        loopVisits += 1
        return { message: 'loop', branch: loopVisits <= 2 ? 'body' : 'done' }
      }
      return { message: node.name }
    })

    expect(state.status).toBe('succeeded')
    expect(visited).toEqual(['start', 'for-each', 'set-variable', 'continue-loop', 'for-each', 'set-variable', 'continue-loop', 'for-each', 'end'])
  })

  it('fails clearly when continue-loop is used outside a loop', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const continueLoop = createNode('continue-loop', { x: 100, y: 0 })
    const graph: WorkflowGraph = {
      workflowId: 'wf-invalid-continue',
      name: 'invalid continue',
      version: 1,
      entryNodeId: start.id,
      nodes: [start, continueLoop],
      edges: [createEdge(start.id, 'default', continueLoop.id)],
    }

    const state = await walkGraph(graph, handlers(), async node => ({ message: node.name }))

    expect(state.status).toBe('failed')
    expect(state.logs.some(line => line.message.includes('只能在循环体内使用'))).toBe(true)
  })
})

describe('walkGraph approval control', () => {
  it('pauses for approval and follows the approved branch with outputs', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const approval = createNode('approval', { x: 100, y: 0 })
    const approvedEnd = createNode('end', { x: 200, y: -60 })
    const rejectedEnd = createNode('end', { x: 200, y: 0 })
    const timeoutEnd = createNode('end', { x: 200, y: 60 })
    const graph: WorkflowGraph = {
      workflowId: 'wf-approval',
      name: 'approval',
      version: 1,
      entryNodeId: start.id,
      nodes: [start, approval, approvedEnd, rejectedEnd, timeoutEnd],
      edges: [
        createEdge(start.id, 'default', approval.id),
        createEdge(approval.id, 'approved', approvedEnd.id),
        createEdge(approval.id, 'rejected', rejectedEnd.id),
        createEdge(approval.id, 'timeout', timeoutEnd.id),
      ],
    }
    const statuses: RunState['status'][] = []

    const state = await walkGraph(graph, {
      onUpdate: next => { statuses.push(next.status) },
      wait: async () => {},
      requestApproval: async () => ({ decision: 'approved', comment: '可以执行', approverId: 'device-1', approverName: '当前执行人', decidedAt: '2026-10-08T00:00:00.000Z' }),
    }, async node => node.type === 'approval'
      ? { message: '等待审批', approval: { id: 'approval-1', executionId: 'execution-1', workflowId: graph.workflowId, nodeId: node.id, nodeName: node.name, title: '确认执行', description: '', fields: [], requireCommentOnReject: true } }
      : { message: node.name })

    expect(statuses).toContain('waiting-approval')
    expect(state.status).toBe('succeeded')
    expect(state.nodes[approvedEnd.id]).toBe('succeeded')
    expect(state.nodes[rejectedEnd.id]).toBe('pending')
    expect(state.outputs[approval.id]).toMatchObject({ approved: true, decision: 'approved', comment: '可以执行' })
  })

  it('continues through the rejected branch after an approval is rejected', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const approval = createNode('approval', { x: 100, y: 0 })
    const approvedEnd = createNode('end', { x: 200, y: -40 })
    const rejectedEnd = createNode('end', { x: 200, y: 40 })
    const graph: WorkflowGraph = {
      workflowId: 'wf-approval-rejected',
      name: 'approval rejected',
      version: 1,
      entryNodeId: start.id,
      nodes: [start, approval, approvedEnd, rejectedEnd],
      edges: [
        createEdge(start.id, 'default', approval.id),
        createEdge(approval.id, 'approved', approvedEnd.id),
        createEdge(approval.id, 'rejected', rejectedEnd.id),
      ],
    }

    const state = await walkGraph(graph, {
      onUpdate: () => {},
      wait: async () => {},
      requestApproval: async () => ({ decision: 'rejected', comment: '条件不满足', approverName: '当前执行人', decidedAt: '2026-10-08T00:00:00.000Z' }),
    }, async node => node.type === 'approval'
      ? { message: '等待审批', approval: { id: 'approval-2', executionId: 'execution-2', workflowId: graph.workflowId, nodeId: node.id, nodeName: node.name, title: '确认执行', description: '', fields: [], requireCommentOnReject: true } }
      : { message: node.name })

    expect(state.status).toBe('succeeded')
    expect(state.nodes[approvedEnd.id]).toBe('pending')
    expect(state.nodes[rejectedEnd.id]).toBe('succeeded')
    expect(state.outputs[approval.id]).toMatchObject({ approved: false, decision: 'rejected', comment: '条件不满足' })
  })
})

describe('walkGraph execution diagnostics', () => {
  it('records each node lifecycle, output shapes, and selected route without output values', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const condition = createNode('condition', { x: 100, y: 0 })
    const end = createNode('end', { x: 200, y: 0 })
    const graph: WorkflowGraph = { workflowId: 'wf-log', name: 'Log', version: 1, entryNodeId: start.id, nodes: [start, condition, end], edges: [createEdge(start.id, 'default', condition.id), createEdge(condition.id, 'matched', end.id)] }

    const state = await walkGraph(graph, handlers(), async node => node.id === condition.id
      ? { message: '判断成功', branch: 'matched', outputs: { privateValue: 'top-secret', rows: [1, 2] } }
      : { message: '完成' })
    const messages = state.logs.map(line => line.message).join('\n')

    expect(state.status).toBe('succeeded')
    for (const node of graph.nodes) {
      expect(state.logs.some(line => line.nodeId === node.id && line.message.includes('开始执行'))).toBe(true)
      expect(state.logs.some(line => line.nodeId === node.id && line.message.includes('执行耗时：'))).toBe(true)
    }
    expect(messages).toContain('出口「matched」→ 下一节点')
    expect(messages).toContain('privateValue=文本(10字)')
    expect(messages).toContain('rows=数组(2项)')
    expect(messages).not.toContain('top-secret')
  })

  it('keeps the final failure reason and caps oversized log entries', async () => {
    const start = createNode('start', { x: 0, y: 0 })
    const graph: WorkflowGraph = { workflowId: 'wf-failed-log', name: 'Failed Log', version: 1, entryNodeId: start.id, nodes: [start], edges: [] }
    const state = await walkGraph(graph, handlers(), async () => ({ message: '服务请求超时', logs: ['x'.repeat(10_000)], halt: 'failed' }))

    expect(state.status).toBe('failed')
    expect(state.logs.every(line => line.message.length <= 4_800)).toBe(true)
    expect(state.logs.at(-1)?.message).toContain('服务请求超时')
    expect(state.logs.some(line => line.message.includes('日志已截断'))).toBe(true)
  })
})
