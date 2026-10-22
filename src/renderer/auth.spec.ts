import { afterEach, expect, it, vi } from 'vitest'
import { AuthRequestError, currentAuthUser, loginWithPms, storedAuthSession } from './auth.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('distinguishes a temporary auth service failure from an invalid session', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ code: 50300, message: '服务暂不可用' }) }))
  await expect(currentAuthUser('saved-token')).rejects.toMatchObject({ status: 503, invalidSession: false })
})

it('marks an explicit unauthorized response as an invalid session', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ code: 40100, message: '账号已停用' }) }))
  await expect(currentAuthUser('saved-token')).rejects.toMatchObject({ status: 401, invalidSession: true, message: '账号已停用' } satisfies Partial<AuthRequestError>)
})

it('accepts only a service JWT login session', async () => {
  const session = { token: 'header.payload.signature', tokenType: 'Bearer', expiresAt: '2099-01-01T00:00:00.000Z', user: { id: '42', username: 'tester', name: '测试员' } }
  const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0, data: session }) })
  vi.stubGlobal('fetch', fetcher)
  await expect(loginWithPms('tester', 'secret')).resolves.toEqual(session)
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/auth/login'), expect.objectContaining({ method: 'POST', body: JSON.stringify({ username: 'tester', password: 'secret' }) }))
})

it('rejects an old PMS token in the login response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0, data: { token: 'pms-token', tokenType: 'Bearer', expiresAt: '2099-01-01T00:00:00.000Z', user: { id: '42' } } }) }))
  await expect(loginWithPms('tester', 'secret')).rejects.toThrow('JWT 会话无效')
})

it('removes a persisted session from the old PMS-token format', () => {
  const store = new Map([['rpa:pms-auth-session', JSON.stringify({ token: 'old-pms-token', expiresAt: '2099-01-01T00:00:00.000Z', user: { id: '42' } })]])
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, removeItem: (key: string) => { store.delete(key) } })
  expect(storedAuthSession()).toBeUndefined()
  expect(store.has('rpa:pms-auth-session')).toBe(false)
})
