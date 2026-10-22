import { describe, expect, it } from 'vitest'
import { runWorkflowCode } from './code-runtime.ts'

describe('workflow code runtime', () => {
  it('exposes named inputs and workflow variables and returns JSON', () => {
    expect(runWorkflowCode('return { stamp: input.date + variables.offset, ok: true };', { date: '2026-09-30' }, { offset: 'T00:00:00Z' })).toEqual({ stamp: '2026-09-30T00:00:00Z', ok: true })
  })

  it('stops code that exceeds the synchronous execution limit', () => {
    expect(() => runWorkflowCode('while (true) {}', {}, {}, 30)).toThrow(/timed out/i)
  })

  it('rejects non-JSON outputs', () => {
    expect(() => runWorkflowCode('return undefined;', {}, {})).toThrow(/JSON/)
  })
})
