import { describe, expect, it } from 'vitest'
import { createNode } from '@graph/mutate.ts'
import { hasLoopCondition, loopIterationTotal } from './loop.ts'

function loopConfig() {
  const node = createNode('for-each', { x: 0, y: 0 })
  if (node.config.type !== 'for-each') throw new Error('expected for-each config')
  return node.config
}

describe('loop iteration rules', () => {
  it('uses the full collection length when no condition is configured', () => {
    const config = { ...loopConfig(), condition: '', conditionClauses: [], maxItems: 1 }

    expect(hasLoopCondition(config)).toBe(false)
    expect(loopIterationTotal(config, 3)).toBe(3)
  })

  it('keeps the maximum item limit when a structured or legacy condition exists', () => {
    const structured = { ...loopConfig(), conditionClauses: [{ binding: { kind: 'variable' as const, name: 'item' }, operator: 'isNotEmpty' as const }], maxItems: 1 }
    const legacy = { ...loopConfig(), condition: '{{index}} < 10', conditionClauses: [], maxItems: 2 }

    expect(hasLoopCondition(structured)).toBe(true)
    expect(loopIterationTotal(structured, 3)).toBe(1)
    expect(hasLoopCondition(legacy)).toBe(true)
    expect(loopIterationTotal(legacy, 3)).toBe(2)
  })
})
