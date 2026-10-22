import { useEffect, useRef, type ReactNode } from 'react'
import type { JsonValue } from '@graph/types.ts'
import { failedRunReason, readableRunError } from './execution-message.ts'
import { safeEventMessage } from './execution-log.ts'
import { ExecutionLogUploader } from './execution-log-uploader.ts'
import {
  RPA_SERVICE_URL, appendExecutionEvents, claimSchedule, completeScheduleOccurrence,
  createExecution, finishExecution, getWorkflowRevision, linkScheduleExecution, listSchedules, loadSubflowBundle,
} from '../workflow-api.ts'

/** The clock lives in Electron's main process; this host only handles due events and execution I/O. */
export function SchedulerHost(): ReactNode {
  const inProgress = useRef(new Set<string>())
  const activeRunIds = useRef(new Set<string>())

  useEffect(() => {
    const studio = window.studio
    if (!studio) return
    let active = true
    const sync = async (): Promise<void> => {
      try {
        const device = await studio.getDeviceInfo()
        const result = await listSchedules(RPA_SERVICE_URL, device.deviceId)
        if (active) await studio.syncSchedules(result.items)
      } catch (error) {
        if (active) console.error('同步定时配置失败', error)
      }
    }
    void sync()
    const interval = window.setInterval(() => { void sync() }, 60_000)
    const changed = (): void => { void sync() }
    window.addEventListener('rpa:schedules-changed', changed)
    const stop = studio.onScheduleDue(({ id, scheduledAt }) => {
      const key = `${id}@${scheduledAt}`
      if (inProgress.current.has(key)) return
      inProgress.current.add(key)
      void (async () => {
        let occurrenceId: string | undefined
        let executionId: string | undefined
        let executionFinished = false
        let occurrenceFinished = false
        let occurrenceStatus: 'succeeded' | 'failed' = 'failed'
        let occurrenceError: string | undefined
        let runCompleted = false
        let finishPayload: { status: 'succeeded' | 'failed'; outputs?: Readonly<Record<string, JsonValue>>; error?: string } = { status: 'failed' }
        try {
          const device = await studio.getDeviceInfo()
          const claimed = await claimSchedule(RPA_SERVICE_URL, id, device.deviceId, scheduledAt)
          await studio.acknowledgeScheduleDue(id, scheduledAt).catch(() => undefined)
          if (!claimed.claimed || !claimed.occurrenceId || !claimed.workflowId || !claimed.workflowVersion) return
          occurrenceId = claimed.occurrenceId
          const revision = await getWorkflowRevision(RPA_SERVICE_URL, claimed.workflowId, claimed.workflowVersion)
          if (revision.stage !== 'published') throw new Error('定时配置引用的流程版本未发布')
          const graph = revision.graph
          const subflows = await loadSubflowBundle(RPA_SERVICE_URL, graph)
          const inputs = (claimed.inputs ?? {}) as Readonly<Record<string, JsonValue>>
          const record = await createExecution(RPA_SERVICE_URL, {
            workflowId: claimed.workflowId, workflowVersion: claimed.workflowVersion,
            deviceId: device.deviceId, deviceName: device.deviceName, clientVersion: device.clientVersion, inputs,
          })
          executionId = record.id
          await linkScheduleExecution(RPA_SERVICE_URL, id, occurrenceId, executionId)
          window.dispatchEvent(new Event('rpa:schedule-updated'))
          const runId = crypto.randomUUID()
          const uploader = new ExecutionLogUploader(events => appendExecutionEvents(RPA_SERVICE_URL, record.id, events))
          const stopUpdates = studio.onRunUpdate(({ runId: updateRunId, state }) => {
            if (updateRunId === runId) uploader.add(state.logs)
          })
          activeRunIds.current.add(runId)
          let result
          try {
            result = await studio.runWorkflow(graph, { runId, executionId, inputs, subflows, headless: true })
          } catch (error) {
            const message = safeEventMessage(readableRunError(error))
            await uploader.close()
            finishPayload = { status: 'failed', error: message }
            await finishExecution(RPA_SERVICE_URL, executionId, finishPayload)
            executionFinished = true
            occurrenceError = message
            throw error
          } finally {
            stopUpdates()
            activeRunIds.current.delete(runId)
          }
          const logSyncError = await uploader.close(result.logs)
          const succeeded = result.status === 'succeeded'
          runCompleted = true
          occurrenceStatus = succeeded ? 'succeeded' : 'failed'
          occurrenceError = succeeded ? (logSyncError || undefined) : safeEventMessage(failedRunReason(result))
          finishPayload = {
            status: succeeded ? 'succeeded' : 'failed',
            outputs: (result.variables ?? {}) as Readonly<Record<string, JsonValue>>,
            error: succeeded ? undefined : occurrenceError,
          }
          await finishExecution(RPA_SERVICE_URL, executionId, finishPayload)
          executionFinished = true
          await completeScheduleOccurrence(RPA_SERVICE_URL, id, occurrenceId, {
            status: occurrenceStatus, executionId, error: occurrenceError,
          })
          occurrenceFinished = true
        } catch (error) {
          const message = safeEventMessage(readableRunError(error))
          console.error(`定时任务 ${id} 执行失败`, message)
          if (executionId && !executionFinished) await finishExecution(RPA_SERVICE_URL, executionId, {
            ...finishPayload, error: finishPayload.error ?? (runCompleted ? undefined : message),
          }).catch(() => undefined)
          if (occurrenceId && !occurrenceFinished) await completeScheduleOccurrence(RPA_SERVICE_URL, id, occurrenceId, {
            status: runCompleted ? occurrenceStatus : 'failed', executionId, error: occurrenceError ?? (runCompleted ? undefined : message),
          }).catch(() => undefined)
        } finally {
          inProgress.current.delete(key)
          window.dispatchEvent(new Event('rpa:schedule-updated'))
          if (active) void sync()
        }
      })()
    })
    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('rpa:schedules-changed', changed)
      stop()
      for (const runId of activeRunIds.current) void studio.cancelWorkflow(runId).catch(() => undefined)
      void studio.clearSchedules()
    }
  }, [])
  return null
}
