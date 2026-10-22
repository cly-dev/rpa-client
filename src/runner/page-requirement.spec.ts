import { describe, expect, it } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { usablePageUrl, workflowNeedsBrowser, workflowNeedsExistingPage } from './page-requirement.ts'

function line(type: 'click' | 'open-page' | 'api-request' | 'page-action' | 'wait', url = ''): WorkflowGraph {
  const start = createNode('start', { x: 0, y: 0 })
  const action = createNode(type, { x: 100, y: 0 })
  const end = createNode('end', { x: 200, y: 0 })
  const configured = type === 'open-page' ? { ...action, config: { type, url } }
    : type === 'page-action' ? { ...action, config: { type, steps: [{ type: 'open' as const, url }] } }
      : action
  return {
    workflowId: `wf-${type}`, name: type, version: 1, entryNodeId: start.id,
    nodes: [{ ...start, config: { type: 'start', url: '' } }, configured, end],
    edges: [createEdge(start.id, 'default', action.id), createEdge(action.id, 'default', end.id)],
  }
}

describe('browser page requirements', () => {
  it('requires an existing page for a browser action without navigation', () => {
    expect(workflowNeedsExistingPage([line('click')])).toBe(true)
    expect(usablePageUrl('about:blank')).toBe(false)
    expect(usablePageUrl('https://example.com')).toBe(true)
  })

  it('allows a new browser when an action explicitly opens a URL', () => {
    expect(workflowNeedsExistingPage([line('open-page', 'https://example.com')])).toBe(false)
    expect(workflowNeedsExistingPage([line('page-action', 'https://example.com')])).toBe(false)
  })

  it('does not require a browser for an HTTP-only workflow', () => {
    expect(workflowNeedsBrowser([line('api-request')])).toBe(false)
    expect(workflowNeedsExistingPage([line('api-request')])).toBe(false)
    expect(workflowNeedsBrowser([line('wait')])).toBe(false)
    const emptyAction = line('page-action')
    expect(workflowNeedsBrowser([{ ...emptyAction, nodes: emptyAction.nodes.map(node => node.config.type === 'page-action' ? { ...node, config: { type: 'page-action', steps: [] } } : node) }])).toBe(false)
  })
})
