import { describe, expect, it, vi } from 'vitest'
import type { RunLogLine } from '@runner/dry-run.ts'
import { ExecutionLogUploader } from './execution-log-uploader.ts'

const log = (message: string, at: number): RunLogLine => ({ at, nodeId: 'node-1', nodeName: '节点', message })

describe('scheduled execution log uploader', () => {
  it('uploads only new lines from cumulative snapshots with stable sequence numbers', async () => {
    const upload = vi.fn().mockResolvedValue(undefined)
    const uploader = new ExecutionLogUploader(upload, ['secret-value'])
    const first = [log('开始 secret-value', 1)]
    uploader.add(first)
    uploader.add(first)
    await uploader.close([...first, log('完成', 2)])

    expect(upload).toHaveBeenCalledOnce()
    expect(upload.mock.calls[0]?.[0]).toMatchObject([
      { sequence: 1, message: '开始 ••••••' },
      { sequence: 2, message: '完成' },
    ])
  })

  it('flushes after twenty lines without waiting for the workflow to finish', async () => {
    const upload = vi.fn().mockResolvedValue(undefined)
    const uploader = new ExecutionLogUploader(upload)
    uploader.add(Array.from({ length: 20 }, (_, index) => log(`步骤 ${index + 1}`, index)))
    await uploader.flush()
    expect(upload).toHaveBeenCalledOnce()
    expect(upload.mock.calls[0]?.[0]).toHaveLength(20)
    expect(await uploader.close()).toBe('')
  })

  it('uploads a short running log after one second', async () => {
    vi.useFakeTimers()
    try {
      const upload = vi.fn().mockResolvedValue(undefined)
      const uploader = new ExecutionLogUploader(upload)
      uploader.add([log('运行中', 1)])
      expect(upload).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(upload).toHaveBeenCalledOnce()
      await uploader.close()
    } finally { vi.useRealTimers() }
  })
})
