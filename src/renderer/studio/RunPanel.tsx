import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ValidationIssue } from '@graph/types.ts'
import type { DryRunState } from '@runner/dry-run.ts'
import { copyTextToClipboard } from './clipboard.ts'

interface Props {
  readonly issues: readonly ValidationIssue[]
  readonly run: DryRunState | undefined
  readonly expandRequest?: number
}

const STATUS_LABELS: Record<DryRunState['status'], string> = {
  running: '执行中',
  'waiting-approval': '等待审批',
  succeeded: '执行成功',
  failed: '执行失败',
}

function logLevel(message: string): 'error' | 'warning' | 'normal' {
  if (/执行失败|运行失败|尝试失败|错误：|异常：/.test(message)) return 'error'
  if (/等待|重试|超时|跳过/.test(message)) return 'warning'
  return 'normal'
}

export function formatRunLogs(run: DryRunState): string {
  return run.logs.map(line => {
    const time = new Date(line.at).toLocaleString('zh-CN', { hour12: false })
    return `[${time}] [${line.nodeName || '运行'}] ${line.message}`
  }).join('\n')
}

export function RunPanel({ issues, run, expandRequest = 0 }: Props): ReactNode {
  const [collapsed, setCollapsed] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const logRef = useRef<HTMLOListElement>(null)
  const followLogs = useRef(true)
  const statuses = Object.values(run?.nodes ?? {})
  const completed = statuses.filter(status => status === 'succeeded').length
  const failed = statuses.filter(status => status === 'failed' || status === 'waiting-user').length
  const currentNodeName = run?.currentNodeId === undefined ? undefined
    : [...run.logs].reverse().find(line => line.nodeId === run.currentNodeId)?.nodeName

  useEffect(() => {
    if (!collapsed && followLogs.current && logRef.current !== null) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [collapsed, run?.logs.length])

  useEffect(() => {
    if (expandRequest > 0) setCollapsed(false)
  }, [expandRequest])

  useEffect(() => { setCopyStatus('idle') }, [run?.logs.length])

  return (
    <section id="workflow-run-panel" className={`run-panel${collapsed ? ' is-collapsed' : ''}`} aria-label="流程执行面板">
      <header className="run-panel-header">
        <div className="run-panel-heading">
          <span className={`run-panel-indicator is-${run?.status ?? 'idle'}`} aria-hidden="true" />
          <div><h2>流程执行</h2><small>{run === undefined ? '等待运行' : `已执行 ${completed + failed} 个节点`}</small></div>
        </div>
        <div className="run-panel-actions">
          <span className={`run-panel-status is-${run?.status ?? 'idle'}`} role="status">{run === undefined ? '未运行' : STATUS_LABELS[run.status]}</span>
          <button type="button" className="run-panel-toggle" aria-expanded={!collapsed} onClick={() => { setCollapsed(value => !value) }}>{collapsed ? '展开面板' : '收起面板'}</button>
        </div>
      </header>
      {!collapsed ? <div className="run-panel-body">
        <aside className="run-panel-sidebar">
          {run !== undefined ? <section className="run-panel-card">
            <h3>当前进度</h3>
            <p className="run-panel-current">{run.status === 'running' || run.status === 'waiting-approval' ? currentNodeName || '正在准备节点…' : run.status === 'succeeded' ? '本次运行已结束' : currentNodeName || '流程已停止'}</p>
            <div className="run-panel-stats"><span>成功 {completed}</span><span>失败 {failed}</span></div>
          </section> : null}
          <section className="run-panel-card">
            <h3>画布校验 <span className={issues.length > 0 ? 'run-panel-count is-error' : 'run-panel-count'}>{issues.length > 0 ? `${issues.length} 项待处理` : '已通过'}</span></h3>
            {issues.length > 0 ? <ul className="run-issues">{issues.map((issue, index) => <li key={`${issue.code}-${issue.nodeId ?? issue.edgeId ?? index}`}>{issue.message}</li>)}</ul> : <p className="run-ok">节点与连线配置已通过校验</p>}
          </section>
          {run !== undefined ? <details className="run-output-preview">
            <summary>节点产出 <span>{Object.keys(run.outputs).length} 项</span></summary>
            <pre>{JSON.stringify(run.outputs, null, 2)}</pre>
          </details> : null}
        </aside>
        <div className="run-panel-log-area">
          <div className="run-panel-log-header"><h3>运行日志</h3><div className="run-panel-log-actions"><span>{run?.logs.length ?? 0} 条</span><button type="button" disabled={run === undefined || run.logs.length === 0} onClick={() => { if (run !== undefined) void copyTextToClipboard(formatRunLogs(run)).then(() => { setCopyStatus('copied') }).catch(() => { setCopyStatus('failed') }) }}>{copyStatus === 'copied' ? '已复制' : copyStatus === 'failed' ? '复制失败' : '复制日志'}</button></div></div>
          {run === undefined || run.logs.length === 0 ? <div className="run-panel-empty">运行流程后，节点执行记录会显示在这里。</div> : <ol className="run-log" ref={logRef} onScroll={event => { const element = event.currentTarget; followLogs.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32 }}>
            {run.logs.map((line, index) => <li key={`${line.at}-${index}`} className={`is-${logLevel(line.message)}`}>
              <time dateTime={new Date(line.at).toISOString()}>{new Date(line.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
              <span className="run-log-node" title={line.nodeName || '运行'}>{line.nodeName || '运行'}</span>
              <span className="run-log-message">{line.message}</span>
            </li>)}
          </ol>}
        </div>
      </div> : null}
    </section>
  )
}
