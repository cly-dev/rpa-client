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
  const attempts = useRef(new Map<string, { scheduleId: string; cancelled: boolean; finishedRun: boolean; runId?: string }>())

  useEffect(() => {
    const studio = window.studio
    if (!studio) return
    let active = true
    let syncVersion = 0
    const cancelRun = async (runId: string): Promise<void> => {
      // The pause event can arrive while the run IPC is still being registered.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await studio.cancelWorkflow(runId, 'schedule-paused').catch(() => ({ cancelled: false }))
        if (result.cancelled) return
        if (attempt === 0) await new Promise(resolve => window.setTimeout(resolve, 100))
      }
    }
    const pauseSchedule = (id: string): void => {
      for (const attempt of attempts.current.values()) {
        if (attempt.scheduleId !== id || attempt.finishedRun) continue
        attempt.cancelled = true
        if (attempt.runId) void cancelRun(attempt.runId)
      }
    }
    const sync = async (): Promise<void> => {
      const version = ++syncVersion
      try {
        const device = await studio.getDeviceInfo()
        const result = await listSchedules(RPA_SERVICE_URL, device.deviceId)
        if (!active || version !== syncVersion) return
        const enabled = new Set(result.items.filter(item => item.enabled && !item.deletedAt).map(item => item.id))
        for (const attempt of attempts.current.values()) if (!enabled.has(attempt.scheduleId)) pauseSchedule(attempt.scheduleId)
        await studio.syncSchedules(result.items)
      } catch (error) {
        if (active) console.error('同步定时配置失败', error)
      }
    }
    void sync()
    const interval = window.setInterval(() => { void sync() }, 60_000)
    const changed = (): void => { void sync() }
    const stateChanged = (event: Event): void => {
      const detail = (event as CustomEvent<{ id: string; enabled: boolean }>).detail
      if (detail && !detail.enabled) pauseSchedule(detail.id)
      void sync()
    }
    window.addEventListener('rpa:schedules-changed', changed)
    window.addEventListener('rpa:schedule-state-changed', stateChanged)
    const stopStateChanges = studio.onScheduleStateChanged(({ id, enabled }) => {
      if (!enabled) pauseSchedule(id)
      void sync()
    })
    const stopApprovals = studio.onApprovalRequest(prompt => {
      if (!isScheduledExecutionActive(prompt.executionId)) return
      void (async () => {
        try {
          const device = await studio.getDeviceInfo()
          const record = await createApproval(RPA_SERVICE_URL, prompt, device)
          if (prompt.continuation) {
            if (record.continuationStatus !== 'pending') throw new Error('服务端尚未支持循环审批续跑，请先部署服务端数据库迁移与新版本')
            await studio.acknowledgeApprovalQueued(prompt.id)
          }
          window.dispatchEvent(new Event('rpa:schedule-approval-requested'))
        } catch (error) {
          const message = error instanceof Error ? error.message : '创建审批单失败'
          if (prompt.continuation) await studio.acknowledgeApprovalQueued(prompt.id, `审批服务不可用：${message}`).catch(() => undefined)
          else await studio.respondApproval(prompt.id, 'rejected', `审批服务不可用：${message}`).catch(() => undefined)
        }
      })()
    })
    const stop = studio.onScheduleDue(({ id, scheduledAt }) => {
      const key = `${id}@${scheduledAt}`
      if (inProgress.current.has(key)) return
      inProgress.current.add(key)
      const attempt = { scheduleId: id, cancelled: false, finishedRun: false, runId: undefined as string | undefined }
      attempts.current.set(key, attempt)
      void (async () => {
        let occurrenceId: string | undefined
        let executionId: string | undefined
        let executionFinished = false
        let occurrenceFinished = false
        let occurrenceStatus: 'succeeded' | 'failed' | 'skipped' = 'failed'
        let occurrenceError: string | undefined
        let runCompleted = false
        let secrets: string[] = []
        let finishPayload: { status: 'succeeded' | 'failed' | 'cancelled'; outputs?: Readonly<Record<string, JsonValue>>; error?: string } = { status: 'failed' }
        const requireActive = (): void => { if (attempt.cancelled) throw new Error('定时任务已暂停，当前执行已停止') }
        try {
          const device = await studio.getDeviceInfo()
          const claimed = await claimSchedule(RPA_SERVICE_URL, id, device.deviceId, scheduledAt)
          await studio.acknowledgeScheduleDue(id, scheduledAt).catch(() => undefined)
          if (!claimed.claimed || !claimed.occurrenceId || !claimed.workflowId || !claimed.workflowVersion) return
          occurrenceId = claimed.occurrenceId
          requireActive()
          const revision = await getWorkflowRevision(RPA_SERVICE_URL, claimed.workflowId, claimed.workflowVersion)
          if (revision.stage !== 'published') throw new Error('定时配置引用的流程版本未发布')
          const graph = hydrateScheduledSecrets(revision.graph, claimed.secretDefaults ?? [])
          const subflows = (await loadSubflowBundle(RPA_SERVICE_URL, graph)).map(item => hydrateScheduledSecrets(item, claimed.secretDefaults ?? []))
          requireActive()
          const inputs = (claimed.inputs ?? {}) as Readonly<Record<string, JsonValue>>
          secrets = scheduledSecretStrings([graph, ...subflows], inputs)
          const record = await createExecution(RPA_SERVICE_URL, {
            workflowId: claimed.workflowId, workflowVersion: claimed.workflowVersion,
            deviceId: device.deviceId, deviceName: device.deviceName, clientVersion: device.clientVersion, inputs,
          })
          executionId = record.id
          registerScheduledExecution(executionId)
          requireActive()
          await linkScheduleExecution(RPA_SERVICE_URL, id, occurrenceId, executionId)
          requireActive()
          window.dispatchEvent(new Event('rpa:schedule-updated'))
          const runId = crypto.randomUUID()
          attempt.runId = runId
          const uploader = new ExecutionLogUploader(events => appendExecutionEvents(RPA_SERVICE_URL, record.id, events), secrets)
          const stopUpdates = studio.onRunUpdate(({ runId: updateRunId, state }) => {
            if (updateRunId === runId) uploader.add(state.logs)
          })
          let result
          try {
            requireActive()
            const running = studio.runWorkflow(graph, { runId, executionId, inputs, subflows, headless: true })
            if (attempt.cancelled) void cancelRun(runId)
            result = await running
          } catch (error) {
            const message = safeEventMessage(readableRunError(error), secrets)
            await uploader.close()
            finishPayload = { status: attempt.cancelled ? 'cancelled' : 'failed', error: message }
            await finishExecution(RPA_SERVICE_URL, executionId, finishPayload)
            executionFinished = true
            occurrenceError = message
            occurrenceStatus = attempt.cancelled ? 'skipped' : 'failed'
            throw error
          } finally {
            stopUpdates()
            attempt.finishedRun = true
            attempt.runId = undefined
          }
          const logSyncError = await uploader.close(result.logs)
          const succeeded = result.status === 'succeeded' && !attempt.cancelled
          runCompleted = true
          occurrenceStatus = attempt.cancelled ? 'skipped' : succeeded ? 'succeeded' : 'failed'
          occurrenceError = succeeded ? (logSyncError || undefined) : attempt.cancelled ? '定时任务已暂停，当前执行已停止' : safeEventMessage(failedRunReason(result), secrets)
          finishPayload = {
            status: attempt.cancelled ? 'cancelled' : succeeded ? 'succeeded' : 'failed',
            outputs: secrets.length > 0 ? {} : redactExecutionJson(result.variables ?? {}, secrets) as Readonly<Record<string, JsonValue>>,
            error: succeeded ? undefined : occurrenceError,
          }
          const saved = await finishExecution(RPA_SERVICE_URL, executionId, finishPayload)
          executionFinished = true
          if (saved.status === 'failed') {
            occurrenceStatus = 'failed'
            occurrenceError = saved.error ?? '审批分支执行失败'
          }
          if (saved.status !== 'waiting_approval') await completeScheduleOccurrence(RPA_SERVICE_URL, id, occurrenceId, {
            status: occurrenceStatus, executionId, error: occurrenceError,
          })
          occurrenceFinished = true
        } catch (error) {
          const message = safeEventMessage(readableRunError(error), secrets)
          if (!attempt.cancelled) console.error(`定时任务 ${id} 执行失败`, message)
          if (executionId && !executionFinished) await finishExecution(RPA_SERVICE_URL, executionId, {
            ...finishPayload, status: attempt.cancelled ? 'cancelled' : finishPayload.status,
            error: finishPayload.error ?? (runCompleted ? undefined : message),
          }).catch(() => undefined)
          if (occurrenceId && !occurrenceFinished) await completeScheduleOccurrence(RPA_SERVICE_URL, id, occurrenceId, {
            status: attempt.cancelled ? 'skipped' : runCompleted ? occurrenceStatus : 'failed', executionId, error: occurrenceError ?? (runCompleted ? undefined : message),
          }).catch(() => undefined)
        } finally {
          if (executionId) unregisterScheduledExecution(executionId)
          attempts.current.delete(key)
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
      window.removeEventListener('rpa:schedule-state-changed', stateChanged)
      stopStateChanges()
      stopApprovals()
      stop()
      for (const attempt of attempts.current.values()) {
        attempt.cancelled = true
        if (attempt.runId) void cancelRun(attempt.runId)
      }
      void studio.clearSchedules()
    }
  }, [])
  return null
}
