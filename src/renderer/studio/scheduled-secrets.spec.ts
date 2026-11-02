import { describe, expect, it } from 'vitest'
import type { WorkflowGraph } from '@graph/types.ts'
import { hydrateScheduledSecrets, scheduledSecretStrings } from './scheduled-secrets.ts'

const graph = {
  workflowId: 'flow', name: '流程', version: 1, entryNodeId: 'start', nodes: [], edges: [],
  context: {
    inputs: [{ name: 'token', type: 'string', secret: true, defaultValue: '******' }],
    variables: [{ name: 'password', type: 'string', secret: true, defaultValue: '******' }],
  },
} as WorkflowGraph

describe('scheduled secrets', () => {
  it('restores masked defaults only for the matching revision', () => {
    const restored = hydrateScheduledSecrets(graph, [{ workflowId: 'flow', version: 1, inputs: { token: 'fallback-token' }, variables: { password: 'fixed-secret' } }])
    expect(restored.context?.inputs[0].defaultValue).toBe('fallback-token')
    expect(restored.context?.variables[0].defaultValue).toBe('fixed-secret')
    expect(scheduledSecretStrings([restored], { token: 'runtime-token' })).toEqual(['runtime-token', 'fixed-secret'])
  })

  it('fails instead of running with a redaction marker from an older server', () => {
    expect(() => hydrateScheduledSecrets(graph, [])).toThrow('请更新服务端')
  })
})
