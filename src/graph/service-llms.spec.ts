import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowGraph, WorkflowLlmConfig } from './types.ts'
import { ServiceAuthExpiredError, loadServiceLlmConfigs, withServiceLlms } from './service-llms.ts'

const config: WorkflowLlmConfig = {
  id: 'model/one', name: '服务端模型', enabled: true, model: 'test-model',
  baseUrl: 'https://upstream.example/v1', chatPath: '/chat/completions',
  apiKey: '******', maxTokens: 100,
}

afterEach(() => { vi.unstubAllGlobals() })

describe('service AI configs', () => {
  it('loads all pages with the current service JWT', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ code: 0, data: { items: [config], total: 2 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ code: 0, data: { items: [{ ...config, id: 'model-two' }], total: 2 } }) })
    vi.stubGlobal('fetch', fetchMock)
    expect((await loadServiceLlmConfigs('http://127.0.0.1:3000/api/v1', 'header.payload.signature')).map(item => item.id)).toEqual(['model/one', 'model-two'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toContain('page=2')
    expect(fetchMock.mock.calls[0]?.[1]?.headers.Authorization).toBe('Bearer header.payload.signature')
  })

  it('reports an expired session to the Electron caller', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ code: 40100, message: '登录已失效' }) }))
    await expect(loadServiceLlmConfigs('http://service.test', 'expired.token.value')).rejects.toBeInstanceOf(ServiceAuthExpiredError)
  })

  it('creates runtime-only proxy configs with the service JWT, without exposing the provider key', () => {
    const graph: WorkflowGraph = {
      workflowId: 'wf', name: 'test', version: 1, entryNodeId: 'start', nodes: [], edges: [],
      llm: { ...config, id: 'legacy', apiKey: 'old-secret' },
    }
    const runtime = withServiceLlms(graph, [config], 'header.payload.signature', 'http://127.0.0.1:3000/api/v1')
    expect(runtime.llm?.baseUrl).toBe('http://127.0.0.1:3000/api/v1/llm-configs/model%2Fone')
    expect(runtime.llm?.chatPath).toBe('/chat/completions')
    expect(runtime.llm?.apiKey).toBe('header.payload.signature')
    expect(runtime.llms?.map(item => item.id)).toEqual(['model/one'])
    expect(graph.llm?.apiKey).toBe('old-secret')
  })

  it('does not create a model proxy without an authenticated session', () => {
    const graph: WorkflowGraph = { workflowId: 'wf', name: 'test', version: 1, entryNodeId: 'start', nodes: [], edges: [] }
    expect(() => withServiceLlms(graph, [config], '')).toThrow('请先登录')
  })
})
