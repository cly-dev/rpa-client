import { expect, it, vi } from 'vitest'
import { createNode, createEdge } from '../graph/mutate.ts'
import type { PageActionStep, WorkflowGraph } from '../graph/types.ts'
import { runBrowser, type BrowserDriver } from './browser-run.ts'
function graph(steps: PageActionStep[]): WorkflowGraph {
  const start = { ...createNode('start', { x: 0, y: 0 }), config: { type: 'start' as const, url: 'https://example.test' } }
  const action = { ...createNode('page-action', { x: 100, y: 0 }), id: 'action', config: { type: 'page-action' as const, steps }, execution: { timeoutMs: 20, maxAttempts: 1, onError: 'human-handoff' as const } }
  const end = createNode('end', { x: 200, y: 0 })
  return { workflowId: 'timeout', name: 'timeout', version: 1, entryNodeId: start.id, nodes: [start, action, end], edges: [createEdge(start.id, 'default', 'action'), createEdge('action', 'default', end.id)] }
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const base: BrowserDriver = { async openPage() {}, async click() {}, async type() {}, async extract() { return '' }, async waitFor(ms) { await sleep(ms) } }
const handlers = { onUpdate() {}, wait: async () => {} }
it('retains the specific locator failure rather than racing the same outer timeout', async () => {
  vi.useFakeTimers()
  try {
    const pending = runBrowser(graph([{ type: 'click', selector: '#missing' }]), { ...base, async click() { await Promise.resolve(); await sleep(20); throw new Error('尾部选择器没有匹配到买错') } }, handlers)
    await vi.runAllTimersAsync()
    const state = await pending
    expect(state.status).toBe('failed')
    expect(state.logs.map(l => l.message).join('\n')).toContain('尾部选择器没有匹配到买错')
  } finally { vi.useRealTimers() }
})
it('budgets enabled waits and the explicit post-click delay separately', async () => {
  vi.useFakeTimers()
  try {
    const calls: string[] = []
    const pending = runBrowser(graph([{ type: 'click', selector: '#trigger', waitUntilEnabled: true, waitForLoading: true, waitAfterMs: 30 }]), { ...base,
      async waitUntilEnabled() { calls.push('enabled'); await sleep(15) }, async click() { calls.push('click'); await sleep(15) }, async waitForLoading() { calls.push('loading'); await sleep(15); return true },
    }, handlers)
    await vi.runAllTimersAsync()
    expect((await pending).status).toBe('succeeded')
    expect(calls).toEqual(['enabled', 'click', 'loading'])
  } finally { vi.useRealTimers() }
})
it('reports an unfinished click selector before attempting browser interaction', async () => {
  const click = vi.fn()
  const state = await runBrowser(graph([{ type: 'click', selector: '' }]), { ...base, click }, handlers)
  expect(click).not.toHaveBeenCalled()
  expect(state.logs.map(l => l.message).join('\n')).toContain('点击目标选择器')
})
