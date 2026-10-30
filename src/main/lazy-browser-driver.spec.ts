import { describe, expect, it, vi } from 'vitest'
import type { BrowserDriver } from '@runner/browser-run.ts'
import { createLazyBrowserDriver } from './lazy-browser-driver.ts'

function fakeDriver(calls: string[], onUrlChange?: (listener: (url: string) => void) => () => void): BrowserDriver {
  return {
    async openPage(url) { calls.push(`open:${url}`) },
    async click(selector) { calls.push(`click:${selector}`) },
    async type() {},
    async extract() { return '' },
    async waitFor() {},
    currentUrl() { return calls.some(call => call.startsWith('open:')) ? 'https://example.com' : '' },
    onUrlChange,
  }
}

describe('lazy browser driver', () => {
  it('does not launch a browser for an empty start or a time-only wait', async () => {
    const openSession = vi.fn(async () => ({ driver: fakeDriver([]) }))
    const { driver, getSession } = createLazyBrowserDriver(fakeDriver([]), openSession)
    expect(driver.currentUrl?.()).toBe('')
    await driver.waitFor(1, '')
    expect(getSession()).toBeUndefined()
    expect(openSession).not.toHaveBeenCalled()
  })

  it('launches once at the first actual page action and forwards URL changes', async () => {
    const calls: string[] = []
    let notifyUrl: ((url: string) => void) | undefined
    const page = fakeDriver(calls, listener => { notifyUrl = listener; return () => { notifyUrl = undefined } })
    const openSession = vi.fn(async () => ({ driver: page }))
    const { driver } = createLazyBrowserDriver(fakeDriver([]), openSession)
    const onUrl = vi.fn()
    const stop = driver.onUrlChange?.(onUrl)
    expect(openSession).not.toHaveBeenCalled()

    await driver.openPage('https://example.com')
    await driver.click('button')
    expect(openSession).toHaveBeenCalledOnce()
    expect(calls).toEqual(['open:https://example.com', 'click:button'])
    notifyUrl?.('https://example.com/next')
    expect(onUrl).toHaveBeenCalledWith('https://example.com/next')
    stop?.()
  })

  it('launches Chromium and forwards list row operations', async () => {
    const operateListRows = vi.fn(async () => ({
      totalPageRows: 1, targetDataCount: 1, matchedCount: 1, updatedCount: 1,
      deletedCount: 0, finalPageRows: 1, missingItems: [], duplicateItems: [], deletedKeys: [],
    }))
    const page: BrowserDriver = { ...fakeDriver([]), operateListRows }
    const openSession = vi.fn(async () => ({ driver: page }))
    const { driver } = createLazyBrowserDriver(fakeDriver([]), openSession)

    const result = await driver.operateListRows!({
      containerSelector: '#items', rowSelectorMode: 'class-contains', rowSelector: 'Item__row',
      matchFields: [{ selector: '[class*="Item__sku"]', matchMode: 'exact', readMode: 'text', trim: true, ignoreCase: false }],
      items: [{ index: 0, matchValues: ['SKU-1'], actionValues: [] }], actions: [],
      unmatchedMode: 'keep', deleteSelector: '', confirmSelector: '', waitAfterDeleteMs: 0, maxDeleteCount: 1,
      missingMatchAction: 'stop', duplicateMatchAction: 'all', emptySourceAction: 'stop', timeoutMs: 5_000,
    })

    expect(openSession).toHaveBeenCalledOnce()
    expect(operateListRows).toHaveBeenCalledOnce()
    expect(result.matchedCount).toBe(1)
  })
})
