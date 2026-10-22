import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ExecutionRecord } from '../workflow-api.ts'
import { LiveExecutionPanel } from './LiveExecutionPanel.tsx'

const record: ExecutionRecord = {
  id: 'run-1', workflowId: 'flow-1', workspaceId: 'default', workflowName: '工单处理', workflowVersion: 3,
  deviceId: 'device-1', deviceName: '本机', executorName: '张三', status: 'running',
  inputs: {}, startedAt: '2026-10-14T08:00:00.000Z', createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z',
}

describe('LiveExecutionPanel', () => {
  it('shows the current node name rather than its internal ID and keeps multiline logs readable', () => {
    const html = renderToStaticMarkup(createElement(LiveExecutionPanel, {
      record,
      state: { status: 'running', currentNodeId: 'api_123', nodes: { start: 'succeeded', api_123: 'running' }, outputs: {}, logs: [] },
      events: [{ sequence: 1, nodeId: 'api_123', nodeName: '发送接口请求', message: '请求体：\n{"title":"示例"}', at: Date.UTC(2026, 9, 14, 8, 0, 1) }],
      onOpenDetail() {}, onDismiss() {},
    }))

    expect(html).toContain('发送接口请求')
    expect(html).not.toContain('当前节点：api_123')
    expect(html).toContain('请求体：\n{')
    expect(html).toContain('1</strong><small>条日志')
  })

  it('uses the final run state immediately, before the server record is refreshed', () => {
    const html = renderToStaticMarkup(createElement(LiveExecutionPanel, {
      record,
      state: { status: 'failed', currentNodeId: 'api_123', nodes: { api_123: 'failed' }, outputs: {}, logs: [] },
      events: [], onOpenDetail() {}, onDismiss() {},
    }))

    expect(html).toContain('执行失败')
    expect(html).toContain('收起本次执行')
  })
})
