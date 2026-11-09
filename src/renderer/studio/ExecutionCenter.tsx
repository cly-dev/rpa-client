import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { firstIssue, missingStartUrl } from "@graph/validate.ts";
import type {
  ApprovalPrompt,
  JsonValue,
  WorkflowContextVariable,
  WorkflowGraph,
} from "@graph/types.ts";
import type { DryRunState } from "@runner/dry-run.ts";
import { workflowNeedsBrowser } from "@runner/page-requirement.ts";
import { executionEventTone, failedRunReason, readableRunError } from "./execution-message.ts";
import { safeEventMessage } from './execution-log.ts';
import { BrowserModePicker } from './BrowserModePicker.tsx';
import { LiveExecutionPanel } from './LiveExecutionPanel.tsx';
import { ApprovalRichText } from './ApprovalRichText.tsx';
import { Pagination } from './Pagination.tsx';
import { ClearableNumberInput } from './ClearableNumberInput.tsx';
import { isScheduledExecutionActive } from './scheduled-executions.ts';
import { initialExecutionInputText, rememberExecutionInputText } from './execution-input-memory.ts';
import { nextScheduleOccurrence } from '../../main/schedule-clock.ts';
import {
  RPA_SERVICE_URL,
  appendExecutionEvents,
  createApproval,
  createExecution,
  createSchedule,
  deleteSchedule,
  decideApproval,
  finishExecution,
  getExecution,
  getWorkflowRevision,
  loadSubflowBundle,
  listExecutions,
  listApprovals,
  listWorkflows,
  listSchedules,
  listScheduleOccurrences,
  toggleSchedule,
  type ExecutionEvent,
  type ExecutionRecord,
  type ApprovalRecord,
  type WorkflowListItem,
  type WorkflowSchedule,
  type ScheduleOccurrence,
  type WorkspaceItem,
} from "../workflow-api.ts";

type Tab = "flows" | "history" | "schedules" | "approvals";
interface LiveRun {
  readonly record: ExecutionRecord;
  readonly state?: DryRunState;
  readonly events: readonly ExecutionEvent[];
  readonly error?: string;
}
interface ExecutionCenterProps {
  readonly initialTab?: Tab;
  readonly initialRecordId?: string;
  readonly initialScope?: string;
  readonly approvalOnly?: boolean;
  readonly workspaceId?: string;
  readonly workspaces?: readonly WorkspaceItem[];
  readonly onApprovalTotalChange?: (total: number) => void;
  readonly onApprovalRequested?: () => void;
  readonly onRunActivityChange?: (activity: { readonly runId: string; readonly workflowName: string; readonly state?: DryRunState } | undefined) => void;
}

function ScheduleActionIcon({ kind }: { readonly kind: 'history' | 'pause' | 'play' | 'delete' | 'clock' }): ReactNode {
  const paths: Record<typeof kind, ReactNode> = {
    history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v4h4" /><path d="M12 7v5l3 2" /></>,
    pause: <><path d="M8 5v14" /><path d="M16 5v14" /></>,
    play: <path d="m8 5 11 7-11 7V5Z" />,
    delete: <><path d="M4 7h16" /><path d="M10 4h4" /><path d="m6 7 1 13h10l1-13" /><path d="M10 11v5" /><path d="M14 11v5" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg>;
}

function stringValue(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  return typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : String(value);
}

function parseInput(
  value: string,
  definition: WorkflowContextVariable,
): JsonValue | undefined {
  if (definition.type === 'number' && value.trim() === '') return 1;
  if (value === "")
    return definition.defaultValue === undefined ||
      definition.defaultValue === "******"
      ? undefined
      : definition.defaultValue;
  if (definition.type === "string") return value;
  if (definition.type === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
      throw new Error(`「${definition.name}」必须是有效数字`);
    return parsed;
  }
  if (definition.type === "boolean") {
    if (value !== "true" && value !== "false")
      throw new Error(`请选择「${definition.name}」的值`);
    return value === "true";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`「${definition.name}」需要填写有效 JSON`);
  }
  if (definition.type === "array" && Array.isArray(parsed))
    return parsed as JsonValue;
  if (
    definition.type === "object" &&
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed)
  )
    return parsed as JsonValue;
  throw new Error(
    `「${definition.name}」的值类型应为${definition.type === "array" ? "数组" : "对象"}`,
  );
}

function redactJson(value: JsonValue, secrets: readonly string[]): JsonValue {
  if (typeof value === "string")
    return secrets.reduce(
      (text, secret) => (secret ? text.split(secret).join("••••••") : text),
      value,
    );
  if (Array.isArray(value))
    return value.map((item) => redactJson(item, secrets));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /password|secret|token/i.test(key)
          ? "******"
          : redactJson(item, secrets),
      ]),
    );
  return value;
}

function statusLabel(status: ExecutionRecord["status"]): string {
  return status === "running"
    ? "运行中"
    : status === "waiting_approval"
      ? "待审批"
      : status === "succeeded"
        ? "成功"
        : status === "failed"
          ? "失败"
          : status === "cancelled"
            ? "已取消"
            : "已中断";
}

function occurrenceStatus(item: ScheduleOccurrence): { css: string; label: string } {
  if (item.status === 'succeeded') return { css: 'succeeded', label: '成功' };
  if (item.status === 'failed') return { css: 'failed', label: '失败' };
  if (item.status === 'skipped') return { css: 'cancelled', label: '已跳过' };
  if (item.execution) return { css: item.execution.status, label: statusLabel(item.execution.status) };
  return { css: 'running', label: '准备中' };
}

function approvalStatusLabel(status: ApprovalRecord['status']): string {
  return status === 'pending' ? '待审批'
    : status === 'approved' ? '已通过'
      : status === 'rejected' ? '未通过'
        : status === 'timeout' ? '已超时' : '已取消';
}

export function ExecutionCenter({
  initialTab = "flows",
  initialRecordId,
  initialScope,
  approvalOnly = false,
  workspaceId = 'default',
  workspaces = [],
  onApprovalTotalChange,
  onApprovalRequested,
  onRunActivityChange,
}: ExecutionCenterProps = {}): ReactNode {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [scope, setScope] = useState(initialScope ?? (approvalOnly ? 'all' : workspaceId));
  const [flows, setFlows] = useState<WorkflowListItem[]>([]);
  const [records, setRecords] = useState<ExecutionRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [historyQuery, setHistoryQuery] = useState("");
  const [appliedHistoryQuery, setAppliedHistoryQuery] = useState("");
  const refreshRequestId = useRef(0);
  const metadataRequestId = useRef(0);
  const lastRefreshInputs = useRef({ page, scope, showDeletedSchedules: false, appliedHistoryQuery: '' });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNoticeState] = useState("");
  const [noticeVersion, setNoticeVersion] = useState(0);
  const setNotice = (message: string): void => { setNoticeState(message); setNoticeVersion(version => version + 1); };
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => { setNotice(""); }, 5_000);
    return () => { window.clearTimeout(timer); };
  }, [notice, noticeVersion]);
  const [runMessage, setRunMessage] = useState("");
  const [launchFlow, setLaunchFlow] = useState<WorkflowListItem>();
  const [launchGraph, setLaunchGraph] = useState<WorkflowGraph>();
  const [launchMode, setLaunchMode] = useState<'run' | 'schedule'>('run');
  const [scheduleKind, setScheduleKind] = useState<WorkflowSchedule['kind']>('daily');
  const [scheduleInterval, setScheduleInterval] = useState(60);
  const [scheduleTime, setScheduleTime] = useState('09:00');
  const [scheduleWeekday, setScheduleWeekday] = useState(1);
  const [scheduleStartMode, setScheduleStartMode] = useState<'now' | 'custom'>('now');
  const [scheduleStartAt, setScheduleStartAt] = useState('');
  const [scheduleEndAt, setScheduleEndAt] = useState('');
  const schedulePreview = useMemo(() => {
    if (scheduleStartMode === 'custom' && (!scheduleStartAt || !Number.isFinite(Date.parse(scheduleStartAt)))) return '请选择有效的开始时间';
    if (scheduleEndAt && !Number.isFinite(Date.parse(scheduleEndAt))) return '请选择有效的截止时间';
    const now = Date.now();
    const endAt = scheduleEndAt ? new Date(scheduleEndAt).toISOString() : null;
    if (endAt && Date.parse(endAt) < now) return '截止时间已过去，请重新选择';
    const startAt = scheduleStartMode === 'custom' ? new Date(scheduleStartAt).toISOString() : null;
    if (startAt && endAt && Date.parse(endAt) < Date.parse(startAt)) return '截止时间不能早于开始时间';
    const [hour, minute] = scheduleTime.split(':').map(Number);
    const next = nextScheduleOccurrence({
      id: 'preview', kind: scheduleKind, intervalMinutes: scheduleKind === 'interval' ? scheduleInterval : null,
      hour: scheduleKind === 'interval' ? null : hour, minute: scheduleKind === 'interval' ? null : minute,
      weekday: scheduleKind === 'weekly' ? scheduleWeekday : null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      createdAt: new Date(now).toISOString(), startAt, endAt, enabled: true,
    }, now);
    return next === null ? '当前配置没有后续执行时间' : `预计下次执行：${new Date(next).toLocaleString()}`;
  }, [scheduleKind, scheduleInterval, scheduleTime, scheduleWeekday, scheduleStartMode, scheduleStartAt, scheduleEndAt]);
  const [schedules, setSchedules] = useState<WorkflowSchedule[]>([]);
  const [scheduleActionId, setScheduleActionId] = useState<string>();
  const [showDeletedSchedules, setShowDeletedSchedules] = useState(false);
  const [scheduleHistory, setScheduleHistory] = useState<WorkflowSchedule>();
  const [occurrences, setOccurrences] = useState<ScheduleOccurrence[]>([]);
  const [occurrencePage, setOccurrencePage] = useState(1);
  const [occurrenceTotal, setOccurrenceTotal] = useState(0);
  const [occurrenceLoading, setOccurrenceLoading] = useState(false);
  const [occurrenceError, setOccurrenceError] = useState('');
  const [inputText, setInputText] = useState<Record<string, string>>({});
  const [secretText, setSecretText] = useState<Record<string, string>>({});
  const [launching, setLaunching] = useState(false);
  const [launchHeadless, setLaunchHeadless] = useState(true);
  const [live, setLive] = useState<LiveRun>();
  const [detail, setDetail] = useState<ExecutionRecord>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [approvalTotal, setApprovalTotal] = useState(0);
  const [approvalView, setApprovalView] = useState<'pending' | 'history'>('pending');
  const [approvalHistory, setApprovalHistory] = useState<ApprovalRecord[]>([]);
  const [approvalHistoryPage, setApprovalHistoryPage] = useState(1);
  const [approvalHistoryTotal, setApprovalHistoryTotal] = useState(0);
  const [approvalHistoryLoading, setApprovalHistoryLoading] = useState(false);
  const [approvalHistoryError, setApprovalHistoryError] = useState('');
  const [approvalHistoryRefresh, setApprovalHistoryRefresh] = useState(0);
  const [activeApproval, setActiveApproval] = useState<ApprovalRecord>();
  const [approvalComment, setApprovalComment] = useState("");
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const pageSize = 15;
  const definitions = launchGraph?.context?.inputs ?? [];
  const secretDefinitions =
    launchGraph?.context?.variables.filter((item) => item.secret) ?? [];
  const filteredFlows = useMemo(
    () =>
      flows.filter(
        (flow) =>
          flow.publishedVersion !== null &&
          flow.name.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [flows, query],
  );

  const rememberLaunchInputs = (): void => {
    if (launchFlow) rememberExecutionInputText(launchFlow.id, inputText, secretText, launchMode);
  };

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);
  useEffect(() => { setScope(initialScope ?? (approvalOnly ? 'all' : workspaceId)); setPage(1); }, [workspaceId, approvalOnly, initialScope]);
  useEffect(() => { setApprovalHistoryPage(1); }, [scope]);
  useEffect(() => {
    if (tab !== 'approvals' || approvalView !== 'history') return;
    let active = true;
    setApprovalHistoryLoading(true);
    setApprovalHistoryError('');
    setApprovalHistory([]);
    void listApprovals(RPA_SERVICE_URL, approvalHistoryPage, 15, 'history', undefined, scope === 'all' ? undefined : scope)
      .then(result => {
        if (!active) return;
        setApprovalHistory(result.items);
        setApprovalHistoryTotal(result.total);
        setApprovalHistoryPage(result.page);
      })
      .catch(error => { if (active) setApprovalHistoryError(error instanceof Error ? error.message : '读取审批历史失败'); })
      .finally(() => { if (active) setApprovalHistoryLoading(false); });
    return () => { active = false; };
  }, [tab, approvalView, approvalHistoryPage, scope, approvalHistoryRefresh]);
  useEffect(() => {
    onApprovalTotalChange?.(approvalTotal);
  }, [approvalTotal, onApprovalTotalChange]);

  const refresh = async (recordsOnly = false): Promise<void> => {
    const requestId = ++refreshRequestId.current;
    const metadataId = recordsOnly ? undefined : ++metadataRequestId.current;
    setLoading(true);
    try {
      if (recordsOnly) {
        const runResult = await listExecutions(RPA_SERVICE_URL, page, pageSize, scope === 'all' ? undefined : scope, appliedHistoryQuery);
        if (requestId !== refreshRequestId.current) return;
        setRecords(runResult.items);
        setTotal(runResult.total);
        setPage(runResult.page);
        setNotice("");
        return;
      }
      const device = await window.studio
        ?.getDeviceInfo()
        .catch(() => undefined);
      const [flowResult, runResult, approvalResult, scheduleResult] = await Promise.all([
        listWorkflows(RPA_SERVICE_URL, 1, 100, '', scope === 'all' ? undefined : scope),
        listExecutions(RPA_SERVICE_URL, page, pageSize, scope === 'all' ? undefined : scope, appliedHistoryQuery),
        listApprovals(
          RPA_SERVICE_URL,
          1,
          50,
          "pending",
          device?.deviceId,
          scope === 'all' ? undefined : scope,
        ).catch(() => ({ items: [], total: 0, page: 1, pageSize: 50 })),
        listSchedules(RPA_SERVICE_URL, undefined, scope === 'all' ? undefined : scope, showDeletedSchedules),
      ]);
      if (metadataId === metadataRequestId.current) {
        setFlows(flowResult.items);
        setApprovals(approvalResult.items);
        setApprovalTotal(approvalResult.total);
        setSchedules(scheduleResult.items);
      }
      if (requestId === refreshRequestId.current) {
        setRecords(runResult.items);
        setTotal(runResult.total);
        setPage(runResult.page);
        setNotice("");
      }
    } catch (error) {
      if (requestId !== refreshRequestId.current && metadataId !== metadataRequestId.current) return;
      setNotice(
        error instanceof Error ? error.message : "读取执行中心数据失败",
      );
    } finally {
      if (requestId === refreshRequestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextQuery = historyQuery.trim();
      if (nextQuery !== appliedHistoryQuery) {
        setPage(1);
        setAppliedHistoryQuery(nextQuery);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [historyQuery, appliedHistoryQuery]);

  useEffect(() => {
    const previous = lastRefreshInputs.current;
    const recordsOnly = previous.scope === scope && previous.showDeletedSchedules === showDeletedSchedules && (previous.page !== page || previous.appliedHistoryQuery !== appliedHistoryQuery);
    lastRefreshInputs.current = { page, scope, showDeletedSchedules, appliedHistoryQuery };
    void refresh(recordsOnly);
  }, [page, scope, showDeletedSchedules, appliedHistoryQuery]);

  useEffect(() => {
    const onFinished = (): void => { void refresh(); };
    window.addEventListener('rpa:schedule-updated', onFinished);
    window.addEventListener('rpa:approval-continuation-finished', onFinished);
    return () => { window.removeEventListener('rpa:schedule-updated', onFinished); window.removeEventListener('rpa:approval-continuation-finished', onFinished); };
  }, [page, scope, showDeletedSchedules, appliedHistoryQuery]);

  useEffect(() => {
    const studio = window.studio;
    if (studio === undefined) return;
    return studio.onApprovalRequest((prompt: ApprovalPrompt) => {
      if (isScheduledExecutionActive(prompt.executionId)) return;
      void (async () => {
        try {
          const device = await studio.getDeviceInfo();
          const record = await createApproval(RPA_SERVICE_URL, prompt, device);
          if (prompt.continuation) {
            if (record.continuationStatus !== 'pending') throw new Error('服务端尚未支持循环审批续跑，请先部署服务端数据库迁移与新版本');
            await studio.acknowledgeApprovalQueued(prompt.id);
          }
          setApprovals((current) => [
            record,
            ...current.filter((item) => item.id !== record.id),
          ]);
          setApprovalTotal((current) => current + 1);
          setActiveApproval(record);
          setApprovalComment("");
          setApprovalView('pending');
          setTab("approvals");
          onApprovalRequested?.();
          setLive((current) => prompt.continuation ? current :
            current === undefined
              ? current
              : {
                  ...current,
                  record: { ...current.record, status: "waiting_approval" },
                },
          );
          setNotice(prompt.continuation ? "当前轮审批已挂起，循环继续执行" : "流程正在等待当前执行人审批");
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "创建审批单失败";
          setNotice(`无法创建审批单：${message}`);
          if (prompt.continuation) await studio.acknowledgeApprovalQueued(prompt.id, `审批服务不可用：${message}`).catch(() => undefined);
          else await studio.respondApproval(prompt.id, "rejected", `审批服务不可用：${message}`).catch(() => undefined);
        }
      })();
    });
  }, [onApprovalRequested]);

  const submitApproval = async (
    decision: "approved" | "rejected",
  ): Promise<void> => {
    if (activeApproval === undefined || window.studio === undefined) return;
    if (!activeApproval.continuationStatus && live?.record.id !== activeApproval.executionId && !isScheduledExecutionActive(activeApproval.executionId)) {
      setNotice(
        "这条审批对应的本机执行已经不在运行，当前版本无法恢复，请重新执行流程",
      );
      return;
    }
    if (
      decision === "rejected" &&
      activeApproval.requireCommentOnReject &&
      approvalComment.trim() === ""
    ) {
      setNotice("拒绝审批时必须填写审批意见");
      return;
    }
    setApprovalSubmitting(true);
    try {
      const device = await window.studio.getDeviceInfo();
      const saved = await decideApproval(RPA_SERVICE_URL, activeApproval.id, {
        decision,
        comment: approvalComment.trim(),
        approverId: device.deviceId,
        approverName: device.deviceName,
      });
      if (!activeApproval.continuationStatus) await window.studio.respondApproval(activeApproval.id, decision, approvalComment.trim());
      else window.dispatchEvent(new Event('rpa:approval-continuation-ready'));
      setApprovals((current) => current.filter((item) => item.id !== saved.id));
      setApprovalTotal((current) => Math.max(0, current - 1));
      setActiveApproval(undefined);
      setApprovalComment("");
      setLive((current) => activeApproval.continuationStatus ? current :
        current === undefined
          ? current
          : { ...current, record: { ...current.record, status: "running" } },
      );
      setNotice(
        activeApproval.continuationStatus ? '审批已处理，该轮分支将在本机空闲后续跑' : decision === "approved"
          ? "审批已通过，流程继续执行"
          : "审批已拒绝，流程进入拒绝分支",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "提交审批结果失败");
    } finally {
      setApprovalSubmitting(false);
    }
  };

  const openLaunch = async (flow: WorkflowListItem, mode: 'run' | 'schedule' = 'run'): Promise<void> => {
    if (flow.publishedVersion === null) {
      setNotice("此流程还没有已发布版本，请先发布后再执行。");
      return;
    }
    setLaunching(true);
    setNotice("正在读取流程版本…");
    try {
      const revision = await getWorkflowRevision(
        RPA_SERVICE_URL,
        flow.id,
        flow.publishedVersion,
      );
      setLaunchFlow(flow);
      setLaunchGraph(revision.graph);
      setLaunchMode(mode);
      if (mode === 'schedule') {
        setScheduleStartMode('now');
        setScheduleStartAt('');
        setScheduleEndAt('');
      }
      const previous = initialExecutionInputText(flow.id, revision.graph.context?.inputs ?? [], revision.graph.context?.variables ?? [], true, mode);
      setInputText({ ...previous.inputs });
      setSecretText({ ...previous.secrets });
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取流程版本失败");
    } finally {
      setLaunching(false);
    }
  };

  const saveSchedule = async (): Promise<void> => {
    if (!launchFlow || !launchGraph || launchFlow.publishedVersion === null || launching) return;
    setRunMessage('');
    try {
      const inputs: Record<string, JsonValue> = {};
      for (const definition of definitions) {
        const value = parseInput(inputText[definition.name] ?? '', definition);
        if (value === undefined) {
          if (definition.required && definition.defaultValue !== '******') throw new Error(`请填写必填项「${definition.description || definition.name}」`);
          continue;
        }
        inputs[definition.name] = value;
      }
      const [hour, minute] = scheduleTime.split(':').map(Number);
      if (scheduleStartMode === 'custom' && (!scheduleStartAt || !Number.isFinite(Date.parse(scheduleStartAt)))) throw new Error('请选择有效的开始时间');
      if (scheduleEndAt && !Number.isFinite(Date.parse(scheduleEndAt))) throw new Error('请选择有效的截止时间');
      const startAt = scheduleStartMode === 'custom' ? new Date(scheduleStartAt).toISOString() : undefined;
      const endAt = scheduleEndAt ? new Date(scheduleEndAt).toISOString() : undefined;
      if (endAt && Date.parse(endAt) < Date.now()) throw new Error('截止时间已过去，请重新选择');
      if (startAt && endAt && Date.parse(endAt) < Date.parse(startAt)) throw new Error('截止时间不能早于开始时间');
      const now = Date.now();
      if (nextScheduleOccurrence({
        id: 'preview', kind: scheduleKind, intervalMinutes: scheduleKind === 'interval' ? scheduleInterval : null,
        hour: scheduleKind === 'interval' ? null : hour, minute: scheduleKind === 'interval' ? null : minute,
        weekday: scheduleKind === 'weekly' ? scheduleWeekday : null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        createdAt: new Date(now).toISOString(), startAt, endAt, enabled: true,
      }, now) === null) throw new Error('当前开始和截止时间范围内没有可执行时刻，请调整定时规则');
      const studio = window.studio;
      if (!studio) throw new Error('当前窗口不支持本机定时执行');
      setLaunching(true);
      const device = await studio.getDeviceInfo();
      const subflows = await loadSubflowBundle(RPA_SERVICE_URL, launchGraph);
      if (workflowNeedsBrowser([launchGraph, ...subflows]) && missingStartUrl(launchGraph) && !subflows.some(item => item.nodes.some(node => node.config.type === 'start' && node.config.url.trim() !== ''))) {
        throw new Error('流程和子流程都没有配置开始 URL，无法定时运行页面步骤');
      }
      await createSchedule(RPA_SERVICE_URL, {
        workflowId: launchFlow.id, workflowVersion: launchFlow.publishedVersion,
        deviceId: device.deviceId, deviceName: device.deviceName,
        kind: scheduleKind,
        ...(scheduleKind === 'interval' ? { intervalMinutes: scheduleInterval } : { hour, minute }),
        ...(scheduleKind === 'weekly' ? { weekday: scheduleWeekday } : {}),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, startAt, endAt, inputs,
      });
      rememberLaunchInputs();
      setLaunchFlow(undefined);
      setLaunchGraph(undefined);
      setTab('schedules');
      await refresh();
      window.dispatchEvent(new Event('rpa:schedules-changed'));
      setNotice('定时任务已保存；软件运行且当前 PMS 账号已登录时，由本机按时执行。');
    } catch (error) {
      setRunMessage(error instanceof Error ? error.message : '保存定时任务失败');
    } finally {
      setLaunching(false);
    }
  };

  const changeScheduleState = async (schedule: WorkflowSchedule): Promise<void> => {
    if (scheduleActionId !== undefined) return;
    setScheduleActionId(schedule.id);
    try {
      await toggleSchedule(RPA_SERVICE_URL, schedule.id, !schedule.enabled);
      window.dispatchEvent(new CustomEvent('rpa:schedule-state-changed', { detail: { id: schedule.id, enabled: !schedule.enabled } }));
      await window.studio?.notifyScheduleState(schedule.id, !schedule.enabled).catch(() => undefined);
      await refresh();
      window.dispatchEvent(new Event('rpa:schedules-changed'));
      setNotice(schedule.enabled ? '定时任务已暂停，当前执行正在停止' : '定时任务已恢复');
    } catch (error) { setNotice(error instanceof Error ? error.message : '更新定时任务失败'); }
    finally { setScheduleActionId(undefined); }
  };

  const removeSchedule = async (schedule: WorkflowSchedule): Promise<void> => {
    if (!window.confirm(`确定删除「${schedule.workflowName ?? schedule.workflowId}」的定时任务吗？历史执行记录会保留。`)) return;
    if (scheduleActionId !== undefined) return;
    setScheduleActionId(schedule.id);
    try {
      await deleteSchedule(RPA_SERVICE_URL, schedule.id);
      await refresh();
      window.dispatchEvent(new Event('rpa:schedules-changed'));
      setNotice('定时任务已删除');
    } catch (error) { setNotice(error instanceof Error ? error.message : '删除定时任务失败'); }
    finally { setScheduleActionId(undefined); }
  };

  const runSelected = async (): Promise<void> => {
    if (launchFlow === undefined || launchGraph === undefined) return;
    setRunMessage("");
    const issue = firstIssue(launchGraph);
    if (issue !== undefined) {
      setRunMessage(issue.message);
      return;
    }
    let inputs: Record<string, JsonValue> = {};
    let variables: Record<string, JsonValue> = {};
    try {
      for (const definition of definitions) {
        const text = inputText[definition.name] ?? "";
        const value = parseInput(text, definition);
        if (value === undefined) {
          if (definition.required)
            throw new Error(
              `请填写必填项「${definition.description || definition.name}」`,
            );
          continue;
        }
        inputs[definition.name] = value;
      }
      for (const definition of secretDefinitions) {
        const value = parseInput(secretText[definition.name] ?? "", {
          ...definition,
          defaultValue: undefined,
        });
        if (value === undefined || value === null || value === "")
          throw new Error(
            `请填写敏感固定变量「${definition.description || definition.name}」`,
          );
        variables[definition.name] = value;
      }
    } catch (error) {
      setRunMessage(readableRunError(error));
      return;
    }
    rememberLaunchInputs();
    const secrets = [
      ...definitions
        .filter((item) => item.secret)
        .map((item) => String(inputs[item.name] ?? "")),
      ...Object.values(variables).map((value) =>
        typeof value === "string" ? value : JSON.stringify(value),
      ),
    ].filter((value) => value !== "" && value !== "null");
    const studio = window.studio;
    if (studio === undefined) {
      setRunMessage("当前窗口不支持本机执行");
      return;
    }
    const runId = crypto.randomUUID();
    setLaunching(true);
    setNotice("正在创建执行记录…");
    let localFailure: string | undefined;
    try {
      const device = await studio.getDeviceInfo();
      const subflows = await loadSubflowBundle(RPA_SERVICE_URL, launchGraph);
      if (
        workflowNeedsBrowser([launchGraph, ...subflows]) &&
        missingStartUrl(launchGraph) &&
        !subflows.some((item) =>
          item.nodes.some(
            (node) =>
              node.config.type === "start" && node.config.url.trim() !== "",
          ),
        )
      ) {
        throw new Error(
          "流程和子流程都没有配置开始 URL；请在开始节点填写一个初始地址",
        );
      }
      const created = await createExecution(RPA_SERVICE_URL, {
        workflowId: launchFlow.id,
        workflowVersion: launchFlow.publishedVersion as number,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        clientVersion: device.clientVersion,
        inputs,
      });
      setLaunchFlow(undefined);
      setLaunchGraph(undefined);
      setLive({ record: created, events: [] });
      setTab("history");
      setNotice("已在本机启动流程，执行记录正在同步到服务端");

      let uploaded = 0;
      let sequence = 0;
      let uploadChain = Promise.resolve();
      let syncError = "";
      onRunActivityChange?.({ runId, workflowName: launchFlow.name });
      const stop = studio.onRunUpdate(({ runId: updateRunId, state }) => {
        if (updateRunId !== runId) return;
        onRunActivityChange?.({ runId, workflowName: launchFlow.name, state });
        const newEvents: ExecutionEvent[] = state.logs
          .slice(uploaded)
          .map((log) => ({
            sequence: ++sequence,
            nodeId: log.nodeId,
            nodeName: log.nodeName.slice(0, 200),
            message: safeEventMessage(log.message, secrets),
            at: log.at,
            notificationEvent: log.notificationEvent,
            notificationValues: log.notificationValues,
          }));
        uploaded = state.logs.length;
        setLive((current) =>
          current?.record.id === created.id ? { ...current, state, events: [...current.events, ...newEvents] } : current,
        );
        if (newEvents.length > 0) {
          uploadChain = uploadChain
            .then(async () => {
              for (let offset = 0; offset < newEvents.length; offset += 250) {
                await appendExecutionEvents(
                  RPA_SERVICE_URL,
                  created.id,
                  newEvents.slice(offset, offset + 250),
                );
              }
            })
            .catch((error) => {
              syncError =
                error instanceof Error ? error.message : "执行日志同步失败";
            });
        }
      });
      let finalState: DryRunState;
      try {
        finalState = await studio.runWorkflow(launchGraph, {
          runId,
          executionId: created.id,
          inputs,
          variables,
          headless: launchHeadless,
          openDebugBrowserOnPageActionFailure: launchHeadless,
          subflows,
        });
      } catch (error) {
        const message = safeEventMessage(readableRunError(error), secrets);
        localFailure = message;
        setRunMessage(message);
        setLive((current) =>
          current?.record.id === created.id
            ? { ...current, error: message }
            : current,
        );
        await uploadChain;
        const cancelled = message.includes('流程已由用户停止');
        const failedRecord = await finishExecution(RPA_SERVICE_URL, created.id, {
          status: cancelled ? "cancelled" : "failed",
          error: cancelled ? undefined : message,
        });
        setLive((current) =>
          current?.record.id === created.id ? { ...current, record: failedRecord, error: cancelled ? undefined : message } : current,
        );
        if (cancelled) {
          setNotice('流程已停止');
          return;
        }
        throw error;
      } finally {
        stop();
      }
      const finalStatus =
        finalState.status === "succeeded" ? "succeeded" : "failed";
      if (finalStatus === "failed") {
        localFailure = safeEventMessage(failedRunReason(finalState), secrets);
        const debugHint = finalState.debugBrowser?.opened
          ? "已打开调试浏览器：可交互页面为按失败地址恢复的副本，另一标签页保留失败瞬间截图；未重新执行流程。"
          : finalState.debugBrowser?.message
            ? `调试浏览器未能打开：${safeEventMessage(finalState.debugBrowser.message, secrets)}`
            : "";
        setRunMessage(debugHint ? `${localFailure}；${debugHint}` : localFailure);
      }
      await uploadChain;
      const saved = await finishExecution(RPA_SERVICE_URL, created.id, {
        status: finalStatus,
        outputs: redactJson(finalState.variables ?? {}, secrets) as Readonly<
          Record<string, JsonValue>
        >,
        error:
          finalState.status === "failed"
            ? localFailure
            : undefined,
      });
      setLive({
        record: saved,
        state: finalState,
        events: finalState.logs.map((log, index) => ({ sequence: index + 1, nodeId: log.nodeId, nodeName: log.nodeName, message: safeEventMessage(log.message, secrets), at: log.at })),
        ...(syncError
          ? { error: `运行已结束，但部分日志未同步：${syncError}` }
          : {}),
      });
      if (saved.status === 'waiting_approval') setNotice('循环扫描已完成，等待各轮审批及分支续跑');
      else if (saved.status === 'failed') setNotice(saved.error || '审批分支执行失败');
      else if (finalStatus === "succeeded") setNotice("本机执行成功");
      await refresh();
    } catch (error) {
      if (localFailure === undefined) setRunMessage(safeEventMessage(readableRunError(error), secrets));
      await refresh();
    } finally {
      setLaunching(false);
      onRunActivityChange?.(undefined);
    }
  };

  const loadScheduleHistory = async (schedule: WorkflowSchedule, targetPage: number): Promise<void> => {
    setOccurrenceLoading(true);
    setOccurrenceError('');
    try {
      const result = await listScheduleOccurrences(RPA_SERVICE_URL, schedule.id, targetPage, pageSize);
      setOccurrences(result.items);
      setOccurrencePage(result.page);
      setOccurrenceTotal(result.total);
    } catch (error) {
      setOccurrenceError(error instanceof Error ? error.message : '读取定时执行记录失败');
    } finally { setOccurrenceLoading(false); }
  };

  const openScheduleHistory = (schedule: WorkflowSchedule): void => {
    setScheduleHistory(schedule);
    setOccurrences([]);
    setOccurrencePage(1);
    setOccurrenceTotal(0);
    void loadScheduleHistory(schedule, 1);
  };

  const openDetail = async (record: Pick<ExecutionRecord, 'id'>): Promise<void> => {
    setDetailLoading(true);
    try {
      setDetail(await getExecution(RPA_SERVICE_URL, record.id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取执行详情失败");
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    if (initialRecordId) void openDetail({ id: initialRecordId });
  }, [initialRecordId]);

  useEffect(() => {
    if (!scheduleHistory) return;
    const timer = window.setInterval(() => { void loadScheduleHistory(scheduleHistory, occurrencePage); }, 5_000);
    return () => window.clearInterval(timer);
  }, [scheduleHistory?.id, occurrencePage]);

  useEffect(() => {
    if (!detail || (detail.status !== 'running' && detail.status !== 'waiting_approval')) return;
    const id = detail.id;
    const timer = window.setInterval(() => {
      void getExecution(RPA_SERVICE_URL, id).then(next => { setDetail(current => current?.id === id ? next : current); }).catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [detail?.id, detail?.status]);

  return (
    <section className="workbench-content execution-center">
      <div className="workbench-page-heading">
        <div>
          <span className="eyebrow">
            {approvalOnly ? "APPROVAL TASKS" : "LOCAL RUNNER"}
          </span>
          <h1>{approvalOnly ? "审批列表" : "执行中心"}</h1>
          <p>
            {approvalOnly
              ? "查看当前执行人的待审批任务，并决定流程继续或拒绝。"
              : "流程在这台电脑本地运行，服务端保存执行记录和日志。"}
          </p>
        </div>
        <div className="execution-space-actions"><label>查看空间<select aria-label="执行与审批空间筛选" value={scope} onChange={event => { setScope(event.target.value); setPage(1); }}><option value="all">全部空间</option>{scope !== 'all' && !workspaces.some(item => item.id === scope) ? <option value={scope}>{scope === 'default' ? '默认空间' : scope}</option> : null}{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button
          className="workbench-primary"
          disabled={loading || launching}
          onClick={() => {
            void refresh();
            if (tab === 'approvals' && approvalView === 'history') setApprovalHistoryRefresh(value => value + 1);
          }}
        >刷新</button></div>
      </div>
      {approvalOnly ? (
        <div className="approval-list-summary">
          <strong>{approvalTotal}</strong>
          <span>条待审批任务</span>
        </div>
      ) : (
        <div className="execution-tabs">
          <button
            className={tab === "flows" ? "active" : ""}
            onClick={() => {
              setTab("flows");
            }}
          >
            选择流程
          </button>
          <button
            className={tab === "history" ? "active" : ""}
            onClick={() => {
              setTab("history");
            }}
          >
            执行记录 <span>{total}</span>
          </button>
          <button className={tab === 'schedules' ? 'active' : ''} onClick={() => { setTab('schedules'); }}>定时任务 <span>{schedules.length}</span></button>
        </div>
      )}
      {notice ? (
        <p className="execution-notice" role="status">
          {notice}
        </p>
      ) : null}
      {runMessage ? (
        <div className="execution-message" role="alert">
          <span className="execution-message-icon" aria-hidden="true">!</span>
          <div><strong>执行失败</strong><p>{runMessage}</p></div>
          <button type="button" aria-label="关闭执行错误提示" onClick={() => { setRunMessage(""); }}>×</button>
        </div>
      ) : null}
      {live ? <LiveExecutionPanel record={live.record} state={live.state} events={live.events} error={live.error} onOpenDetail={() => { void openDetail(live.record) }} onDismiss={() => { setLive(undefined) }} /> : null}
      {tab === "flows" ? (
        <>
          <div className="workbench-list-toolbar">
            <label className="workbench-search">
              <span>⌕</span>
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                placeholder="搜索要运行的流程…"
              />
            </label>
            <span>{filteredFlows.length} 个流程</span>
          </div>
          {loading ? (
            <div className="workbench-empty">
              <span className="workbench-spinner" />
              正在读取流程…
            </div>
          ) : filteredFlows.length === 0 ? (
            <div className="workbench-empty">
              <strong>没有可运行的流程</strong>
              <p>只有已发布的正式版本可以执行；请先到流程管理中发布流程。</p>
            </div>
          ) : (
            <div className="workbench-flow-grid">
              {filteredFlows.map((flow) => (
                <article className="workbench-flow-card" key={flow.id}>
                  <div className="execution-flow-card">
                    <span className="workbench-flow-icon">▶</span>
                    <strong>{flow.name}</strong>
                    <small>
                      {workspaces.find(item => item.id === flow.workspaceId)?.name ?? flow.workspaceId} · 已发布版本 v{flow.publishedVersion}
                      {flow.status === "draft" ? " · 有未发布草稿" : ""}
                    </small>
                    <div className="execution-flow-actions">
                      <button
                        type="button"
                        className="workbench-primary"
                        disabled={launching || live?.record.status === "running"}
                        onClick={() => {
                          void openLaunch(flow);
                        }}
                      >
                        选择并执行
                      </button>
                      <button type="button" className="execution-schedule-create" disabled={launching} onClick={() => { void openLaunch(flow, 'schedule'); }}><ScheduleActionIcon kind="clock" />定时执行</button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      ) : tab === 'schedules' ? (
        <div className="execution-record-list">
          <div className="execution-schedule-toolbar"><label><input type="checkbox" checked={showDeletedSchedules} onChange={event => setShowDeletedSchedules(event.target.checked)} />显示已删除任务的历史</label></div>
          {schedules.length === 0 ? <div className="workbench-empty"><strong>还没有定时任务</strong><p>从“选择流程”中找到已发布流程，点击“定时执行”创建。</p></div> : schedules.map(schedule => (
            <div className="execution-record-row execution-schedule-row" key={schedule.id}>
              <span className={`execution-status is-${schedule.deletedAt || !schedule.enabled || (schedule.endAt && Date.parse(schedule.endAt) < Date.now()) ? 'cancelled' : 'running'}`}>{schedule.deletedAt ? '已删除' : !schedule.enabled ? '已暂停' : schedule.endAt && Date.parse(schedule.endAt) < Date.now() ? '已截止' : '已启用'}</span>
              <span className="execution-record-main"><strong>{schedule.workflowName ?? schedule.workflowId}</strong><small>
                v{schedule.workflowVersion} · {schedule.kind === 'interval' ? `每 ${schedule.intervalMinutes} 分钟` : schedule.kind === 'daily' ? `每天 ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}` : `每周${['日', '一', '二', '三', '四', '五', '六'][schedule.weekday ?? 0]} ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`} · {schedule.deviceName} · {schedule.timezone}
                {` · 开始：${schedule.startAt ? new Date(schedule.startAt).toLocaleString() : '创建后立即生效'} · 截止：${schedule.endAt ? new Date(schedule.endAt).toLocaleString() : '不截止'}`}
                {schedule.lastOccurrence ? ` · 最近触发：${new Date(schedule.lastOccurrence.scheduledAt).toLocaleString()}（${schedule.lastOccurrence.status}）` : ''}
              </small></span>
              <div className="execution-schedule-actions">
                <button type="button" className="execution-schedule-toggle execution-schedule-history" onClick={() => openScheduleHistory(schedule)}><ScheduleActionIcon kind="history" />执行记录</button>
                {!schedule.deletedAt ? <><button type="button" className={`execution-schedule-toggle ${schedule.enabled ? 'execution-schedule-pause' : 'execution-schedule-resume'}`} disabled={scheduleActionId !== undefined} onClick={() => { void changeScheduleState(schedule); }}><ScheduleActionIcon kind={schedule.enabled ? 'pause' : 'play'} />{scheduleActionId === schedule.id ? '处理中…' : schedule.enabled ? '暂停任务' : '恢复任务'}</button>
                <button type="button" className="execution-schedule-delete" disabled={scheduleActionId !== undefined} onClick={() => { void removeSchedule(schedule); }}><ScheduleActionIcon kind="delete" />删除</button></> : null}
              </div>
            </div>
          ))}
        </div>
      ) : tab === "approvals" ? (
        <>
          <div className="approval-view-tabs" role="tablist" aria-label="审批任务分类">
            <button type="button" role="tab" aria-selected={approvalView === 'pending'} className={approvalView === 'pending' ? 'active' : ''} onClick={() => setApprovalView('pending')}>待审批 <span>{approvalTotal}</span></button>
            <button type="button" role="tab" aria-selected={approvalView === 'history'} className={approvalView === 'history' ? 'active' : ''} onClick={() => setApprovalView('history')}>审批历史</button>
          </div>
          {approvalView === 'pending' ? loading ? (
            <div className="workbench-empty">
              <span className="workbench-spinner" />
              正在读取待审批任务…
            </div>
          ) : approvals.length === 0 ? (
            <div className="workbench-empty">
              <strong>没有待审批任务</strong>
              <p>流程运行到人工审批节点后，会出现在这里。</p>
            </div>
          ) : (
            <div className="execution-record-list">
              {approvals.map((item) => (
                <button
                  type="button"
                  className="execution-record-row"
                  key={item.id}
                  onClick={() => {
                    setActiveApproval(item);
                    setApprovalComment("");
                  }}
                >
                  <span className="execution-status is-waiting_approval">
                    待审批
                  </span>
                  <span className="execution-record-main">
                    <strong>{item.title}</strong>
                    <small>
                      {workspaces.find(space => space.id === item.workspaceId)?.name ?? item.workspaceId} · {item.nodeName} · {item.deviceName}
                    </small>
                  </span>
                  <time>{new Date(item.createdAt).toLocaleString()}</time>
                  <i>›</i>
                </button>
              ))}
            </div>
          ) : approvalHistoryLoading ? (
            <div className="workbench-empty"><span className="workbench-spinner" />正在读取审批历史…</div>
          ) : approvalHistoryError ? (
            <div className="workbench-empty"><strong>读取审批历史失败</strong><p>{approvalHistoryError}</p></div>
          ) : approvalHistory.length === 0 ? (
            <div className="workbench-empty"><strong>暂无审批历史</strong><p>通过、未通过、超时或取消的审批会显示在这里。</p></div>
          ) : (
            <>
              <div className="execution-record-list">
                {approvalHistory.map(item => (
                  <button type="button" className="execution-record-row approval-history-row" key={item.id} onClick={() => { setActiveApproval(item); setApprovalComment(''); }}>
                    <span className={`execution-status is-${item.status}`}>{approvalStatusLabel(item.status)}</span>
                    <span className="execution-record-main">
                      <strong>{item.workflowName ? `${item.workflowName} · ` : ''}{item.title}</strong>
                      <small>{workspaces.find(space => space.id === item.workspaceId)?.name ?? item.workspaceId} · {item.nodeName} · 审批人：{item.approverName || '未记录'}</small>
                      {item.status === 'rejected' ? <span className="approval-history-reason">不通过原因：{item.comment?.trim() || '未填写原因'}</span> : null}
                      {item.continuationStatus ? <span className="approval-history-reason">分支续跑：{{ pending: '待审批', ready: '待本机执行', claimed: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' }[item.continuationStatus]}</span> : null}
                    </span>
                    <time>{new Date(item.decidedAt ?? item.createdAt).toLocaleString()}</time>
                    <i>›</i>
                  </button>
                ))}
              </div>
              {approvalHistoryTotal > pageSize ? <Pagination page={approvalHistoryPage} totalPages={Math.ceil(approvalHistoryTotal / pageSize)} disabled={approvalHistoryLoading} onPageChange={setApprovalHistoryPage} /> : null}
            </>
          )}
        </>
      ) : (
        <>
          <div className="execution-history-toolbar">
            <label className="execution-history-search">
              <span aria-hidden="true">⌕</span>
              <input type="search" maxLength={100} value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} placeholder="搜索流程名称、执行 ID、执行人或设备" aria-label="搜索执行记录" />
            </label>
            {historyQuery ? <button type="button" className="execution-history-clear" onClick={() => setHistoryQuery("")}>清空</button> : null}
            <span className="execution-history-count">共 {total} 条记录</span>
          </div>
          {loading ? (
            <div className="workbench-empty">
              <span className="workbench-spinner" />
              正在读取执行记录…
            </div>
          ) : records.length === 0 ? (
            <div className="workbench-empty">
              <strong>{appliedHistoryQuery ? "没有匹配的执行记录" : "还没有执行记录"}</strong>
              <p>{appliedHistoryQuery ? "试试其他流程名称、执行 ID、执行人或设备名称。" : "选择一个流程并在本机启动，记录会出现在这里。"}</p>
            </div>
          ) : (
            <div className="execution-record-list">
              {records.map((record) => (
                <button
                  type="button"
                  className="execution-record-row"
                  key={record.id}
                  onClick={() => {
                    void openDetail(record);
                  }}
                >
                  <span className={`execution-status is-${record.status}`}>
                    {statusLabel(record.status)}
                  </span>
                  <span className="execution-record-main">
                    <strong>{record.workflowName}</strong>
                    <small>
                      {workspaces.find(item => item.id === record.workspaceId)?.name ?? record.workspaceId} · v{record.workflowVersion} · 执行人：{record.executorName ?? '历史未记录'} · {record.deviceName}
                    </small>
                  </span>
                  <time>{new Date(record.startedAt).toLocaleString()}</time>
                  <i>›</i>
                </button>
              ))}
            </div>
          )}
          {total > pageSize ? (
            <Pagination
              page={page}
              totalPages={Math.ceil(total / pageSize)}
              disabled={loading}
              onPageChange={setPage}
            />
          ) : null}
        </>
      )}
      {launchFlow && launchGraph ? (
        <div
          className="execution-dialog-backdrop"
          role="presentation"
          onClick={() => {
            if (!launching) {
              rememberLaunchInputs();
              setLaunchFlow(undefined);
              setLaunchGraph(undefined);
              setNotice("");
            }
          }}
        >
          <section
            className="execution-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="启动流程"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <header>
              <div>
                <h2>{launchMode === 'schedule' ? '创建定时任务' : '启动流程'}</h2>
                <p>
                  {launchFlow.name} · 已发布版本 v{launchFlow.publishedVersion} ·
                  {launchMode === 'schedule' ? '由本机定时运行' : '在本机运行'}
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭"
                disabled={launching}
                onClick={() => {
                  rememberLaunchInputs();
                  setLaunchFlow(undefined);
                  setLaunchGraph(undefined);
                  setNotice("");
                }}
              >
                ×
              </button>
            </header>
            <div className="execution-dialog-body">
              {launchMode === 'schedule' ? (
                <div className="execution-local-note">
                  <span>⌘</span>
                  <p>定时任务始终在后台以无头浏览器执行；接口请求由本机直接发送。</p>
                </div>
              ) : (
                <>
                  <BrowserModePicker name="execution-browser-mode" headless={launchHeadless} onChange={setLaunchHeadless} />
                  <div className="execution-local-note">
                    <span>⌘</span>
                    <p>{launchHeadless ? '页面操作在后台 Chromium 中执行，不弹出窗口。' : '页面操作会打开可见 Chromium 窗口，便于查看点击和输入。'} 接口请求由本机直接发送。</p>
                  </div>
                </>
              )}
              {definitions.length === 0 && secretDefinitions.length === 0 ? (
                <p className="execution-no-inputs">
                  此流程没有需要填写的运行时输入。
                </p>
              ) : (
                definitions.map((item) => (
                  <label
                    className="execution-input-field"
                    key={`input-${item.name}`}
                  >
                    <span>
                      {item.description || item.name}
                      {item.required ? <em>必填</em> : null}
                    </span>
                    {item.type === "boolean" ? (
                      <select
                        value={inputText[item.name] ?? ""}
                        onChange={(event) => {
                          setInputText((current) => ({
                            ...current,
                            [item.name]: event.target.value,
                          }));
                        }}
                      >
                        <option value="">请选择</option>
                        <option value="true">是</option>
                        <option value="false">否</option>
                      </select>
                    ) : item.type === "object" || item.type === "array" ? (
                      <textarea
                        rows={3}
                        value={inputText[item.name] ?? ""}
                        onChange={(event) => {
                          setInputText((current) => ({
                            ...current,
                            [item.name]: event.target.value,
                          }));
                        }}
                        placeholder={
                          item.type === "object"
                            ? '{"key":"value"}'
                            : '["value"]'
                        }
                      />
                    ) : (
                      <input
                        type={
                          item.secret
                            ? "password"
                            : item.type === "number"
                              ? "number"
                              : "text"
                        }
                        value={inputText[item.name] ?? ""}
                        onChange={(event) => {
                          setInputText((current) => ({
                            ...current,
                            [item.name]: event.target.value,
                          }));
                        }}
                        onBlur={(event) => {
                          if (item.type === 'number' && event.currentTarget.value.trim() === '') setInputText(current => ({ ...current, [item.name]: '1' }));
                        }}
                        placeholder={
                          item.defaultValue === undefined
                            ? `请输入${item.type === "number" ? "数字" : "内容"}`
                            : stringValue(item.defaultValue)
                        }
                      />
                    )}
                  </label>
                ))
              )}
              {secretDefinitions.length > 0 ? (
                launchMode === 'schedule' ? <p className="execution-local-note">敏感固定变量将在定时触发时，从已发布版本安全读取；无需在此重复填写。</p> :
                <div className="execution-secret-section">
                  <strong>本次运行的敏感固定值</strong>
                  <p>
                    服务端已对敏感值脱敏，请在本机临时填写；不会写入执行记录。
                  </p>
                  {secretDefinitions.map((item) => (
                    <label
                      className="execution-input-field"
                      key={`secret-${item.name}`}
                    >
                      <span>
                        {item.description || item.name}
                        <em>必填</em>
                      </span>
                      {item.type === "object" || item.type === "array" ? (
                        <textarea
                          rows={3}
                          value={secretText[item.name] ?? ""}
                          onChange={(event) => {
                            setSecretText((current) => ({
                              ...current,
                              [item.name]: event.target.value,
                            }));
                          }}
                          placeholder={
                            item.type === "object"
                              ? '{"key":"value"}'
                              : '["value"]'
                          }
                        />
                      ) : item.type === "boolean" ? (
                        <select
                          value={secretText[item.name] ?? ""}
                          onChange={(event) => {
                            setSecretText((current) => ({
                              ...current,
                              [item.name]: event.target.value,
                            }));
                          }}
                        >
                          <option value="">请选择</option>
                          <option value="true">是</option>
                          <option value="false">否</option>
                        </select>
                      ) : (
                        <input
                          type="password"
                          value={secretText[item.name] ?? ""}
                          onChange={(event) => {
                            setSecretText((current) => ({
                              ...current,
                              [item.name]: event.target.value,
                            }));
                          }}
                          placeholder="仅用于本次本机运行"
                          onBlur={(event) => {
                            if (item.type === 'number' && event.currentTarget.value.trim() === '') setSecretText(current => ({ ...current, [item.name]: '1' }));
                          }}
                        />
                      )}
                    </label>
                  ))}
                </div>
              ) : null}
              {launchMode === 'schedule' ? <div className="execution-schedule-settings">
                <label>执行频率<select value={scheduleKind} onChange={event => setScheduleKind(event.target.value as WorkflowSchedule['kind'])}><option value="daily">每天</option><option value="weekly">每周</option><option value="interval">固定间隔</option></select></label>
                {scheduleKind === 'interval' ? <label>间隔分钟<ClearableNumberInput min={1} max={10080} value={scheduleInterval} onChange={event => setScheduleInterval(Number(event.target.value))} /></label> : <>
                  {scheduleKind === 'weekly' ? <label>星期<select value={scheduleWeekday} onChange={event => setScheduleWeekday(Number(event.target.value))}>{['日', '一', '二', '三', '四', '五', '六'].map((label, index) => <option key={index} value={index}>星期{label}</option>)}</select></label> : null}
                  <label>执行时间<input type="time" value={scheduleTime} onChange={event => setScheduleTime(event.target.value)} /></label>
                </>}
                <label>开始生效<select value={scheduleStartMode} onChange={event => setScheduleStartMode(event.target.value as 'now' | 'custom')}><option value="now">立即开始</option><option value="custom">指定时间</option></select></label>
                {scheduleStartMode === 'custom' ? <label>开始时间<input type="datetime-local" value={scheduleStartAt} onChange={event => setScheduleStartAt(event.target.value)} /></label> : null}
                <label>截止时间（可不填）<input type="datetime-local" value={scheduleEndAt} onChange={event => setScheduleEndAt(event.target.value)} /></label>
                <p>{schedulePreview}。过去的开始时间只用于计算排程，不补跑历史；不填截止时间则持续执行。</p>
                <p>按本机时区 {Intl.DateTimeFormat().resolvedOptions().timeZone} 计时。软件关闭或账号退出期间不会执行，重新打开后仅补最近 5 分钟内的触发。</p>
              </div> : null}
            </div>
            <footer>
              <button
                type="button"
                onClick={() => {
                  setLaunchFlow(undefined);
                  setLaunchGraph(undefined);
                  setNotice("");
                }}
                disabled={launching}
              >
                取消
              </button>
              <button
                type="button"
                className="workbench-primary"
                onClick={() => {
                  void (launchMode === 'schedule' ? saveSchedule() : runSelected());
                }}
                disabled={launching}
              >
                {launching ? (launchMode === 'schedule' ? '保存中…' : '正在启动…') : launchMode === 'schedule' ? '保存定时任务' : '▶ 在本机执行'}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {activeApproval ? (
        <div className="execution-dialog-backdrop" role="presentation">
          <section
            className="execution-dialog approval-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="审批任务"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <header>
              <div>
                <h2>{activeApproval.title}</h2>
                <p>{activeApproval.workflowName ? `${activeApproval.workflowName} · ` : ''}{activeApproval.nodeName} · {activeApproval.status === 'pending' ? '当前执行人审批' : '审批历史'}</p>
              </div>
              <button
                type="button"
                aria-label="关闭"
                disabled={approvalSubmitting}
                onClick={() => {
                  setActiveApproval(undefined);
                }}
              >
                ×
              </button>
            </header>
            <div className="execution-dialog-body">
              <ApprovalRichText className="approval-description" value={activeApproval.description || "请确认是否允许流程继续执行。"} />
              {activeApproval.fields.length > 0 ? (
                <dl className="approval-detail-list">
                  {activeApproval.fields.map((field, index) => (
                    <div key={`${field.label}-${index}`}>
                      <dt>{field.label || `字段 ${index + 1}`}</dt>
                      <dd>{typeof field.value === "string" ? <ApprovalRichText value={field.value} /> : typeof field.value === "object" && field.value !== null ? JSON.stringify(field.value, null, 2) : String(field.value ?? "")}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {activeApproval.status === 'pending' ? <label className="execution-input-field">
                <span>审批意见{activeApproval.requireCommentOnReject ? <em>拒绝时必填</em> : null}</span>
                <textarea rows={4} value={approvalComment} onChange={event => setApprovalComment(event.target.value)} placeholder="填写审批意见（可选）" />
              </label> : <div className="approval-history-result">
                <div><span>审批结果</span><strong className={`execution-status is-${activeApproval.status}`}>{approvalStatusLabel(activeApproval.status)}</strong></div>
                <div><span>审批人</span><strong>{activeApproval.approverName || '未记录'}</strong></div>
                <div><span>处理时间</span><strong>{new Date(activeApproval.decidedAt ?? activeApproval.createdAt).toLocaleString()}</strong></div>
                {activeApproval.continuationStatus ? <div><span>分支续跑</span><strong>{{ pending: '待审批', ready: '待本机执行', claimed: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' }[activeApproval.continuationStatus]}</strong></div> : null}
                {activeApproval.status === 'rejected' || activeApproval.comment?.trim() ? <div className="approval-history-comment"><span>{activeApproval.status === 'rejected' ? '不通过原因' : '审批意见'}</span><ApprovalRichText value={activeApproval.comment?.trim() || '未填写原因'} /></div> : null}
              </div>}
              {activeApproval.status === 'pending' && activeApproval.timeoutAt ? (
                <p className="properties-hint">
                  审批截止时间：
                  {new Date(activeApproval.timeoutAt).toLocaleString()}
                </p>
              ) : null}
            </div>
            <footer>
              {activeApproval.status === 'pending' ? <><button
                type="button"
                className="approval-reject"
                disabled={approvalSubmitting}
                onClick={() => {
                  void submitApproval("rejected");
                }}
              >
                拒绝
              </button>
              <button
                type="button"
                className="workbench-primary"
                disabled={approvalSubmitting}
                onClick={() => {
                  void submitApproval("approved");
                }}
              >
                {approvalSubmitting ? "正在提交…" : activeApproval.continuationStatus ? "通过并续跑本轮" : "通过并继续"}
              </button>
              </> : <>{activeApproval.continuationExecutionId ? <button type="button" onClick={() => { const id = activeApproval.continuationExecutionId!; setActiveApproval(undefined); void openDetail({ id }); }}>查看分支日志</button> : null}<button type="button" onClick={() => setActiveApproval(undefined)}>关闭</button></>}
            </footer>
          </section>
        </div>
      ) : null}
      {scheduleHistory && !detail ? <div className="execution-dialog-backdrop" role="presentation" onClick={() => setScheduleHistory(undefined)}>
        <section className="execution-dialog execution-detail-dialog" role="dialog" aria-modal="true" aria-label="定时执行记录" onClick={event => event.stopPropagation()}>
          <header><div><h2>{scheduleHistory.workflowName ?? scheduleHistory.workflowId} · 定时执行记录</h2><p>每次实际触发单独记录；软件关闭期间未触发的时间点不会产生记录。</p></div><button type="button" aria-label="关闭" onClick={() => setScheduleHistory(undefined)}>×</button></header>
          <div className="execution-dialog-body">
            {occurrenceError ? <p className="execution-error">{occurrenceError}</p> : null}
            {occurrenceLoading && occurrences.length === 0 ? <p>正在读取执行记录…</p> : occurrences.length === 0 ? <p>暂无触发记录</p> : <div className="execution-record-list">
              {occurrences.map(item => <div className="execution-record-row execution-schedule-occurrence" key={item.id}>
                <span className={`execution-status is-${occurrenceStatus(item).css}`}>{occurrenceStatus(item).label}</span>
                <span className="execution-record-main"><strong>计划触发：{new Date(item.scheduledAt).toLocaleString()}</strong><small>{item.execution?.startedAt ? `实际开始：${new Date(item.execution.startedAt).toLocaleString()}` : '尚未创建执行记录'}{item.error ? ` · ${item.error}` : ''}</small></span>
                {item.executionId ? <button type="button" className="execution-schedule-toggle" onClick={() => { void openDetail({ id: item.executionId as string }); }}>查看日志</button> : null}
              </div>)}
            </div>}
            {occurrenceTotal > pageSize ? <Pagination page={occurrencePage} totalPages={Math.ceil(occurrenceTotal / pageSize)} disabled={occurrenceLoading} onPageChange={target => { void loadScheduleHistory(scheduleHistory, target); }} /> : null}
          </div>
          <footer><button type="button" onClick={() => { void loadScheduleHistory(scheduleHistory, occurrencePage); }}>刷新</button><button type="button" onClick={() => setScheduleHistory(undefined)}>关闭</button></footer>
        </section>
      </div> : null}
      {detail ? (
        <div
          className="execution-dialog-backdrop"
          role="presentation"
          onClick={() => {
            setDetail(undefined);
          }}
        >
          <section
            className="execution-dialog execution-detail-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="执行详情"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <header>
              <div>
                <h2>{detail.workflowName}</h2>
                <p>
                  版本 v{detail.workflowVersion} ·{" "}
                  {new Date(detail.startedAt).toLocaleString()}
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setDetail(undefined);
                }}
              >
                ×
              </button>
            </header>
            <div className="execution-detail-meta">
              <span className={`execution-status is-${detail.status}`}>
                {statusLabel(detail.status)}
              </span>
              <span>执行人：{detail.executorName ?? '历史未记录'}</span>
              <span>设备：{detail.deviceName}</span>
              {detail.finishedAt ? (
                <span>
                  耗时{" "}
                  {Math.max(
                    0,
                    Math.round(
                      (new Date(detail.finishedAt).getTime() -
                        new Date(detail.startedAt).getTime()) /
                        1000,
                    ),
                  )}{" "}
                  秒
                </span>
              ) : null}
            </div>
            {detail.error ? (
              <p className="execution-error">{detail.error}</p>
            ) : null}
            <div className="execution-detail-events">
              {detailLoading ? (
                <p>正在加载详情…</p>
              ) : (detail.events ?? []).length === 0 ? (
                <p>暂无节点日志</p>
              ) : (
                detail.events?.map((event) => (
                  <article key={event.sequence} className={`is-${executionEventTone(event.message)}`}>
                    <time>{new Date(event.at).toLocaleTimeString()}</time>
                    <strong>{event.nodeName}</strong>
                    <p>{event.message}</p>
                  </article>
                ))
              )}
            </div>
            <footer>
              <button
                type="button"
                onClick={() => {
                  setDetail(undefined);
                }}
              >
                关闭
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
