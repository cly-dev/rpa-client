import { describe, expect, it } from 'vitest'
import { createDefaultTemplate } from '@graph/index.ts'
import { importNodeJson, importWorkflowJson } from './json-transfer.ts'

describe('JSON transfer', () => {
  it('imports a workflow while preserving the current workflow identity', () => {
    const current = createDefaultTemplate()
    const source = { ...createDefaultTemplate(), workflowId: 'foreign', name: '导入流程', version: 99 }
    const imported = importWorkflowJson(JSON.stringify(source), current)
    expect(imported.workflowId).toBe(current.workflowId)
    expect(imported.version).toBe(current.version)
    expect(imported.name).toBe('导入流程')
  })

  it('imports node configuration while preserving id and position', () => {
    const current = createDefaultTemplate().nodes[0]!
    const source = { ...current, id: 'foreign-node', name: '导入开始节点', position: { x: 999, y: 999 }, config: { type: 'start', url: 'https://example.com' } }
    const imported = importNodeJson(JSON.stringify(source), current)
    expect(imported.id).toBe(current.id)
    expect(imported.position).toEqual(current.position)
    expect(imported.name).toBe('导入开始节点')
    expect(imported.config).toEqual({ type: 'start', url: 'https://example.com' })
  })

  it('rejects importing a different node type', () => {
    const current = createDefaultTemplate().nodes[0]!
    const source = { ...current, type: 'end', config: { type: 'end' } }
    expect(() => importNodeJson(JSON.stringify(source), current)).toThrow('节点类型不一致')
  })
})
