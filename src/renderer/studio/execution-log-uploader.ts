import type { RunLogLine } from '@runner/dry-run.ts'
import type { ExecutionEvent } from '../workflow-api.ts'
import { safeEventMessage } from './execution-log.ts'

/** Incrementally persists one run's cumulative log snapshots. */
export class ExecutionLogUploader {
  private seen = 0
  private sequence = 0
  private pending: ExecutionEvent[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private chain = Promise.resolve()
  private failure = ''

  constructor(private readonly upload: (events: readonly ExecutionEvent[]) => Promise<unknown>, private readonly secrets: readonly string[] = []) {}

  get error(): string { return this.failure }

  add(logs: readonly RunLogLine[]): void {
    if (logs.length <= this.seen) return
    for (const log of logs.slice(this.seen)) {
      this.pending.push({
        sequence: ++this.sequence, nodeId: log.nodeId, nodeName: log.nodeName.slice(0, 200),
        message: safeEventMessage(log.message, this.secrets), at: log.at,
        notificationEvent: log.notificationEvent, notificationValues: log.notificationValues,
      })
    }
    this.seen = logs.length
    if (this.pending.length >= 20) void this.flush()
    else if (this.timer === undefined) this.timer = setTimeout(() => { void this.flush() }, 1000)
  }

  flush(): Promise<void> {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    const batch = this.pending.splice(0, 250)
    if (batch.length === 0) return this.chain
    this.chain = this.chain.then(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { await this.upload(batch); return }
        catch (error) {
          if (attempt === 2) { this.failure = error instanceof Error ? error.message : '日志同步失败'; return }
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
        }
      }
    })
    if (this.pending.length > 0) void this.flush()
    return this.chain
  }

  async close(logs?: readonly RunLogLine[]): Promise<string> {
    if (logs) this.add(logs)
    await this.flush()
    return this.failure
  }
}
