import { describe, expect, it } from 'vitest'
import { createDefaultTemplate } from './template.ts'
import { createEdge, createNode, patchNode } from './mutate.ts'
import { reorderImageRecognitionCase } from './image-recognition-cases.ts'

describe('image recognition branches', () => {
  it('changes priority without changing the branch ID, prompt, or existing connection', () => {
    const image = createNode('image-recognition', { x: 200, y: 100 })
    if (image.config.type !== 'image-recognition') throw new Error('Expected image recognition node')
    const config = { ...image.config, cases: [
      { id: 'paid', name: '付款截图', prompt: '显示支付成功' },
      { id: 'other', name: '其他截图', prompt: '显示其他内容' },
    ] }
    const target = createNode('end', { x: 500, y: 100 })
    const template = createDefaultTemplate()
    const graph = { ...template, nodes: [...template.nodes, { ...image, config }, target], edges: [...template.edges, createEdge(image.id, 'case-paid', target.id)] }

    const moved = patchNode(graph, image.id, { config: reorderImageRecognitionCase(config, 0, 1) })
    const updated = moved.nodes.find(node => node.id === image.id)?.config
    expect(updated?.type === 'image-recognition' ? updated.cases.map(item => [item.id, item.prompt]) : []).toEqual([
      ['other', '显示其他内容'],
      ['paid', '显示支付成功'],
    ])
    expect(moved.edges.find(edge => edge.sourceNodeId === image.id)?.sourcePort).toBe('case-paid')
  })
})
