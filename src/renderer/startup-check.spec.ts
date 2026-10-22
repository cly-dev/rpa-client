import { expect, it, vi } from 'vitest'
import { checkServiceReadiness } from './startup-check.ts'

function reply(status: number, data?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response
}

it('accepts a ready server with the supported API contract', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply(200, { code: 0, data: { status: 'ready', apiVersion: 1 } }))
  expect(await checkServiceReadiness(fetcher)).toEqual({ kind: 'ready', message: '服务端已就绪' })
  expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/health$/), expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }))
})

it('distinguishes old servers, unavailable servers and incompatible contracts', async () => {
  expect((await checkServiceReadiness(vi.fn().mockResolvedValue(reply(404)))).kind).toBe('incompatible')
  expect((await checkServiceReadiness(vi.fn().mockResolvedValue(reply(503)))).kind).toBe('unavailable')
  expect((await checkServiceReadiness(vi.fn().mockResolvedValue(reply(200, { code: 0, data: { status: 'ready', apiVersion: 2 } })))).kind).toBe('incompatible')
  expect((await checkServiceReadiness(vi.fn().mockRejectedValue(new Error('offline')))).kind).toBe('unavailable')
})
