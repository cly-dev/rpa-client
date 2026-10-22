import type { WorkflowGraph, WorkflowLlmConfig } from './types.ts'

export const RPA_SERVICE_URL = import.meta.env.VITE_RPA_SERVICE_URL.replace(/\/+$/, '')

interface ApiEnvelope<T> {
  readonly code: number
  readonly message: string
  readonly data: T
}

export class ServiceAuthExpiredError extends Error {}

/** Main-process metadata requests use the JWT supplied by the verified Studio session. */
export async function loadServiceLlmConfigs(baseUrl: string, token: string): Promise<WorkflowLlmConfig[]> {
  if (!token) throw new Error('请先登录')
  const items: WorkflowLlmConfig[] = []
  let page = 1
  while (true) {
    const url = `${baseUrl.replace(/\/+$/, '')}/llm-configs?page=${page}&pageSize=100&sort=updatedAt&order=desc`
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    let envelope: ApiEnvelope<{ items: WorkflowLlmConfig[]; total: number }>
    try { envelope = await response.json() as ApiEnvelope<{ items: WorkflowLlmConfig[]; total: number }> }
    catch {
      if (response.status === 401) throw new ServiceAuthExpiredError('登录已失效，请重新登录')
      throw new Error(`读取 AI 配置失败（HTTP ${response.status}）`)
    }
    if (response.status === 401 || envelope.code === 40100) throw new ServiceAuthExpiredError(envelope.message || '登录已失效，请重新登录')
    if (!response.ok || envelope.code !== 0) throw new Error(envelope.message || `读取 AI 配置失败（HTTP ${response.status}）`)
    items.push(...envelope.data.items)
    if (items.length >= envelope.data.total || envelope.data.items.length === 0) return items
    page += 1
  }
}

/** Runtime-only graph: never save these proxy URLs into a workflow draft. */
export function withServiceLlms(graph: WorkflowGraph, configs: readonly WorkflowLlmConfig[], sessionToken: string, baseUrl = RPA_SERVICE_URL): WorkflowGraph {
  if (!sessionToken.trim()) throw new Error('请先登录')
  const llms = configs.map(config => ({
    ...config,
    baseUrl: `${baseUrl.replace(/\/+$/, '')}/llm-configs/${encodeURIComponent(config.id)}`,
    chatPath: '/chat/completions',
    // Only the in-memory execution graph receives the service JWT. Saved AI configs
    // never expose the upstream provider key to the client.
    apiKey: sessionToken,
  }))
  return { ...graph, llms, llm: llms.find(item => item.enabled) }
}
