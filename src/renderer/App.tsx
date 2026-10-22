import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Studio } from './studio/Studio.tsx'
import { SchedulerHost } from './studio/SchedulerHost.tsx'
import { AUTH_EXPIRED_EVENT, AuthRequestError, clearAuthSession, currentAuthUser, expireAuthSession, loginWithPms, logoutAuthSession, saveAuthSession, storedAuthSession, type AuthSession } from './auth.ts'
import { checkServiceReadiness, type ServiceReadiness } from './startup-check.ts'

interface BrowserStatus { readonly available: boolean; readonly message: string }

async function checkBrowserWithTimeout(): Promise<BrowserStatus> {
  const unavailable = { available: false, message: '无法读取浏览器环境，请重启客户端' }
  let timer: ReturnType<typeof setTimeout> | undefined
  const probe = window.studio?.checkBrowserReadiness().catch(() => unavailable) ?? Promise.resolve(unavailable)
  const timeout = new Promise<BrowserStatus>(resolve => { timer = setTimeout(() => resolve(unavailable), 3500) })
  try { return await Promise.race([probe, timeout]) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

export function App(): ReactNode {
  const [session, setSession] = useState<AuthSession | undefined>(storedAuthSession)
  const [verifiedToken, setVerifiedToken] = useState<string>()
  const [service, setService] = useState<ServiceReadiness>()
  const [browser, setBrowser] = useState<BrowserStatus>()
  const [refreshing, setRefreshing] = useState(false)
  const [checking, setChecking] = useState(false)
  const [authAttempt, setAuthAttempt] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const checkId = useRef(0)
  const lastCheckAt = useRef(0)

  const recheckEnvironment = useCallback(async (): Promise<void> => {
    const id = ++checkId.current
    lastCheckAt.current = Date.now()
    setRefreshing(true)
    const [nextService, nextBrowser] = await Promise.all([
      checkServiceReadiness(),
      checkBrowserWithTimeout(),
    ])
    if (id !== checkId.current) return
    setService(nextService)
    setBrowser(nextBrowser)
    setRefreshing(false)
    lastCheckAt.current = Date.now()
  }, [])

  useEffect(() => {
    void recheckEnvironment()
    const onOnline = (): void => { void recheckEnvironment() }
    const onFocus = (): void => { if (Date.now() - lastCheckAt.current > 60_000) void recheckEnvironment() }
    window.addEventListener('online', onOnline)
    window.addEventListener('focus', onFocus)
    return () => {
      checkId.current += 1
      window.removeEventListener('online', onOnline)
      window.removeEventListener('focus', onFocus)
    }
  }, [recheckEnvironment])

  useEffect(() => {
    const expired = (): void => {
      void window.studio?.setServiceToken(undefined).catch(() => undefined)
      setSession(undefined); setVerifiedToken(undefined); setError('登录已失效，请重新登录')
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, expired)
    const stopMainListener = window.studio?.onAuthExpired(token => { expireAuthSession(token) })
    return () => { window.removeEventListener(AUTH_EXPIRED_EVENT, expired); stopMainListener?.() }
  }, [])

  useEffect(() => {
    if (!session || service?.kind !== 'ready') {
      setChecking(false)
      if (service?.kind !== 'ready') setVerifiedToken(undefined)
      return
    }
    let active = true
    setChecking(true)
    setError('')
    void currentAuthUser(session.token).then(async user => {
      if (!active) return
      await window.studio?.setServiceToken(session.token)
      if (!active) return
      setSession(current => current?.token === session.token ? { ...current, user } : current)
      setVerifiedToken(session.token)
      setChecking(false)
    }).catch(reason => {
      if (!active) return
      setChecking(false)
      if (reason instanceof AuthRequestError && reason.invalidSession) {
        clearAuthSession()
        void window.studio?.setServiceToken(undefined).catch(() => undefined)
        setSession(undefined)
        setVerifiedToken(undefined)
        setError(reason.message || '登录已失效，请重新登录')
      } else {
        setVerifiedToken(undefined)
        setError(reason instanceof Error ? reason.message : '认证服务暂不可用，请稍后重试')
      }
    })
    return () => { active = false }
  }, [session?.token, service?.kind, authAttempt])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      const next = await loginWithPms(username.trim(), password)
      await window.studio?.setServiceToken(next.token)
      saveAuthSession(next)
      setPassword('')
      setVerifiedToken(next.token)
      setSession(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败')
    } finally { setSubmitting(false) }
  }
  const logout = (): void => {
    if (session) void logoutAuthSession(session.token).catch(() => undefined)
    void window.studio?.setServiceToken(undefined).catch(() => undefined)
    clearAuthSession()
    setSession(undefined)
    setVerifiedToken(undefined)
  }

  if (!service) return <main className="auth-screen"><div className="auth-card"><h1>正在检查运行环境…</h1><p>正在确认服务端与浏览器组件是否就绪。</p></div></main>
  if (service.kind !== 'ready') return <main className="auth-screen"><div className="auth-card">
    <span className="auth-eyebrow">RPA STUDIO · 环境检查</span>
    <h1>{service.kind === 'incompatible' ? '服务版本不兼容' : '暂时无法连接服务端'}</h1>
    <p role="alert">{service.message}</p>
    <div className="auth-actions"><button type="button" disabled={refreshing} onClick={() => { void recheckEnvironment() }}>{refreshing ? '正在检测…' : '重新检测'}</button>{session ? <button type="button" className="auth-secondary" onClick={logout}>退出登录</button> : null}</div>
  </div></main>
  if (session && verifiedToken !== session.token) return <main className="auth-screen"><div className="auth-card">
    <h1>{checking || !error ? '正在验证登录状态…' : '暂时无法验证登录状态'}</h1>
    {error ? <p role="alert">{error}</p> : <p>请稍候，正在确认当前账号是否可用。</p>}
    {!checking && error ? <div className="auth-actions"><button type="button" disabled={refreshing} onClick={() => { setAuthAttempt(value => value + 1); void recheckEnvironment() }}>重试</button><button type="button" className="auth-secondary" onClick={logout}>退出登录</button></div> : null}
  </div></main>
  if (session) return <div className="app-shell">
    {browser && !browser.available ? <div className="environment-banner" role="status"><span>{browser.message}。页面流程和元素拾取暂不可用，其他功能仍可使用。</span><button type="button" disabled={refreshing} onClick={() => { void recheckEnvironment() }}>{refreshing ? '检测中…' : '重新检测'}</button></div> : null}
    <SchedulerHost />
    <Studio currentUser={session.user} onLogout={logout} />
  </div>
  return <main className="auth-screen"><form className="auth-card" onSubmit={event => { void submit(event) }}>
    <span className="auth-eyebrow">RPA STUDIO · PMS 账号</span>
    <h1>登录工作台</h1>
    <p>使用扬腾 PMS 账号登录；执行、编辑和发布操作将记录到当前账号。</p>
    {browser && !browser.available ? <p className="auth-environment-note" role="status">{browser.message}。登录后仍可编辑非页面流程。<button type="button" disabled={refreshing} onClick={() => { void recheckEnvironment() }}>{refreshing ? '检测中…' : '重新检测'}</button></p> : null}
    <label>登录名<input autoFocus autoComplete="username" required value={username} onChange={event => setUsername(event.target.value)} placeholder="请输入 PMS 登录名" /></label>
    <label>密码<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} placeholder="请输入密码" /></label>
    {error ? <p className="auth-error" role="alert">{error}</p> : null}
    <button type="submit" disabled={submitting}>{submitting ? '正在验证…' : '登录'}</button>
  </form></main>
}
