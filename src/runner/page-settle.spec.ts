import { describe, expect, it } from 'vitest'
import { pageIsSettled } from './playwright-driver.ts'

describe('picker page settle detection', () => {
  it('waits while a relevant network request is still active', () => {
    expect(pageIsSettled({ now: 2_000, activeRequests: 1, lastNetworkActivityAt: 1_000, domStableSince: 1_000 })).toBe(false)
  })

  it('waits until both network and DOM have stayed quiet long enough', () => {
    expect(pageIsSettled({ now: 2_000, activeRequests: 0, lastNetworkActivityAt: 1_700, domStableSince: 1_000 })).toBe(false)
    expect(pageIsSettled({ now: 2_000, activeRequests: 0, lastNetworkActivityAt: 1_000, domStableSince: 1_700 })).toBe(false)
    expect(pageIsSettled({ now: 2_000, activeRequests: 0, lastNetworkActivityAt: 1_500, domStableSince: 1_500 }, 500)).toBe(true)
  })
})
