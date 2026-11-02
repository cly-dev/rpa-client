import { describe, expect, it } from 'vitest'
import { emptyNumberFallback } from './ClearableNumberInput.tsx'

describe('empty numeric field fallback', () => {
  it('uses 1 when the field is cleared', () => {
    expect(emptyNumberFallback(undefined)).toBe(1)
    expect(emptyNumberFallback(0)).toBe(1)
    expect(emptyNumberFallback(1)).toBe(1)
  })

  it('respects a stricter minimum value', () => {
    expect(emptyNumberFallback(50)).toBe(50)
    expect(emptyNumberFallback(100)).toBe(100)
  })
})
