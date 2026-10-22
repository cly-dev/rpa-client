import { RPA_SERVICE_URL } from '@graph/service-llms.ts'

export interface AuthUser { readonly id: string; readonly username: string; readonly name: string }
export interface AuthSession { readonly token: string; readonly tokenType: 'Bearer'; readonly expiresAt: string; readonly user: AuthUser }

const STORAGE_KEY = 'rpa:pms-auth-session'
export const AUTH_EXPIRED_EVENT = 'rpa:auth-expired'

interface ApiEnvelope<T> { readonly code: number; readonly message: string; readonly data: T }

export class AuthRequestError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
  get invalidSession(): boolean { return this.status === 401 }
}

export function storedAuthSession(): AuthSession | undefined {
  if (typeof localStorage === 'undefined') return undefined
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const session = JSON.parse(raw) as AuthSession
    const expiresAt = new Date(session.expiresAt).getTime()
    if (!session.token || session.tokenType !== 'Bearer' || !session.user?.id || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      clearAuthSession()
      return undefined
    }
    return session
  } catch { clearAuthSession(); return undefined }
}

export function authToken(): string | undefined { return storedAuthSession()?.token }
export function saveAuthSession(session: AuthSession): void { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)) }
export function clearAuthSession(): void { if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY) }
export function expireAuthSession(token?: string): void {
  if (token && typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw && (JSON.parse(raw) as Partial<AuthSession>).token !== token) return
    } catch { /* A corrupt session can be discarded. */ }
  }
  clearAuthSession()
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
}

async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${RPA_SERVICE_URL}/auth${path}`, { ...init, signal: AbortSignal.timeout(path === '/login' ? 12000 : 5000), headers: { 'Content-Type': 'application/json', ...init?.headers } })
  } catch { throw new AuthRequestError('无法连接 RPA 服务，请确认服务端已启动') }
  let body: ApiEnvelope<T>
  try { body = await response.json() as ApiEnvelope<T> }
  catch { throw new AuthRequestError(`认证服务返回无效响应（HTTP ${response.status}）`, response.status) }
  if (!response.ok || body.code !== 0) throw new AuthRequestError(body.message || `认证失败（HTTP ${response.status}）`, response.status === 401 || body.code === 40100 ? 401 : response.status)
  return body.data
}

export async function loginWithPms(username: string, password: string): Promise<AuthSession> {
  const session = await authRequest<AuthSession>('/login', { method: 'POST', body: JSON.stringify({ username, password }) })
  if (session?.tokenType !== 'Bearer' || !/^[^.]+\.[^.]+\.[^.]+$/.test(session.token ?? '') || !session.user?.id || !Number.isFinite(new Date(session.expiresAt).getTime())) {
    throw new AuthRequestError('登录服务返回的 JWT 会话无效，请联系管理员检查服务端版本')
  }
  return session
}

export function currentAuthUser(token: string): Promise<AuthUser> {
  return authRequest('/me', { headers: { Authorization: `Bearer ${token}` } })
}

export async function logoutAuthSession(token: string): Promise<void> {
  await authRequest('/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
}
