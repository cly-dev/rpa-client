import { expect, it } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import type { WorkflowGraph } from '@graph/types.ts'
import { runBrowser, type BrowserDriver } from './browser-run.ts'
import { FileDownloadError } from './file-download.ts'

function graphForAction(): WorkflowGraph {
  const start = createNode('start', { x: 0, y: 0 })
  const action = createNode('page-action', { x: 200, y: 0 })
  return { workflowId: 'upload-recovery', version: 1, name: 'upload recovery', entryNodeId: start.id,
    nodes: [start, { ...action, execution: { ...action.execution, maxAttempts: 3 }, config: { type: 'page-action', steps: [
      { type: 'click', selector: '#prepare' },
      { type: 'upload', selector: 'input[type=file]', file: { kind: 'literal', value: 'https://example.com/image.jpg' } },
    ] } }], edges: [createEdge(start.id, 'default', action.id)],
  }
}

it('preserves the download failure marker through page-step error wrapping and avoids replaying clicks', async () => {
  let clicks = 0
  let uploads = 0
  const driver: BrowserDriver = {
    async openPage() {}, async click() { clicks++ }, async type() {}, async extract() { return '' }, async waitFor() {},
    async uploadFileFromUrl() { uploads++; throw new FileDownloadError('图片下载失败') },
  }
  const state = await runBrowser(graphForAction(), driver, { onUpdate() {}, wait: async () => {} })
  expect(clicks).toBe(1)
  expect(uploads).toBe(1)
  expect(state.status).not.toBe('succeeded')
})

it('does not retain raw Playwright authentication headers in recorded failure logs', async () => {
  const driver: BrowserDriver = {
    async openPage() {}, async click() { throw new Error('TLS failure\nCall log:\n  - cookie: secret-session=private-cookie\n  - authorization: Bearer private-bearer') },
    async type() {}, async extract() { return '' }, async waitFor() {},
  }
  const state = await runBrowser(graphForAction(), driver, { onUpdate() {}, wait: async () => {} })
  expect(JSON.stringify(state)).not.toMatch(/private-cookie|private-bearer/)
  expect(JSON.stringify(state)).toContain('TLS failure')
})
