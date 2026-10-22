import { describe, expect, it } from 'vitest'
import { createDefaultTemplate } from './template.ts'
import { createNode } from './mutate.ts'
import { validateGraph } from './validate.ts'

describe('API request configuration validation', () => {
  it('reports missing URL, invalid timeout and unnamed parameters on the request node', () => {
    const graph = createDefaultTemplate()
    const request = createNode('api-request', { x: 200, y: 120 })
    const next = { ...graph, nodes: [...graph.nodes, { ...request, config: { ...request.config, timeoutMs: 0, queryParams: [{ name: '', value: 'x' }] } }] }
    const codes = validateGraph(next).filter(item => item.nodeId === request.id).map(item => item.code)
    expect(codes).toContain('api-request-url-invalid')
    expect(codes).toContain('api-request-timeout-invalid')
    expect(codes).toContain('api-request-parameter-empty')
  })

  it('allows variable-based URLs to be resolved at runtime', () => {
    const graph = createDefaultTemplate()
    const request = createNode('api-request', { x: 200, y: 120 })
    const next = { ...graph, nodes: [...graph.nodes, { ...request, config: { ...request.config, url: '{{apiBase}}/orders' } }] }
    expect(validateGraph(next).some(item => item.nodeId === request.id && item.code === 'api-request-url-invalid')).toBe(false)
  })

  it('marks malformed JSON request body templates on the request node', () => {
    const graph = createDefaultTemplate()
    const request = createNode('api-request', { x: 200, y: 120 })
    const next = { ...graph, nodes: [...graph.nodes, { ...request, config: { ...request.config, body: '{"items":{{inputs.items}}}}' } }] }
    const bodyIssue = validateGraph(next).find(item => item.nodeId === request.id && item.code === 'api-request-body-invalid')
    expect(bodyIssue?.message).toContain('请求体 JSON 格式错误')
  })
})
