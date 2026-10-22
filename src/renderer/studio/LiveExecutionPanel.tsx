import { useState, type ReactNode } from 'react'
import type { DryRunState } from '@runner/dry-run.ts'
import type { ExecutionEvent, ExecutionRecord, ExecutionStatus } from '../workflow-api.ts'

interface Props {
  readonly record: ExecutionRecord
  readonly state?: DryRunState
  readonly events: readonly ExecutionEvent[]
  readonly error?: string
  readonly onOpenDetail: () => void
  readonly onDismiss: () => void
}

const STATUS_LABELS: Record<ExecutionStatus, string> = {
  running: '运行中', waiting_approval: '待审批', succeeded: '执行成功', failed: '执行失败', cancelled: '已取消', interrupted: '已中断',
}

function displayStatus(record: ExecutionRecord, state: DryRunState | undefined): ExecutionStatus {
  if (record.status !== 'running') return record.status
  if (state?.status === 'waiting-approval') return 'waiting_approval'
  if (state?.status === 'succeeded' || state?.status === 'failed') return state.status
  return record.status
}

function eventTone(message: string): 'error' | 'warning' | 'normal' {
  if (/执行失败|运行失败|尝试失败|错误：|异常：/.test(message)) return 'error'
  if (/等待|重试|超时|跳过/.test(message)) return 'warning'
  return 'normal'
}

export function LiveExecutionPanel({ record, state, events, error, onOpenDetail, onDismiss }: Props): ReactNode {
  const [showAll, setShowAll] = useState(false)
  const status = displayStatus(record, state)
  const active = status === 'running' || status === 'waiting_approval'
  const visibleEvents = showAll ? events : events.slice(-8)
  const currentNode = state?.currentNodeId === undefined ? undefined : [...events].reverse().find(event => event.nodeId === state.currentNodeId)?.nodeName
  const visited = Object.values(state?.nodes ?? {}).filter(nodeStatus => nodeStatus !== 'pending' && nodeStatus !== 'skipped').length

  return <article className={`execution-live-card is-${status}`} aria-label="当前流程执行">
    <header className="execution-live-heading">
      <div className="execution-live-title">
        <span className="execution-live-icon" aria-hidden="true">▶</span>
        <div><small>本机执行 · v{record.workflowVersion}</small><h2>{record.workflowName}</h2></div>
      </div>
      <div className="execution-live-heading-actions">
        <span className={`execution-status is-${status}`} role="status">{STATUS_LABELS[status]}</span>
        {!active ? <button type="button" className="execution-live-dismiss" onClick={onDismiss} aria-label="收起本次执行">×</button> : null}
      </div>
    </header>
    <div className="execution-live-meta">
      <span>执行人：{record.executorName || '当前执行人'}</span>
      <span>设备：{record.deviceName}</span>
      <span>开始：{new Date(record.startedAt).toLocaleString()}</span>
    </div>
    <div className="execution-live-summary">
      <div className="execution-live-current"><small>{active ? '当前节点' : '最后节点'}</small><strong>{currentNode || (active ? '正在准备运行…' : '本次执行已结束')}</strong></div>
      <div className="execution-live-stat"><strong>{visited}</strong><small>经过节点</small></div>
      <div className="execution-live-stat"><strong>{events.length}</strong><small>条日志</small></div>
    </div>
    {error ? <p className="execution-live-error" role="alert">{error}</p> : null}
    <section className="execution-live-log-section" aria-label="实时运行日志">
      <div className="execution-live-log-heading"><h3>实时日志</h3>{events.length > 8 ? <button type="button" onClick={() => { setShowAll(value => !value) }}>{showAll ? '只看最近 8 条' : `查看全部 ${events.length} 条`}</button> : null}</div>
      {visibleEvents.length === 0 ? <p className="execution-live-empty">正在准备本机浏览器与运行环境，节点日志会实时显示在这里。</p> : <ol className={`execution-live-logs${showAll ? ' is-expanded' : ''}`}>
        {visibleEvents.map(event => <li key={event.sequence} className={`is-${eventTone(event.message)}`}>
          <time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
          <strong title={event.nodeName || '流程'}>{event.nodeName || '流程'}</strong>
          <span>{event.message}</span>
        </li>)}
      </ol>}
    </section>
    <footer><button type="button" onClick={onOpenDetail}>查看执行详情</button>{!active ? <span>执行记录已保留在下方列表</span> : null}</footer>
  </article>
}
