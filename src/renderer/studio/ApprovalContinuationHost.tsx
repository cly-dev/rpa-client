import { useEffect, useRef, type ReactNode } from 'react'
import type { JsonValue } from '@graph/types.ts'
import { failedRunReason, readableRunError } from './execution-message.ts'
import { ExecutionLogUploader } from './execution-log-uploader.ts'
import { redactExecutionJson, safeEventMessage } from './execution-log.ts'
import { hydrateScheduledSecrets, scheduledSecretStrings } from './scheduled-secrets.ts'
import {
  RPA_SERVICE_URL, appendExecutionEvents, claimApprovalContinuation, completeApprovalContinuation,
  finishExecution, getWorkflowRevision, listReadyApprovalContinuations, loadSubflowBundle, renewApprovalContinuation,
} from '../workflow-api.ts'

/** The service keeps the queue; only this signed-in executor device runs the branch. */
export function ApprovalContinuationHost(): ReactNode {
  const busy = useRef(false)
  useEffect(() => {
    const studio = window.studio
    if (!studio) return
    let active = true
    const poll = async (): Promise<void> => {
      if (!active || busy.current) return
      busy.current = true
      try {
        if (!(await studio.canRunContinuation()).ready) return
        const device = await studio.getDeviceInfo()
        const ready = await listReadyApprovalContinuations(RPA_SERVICE_URL, device.deviceId)
        const next = ready.items[0]
        if (!next || !active) return
        const task = await claimApprovalContinuation(RPA_SERVICE_URL, next.id, device)
        const lease = window.setInterval(() => { void renewApprovalContinuation(RPA_SERVICE_URL, task.approvalId, task.executionId).catch(error => console.error('审批续跑租约续期失败', error)) }, 60_000)
        let uploader: ExecutionLogUploader | undefined
        let stopUpdates: (() => void) | undefined
        let secrets: string[] = []
        let finalStatus: 'succeeded' | 'failed' = 'failed'
        let errorMessage = ''
        try {
          const revision = await getWorkflowRevision(RPA_SERVICE_URL, task.workflowId, task.workflowVersion)
          const graph = hydrateScheduledSecrets(revision.graph, task.continuation.secretDefaults ?? [])
          const subflows = (await loadSubflowBundle(RPA_SERVICE_URL, graph)).map(flow => hydrateScheduledSecrets(flow, task.continuation.secretDefaults ?? []))
          secrets = scheduledSecretStrings([graph, ...subflows], task.continuation.inputs)
          const runId = crypto.randomUUID()
          uploader = new ExecutionLogUploader(events => appendExecutionEvents(RPA_SERVICE_URL, task.executionId, events), secrets)
          stopUpdates = studio.onRunUpdate(({ runId: updateRunId, state }) => { if (updateRunId === runId) uploader?.add(state.logs) })
          const result = await studio.runWorkflow(graph, {
            runId, executionId: task.executionId, inputs: task.continuation.inputs,
            variables: task.continuation.variables, outputs: task.continuation.outputs,
            subflows, headless: true,
            resumeApproval: { nodeId: task.nodeId, decision: task.decision, comment: task.comment, approverId: task.approverId, approverName: task.approverName, decidedAt: task.decidedAt },
          })
          await uploader.close(result.logs)
          finalStatus = result.status === 'succeeded' ? 'succeeded' : 'failed'
          if (finalStatus === 'failed') errorMessage = safeEventMessage(failedRunReason(result), secrets)
          await finishExecution(RPA_SERVICE_URL, task.executionId, {
            status: finalStatus,
            outputs: redactExecutionJson(result.variables ?? {}, secrets) as Readonly<Record<string, JsonValue>>,
            error: errorMessage || undefined,
          })
        } catch (error) {
          errorMessage = safeEventMessage(readableRunError(error), secrets)
          await uploader?.close()
          await finishExecution(RPA_SERVICE_URL, task.executionId, { status: 'failed', error: errorMessage }).catch(() => undefined)
        } finally {
          stopUpdates?.()
          window.clearInterval(lease)
        }
        await completeApprovalContinuation(RPA_SERVICE_URL, task.approvalId, task.executionId, finalStatus)
        window.dispatchEvent(new Event('rpa:approval-continuation-finished'))
      } catch (error) {
        if (active) console.error('审批分支续跑失败，稍后重试', error)
      } finally {
        busy.current = false
      }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, 15_000)
    const wake = (): void => { void poll() }
    window.addEventListener('rpa:approval-continuation-ready', wake)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('rpa:approval-continuation-ready', wake) }
  }, [])
  return null
}
