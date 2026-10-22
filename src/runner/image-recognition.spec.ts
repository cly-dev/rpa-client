import { describe, expect, it, vi } from 'vitest'
import { createEdge, createNode } from '@graph/mutate.ts'
import { parseWorkflow } from '@graph/parse.ts'
import { validateGraph } from '@graph/validate.ts'
import type { ImageRecognitionConfig, WorkflowGraph } from '@graph/types.ts'
import { runBrowser, type BrowserDriver } from './browser-run.ts'
import { runDry } from './dry-run.ts'
import { workflowNeedsBrowser } from './page-requirement.ts'

const tinyPng = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`

function fixture(): { graph: WorkflowGraph; nodeId: string; endings: readonly string[] } {
  const start = { ...createNode('start', { x: 0, y: 0 }), config: { type: 'start' as const, url: '' } }
  const image = createNode('image-recognition', { x: 100, y: 0 })
  const endings = [createNode('end', { x: 200, y: -80 }), createNode('end', { x: 200, y: 0 }), createNode('end', { x: 200, y: 80 })]
  const config: ImageRecognitionConfig = { type: 'image-recognition', image: { kind: 'variable', name: 'photo' }, path: '', instruction: '只看图片', cases: [{ id: 'paid', name: '付款', prompt: '付款成功截图' }, { id: 'logistics', name: '物流', prompt: '物流面单' }], outputName: 'imageResult' }
  return { graph: { workflowId: 'vision-test', name: 'Vision', version: 1, entryNodeId: start.id, llm: { id: 'vision', name: 'Vision', enabled: true, model: 'test', baseUrl: 'http://localhost:3000', chatPath: '/v1/chat/completions', apiKey: '', maxTokens: 500 }, nodes: [start, { ...image, config, inputBindings: { image: config.image } }, ...endings], edges: [createEdge(start.id, 'default', image.id), createEdge(image.id, 'case-paid', endings[0].id), createEdge(image.id, 'case-logistics', endings[1].id), createEdge(image.id, 'else', endings[2].id)] }, nodeId: image.id, endings: endings.map(item => item.id) }
}

function driver(branch: string, observed: string[]): BrowserDriver {
  return {
    async openPage() {}, async click() {}, async type() {}, async extract() { return '' }, async waitFor() {},
    async recognizeImage(image, instruction, cases) { observed.push(image, instruction, cases.map(item => item.id).join(',')); return { branch, reason: '可见付款信息' } },
  }
}

describe('image recognition node', () => {
  it('preserves dynamic branch ports through workflow parsing and validation', () => {
    const { graph } = fixture()
    expect(validateGraph(graph)).toEqual([])
    expect(workflowNeedsBrowser([graph])).toBe(false)
    const parsed = parseWorkflow(graph)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.graph.nodes.find(node => node.type === 'image-recognition')?.config).toMatchObject({ type: 'image-recognition', cases: [{ id: 'paid' }, { id: 'logistics' }] })
  })

  it('can dry-run an image-only workflow without a start URL', async () => {
    const { graph, endings } = fixture()
    const state = await runDry(graph, { onUpdate() {}, wait: async () => {} })
    expect(state.status).toBe('succeeded')
    expect(state.nodes[endings[2]]).toBe('succeeded')
  })

  it('routes to the model-selected branch and exposes a small structured result', async () => {
    const { graph, nodeId, endings } = fixture()
    const observed: string[] = []
    const state = await runBrowser(graph, driver('case-logistics', observed), { onUpdate() {}, wait: async () => {} }, { variables: { photo: tinyPng } })
    expect(state.status, JSON.stringify(state.logs)).toBe('succeeded')
    expect(state.nodes[endings[1]]).toBe('succeeded')
    expect(state.nodes[endings[0]]).toBe('pending')
    expect(state.outputs[nodeId]?.imageResult).toEqual({ branch: 'case-logistics', label: '物流', reason: '可见付款信息' })
    expect(state.variables?.imageResult).toEqual(state.outputs[nodeId]?.imageResult)
    expect(observed[0]).toBe(tinyPng)
    expect(state.logs.some(line => line.message.includes(tinyPng))).toBe(false)
  })

  it('uses else only when explicitly selected, and rejects unknown branch IDs', async () => {
    const { graph, nodeId, endings } = fixture()
    const handlers = { onUpdate() {}, wait: async () => {} }
    const fallback = await runBrowser(graph, driver('else', []), handlers, { variables: { photo: tinyPng } })
    expect(fallback.nodes[endings[2]], JSON.stringify(fallback.logs)).toBe('succeeded')
    const invalid = await runBrowser(graph, driver('case-unknown', []), handlers, { variables: { photo: tinyPng } })
    expect(invalid.status).toBe('failed')
    expect(invalid.nodes[nodeId]).toBe('failed')
  })

  it('resolves a template expression used as the image source', async () => {
    const { graph, nodeId } = fixture()
    const nodes = graph.nodes.map(node => node.id === nodeId && node.config.type === 'image-recognition'
      ? { ...node, config: { ...node.config, image: { kind: 'literal' as const, value: '{{photo}}' } } }
      : node)
    const state = await runBrowser({ ...graph, nodes }, driver('else', []), { onUpdate() {}, wait: async () => {} }, { variables: { photo: tinyPng } })
    expect(state.status).toBe('succeeded')
  })

  it('probes an image URL once, logs only its metadata, then recognizes the downloaded image', async () => {
    const { graph } = fixture()
    const observed: string[] = []
    const fetchMock = vi.fn(async () => new Response(Buffer.from(tinyPng.slice(tinyPng.indexOf(',') + 1), 'base64'), { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const state = await runBrowser(graph, driver('case-paid', observed), { onUpdate() {}, wait: async () => {} }, { variables: { photo: 'https://example.com/photo.png?token=secret' } })
      expect(state.status).toBe('succeeded')
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(observed[0]).toBe(tinyPng)
      expect(state.logs.some(line => line.message.includes('图片链接访问探针通过（HTTP 200，image/png，8 字节）'))).toBe(true)
      expect(state.logs.some(line => line.message.includes('token=secret') || line.message.includes(tinyPng))).toBe(false)
    } finally { vi.unstubAllGlobals() }
  })

  it('logs the redacted image URL when its access probe fails', async () => {
    const { graph, nodeId } = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    try {
      const state = await runBrowser(graph, driver('case-paid', []), { onUpdate() {}, wait: async () => {} }, {
        variables: { photo: 'https://example.com/missing.png?token=secret&size=large' },
      })
      expect(state.status).toBe('failed')
      expect(state.nodes[nodeId]).toBe('failed')
      expect(state.logs.some(line => line.message.includes('HTTP 404')
        && line.message.includes('https://example.com/missing.png?token=******&size=large'))).toBe(true)
      expect(state.logs.some(line => line.message.includes('token=secret'))).toBe(false)
    } finally { vi.unstubAllGlobals() }
  })
})
