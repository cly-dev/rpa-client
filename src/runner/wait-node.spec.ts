import { describe, expect, it, vi } from 'vitest'
import { createDefaultTemplate, createEdge, createNode } from '@graph/index.ts'
import type { BrowserDriver } from './browser-run.ts'
import { runBrowser } from './browser-run.ts'

function driver(waitFor: BrowserDriver['waitFor']): BrowserDriver {
  return {
    openPage: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    extract: vi.fn(async () => ''),
    waitFor,
    currentUrl: () => 'https://example.com/current',
  }
}

function waitGraph(mode: 'visible' | 'hidden') {
  const base = createDefaultTemplate()
  const start = base.nodes.find(node => node.type === 'start')!
  const end = base.nodes.find(node => node.type === 'end')!
  const wait = createNode('wait', { x: 250, y: 0 })
  return {
    ...base,
    nodes: [start, { ...wait, config: { type: 'wait' as const, mode, ms: 12_000, selector: '#ready' } }, end],
    edges: [createEdge(start.id, 'default', wait.id), createEdge(wait.id, 'default', end.id)],
  }
}

describe('wait condition node', () => {
  it('waits until an element becomes visible', async () => {
    const waitFor = vi.fn(async () => undefined)
    const state = await runBrowser(waitGraph('visible'), driver(waitFor), { onUpdate() {}, wait: async () => {} }, { allowExistingPage: true })
    expect(state.status).toBe('succeeded')
    expect(waitFor).toHaveBeenCalledWith(12_000, '#ready', 'visible')
  })

  it('waits until an element becomes hidden or detached', async () => {
    const waitFor = vi.fn(async () => undefined)
    const state = await runBrowser(waitGraph('hidden'), driver(waitFor), { onUpdate() {}, wait: async () => {} }, { allowExistingPage: true })
    expect(state.status).toBe('succeeded')
    expect(waitFor).toHaveBeenCalledWith(12_000, '#ready', 'hidden')
  })
})
