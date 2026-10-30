import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { formatRunLogs, RunPanel } from './RunPanel.tsx'

describe('RunPanel', () => {
  it('shows a compact status summary, validation issues, and timestamped node logs', () => {
    const html = renderToStaticMarkup(createElement(RunPanel, { issues: [{ code: 'entry-count', message: '缺少开始节点' }], run: {
      status: 'failed', currentNodeId: 'request', nodes: { start: 'succeeded', request: 'failed' },
      outputs: { start: { url: 'https://example.com' } },
      logs: [{ at: Date.UTC(2026, 9, 14, 8, 0, 0), nodeId: 'request', nodeName: '接口请求', message: '接口请求执行失败' }],
    } }))
    expect(html).toContain('执行失败')
    expect(html).toContain('已执行 2 个节点')
    expect(html).toContain('缺少开始节点')
    expect(html).toContain('接口请求执行失败')
    expect(html).toContain('节点产出')
    expect(html).toContain('复制日志')
    expect(html).not.toContain('<details class="run-output-preview" open')
  })

  it('formats all logs for clipboard copying', () => {
    const run = {
      status: 'succeeded' as const, nodes: {}, outputs: {},
      logs: [{ at: Date.UTC(2026, 9, 30, 8, 0, 0), nodeId: 'node-1', nodeName: '接口请求', message: '执行完成' }],
    }
    expect(formatRunLogs(run)).toContain('[接口请求] 执行完成')
  })
})
