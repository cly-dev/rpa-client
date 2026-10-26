import type { BrowserDriver } from '@runner/browser-run.ts'

interface BrowserSession { readonly driver: BrowserDriver }

const PAGE_METHODS = new Set([
  'openPage', 'hover', 'click', 'selectOption', 'type', 'extract',
  'extractList', 'extractListAuto', 'extractListAi', 'waitForResponse',
  'waitForUrl', 'elementState', 'waitForPageSettled',
])

/** Start Chromium only when an executed step actually needs a page. */
export function createLazyBrowserDriver<T extends BrowserSession>(
  fallback: BrowserDriver,
  openSession: () => Promise<T>,
  initialSession?: T,
): { driver: BrowserDriver; getSession: () => T | undefined } {
  let session = initialSession
  let opening: Promise<T> | undefined
  let stopSessionListener: (() => void) | undefined
  const urlListeners = new Set<(url: string) => void>()

  const attachListener = (): void => {
    stopSessionListener?.()
    stopSessionListener = session?.driver.onUrlChange?.(url => {
      for (const listener of urlListeners) listener(url)
    })
  }
  if (session !== undefined) attachListener()

  const pageDriver = async (): Promise<BrowserDriver> => {
    if (session !== undefined) return session.driver
    opening ??= openSession().then(opened => {
      session = opened
      attachListener()
      return opened
    }).finally(() => { opening = undefined })
    return (await opening).driver
  }

  const driver = new Proxy(fallback, {
    get(target, property) {
      if (property === 'currentUrl') return () => session?.driver.currentUrl?.() ?? ''
      if (property === 'currentTitle') return session?.driver.currentTitle === undefined ? undefined : () => session!.driver.currentTitle!()
      if (property === 'onUrlChange') return (listener: (url: string) => void) => {
        urlListeners.add(listener)
        if (session !== undefined && stopSessionListener === undefined) attachListener()
        return () => {
          urlListeners.delete(listener)
          if (urlListeners.size === 0) {
            stopSessionListener?.()
            stopSessionListener = undefined
          }
        }
      }
      if (property === 'requestApi') return (...args: unknown[]) => {
        const source = session?.driver ?? target
        const method = source.requestApi
        if (method === undefined) throw new Error('当前驱动不支持接口请求')
        return Reflect.apply(method, source, args)
      }
      if (property === 'waitFor') return (ms: number, selector?: string, state?: 'visible' | 'hidden') => {
        if (session === undefined && !selector?.trim()) return new Promise<void>(resolve => { setTimeout(resolve, Math.max(0, ms)) })
        return pageDriver().then(source => source.waitFor(ms, selector ?? '', state))
      }
      if (typeof property === 'string' && PAGE_METHODS.has(property)) return (...args: unknown[]) => pageDriver().then(source => {
        const method = Reflect.get(source, property) as unknown
        if (typeof method !== 'function') throw new Error(`当前浏览器驱动不支持 ${property}`)
        return Reflect.apply(method, source, args)
      })
      return Reflect.get(target, property)
    },
  }) as BrowserDriver

  return { driver, getSession: () => session }
}
