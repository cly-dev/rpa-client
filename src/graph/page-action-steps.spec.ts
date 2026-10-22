import { describe, expect, it } from 'vitest'
import type { PageActionStep } from './types.ts'
import { reorderPageActionStep } from './page-action-steps.ts'

describe('reorderPageActionStep', () => {
  const steps: readonly PageActionStep[] = [
    { type: 'click', selector: '#first', waitAfterMs: 100 },
    { type: 'type', selector: '#second', value: { kind: 'literal', value: 'hello' }, waitAfterMs: 200 },
    { type: 'wait', ms: 300 },
  ]

  it('moves a step with its complete configuration', () => {
    expect(reorderPageActionStep(steps, 1, 0)).toEqual([
      steps[1],
      steps[0],
      steps[2],
    ])
  })

  it('ignores moves outside the list', () => {
    expect(reorderPageActionStep(steps, 0, -1)).toBe(steps)
    expect(reorderPageActionStep(steps, 2, 3)).toBe(steps)
  })
})
