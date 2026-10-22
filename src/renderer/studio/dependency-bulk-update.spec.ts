import { describe, expect, it, vi } from 'vitest'
import { createNode } from '@graph/mutate.ts'
import { createDefaultTemplate } from '@graph/template.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { applyParentVersionUpdate, executeCascadingParentVersionUpdates, executeParentVersionUpdates, hasRedactedSecrets, planParentVersionUpdates } from './dependency-bulk-update.ts'

function child(version: number): WorkflowGraph {
  return { ...createDefaultTemplate(), workflowId: 'child', version, context: { inputs: [{ name: 'id', type: 'string' }], variables: [] } }
}

describe('parent dependency version updates', () => {
  it('updates only calls to the selected child across multiple parents', () => {
    const old = child(1)
    const target = child(2)
    const call = createNode('call-subflow', { x: 0, y: 0 })
    const other = createNode('call-subflow', { x: 100, y: 0 })
    const graph = { ...createDefaultTemplate(), nodes: [
      { ...call, config: { type: 'call-subflow' as const, workflowId: 'child', workflowVersion: 1, inputMappings: [{ inputName: 'id', source: { kind: 'literal' as const, value: 'A' } }] } },
      { ...other, config: { type: 'call-subflow' as const, workflowId: 'other', workflowVersion: 1, inputMappings: [] } },
    ] }
    const parents = [
      { id: 'parent-a', name: 'A', updatedAt: 't1', graph },
      { id: 'parent-b', name: 'B', updatedAt: 't2', graph: { ...graph, workflowId: 'parent-b' } },
    ]
    const updates = planParentVersionUpdates(parents, 'child', target, [old])
    expect(updates).toHaveLength(2)
    expect(updates.map(item => item.plan.updates.size)).toEqual([1, 1])
    const changed = applyParentVersionUpdate(updates[0])
    expect(changed.nodes[0].config).toMatchObject({ workflowVersion: 2, inputMappings: [{ inputName: 'id' }] })
    expect(changed.nodes[1].config).toMatchObject({ workflowId: 'other', workflowVersion: 1 })
    expect(graph.nodes[0].config).toMatchObject({ workflowVersion: 1 })
  })

  it('skips parents already using the target version', () => {
    const target = child(2)
    const call = createNode('call-subflow', { x: 0, y: 0 })
    const graph = { ...createDefaultTemplate(), nodes: [{ ...call, config: { type: 'call-subflow' as const, workflowId: 'child', workflowVersion: 2 } }] }
    expect(planParentVersionUpdates([{ id: 'parent', name: 'P', updatedAt: 't', graph }], 'child', target, [target])).toEqual([])
  })

  it('publishes a parent whose draft is current but published graph still uses the old child', async () => {
    const old = child(1)
    const target = child(2)
    const call = createNode('call-subflow', { x: 0, y: 0 })
    const draft = { ...createDefaultTemplate(), workflowId: 'parent', nodes: [{ ...call, config: { type: 'call-subflow' as const, workflowId: 'child', workflowVersion: 2 } }] }
    const publishedGraph = { ...draft, version: 3, nodes: [{ ...call, config: { type: 'call-subflow' as const, workflowId: 'child', workflowVersion: 1 } }] }
    const parent = { id: 'parent', name: 'P', updatedAt: 't', graph: draft, publishedGraph }
    const updates = planParentVersionUpdates([parent], 'child', target, [old])

    expect(updates).toMatchObject([{ mode: 'publish-only' }])
    expect(updates[0].plan.updates.size).toBe(0)
    const saveDraft = vi.fn()
    const publish = vi.fn(async () => ({ publishedVersion: 4 }))
    const outcomes = await executeParentVersionUpdates(updates, { getParent: async () => parent, saveDraft, publish })

    expect(saveDraft).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledWith('parent')
    expect(outcomes).toMatchObject([{ status: 'published', version: 4 }])
  })

  it('checks for concurrent draft changes before saving and publishing', async () => {
    const old = child(1)
    const target = child(2)
    const call = createNode('call-subflow', { x: 0, y: 0 })
    const graph = { ...createDefaultTemplate(), nodes: [{ ...call, config: { type: 'call-subflow' as const, workflowId: 'child', workflowVersion: 1 } }] }
    const updates = planParentVersionUpdates([{ id: 'parent', name: 'P', updatedAt: 't1', graph }], 'child', target, [old])
    const saveDraft = vi.fn()
    const publish = vi.fn()
    const outcomes = await executeParentVersionUpdates(updates, {
      getParent: async () => ({ id: 'parent', name: 'P', updatedAt: 't2', graph }),
      saveDraft,
      publish,
    })
    expect(outcomes).toMatchObject([{ status: 'not-updated', error: '父流程草稿已变化，请重新预览后再操作' }])
    expect(saveDraft).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('does not overwrite secrets redacted by the service', async () => {
    const old = child(1)
    const target = child(2)
    const call = createNode('call-subflow', { x: 0, y: 0 })
    const graph = {
      ...createDefaultTemplate(),
      nodes: [{ ...call, config: { type: 'call-subflow' as const, workflowId: 'child', workflowVersion: 1 } }],
      context: { inputs: [{ name: 'token', type: 'string' as const, secret: true, defaultValue: '******' }], variables: [] },
    }
    expect(hasRedactedSecrets(graph)).toBe(true)
    const updates = planParentVersionUpdates([{ id: 'parent', name: 'P', updatedAt: 't', graph }], 'child', target, [old])
    const saveDraft = vi.fn()
    const publish = vi.fn()
    const outcomes = await executeParentVersionUpdates(updates, {
      getParent: async () => ({ id: 'parent', name: 'P', updatedAt: 't', graph }),
      saveDraft,
      publish,
    })
    expect(outcomes).toMatchObject([{ status: 'not-updated', error: '父流程包含服务端遮蔽的密钥，无法安全地整体保存草稿' }])
    expect(saveDraft).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('reports a saved draft when publishing fails and continues with the next parent', async () => {
    const old = child(1)
    const target = child(2)
    const call = createNode('call-subflow', { x: 0, y: 0 })
    const graph = { ...createDefaultTemplate(), nodes: [{ ...call, config: { type: 'call-subflow' as const, workflowId: 'child', workflowVersion: 1 } }] }
    const parents = [
      { id: 'a', name: 'A', updatedAt: 't', graph },
      { id: 'b', name: 'B', updatedAt: 't', graph: { ...graph, workflowId: 'b' } },
    ]
    const updates = planParentVersionUpdates(parents, 'child', target, [old])
    const saved: string[] = []
    const outcomes = await executeParentVersionUpdates(updates, {
      getParent: async id => parents.find(item => item.id === id)!,
      saveDraft: async next => { saved.push(next.workflowId) },
      publish: async id => { if (id === 'a') throw new Error('发布校验失败'); return { publishedVersion: 4 } },
    })
    expect(saved).toHaveLength(2)
    expect(outcomes).toMatchObject([{ status: 'draft-only', error: '发布校验失败' }, { status: 'published', version: 4 }])
  })

  it('cascades a grandchild version through the child and then the root parent', async () => {
    const callGraph = (workflowId: string, version: number, calledId: string, calledVersion: number): WorkflowGraph => {
      const call = createNode('call-subflow', { x: 0, y: 0 })
      return { ...createDefaultTemplate(), workflowId, name: workflowId, version, nodes: [
        { ...call, config: { type: 'call-subflow' as const, workflowId: calledId, workflowVersion: calledVersion } },
      ] }
    }
    const grandchildV1 = child(1)
    const grandchildV2 = child(2)
    const childV1 = callGraph('middle', 1, 'child', 1)
    const parentV1 = callGraph('root', 1, 'middle', 1)
    const records = new Map([
      ['middle', { id: 'middle', name: 'Middle', updatedAt: 'm1', graph: childV1, publishedVersion: 1 }],
      ['root', { id: 'root', name: 'Root', updatedAt: 'r1', graph: parentV1, publishedVersion: 1 }],
    ])
    const revisions = new Map<string, WorkflowGraph>([
      ['child@1', grandchildV1], ['child@2', grandchildV2], ['middle@1', childV1], ['root@1', parentV1],
    ])

    const outcomes = await executeCascadingParentVersionUpdates([{ workflowId: 'child', version: 2, graph: grandchildV2 }], {
      async listParentIds(id) { return id === 'child' ? ['middle'] : id === 'middle' ? ['root'] : [] },
      async getParent(id) { return records.get(id)! },
      async getRevision(id, version) { return revisions.get(`${id}@${version}`)! },
      async saveDraft(graph) {
        const record = records.get(graph.workflowId)!
        records.set(graph.workflowId, { ...record, graph, updatedAt: `${record.updatedAt}-saved` })
      },
      async publish(id) {
        const record = records.get(id)!
        const version = (record.publishedVersion ?? 0) + 1
        const graph = { ...record.graph, version }
        records.set(id, { ...record, graph, publishedVersion: version })
        revisions.set(`${id}@${version}`, graph)
        return { publishedVersion: version }
      },
      async validate() { return undefined },
    })

    expect(outcomes).toMatchObject([
      { id: 'middle', status: 'published', version: 2, depth: 1, childWorkflowId: 'child', childVersion: 2 },
      { id: 'root', status: 'published', version: 2, depth: 2, childWorkflowId: 'middle', childVersion: 2 },
    ])
    expect(records.get('middle')?.graph.nodes[0].config).toMatchObject({ workflowId: 'child', workflowVersion: 2 })
    expect(records.get('root')?.graph.nodes[0].config).toMatchObject({ workflowId: 'middle', workflowVersion: 2 })
  })
})
