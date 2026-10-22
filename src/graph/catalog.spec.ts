import { describe, expect, it } from 'vitest'

import { PALETTE_TYPES } from './catalog'

describe('node palette', () => {
  it('shows the standalone wait node', () => {
    expect(PALETTE_TYPES).toContain('wait')
  })
})
