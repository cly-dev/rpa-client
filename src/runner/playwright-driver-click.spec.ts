import type { Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { clickExactVisibleText, isPickedFingerprintSelector, parseReadableScopedTextSelector, shouldClickByExactVisibleText, shouldSkipExpandedTrigger, waitForPickedSelector } from './playwright-driver.ts'

describe('exact-text clicks', () => {
  it('uses a retryable visible locator instead of checking the page immediately', async () => {
    let reveal!: () => void
    const revealed = new Promise<void>(resolve => { reveal = resolve })
    const click = vi.fn(async () => undefined)
    const waitFor = vi.fn(() => revealed)
    const first = vi.fn(() => ({ click, waitFor }))
    const count = vi.fn(async () => 1)
    const visible = vi.fn(() => ({ first, count }))
    const getByText = vi.fn(() => ({ visible }))
    const page = { getByText } as unknown as Pick<Page, 'getByText'>

    const result = clickExactVisibleText(page, '登录', 2_000)
    expect(getByText).toHaveBeenCalledWith('登录', { exact: true })
    expect(visible).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledOnce()
    expect(waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 2_000 })
    reveal()
    await expect(result).resolves.toBeUndefined()
    expect(click).toHaveBeenCalledWith({ timeout: 2_000 })
  })

  it('reports a useful message only after the configured timeout is reached', async () => {
    const timeout = Object.assign(new Error('waiting for locator'), { name: 'TimeoutError' })
    const page = { getByText: () => ({ visible: () => ({ count: async () => 0, first: () => ({ waitFor: () => Promise.reject(timeout) }) }) }) } as unknown as Pick<Page, 'getByText'>
    await expect(clickExactVisibleText(page, '登录', 1_500)).rejects.toThrow('等待可见文本「登录」超时（1500 毫秒）')
  })

  it('includes safe page diagnostics without logging query parameters', async () => {
    const timeout = Object.assign(new Error('waiting for locator'), { name: 'TimeoutError' })
    const page = {
      url: () => 'https://oms.example.com/login?token=private-token',
      title: async () => '安全验证',
      frames: () => [{}, {}],
      getByText: () => ({
        count: async () => 2,
        visible: () => ({
          count: async () => 0,
          first: () => ({ waitFor: () => Promise.reject(timeout) }),
        }),
      }),
    } as unknown as Page

    const message = await clickExactVisibleText(page, '登录', 30_000).then(
      () => '',
      (error: Error) => error.message,
    )
    expect(message).toContain('当前页面：https://oms.example.com/login')
    expect(message).toContain('标题：安全验证')
    expect(message).toContain('主页面精确匹配：2 项，可见：0 项')
    expect(message).toContain('iframe：1 个')
    expect(message).not.toContain('private-token')
  })

  it('refuses to guess when a legacy exact-text selector has multiple visible matches', async () => {
    const click = vi.fn(async () => undefined)
    const page = {
      getByText: () => ({
        visible: () => ({ count: async () => 2, first: () => ({ waitFor: async () => undefined, click }) }),
      }),
    } as unknown as Pick<Page, 'getByText'>

    await expect(clickExactVisibleText(page, '确定', 3_000)).rejects.toThrow('匹配到 2 个可见元素')
    expect(click).not.toHaveBeenCalled()
  })
})

describe('expanded trigger skipping', () => {
  it('does not skip tree options just because the dropdown is already open', () => {
    expect(shouldSkipExpandedTrigger('combobox', 'true')).toBe(true)
    expect(shouldSkipExpandedTrigger('treeitem', 'true')).toBe(false)
    expect(shouldSkipExpandedTrigger(null, 'true')).toBe(false)
  })
})

describe('fingerprint click routing', () => {
  it('never treats an rpa-context payload as visible page text', () => {
    const selector = `text-exact:rpa-context:${encodeURIComponent(JSON.stringify({
      version: 1,
      tag: 'div',
      css: 'html > body > div.arco-tree > div.arco-tree-node.arco-tree-node-is-leaf:nth-of-type(13)',
      parentPath: 'html > body > div.arco-tree:nth-of-type(1)',
      text: '买错',
      role: 'treeitem',
    }))}`
    expect(isPickedFingerprintSelector(selector)).toBe(true)
    expect(shouldClickByExactVisibleText(selector)).toBe(false)
    expect(shouldClickByExactVisibleText('text-exact:买错')).toBe(true)
  })

  it('routes a copied readable parent-scoped selector through the structured locator', () => {
    const selector = 'text-exact:物流太慢 · 父级:#drawer > div.arco-tree > div:nth-of-type(15)'
    expect(parseReadableScopedTextSelector(selector)).toEqual({ text: '物流太慢', parentPath: '#drawer > div.arco-tree > div:nth-of-type(15)' })
    expect(isPickedFingerprintSelector(selector)).toBe(true)
    expect(shouldClickByExactVisibleText(selector)).toBe(false)
  })

  it('parses the optional copied same-text occurrence', () => {
    expect(parseReadableScopedTextSelector('text-exact:物流太慢 · 第2个同名 · 父级:#drawer')).toEqual({
      text: '物流太慢',
      textIndex: 1,
      parentPath: '#drawer',
    })
  })
})

describe('picked selector waits', () => {
  it('translates exact-text picker selectors before waiting for visibility', async () => {
    const waitFor = vi.fn(async () => undefined)
    const first = vi.fn(() => ({ waitFor }))
    const visible = vi.fn(() => ({ first }))
    const getByText = vi.fn(() => ({ visible }))
    const locator = vi.fn()
    const page = { getByText, locator } as unknown as Pick<Page, 'getByText' | 'locator'>

    await waitForPickedSelector(page, 'text-exact:确定', 'visible', 12_000)

    expect(getByText).toHaveBeenCalledWith('确定', { exact: true })
    expect(visible).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledOnce()
    expect(waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 12_000 })
    expect(locator).not.toHaveBeenCalled()
  })

  it('does not wait for the encoded fingerprint blob as visible text', async () => {
    const selector = `text-exact:rpa-context:${encodeURIComponent(JSON.stringify({ version: 1, tag: 'div', css: '.arco-tree-node', text: '买错' }))}`
    const page = { getByText: vi.fn(), locator: vi.fn() } as unknown as Pick<Page, 'getByText' | 'locator'>
    await expect(waitForPickedSelector(page, selector, 'visible', 12_000)).rejects.toThrow('拾取指纹无法按可见文本等待')
    expect(page.getByText).not.toHaveBeenCalled()
  })

  it('waits for copied exact text inside its copied parent DOM scope', async () => {
    const waitFor = vi.fn(async () => undefined)
    const first = vi.fn(() => ({ waitFor }))
    const getByText = vi.fn(() => ({ first }))
    const scoped = { getByText }
    const locator = vi.fn(() => scoped)
    const page = { getByText: vi.fn(), locator } as unknown as Pick<Page, 'getByText' | 'locator'>

    await waitForPickedSelector(page, 'text-exact:物流太慢 · 父级:#drawer > div.tree', 'visible', 5_000)

    expect(locator).toHaveBeenCalledWith('#drawer > div.tree')
    expect(getByText).toHaveBeenCalledWith('物流太慢', { exact: true })
    expect(waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 5_000 })
  })

  it('keeps ordinary CSS selectors unchanged', async () => {
    const waitFor = vi.fn(async () => undefined)
    const first = vi.fn(() => ({ waitFor }))
    const locator = vi.fn(() => ({ first }))
    const page = { getByText: vi.fn(), locator } as unknown as Pick<Page, 'getByText' | 'locator'>

    await waitForPickedSelector(page, '#confirm', 'hidden', 0)

    expect(locator).toHaveBeenCalledWith('#confirm')
    expect(waitFor).toHaveBeenCalledWith({ state: 'hidden', timeout: 1 })
  })
})
