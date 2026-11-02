import { useEffect, useState, type ReactNode } from 'react';
import { getDashboardSummary, RPA_SERVICE_URL, type DashboardSummary } from '../workflow-api.ts';

interface DashboardViewProps {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly onOpenHistory: (executionId?: string) => void;
  readonly onOpenApprovals: () => void;
  readonly onOpenSchedules: () => void;
  readonly onOpenWorkflows: () => void;
}

function todayWindow(): { from: Date; to: Date } {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
  };
}

export function DashboardView({ workspaceId, workspaceName, onOpenHistory, onOpenApprovals, onOpenSchedules, onOpenWorkflows }: DashboardViewProps): ReactNode {
  const [summary, setSummary] = useState<DashboardSummary>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      const { from, to } = todayWindow();
      try {
        const result = await getDashboardSummary(RPA_SERVICE_URL, workspaceId, from, to);
        if (!active) return;
        setSummary(result);
        setUpdatedAt(new Date());
        setError('');
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '读取看板数据失败');
      } finally {
        if (active) setLoading(false);
      }
    };
    setSummary(undefined);
    setLoading(true);
    void load();
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [workspaceId, reloadKey]);

  const stats = summary?.executions;
  const cards = [
    { label: '今日执行', value: stats?.total ?? 0, detail: '当前空间的全部执行', tone: 'neutral', onClick: () => onOpenHistory() },
    { label: '成功率', value: stats?.successRate === null || !stats ? '—' : `${stats.successRate}%`, detail: '仅统计成功与失败的执行', tone: 'success', onClick: () => onOpenHistory() },
    { label: '今日失败', value: stats?.failed ?? 0, detail: '进入执行记录排查', tone: 'danger', onClick: () => onOpenHistory() },
    { label: '待我审批', value: summary?.pendingApprovals ?? 0, detail: '当前账号需要处理', tone: 'warning', onClick: onOpenApprovals },
    { label: '启用的定时任务', value: summary?.schedules.active ?? 0, detail: `已暂停 ${summary?.schedules.paused ?? 0} 个`, tone: 'info', onClick: onOpenSchedules },
    { label: '已发布流程', value: summary?.publishedWorkflows ?? 0, detail: '当前空间可用流程', tone: 'neutral', onClick: onOpenWorkflows },
  ] as const;

  return <section className="workbench-content dashboard-view">
    <div className="workbench-page-heading dashboard-heading">
      <div><span className="eyebrow">OVERVIEW</span><h1>运行看板</h1><p>{workspaceName} · 今日数据按本机时区统计；执行数据每分钟自动刷新</p></div>
      <button type="button" className="dashboard-refresh" disabled={loading} onClick={() => setReloadKey(key => key + 1)}>{loading ? '读取中…' : '刷新数据'}</button>
    </div>
    {error ? <div className="dashboard-error" role="alert">{error}<button type="button" onClick={() => setReloadKey(key => key + 1)}>重试</button></div> : null}
    {loading && !summary ? <div className="workbench-empty"><span className="workbench-spinner" />正在汇总看板数据…</div> : summary ? <>
      <div className="dashboard-metrics">
        {cards.map(card => <button type="button" key={card.label} className={`dashboard-metric is-${card.tone}`} onClick={card.onClick}>
          <span className="dashboard-metric-label">{card.label}<span aria-hidden="true">↗</span></span>
          <strong>{card.value}</strong>
          <small>{card.detail}</small>
        </button>)}
      </div>
      <div className="dashboard-detail-grid">
        <section className="dashboard-panel">
          <div className="dashboard-panel-heading"><div><h2>今日执行状态</h2><p>成功、失败之外的状态单独展示</p></div><button type="button" onClick={() => onOpenHistory()}>查看全部</button></div>
          <div className="dashboard-status-grid">
            <div><span className="is-success" />成功<strong>{stats?.succeeded ?? 0}</strong></div>
            <div><span className="is-danger" />失败<strong>{stats?.failed ?? 0}</strong></div>
            <div><span className="is-info" />运行中<strong>{stats?.running ?? 0}</strong></div>
            <div><span className="is-warning" />等待审批<strong>{stats?.waitingApproval ?? 0}</strong></div>
            <div><span className="is-muted" />已取消<strong>{stats?.cancelled ?? 0}</strong></div>
            <div><span className="is-muted" />已中断<strong>{stats?.interrupted ?? 0}</strong></div>
          </div>
        </section>
        <section className="dashboard-panel">
          <div className="dashboard-panel-heading"><div><h2>最近 7 天失败执行</h2><p>按发生时间倒序，最多显示 5 条</p></div><button type="button" onClick={() => onOpenHistory()}>执行记录</button></div>
          {summary.recentFailures.length === 0 ? <p className="dashboard-empty">最近 7 天没有失败执行</p> : <div className="dashboard-failure-list">
            {summary.recentFailures.map(item => <button type="button" key={item.id} onClick={() => onOpenHistory(item.id)}>
              <span><strong>{item.workflowName} <small>v{item.workflowVersion}</small></strong><small>{new Date(item.startedAt).toLocaleString()} · {item.executorName || '未知执行人'}</small></span>
              <em title={item.error ?? undefined}>{item.error || '运行失败，查看执行日志'}</em>
              <b aria-hidden="true">›</b>
            </button>)}
          </div>}
        </section>
      </div>
      {updatedAt ? <p className="dashboard-updated">最近更新：{updatedAt.toLocaleTimeString()}</p> : null}
    </> : null}
  </section>;
}
