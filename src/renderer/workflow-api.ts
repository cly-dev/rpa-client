import type { ApprovalPrompt, JsonValue, WorkflowGraph, WorkflowLlmConfig } from '@graph/types.ts'
import { RPA_SERVICE_URL } from '@graph/service-llms.ts'
import { authToken, expireAuthSession } from './auth.ts'

export { RPA_SERVICE_URL }

export interface WorkflowListItem {
  readonly id: string
  readonly workspaceId: string
  readonly name: string
  readonly kind: 'main' | 'reusable'
  readonly status: string
  readonly childCount: number
  readonly parentCount: number
  readonly draftVersion: number
  readonly publishedVersion: number | null
  readonly lastEditedById?: string | null
  readonly lastEditedByName?: string | null
  readonly lastPublishedById?: string | null
  readonly lastPublishedByName?: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface WorkflowRevisionItem {
  readonly id: string
  readonly version: number
  readonly stage: 'published'
  readonly publishedById?: string | null
  readonly publishedByName?: string | null
  readonly createdAt: string
}

export interface WorkflowDependencyItem {
  readonly callNodeId: string
  readonly childVersion: number
  readonly workflow: WorkflowListItem
}

export interface WorkflowDependencies {
  readonly children: readonly WorkflowDependencyItem[]
  readonly parents: readonly WorkflowDependencyItem[]
}

export interface WorkflowPackage {
  readonly format: 'rpa-workflow-package'
  readonly formatVersion: 1
  readonly exportedAt: string
  readonly roots: readonly { readonly sourceId: string; readonly sourceVersion: number }[]
  readonly workflows: readonly { readonly sourceId: string; readonly sourceVersion: number; readonly name: string; readonly kind: string; readonly graph: WorkflowGraph }[]
}

export interface WorkflowPackagePreview {
  readonly workspaceId: string
  readonly rootCount: number
  readonly workflowCount: number
  readonly items: readonly { readonly sourceId: string; readonly sourceVersion: number; readonly name: string; readonly kind: string; readonly isRoot: boolean; readonly childCount: number }[]
}

export interface WorkflowPackageImportResult {
  readonly workspaceId: string
  readonly items: readonly { readonly id: string; readonly name: string; readonly sourceId: string; readonly sourceVersion: number; readonly version: number }[]
  readonly roots: readonly { readonly sourceId: string; readonly sourceVersion: number; readonly id: string }[]
}

export interface WorkflowSchedule {
  readonly id: string
  readonly workflowId: string
  readonly workflowName?: string
  readonly workflowVersion: number
  readonly workspaceId: string
  readonly ownerId: string
  readonly ownerName: string
  readonly deviceId: string
  readonly deviceName: string
  readonly kind: 'interval' | 'daily' | 'weekly'
  readonly intervalMinutes: number | null
  readonly hour: number | null
  readonly minute: number | null
  readonly weekday: number | null
  readonly timezone: string
  readonly inputs: Readonly<Record<string, JsonValue>>
  readonly enabled: boolean
  readonly deletedAt?: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastOccurrence?: { readonly scheduledAt: string; readonly status: string; readonly executionId?: string | null; readonly error?: string | null } | null
}

export interface ScheduleOccurrence {
  readonly id: string
  readonly scheduleId: string
  readonly scheduledAt: string
  readonly status: 'claimed' | 'succeeded' | 'failed' | 'skipped'
  readonly executionId?: string | null
  readonly error?: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly execution?: { readonly id: string; readonly status: ExecutionStatus; readonly startedAt: string; readonly finishedAt?: string | null } | null
}

export interface LlmConfigItem extends WorkflowLlmConfig { readonly createdAt: string; readonly updatedAt: string }

export type ExecutionStatus = 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export interface ExecutionEvent { readonly sequence: number; readonly nodeId: string; readonly nodeName: string; readonly message: string; readonly at: number; readonly notificationEvent?: 'node.succeeded' | 'node.failed'; readonly notificationValues?: Readonly<Record<string, JsonValue>> }
export interface ExecutionRecord {
  readonly id: string
  readonly workflowId: string
  readonly workspaceId: string
  readonly workflowName: string
  readonly workflowVersion: number
  readonly deviceId: string
  readonly deviceName: string
  readonly executorId?: string | null
  readonly executorName?: string | null
  readonly status: ExecutionStatus
  readonly inputs: Readonly<Record<string, JsonValue>>
  readonly outputs?: Readonly<Record<string, JsonValue>>
  readonly error?: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly events?: readonly ExecutionEvent[]
  readonly webhooks?: readonly { readonly eventId: string; readonly eventType: string; readonly status: string; readonly attempts: number; readonly lastError?: string; readonly createdAt: string; readonly sentAt?: string }[]
}

export interface ApprovalRecord extends ApprovalPrompt {
  readonly workspaceId: string
  readonly status: 'pending' | 'approved' | 'rejected' | 'timeout' | 'cancelled'
  readonly deviceId: string
  readonly deviceName: string
  readonly comment?: string
  readonly approverId?: string
  readonly approverName?: string
  readonly createdAt: string
  readonly decidedAt?: string
}

interface ApiEnvelope<T> {
  readonly code: number
  readonly message: string
  readonly data: T
}

export interface WorkspaceItem {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly createdById?: string | null
  readonly createdByName?: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

function endpoint(baseUrl: string, resource: 'workflows' | 'workspaces' | 'llm-configs' | 'lists' | 'executions' | 'approvals' | 'webhooks' | 'schedules', path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${resource}${path}`
}

async function request<T>(baseUrl: string, resource: 'workflows' | 'workspaces' | 'llm-configs' | 'lists' | 'executions' | 'approvals' | 'webhooks' | 'schedules', path: string, init?: RequestInit): Promise<T> {
  let response: Response
  const token = authToken()
  if (!token) {
    expireAuthSession()
    throw new Error('请先登录')
  }
  try {
    response = await fetch(endpoint(baseUrl, resource, path), {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers, Authorization: `Bearer ${token}` },
    })
  } catch {
    throw new Error(`无法连接 RPA 服务：${baseUrl}。请确认后端已启动，并检查服务地址。`)
  }
  let body: ApiEnvelope<T>
  try { body = await response.json() as ApiEnvelope<T> }
  catch {
    if (response.status === 401) expireAuthSession(token)
    throw new Error(`服务端返回无效响应（HTTP ${response.status}）`)
  }
  if (response.status === 401 || body.code === 40100) {
    expireAuthSession(token)
    throw new Error(body.message || '登录已失效，请重新登录')
  }
  if (!response.ok || body.code !== 0) throw new Error(body.message || `请求失败（HTTP ${response.status}）`)
  return body.data
}

/** The editor loads model metadata through the same authenticated client as other business APIs. */
export async function loadServiceLlmConfigs(baseUrl = RPA_SERVICE_URL): Promise<WorkflowLlmConfig[]> {
  const items: WorkflowLlmConfig[] = []
  let page = 1
  while (true) {
    const result = await request<{ items: WorkflowLlmConfig[]; total: number }>(baseUrl, 'llm-configs', `?page=${page}&pageSize=100&sort=updatedAt&order=desc`)
    items.push(...result.items)
    if (items.length >= result.total || result.items.length === 0) return items
    page += 1
  }
}

export function listWorkspaces(baseUrl: string): Promise<{ items: WorkspaceItem[] }> {
  return request(baseUrl, 'workspaces', '')
}

export function createWorkspace(baseUrl: string, value: { name: string; description?: string }): Promise<WorkspaceItem> {
  return request(baseUrl, 'workspaces', '', { method: 'POST', body: JSON.stringify(value) })
}

export function updateWorkspace(baseUrl: string, id: string, value: { name: string; description: string }): Promise<WorkspaceItem> {
  return request(baseUrl, 'workspaces', `/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(value) })
}

export function deleteWorkspace(baseUrl: string, id: string): Promise<{ id: string }> {
  return request(baseUrl, 'workspaces', `/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function listWorkflows(baseUrl: string, page = 1, pageSize = 20, q = '', workspaceId?: string, status?: 'archived'): Promise<{ items: WorkflowListItem[]; total: number; page: number; pageSize: number }> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort: 'updatedAt', order: 'desc' })
  if (q.trim()) params.set('q', q.trim())
  if (workspaceId) params.set('workspaceId', workspaceId)
  if (status) params.set('status', status)
  return request(baseUrl, 'workflows', `?${params}`)
}

export function listSchedules(baseUrl: string, deviceId?: string, workspaceId?: string, includeDeleted = false): Promise<{ items: WorkflowSchedule[] }> {
  const params = new URLSearchParams()
  if (deviceId) params.set('deviceId', deviceId)
  if (workspaceId) params.set('workspaceId', workspaceId)
  if (includeDeleted) params.set('includeDeleted', 'true')
  return request(baseUrl, 'schedules', `?${params}`)
}

export function listScheduleOccurrences(baseUrl: string, id: string, page = 1, pageSize = 20): Promise<{ items: ScheduleOccurrence[]; total: number; page: number; pageSize: number }> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
  return request(baseUrl, 'schedules', `/${encodeURIComponent(id)}/occurrences?${params}`)
}

export function createSchedule(baseUrl: string, value: {
  workflowId: string; workflowVersion: number; deviceId: string; deviceName: string;
  kind: WorkflowSchedule['kind']; intervalMinutes?: number; hour?: number; minute?: number; weekday?: number;
  timezone: string; inputs: Readonly<Record<string, JsonValue>>;
}): Promise<WorkflowSchedule> {
  return request(baseUrl, 'schedules', '', { method: 'POST', body: JSON.stringify(value) })
}

export function toggleSchedule(baseUrl: string, id: string, enabled: boolean): Promise<WorkflowSchedule> {
  return request(baseUrl, 'schedules', `/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) })
}

export function deleteSchedule(baseUrl: string, id: string): Promise<{ id: string }> {
  return request(baseUrl, 'schedules', `/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function claimSchedule(baseUrl: string, id: string, deviceId: string, scheduledAt: string): Promise<{ claimed: boolean; occurrenceId?: string; workflowId?: string; workflowVersion?: number; inputs?: Readonly<Record<string, JsonValue>> }> {
  return request(baseUrl, 'schedules', `/${encodeURIComponent(id)}/claim`, { method: 'POST', body: JSON.stringify({ deviceId, scheduledAt }) })
}

export function linkScheduleExecution(baseUrl: string, id: string, occurrenceId: string, executionId: string): Promise<{ id: string; executionId: string }> {
  return request(baseUrl, 'schedules', `/${encodeURIComponent(id)}/occurrences/${encodeURIComponent(occurrenceId)}/execution`, { method: 'PATCH', body: JSON.stringify({ executionId }) })
}

export function completeScheduleOccurrence(baseUrl: string, id: string, occurrenceId: string, value: { status: 'succeeded' | 'failed' | 'skipped'; executionId?: string; error?: string }): Promise<{ id: string; status: string }> {
  return request(baseUrl, 'schedules', `/${encodeURIComponent(id)}/occurrences/${encodeURIComponent(occurrenceId)}`, { method: 'PATCH', body: JSON.stringify(value) })
}

export function exportWorkflowPackage(baseUrl: string, workflowIds: readonly string[]): Promise<WorkflowPackage> {
  return request(baseUrl, 'workflows', '/packages/export', { method: 'POST', body: JSON.stringify({ workflowIds }) })
}

export function previewWorkflowPackage(baseUrl: string, bundle: WorkflowPackage, workspaceId: string): Promise<WorkflowPackagePreview> {
  return request(baseUrl, 'workflows', '/packages/preview', { method: 'POST', body: JSON.stringify({ package: bundle, workspaceId }) })
}

export function importWorkflowPackage(baseUrl: string, bundle: WorkflowPackage, workspaceId: string): Promise<WorkflowPackageImportResult> {
  return request(baseUrl, 'workflows', '/packages/import', { method: 'POST', body: JSON.stringify({ package: bundle, workspaceId }) })
}

export function getWorkflow(baseUrl: string, id: string): Promise<WorkflowListItem & { graph: WorkflowGraph }> {
  return request(baseUrl, 'workflows', `/${encodeURIComponent(id)}`)
}

export function listWorkflowRevisions(baseUrl: string, id: string): Promise<{ items: WorkflowRevisionItem[] }> {
  return request(baseUrl, 'workflows', `/${encodeURIComponent(id)}/revisions`)
}

export function getWorkflowDependencies(baseUrl: string, id: string): Promise<WorkflowDependencies> {
  return request(baseUrl, 'workflows', `/${encodeURIComponent(id)}/dependencies`)
}

export function getWorkflowRevision(baseUrl: string, id: string, version: number): Promise<{ version: number; stage: string; graph: WorkflowGraph }> {
  return request(baseUrl, 'workflows', `/${encodeURIComponent(id)}/revisions/${version}`)
}

export async function loadSubflowBundle(baseUrl: string, root: WorkflowGraph, maxDepth = 10): Promise<WorkflowGraph[]> {
  const loaded = new Map<string, WorkflowGraph>()
  const visit = async (graph: WorkflowGraph, ancestry: readonly string[]): Promise<void> => {
    for (const node of graph.nodes) {
      if (node.config.type !== 'call-subflow') continue
      const { workflowId, workflowVersion } = node.config
      if (workflowId.trim() === '' || workflowVersion === undefined) throw new Error(`调用子流程节点「${node.name}」尚未选择已发布版本`)
      if (ancestry.includes(workflowId)) throw new Error(`检测到子流程循环调用：${[...ancestry, workflowId].join(' → ')}`)
      if (ancestry.length >= maxDepth) throw new Error(`子流程嵌套超过最大层级 ${maxDepth}`)
      const key = `${workflowId}@${workflowVersion}`
      let child = loaded.get(key)
      if (child === undefined) {
        const revision = await getWorkflowRevision(baseUrl, workflowId, workflowVersion)
        if (revision.stage !== 'published') throw new Error(`子流程「${revision.graph.name}」v${workflowVersion} 不是已发布版本`)
        child = revision.graph
        loaded.set(key, child)
      }
      await visit(child, [...ancestry, workflowId])
    }
  }
  await visit(root, [root.workflowId])
  return [...loaded.values()]
}

export function createWorkflow(baseUrl: string, graph: WorkflowGraph, workspaceId = 'default'): Promise<WorkflowListItem & { graph: WorkflowGraph }> {
  return request(baseUrl, 'workflows', '', { method: 'POST', body: JSON.stringify({ graph, workspaceId }) })
}

export function updateWorkflow(baseUrl: string, graph: WorkflowGraph): Promise<WorkflowListItem & { graph: WorkflowGraph }> {
  return request(baseUrl, 'workflows', `/${encodeURIComponent(graph.workflowId)}`, { method: 'PUT', body: JSON.stringify({ graph }) })
}

export function publishWorkflow(baseUrl: string, id: string): Promise<{ id: string; publishedVersion: number }> {
  return request(baseUrl, 'workflows', `/${encodeURIComponent(id)}/publish`, { method: 'POST' })
}

export function testDingTalkWebhook(baseUrl: string, value: { url: string; messageTemplate: string; workflowName: string; nodeName?: string }): Promise<{ message: string }> {
  return request(baseUrl, 'webhooks', '/test', { method: 'POST', body: JSON.stringify(value) })
}

export function copyWorkflow(baseUrl: string, id: string): Promise<WorkflowListItem> {
  return request(baseUrl, 'workflows', `/${encodeURIComponent(id)}/copy`, { method: 'POST' })
}

export function moveWorkflow(baseUrl: string, id: string, workspaceId: string): Promise<WorkflowListItem> {
  return request(baseUrl, 'workflows', `/${encodeURIComponent(id)}/workspace`, { method: 'PATCH', body: JSON.stringify({ workspaceId }) })
}

export function archiveWorkflow(baseUrl: string, id: string): Promise<WorkflowListItem> {
  return request(baseUrl, 'workflows', `/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function deleteWorkflowPermanently(baseUrl: string, id: string): Promise<{ id: string }> {
  return request(baseUrl, 'workflows', `/${encodeURIComponent(id)}/permanent`, { method: 'DELETE' })
}

export async function listLlmConfigs(baseUrl: string): Promise<{ items: LlmConfigItem[]; total: number; page: number; pageSize: number }> {
  const items: LlmConfigItem[] = []
  let page = 1
  while (true) {
    const result = await request<{ items: LlmConfigItem[]; total: number; page: number; pageSize: number }>(baseUrl, 'llm-configs', `?page=${page}&pageSize=100&sort=updatedAt&order=desc`)
    items.push(...result.items)
    if (items.length >= result.total || result.items.length === 0) return { ...result, items }
    page += 1
  }
}

export function createLlmConfig(baseUrl: string, config: WorkflowLlmConfig): Promise<LlmConfigItem> {
  return request(baseUrl, 'llm-configs', '', { method: 'POST', body: JSON.stringify(config) })
}

export function updateLlmConfig(baseUrl: string, config: WorkflowLlmConfig): Promise<LlmConfigItem> {
  const { id, ...body } = config
  return request(baseUrl, 'llm-configs', `/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) })
}

export function deleteLlmConfig(baseUrl: string, id: string): Promise<{ id: string }> {
  return request(baseUrl, 'llm-configs', `/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function testLlmConfig(baseUrl: string, id: string): Promise<{ ok: true; message: string }> {
  return request(baseUrl, 'llm-configs', `/${encodeURIComponent(id)}/test`, { method: 'POST' })
}

export function listExecutions(baseUrl: string, page = 1, pageSize = 20, workspaceId?: string): Promise<{ items: ExecutionRecord[]; total: number; page: number; pageSize: number }> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort: 'startedAt', order: 'desc' })
  if (workspaceId) params.set('workspaceId', workspaceId)
  return request(baseUrl, 'executions', `?${params}`)
}

export function getExecution(baseUrl: string, id: string): Promise<ExecutionRecord> {
  return request(baseUrl, 'executions', `/${encodeURIComponent(id)}`)
}

export function createExecution(baseUrl: string, value: { workflowId: string; workflowVersion: number; deviceId: string; deviceName: string; clientVersion: string; inputs: Readonly<Record<string, JsonValue>> }): Promise<ExecutionRecord> {
  return request(baseUrl, 'executions', '', { method: 'POST', body: JSON.stringify(value) })
}

export function appendExecutionEvents(baseUrl: string, id: string, events: readonly ExecutionEvent[]): Promise<{ accepted: number }> {
  return request(baseUrl, 'executions', `/${encodeURIComponent(id)}/events`, { method: 'POST', body: JSON.stringify({ events }) })
}

export function finishExecution(baseUrl: string, id: string, value: { status: Exclude<ExecutionStatus, 'running'>; outputs?: Readonly<Record<string, JsonValue>>; error?: string }): Promise<ExecutionRecord> {
  return request(baseUrl, 'executions', `/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(value) })
}

export function listApprovals(baseUrl: string, page = 1, pageSize = 50, status = 'pending', deviceId?: string, workspaceId?: string): Promise<{ items: ApprovalRecord[]; total: number; page: number; pageSize: number }> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), status, sort: 'createdAt', order: 'desc' })
  if (deviceId) params.set('deviceId', deviceId)
  if (workspaceId) params.set('workspaceId', workspaceId)
  return request(baseUrl, 'approvals', `?${params}`)
}

export function createApproval(baseUrl: string, prompt: ApprovalPrompt, device: { deviceId: string; deviceName: string }): Promise<ApprovalRecord> {
  return request(baseUrl, 'approvals', '', { method: 'POST', body: JSON.stringify({ ...prompt, ...device }) })
}

export function decideApproval(baseUrl: string, id: string, value: { decision: 'approved' | 'rejected'; comment: string; approverId: string; approverName: string }): Promise<ApprovalRecord> {
  return request(baseUrl, 'approvals', `/${encodeURIComponent(id)}/decision`, { method: 'POST', body: JSON.stringify(value) })
}
