import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BrowserModePicker } from './BrowserModePicker.tsx'

describe('BrowserModePicker', () => {
  it('marks the selected browser mode', () => {
    const html = renderToStaticMarkup(createElement(BrowserModePicker, { headless: true, name: 'run-browser', onChange: vi.fn() }))
    expect(html).toContain('无头运行')
    expect(html).toContain('显示浏览器')
    expect(html).toContain('is-selected')
  })
})
