import type { PageActionStep } from './types.ts'

export function reorderPageActionStep(steps: readonly PageActionStep[], from: number, to: number): readonly PageActionStep[] {
  if (from < 0 || from >= steps.length || to < 0 || to >= steps.length || from === to) return steps
  const next = [...steps]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
