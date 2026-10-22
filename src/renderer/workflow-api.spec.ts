import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { archiveWorkflow, linkScheduleExecution, listScheduleOccurrences, listSchedules, listWorkflows, loadServiceLlmConfigs, listWorkflowRevisions, moveWorkflow } from './workflow-api.ts'

afterEach(() => { vi.unstubAllGlobals() })
beforeEach(() => {
  const store = new Map<string, string>([['rpa:pms-auth-session', JSON.stringify({
    token: 'header.payload.signature', tokenType: 'Bearer', expiresAt: '2099-01-01T00:00:00.000Z',
    user: { id: '42', username: 'tester', name: '测试员' },
  })]])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  })
})

it('loads published revision metadata for the subflow version picker', async () => {
  const items = [{ id: 'revision-3', version: 3, stage: 'published', createdAt: '2026-10-13T00:00:00.000Z' }]
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0, message: '', data: { items } }) })
  vi.stubGlobal('fetch', fetcher)

  expect(await listWorkflowRevisions('http://service.test', 'wf-1')).toEqual({ items })
  expect(fetcher).toHaveBeenCalledWith('http://service.test/workflows/wf-1/revisions', expect.objectContaining({ headers: { 'Content-Type': 'application/json', Authorization: 'Bearer header.payload.signature' } }))
})

it('sends a workspace-only patch when moving a workflow', async () => {
  const moved = { id: 'wf-1', workspaceId: 'ws-service', publishedVersion: 3 }
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0, message: '', data: moved }) })
  vi.stubGlobal('fetch', fetcher)

  expect(await moveWorkflow('http://service.test', 'wf-1', 'ws-service')).toEqual(moved)
  expect(fetcher).toHaveBeenCalledWith('http://service.test/workflows/wf-1/workspace', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ workspaceId: 'ws-service' }) }))
})

it('loads archived workflows separately and archives without a permanent-delete request', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0, data: { items: [], total: 0, page: 1, pageSize: 12 } }) })
  vi.stubGlobal('fetch', fetcher)

  await listWorkflows('http://service.test', 1, 12, '', 'space-1', 'archived')
  await archiveWorkflow('http://service.test', 'wf-1')

  expect(fetcher.mock.calls[0]?.[0]).toContain('workspaceId=space-1&status=archived')
  expect(fetcher.mock.calls[1]?.[0]).toBe('http://service.test/workflows/wf-1')
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' })
})

it('loads every AI configuration page with the service JWT', async () => {
  const config = { id: 'model-one', name: '模型', enabled: true, model: 'test', baseUrl: '', chatPath: '', apiKey: '', maxTokens: 100 }
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ code: 0, data: { items: [config], total: 2 } }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ code: 0, data: { items: [{ ...config, id: 'model-two' }], total: 2 } }) })
  vi.stubGlobal('fetch', fetcher)
  expect((await loadServiceLlmConfigs('http://service.test')).map(item => item.id)).toEqual(['model-one', 'model-two'])
  expect(fetcher.mock.calls[1]?.[0]).toContain('page=2')
  expect(fetcher.mock.calls[0]?.[1]?.headers.Authorization).toBe('Bearer header.payload.signature')
  expect(fetcher.mock.calls[1]?.[1]?.headers.Authorization).toBe('Bearer header.payload.signature')
})

it('clears the session after an unauthorized business response', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ code: 40100, message: '登录已失效' }) })
  vi.stubGlobal('fetch', fetcher)
  const dispatchEvent = vi.fn()
  vi.stubGlobal('window', { dispatchEvent })
  await expect(listWorkflowRevisions('http://service.test', 'wf-1')).rejects.toThrow('登录已失效')
  expect(localStorage.getItem('rpa:pms-auth-session')).toBeNull()
  expect(dispatchEvent).toHaveBeenCalledOnce()
})

it('treats code 40100 as expired even when HTTP status is 200', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 40100, message: '登录已失效' }) }))
  await expect(listWorkflowRevisions('http://service.test', 'wf-1')).rejects.toThrow('登录已失效')
  expect(localStorage.getItem('rpa:pms-auth-session')).toBeNull()
})

it('does not remove a newer login after an old request returns 401', async () => {
  const fetcher = vi.fn().mockImplementation(async () => {
    localStorage.setItem('rpa:pms-auth-session', JSON.stringify({
      token: 'newer.jwt.token', tokenType: 'Bearer', expiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: '43', username: 'another', name: '另一个用户' },
    }))
    return { ok: false, status: 401, json: async () => ({ code: 40100, message: '旧会话失效' }) }
  })
  vi.stubGlobal('fetch', fetcher)
  await expect(listWorkflowRevisions('http://service.test', 'wf-1')).rejects.toThrow('旧会话失效')
  expect(JSON.parse(localStorage.getItem('rpa:pms-auth-session') ?? '{}').token).toBe('newer.jwt.token')
})

it('does not call a business API without a session', async () => {
  localStorage.removeItem('rpa:pms-auth-session')
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await expect(listWorkflowRevisions('http://service.test', 'wf-1')).rejects.toThrow('请先登录')
  expect(fetcher).not.toHaveBeenCalled()
})

it('reads paged schedule history and links a running execution with the service JWT', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0, data: { items: [], total: 0, page: 2, pageSize: 20 } }) })
  vi.stubGlobal('fetch', fetcher)

  await listScheduleOccurrences('http://service.test', 'schedule/1', 2)
  await linkScheduleExecution('http://service.test', 'schedule/1', 'occurrence/1', 'execution-1')
  await listSchedules('http://service.test', undefined, undefined, true)

  expect(fetcher.mock.calls[0]?.[0]).toBe('http://service.test/schedules/schedule%2F1/occurrences?page=2&pageSize=20')
  expect(fetcher.mock.calls[1]?.[0]).toBe('http://service.test/schedules/schedule%2F1/occurrences/occurrence%2F1/execution')
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ executionId: 'execution-1' }) })
  expect(fetcher.mock.calls[2]?.[0]).toBe('http://service.test/schedules?includeDeleted=true')
  expect(fetcher.mock.calls[0]?.[1]?.headers.Authorization).toBe('Bearer header.payload.signature')
})
