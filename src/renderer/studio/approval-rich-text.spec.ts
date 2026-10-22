import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApprovalRichText, safeApprovalLink } from './ApprovalRichText.tsx'

describe('approval rich text', () => {
  it('only allows HTTP links', () => {
    expect(safeApprovalLink('https://example.com/order/1')).toBe('https://example.com/order/1')
    expect(safeApprovalLink('javascript:alert(1)')).toBeUndefined()
    expect(safeApprovalLink('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(safeApprovalLink('//example.com')).toBeUndefined()
  })

  it('keeps plain text escaped when no DOM is available', () => {
    const html = renderToStaticMarkup(createElement(ApprovalRichText, { value: '订单 <script>alert(1)</script>\n请审批' }))
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })
})
