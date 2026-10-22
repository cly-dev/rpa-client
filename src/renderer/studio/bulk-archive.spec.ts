import { expect, it, vi } from 'vitest'
import { bulkArchiveWorkflows } from './bulk-archive.ts'

it('archives unique workflows and reports partial failures without stopping', async () => {
  const archive = vi.fn(async (id: string) => {
    if (id === 'wf-b') throw new Error('服务暂不可用')
  })
  const result = await bulkArchiveWorkflows(['wf-a', 'wf-b', 'wf-a', 'wf-c'], archive)
  expect(archive.mock.calls.map(([id]) => id)).toEqual(['wf-a', 'wf-b', 'wf-c'])
  expect(result).toEqual({ archivedIds: ['wf-a', 'wf-c'], failures: [{ id: 'wf-b', message: '服务暂不可用' }] })
})
