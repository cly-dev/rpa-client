import type { Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { clickExactVisibleText } from './playwright-driver.ts'

describe('exact-text clicks', () => {
  it('uses a retryable visible locator instead of checking the page immediately', async () => {
    let reveal!: () => void
    const clicked = new Promise<void>(resolve => { reveal = resolve })
    const click = vi.fn(() => clicked)
    const last = vi.fn(() => ({ click }))
    const visible = vi.fn(() => ({ last }))
    const getByText = vi.fn(() => ({ visible }))
    const page = { getByText } as unknown as Pick<Page, 'getByText'>

    const result = clickExactVisibleText(page, '登录', 2_000)
    expect(getByText).toHaveBeenCalledWith('登录', { exact: true })
    expect(visible).toHaveBeenCalledOnce()
    expect(last).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledWith({ timeout: 2_000 })
    reveal()
    await expect(result).resolves.toBeUndefined()
  })

  it('reports a useful message only after the configured timeout is reached', async () => {
    const timeout = Object.assign(new Error('waiting for locator'), { name: 'TimeoutError' })
    const page = { getByText: () => ({ visible: () => ({ last: () => ({ click: () => Promise.reject(timeout) }) }) }) } as unknown as Pick<Page, 'getByText'>
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
          last: () => ({ click: () => Promise.reject(timeout) }),
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
})
