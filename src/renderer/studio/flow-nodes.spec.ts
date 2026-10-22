import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { createDefaultTemplate } from '@graph/template.ts'
import { createNode, createEdge } from '@graph/mutate.ts'
import { validateGraph } from '@graph/validate.ts'
import { toFlowNodes } from './flow-nodes.ts'
import { FlowNode, type StudioFlowNode } from './FlowNode.tsx'

describe('toFlowNodes', () => {
  it('keeps measured node dimensions while positions change during dragging', () => {
    const graph = createDefaultTemplate()
    const source = graph.nodes[1]!
    const measured = new Map(graph.nodes.map(node => [node.id, { width: 180, height: 90 }] as const))
    const moved = { ...graph, nodes: graph.nodes.map(node => node.id === source.id ? { ...node, position: { x: node.position.x + 40, y: node.position.y + 20 } } : node) }

    const before = toFlowNodes(graph, {}, undefined, () => {}, measured)
    const after = toFlowNodes(moved, {}, source.id, () => {}, measured)

    expect(after).toHaveLength(before.length)
    expect(after.every(node => node.measured?.width === 180 && node.measured?.height === 90)).toBe(true)
    expect(after.find(node => node.id === source.id)?.position).toEqual({ x: source.position.x + 40, y: source.position.y + 20 })
  })

  it('exposes the connected outlet state for a multi-way decision card', () => {
    const graph = createDefaultTemplate()
    const choice = createNode('switch', { x: 200, y: 100 })
    const target = createNode('end', { x: 500, y: 100 })
    const withChoice = { ...graph, nodes: [...graph.nodes, choice, target], edges: [...graph.edges, createEdge(choice.id, 'case-0', target.id)] }
    const card = toFlowNodes(withChoice, {}, undefined, () => {}, new Map()).find(node => node.id === choice.id)
    expect(card?.data.connectedPorts).toEqual(['case-0'])
  })

  it('shows scene names, prompt previews and connection state on the canvas card', () => {
    const choice = createNode('switch', { x: 200, y: 100 })
    const card = {
      id: choice.id,
      data: {
        type: choice.type, name: '判断客户意图', status: 'pending', connectedPorts: ['case-1'],
        config: { type: 'switch', mode: 'ai', cases: ['问候', '辱骂投诉'], casePrompts: ['打招呼的话', '含有辱骂或攻击性用语'] },
      },
      selected: false,
    } as unknown as NodeProps<StudioFlowNode>
    const markup = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(FlowNode, card)))
    expect(markup).toContain('AI 场景判断')
    expect(markup).toContain('辱骂投诉')
    expect(markup).toContain('含有辱骂或攻击性用语')
    expect(markup).toContain('已连接')
    expect(markup).toContain('待连接')
  })

  it('shows image recognition branches with the same scene card and stable outlet IDs', () => {
    const image = createNode('image-recognition', { x: 200, y: 100 })
    const card = {
      id: image.id,
      data: {
        type: image.type, name: '识别付款图片', status: 'pending', connectedPorts: ['case-paid'],
        config: { type: 'image-recognition', cases: [{ id: 'paid', name: '付款截图', prompt: '图片中显示支付成功' }, { id: 'other', name: '其他截图', prompt: '显示其他内容' }] },
      },
      selected: false,
    } as unknown as NodeProps<StudioFlowNode>
    const markup = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(FlowNode, card)))
    expect(markup).toContain('AI 图片识别')
    expect(markup).toContain('付款截图')
    expect(markup).toContain('图片中显示支付成功')
    expect(markup).toContain('data-handleid="case-paid"')
    expect(markup).toContain('已连接')
    expect(markup).toContain('待连接')
    expect(markup).toContain('否则')
  })

  it('keeps a visible source handle on the start node', () => {
    const start = createNode('start', { x: 0, y: 0 })
    const card = {
      id: start.id,
      data: { type: 'start', name: '开始', status: 'pending', connectedPorts: [], config: start.config },
      selected: false,
    } as unknown as NodeProps<StudioFlowNode>
    const markup = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(FlowNode, card)))
    expect(markup).toContain('拖动或点击右侧圆点连接下一节点')
    expect(markup).toContain('data-handleid="default"')
  })

  it('marks an invalid API request on the canvas with its validation message', () => {
    const graph = createDefaultTemplate()
    const request = createNode('api-request', { x: 200, y: 120 })
    const invalid = { ...graph, nodes: [...graph.nodes, request] }
    const card = toFlowNodes(invalid, {}, undefined, () => {}, new Map(), validateGraph(invalid)).find(node => node.id === request.id)
    expect(card?.data.issues).toContain('接口请求需要有效的 HTTP(S) 请求 URL')
    const markup = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(FlowNode, { ...card, selected: false } as NodeProps<StudioFlowNode>)))
    expect(markup).toContain('data-invalid="true"')
    expect(markup).toContain('接口请求需要有效的 HTTP(S) 请求 URL')
  })
})
