import { useEffect, useRef, type ReactNode } from 'react'
import type { JsonValue } from '@graph/types.ts'
import { failedRunReason, readableRunError } from './execution-message.ts'
import { redactExecutionJson, safeEventMessage } from './execution-log.ts'
import { ExecutionLogUploader } from './execution-log-uploader.ts'
import { hydrateScheduledSecrets, scheduledSecretStrings } from './scheduled-secrets.ts'
import { isScheduledExecutionActive, registerScheduledExecution, unregisterScheduledExecution } from './scheduled-executions.ts'
import {
  RPA_SERVICE_URL, appendExecutionEvents, claimSchedule, completeScheduleOccurrence,
  createApproval, createExecution, finishExecution, getWorkflowRevision, linkScheduleExecution, listSchedules, loadSubflowBundle,
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
    const stopApprovals = studio.onApprovalRequest(prompt => {
      if (!isScheduledExecutionActive(prompt.executionId)) return
      void (async () => {
        try {
          const device = await studio.getDeviceInfo()
          await createApproval(RPA_SERVICE_URL, prompt, device)
          window.dispatchEvent(new Event('rpa:schedule-approval-requested'))
        } catch (error) {
          const message = error instanceof Error ? error.message : '创建审批单失败'
          await studio.respondApproval(prompt.id, 'rejected', `审批服务不可用：${message}`).catch(() => undefined)
        }
      })()
    })
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
        let secrets: string[] = []
        let finishPayload: { status: 'succeeded' | 'failed'; outputs?: Readonly<Record<string, JsonValue>>; error?: string } = { status: 'failed' }
        try {
          const device = await studio.getDeviceInfo()
          const claimed = await claimSchedule(RPA_SERVICE_URL, id, device.deviceId, scheduledAt)
          await studio.acknowledgeScheduleDue(id, scheduledAt).catch(() => undefined)
          if (!claimed.claimed || !claimed.occurrenceId || !claimed.workflowId || !claimed.workflowVersion) return
          occurrenceId = claimed.occurrenceId
          const revision = await getWorkflowRevision(RPA_SERVICE_URL, claimed.workflowId, claimed.workflowVersion)
          if (revision.stage !== 'published') throw new Error('定时配置引用的流程版本未发布')
          const graph = hydrateScheduledSecrets(revision.graph, claimed.secretDefaults ?? [])
          const subflows = (await loadSubflowBundle(RPA_SERVICE_URL, graph)).map(item => hydrateScheduledSecrets(item, claimed.secretDefaults ?? []))
          const inputs = (claimed.inputs ?? {}) as Readonly<Record<string, JsonValue>>
          secrets = scheduledSecretStrings([graph, ...subflows], inputs)
          const record = await createExecution(RPA_SERVICE_URL, {
            workflowId: claimed.workflowId, workflowVersion: claimed.workflowVersion,
            deviceId: device.deviceId, deviceName: device.deviceName, clientVersion: device.clientVersion, inputs,
          })
          executionId = record.id
          registerScheduledExecution(executionId)
          await linkScheduleExecution(RPA_SERVICE_URL, id, occurrenceId, executionId)
          window.dispatchEvent(new Event('rpa:schedule-updated'))
          const runId = crypto.randomUUID()
          const uploader = new ExecutionLogUploader(events => appendExecutionEvents(RPA_SERVICE_URL, record.id, events), secrets)
          const stopUpdates = studio.onRunUpdate(({ runId: updateRunId, state }) => {
            if (updateRunId === runId) uploader.add(state.logs)
          })
          activeRunIds.current.add(runId)
          let result
          try {
            result = await studio.runWorkflow(graph, { runId, executionId, inputs, subflows, headless: true })
          } catch (error) {
            const message = safeEventMessage(readableRunError(error), secrets)
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
          occurrenceError = succeeded ? (logSyncError || undefined) : safeEventMessage(failedRunReason(result), secrets)
          finishPayload = {
            status: succeeded ? 'succeeded' : 'failed',
            outputs: secrets.length > 0 ? {} : redactExecutionJson(result.variables ?? {}, secrets) as Readonly<Record<string, JsonValue>>,
            error: succeeded ? undefined : occurrenceError,
          }
          await finishExecution(RPA_SERVICE_URL, executionId, finishPayload)
          executionFinished = true
          await completeScheduleOccurrence(RPA_SERVICE_URL, id, occurrenceId, {
            status: occurrenceStatus, executionId, error: occurrenceError,
          })
          occurrenceFinished = true
        } catch (error) {
          const message = safeEventMessage(readableRunError(error), secrets)
          console.error(`定时任务 ${id} 执行失败`, message)
          if (executionId && !executionFinished) await finishExecution(RPA_SERVICE_URL, executionId, {
            ...finishPayload, error: finishPayload.error ?? (runCompleted ? undefined : message),
          }).catch(() => undefined)
          if (occurrenceId && !occurrenceFinished) await completeScheduleOccurrence(RPA_SERVICE_URL, id, occurrenceId, {
            status: runCompleted ? occurrenceStatus : 'failed', executionId, error: occurrenceError ?? (runCompleted ? undefined : message),
          }).catch(() => undefined)
        } finally {
          if (executionId) unregisterScheduledExecution(executionId)
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
      stopApprovals()
      stop()
      for (const runId of activeRunIds.current) void studio.cancelWorkflow(runId).catch(() => undefined)
      void studio.clearSchedules()
    }
  }, [])
  return null
}
