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
  const config: ImageRecognitionConfig = { type: 'image-recognition', image: { kind: 'variable', name: 'photo' }, path: '', comparisonEnabled: false, comparisonPrompt: '比较可见内容', instruction: '只看图片', cases: [{ id: 'paid', name: '付款', prompt: '付款成功截图' }, { id: 'logistics', name: '物流', prompt: '物流面单' }], outputName: 'imageResult' }
  return { graph: { workflowId: 'vision-test', name: 'Vision', version: 1, entryNodeId: start.id, llm: { id: 'vision', name: 'Vision', enabled: true, model: 'test', baseUrl: 'http://localhost:3000', chatPath: '/v1/chat/completions', apiKey: '', maxTokens: 500 }, nodes: [start, { ...image, config, inputBindings: { image: config.image } }, ...endings], edges: [createEdge(start.id, 'default', image.id), createEdge(image.id, 'case-paid', endings[0].id), createEdge(image.id, 'case-logistics', endings[1].id), createEdge(image.id, 'else', endings[2].id)] }, nodeId: image.id, endings: endings.map(item => item.id) }
}

function driver(branch: string, observed: string[]): BrowserDriver {
  return {
    async openPage() {}, async click() {}, async type() {}, async extract() { return '' }, async waitFor() {},
    async recognizeImage(images, instruction, cases, _llm, comparisonPrompt) {
      observed.push(images.map(item => `${item.role}:${item.dataUrl}`).join('|'), instruction, cases.map(item => item.id).join(','), comparisonPrompt ?? '')
      const caseEvaluations = branch === 'case-unknown'
        ? [{ branch, matched: true, confidence: 0.9, evidence: '未知场景' }]
        : cases.map(item => ({ branch: `case-${item.id}`, matched: branch === `case-${item.id}`, confidence: branch === `case-${item.id}` ? 0.92 : 0.85, evidence: branch === `case-${item.id}` ? '可见付款信息' : '不符合该场景' }))
      const imageCaseEvaluations = Array.from({ length: images.filter(item => item.role === 'input').length }, (_value, inputIndex) => caseEvaluations.map(item => ({ ...item, inputImageIndex: inputIndex + 1, contradicts: false }))).flat()
      const referenceCount = images.filter(item => item.role === 'reference').length
      const inputCount = images.filter(item => item.role === 'input').length
      const comparisons = referenceCount === 0 ? [] : Array.from({ length: inputCount }, (_item, index) => ({ inputImageIndex: index + 1, referenceImageIndex: 1, comparable: true, reason: '图片可比较', differences: [] }))
      return { comparisonStatus: 'completed', comparisonSummary: '已完成图片观察', comparisons, imageCaseEvaluations, caseEvaluations }
    },
  }
}

describe('image recognition node', () => {
  it('preserves dynamic branch ports through workflow parsing and validation', () => {
    const { graph } = fixture()
    expect(validateGraph(graph)).toEqual([])
    expect(workflowNeedsBrowser([graph])).toBe(false)
    const parsed = parseWorkflow(graph)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.graph.nodes.find(node => node.type === 'image-recognition')?.config).toMatchObject({ type: 'image-recognition', comparisonEnabled: false, comparisonSourceMode: 'upload', comparisonPrompt: '比较可见内容', cases: [{ id: 'paid' }, { id: 'logistics' }] })
  })

  it('can dry-run an image-only workflow without a start URL', async () => {
    const { graph, endings } = fixture()
    const state = await runDry(graph, { onUpdate() {}, wait: async () => {} })
    expect(state.status).toBe('succeeded')
    expect(state.nodes[endings[2]]).toBe('succeeded')
  })

  it('routes using independent case evaluations and exposes comparison evidence', async () => {
    const { graph, nodeId, endings } = fixture()
    const observed: string[] = []
    const state = await runBrowser(graph, driver('case-logistics', observed), { onUpdate() {}, wait: async () => {} }, { variables: { photo: tinyPng } })
    expect(state.status, JSON.stringify(state.logs)).toBe('succeeded')
    expect(state.nodes[endings[1]]).toBe('succeeded')
    expect(state.nodes[endings[0]]).toBe('pending')
    expect(state.outputs[nodeId]?.imageResult).toMatchObject({ branch: 'case-logistics', label: '物流', reason: '可见付款信息', imageCount: 1, comparisonEnabled: false, comparisonImageCount: 0, comparisonStatus: 'completed', comparisonSummary: '已完成图片观察', confidence: 0.92 })
    expect(state.variables?.imageResult).toEqual(state.outputs[nodeId]?.imageResult)
    expect(observed[0]).toBe(`input:${tinyPng}`)
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

  it('selects the first configured scene when multiple independent evaluations match', async () => {
    const { graph, endings } = fixture()
    const priorityDriver: BrowserDriver = {
      ...driver('else', []),
      async recognizeImage() {
        return {
          comparisonStatus: 'completed', comparisonSummary: '两个场景都有可见证据', comparisons: [],
          imageCaseEvaluations: [
            { inputImageIndex: 1, branch: 'case-logistics', matched: true, contradicts: false, confidence: 0.95, evidence: '也符合物流场景' },
            { inputImageIndex: 1, branch: 'case-paid', matched: true, contradicts: false, confidence: 0.8, evidence: '符合付款场景' },
          ],
          caseEvaluations: [
            { branch: 'case-logistics', matched: true, confidence: 0.95, evidence: '也符合物流场景' },
            { branch: 'case-paid', matched: true, confidence: 0.8, evidence: '符合付款场景' },
          ],
        }
      },
    }
    const state = await runBrowser(graph, priorityDriver, { onUpdate() {}, wait: async () => {} }, { variables: { photo: tinyPng } })
    expect(state.status).toBe('succeeded')
    expect(state.nodes[endings[0]]).toBe('succeeded')
    expect(state.nodes[endings[1]]).toBe('pending')
  })

  it('rejects incomplete case evaluations instead of silently choosing a branch', async () => {
    const { graph, nodeId } = fixture()
    const incompleteDriver: BrowserDriver = {
      ...driver('else', []),
      async recognizeImage() {
        return { comparisonStatus: 'completed', comparisonSummary: '判断不完整', comparisons: [], imageCaseEvaluations: [{ inputImageIndex: 1, branch: 'case-paid', matched: true, contradicts: false, confidence: 0.9, evidence: '付款信息' }], caseEvaluations: [{ branch: 'case-paid', matched: true, confidence: 0.9, evidence: '付款信息' }] }
      },
    }
    const state = await runBrowser(graph, incompleteDriver, { onUpdate() {}, wait: async () => {} }, { variables: { photo: tinyPng } })
    expect(state.status).toBe('failed')
    expect(state.nodes[nodeId]).toBe('failed')
    expect(state.logs.some(line => line.message.includes('没有判断场景「case-logistics」'))).toBe(true)
  })

  it('routes to else when all comparison images are not comparable', async () => {
    const { graph, endings } = fixture()
    const incomparableDriver: BrowserDriver = {
      ...driver('else', []),
      async recognizeImage(_images, _instruction, cases) {
        const caseEvaluations = cases.map(item => ({ branch: `case-${item.id}`, matched: false, confidence: 0.95, evidence: '无法可靠比较' }))
        return { comparisonStatus: 'not_comparable', comparisonSummary: '图片角度不对应', comparisons: [], imageCaseEvaluations: caseEvaluations.map(item => ({ ...item, inputImageIndex: 1, contradicts: false })), caseEvaluations }
      },
    }
    const state = await runBrowser(graph, incomparableDriver, { onUpdate() {}, wait: async () => {} }, { variables: { photo: tinyPng } })
    expect(state.status).toBe('succeeded')
    expect(state.nodes[endings[2]]).toBe('succeeded')
  })

  it('still routes by visible scene evidence when reference images are not comparable', async () => {
    const { graph, endings } = fixture()
    const visibleSceneDriver: BrowserDriver = {
      ...driver('else', []),
      async recognizeImage(_images, _instruction, cases) {
        const caseEvaluations = cases.map(item => ({ branch: `case-${item.id}`, matched: item.id === 'logistics', confidence: 0.94, evidence: item.id === 'logistics' ? '图片只展示物流包装和面单' : '未看到付款信息' }))
        return { comparisonStatus: 'not_comparable', comparisonSummary: '包装图片无法与产品参考图比较', comparisons: [], imageCaseEvaluations: caseEvaluations.map(item => ({ ...item, inputImageIndex: 1, contradicts: false })), caseEvaluations }
      },
    }
    const state = await runBrowser(graph, visibleSceneDriver, { onUpdate() {}, wait: async () => {} }, { variables: { photo: tinyPng } })
    expect(state.status).toBe('succeeded')
    expect(state.nodes[endings[1]]).toBe('succeeded')
    expect(state.logs.some(line => line.message.includes('命中（图片 1）'))).toBe(true)
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
      expect(observed[0]).toBe(`input:${tinyPng}`)
      expect(state.logs.some(line => line.message.includes('图片链接访问探针通过（HTTP 200，image/png，8 字节）'))).toBe(true)
      expect(state.logs.some(line => line.message.includes('token=secret') || line.message.includes(tinyPng))).toBe(false)
    } finally { vi.unstubAllGlobals() }
  })

  it('sends multiple images in one model call and still selects one branch', async () => {
    const { graph, nodeId, endings } = fixture()
    const observed: string[] = []
    const state = await runBrowser(graph, driver('case-paid', observed), { onUpdate() {}, wait: async () => {} }, { variables: { photo: [tinyPng, tinyPng] } })
    expect(state.status).toBe('succeeded')
    expect(state.nodes[endings[0]]).toBe('succeeded')
    expect(observed[0]).toBe(`input:${tinyPng}|input:${tinyPng}`)
    expect(state.outputs[nodeId]?.imageResult).toMatchObject({ imageCount: 2, comparisonEnabled: false, branch: 'case-paid' })
  })

  it('adds one reference image and resolves the optional comparison prompt', async () => {
    const { graph, nodeId } = fixture()
    const nodes = graph.nodes.map(node => node.id === nodeId && node.config.type === 'image-recognition'
      ? { ...node, config: { ...node.config, comparisonEnabled: true, comparisonImage: tinyPng, comparisonImageName: '标准截图.png', comparisonPrompt: '对比订单 {{orderId}}' } }
      : node)
    const observed: string[] = []
    const state = await runBrowser({ ...graph, nodes }, driver('else', observed), { onUpdate() {}, wait: async () => {} }, { variables: { photo: [tinyPng, tinyPng], orderId: 'A-100' } })
    expect(state.status).toBe('succeeded')
    expect(observed[0]).toBe(`reference:${tinyPng}|input:${tinyPng}|input:${tinyPng}`)
    expect(observed[3]).toBe('对比订单 A-100')
    expect(state.outputs[nodeId]?.imageResult).toMatchObject({ imageCount: 2, comparisonEnabled: true })
  })

  it('sends multiple uploaded comparison images before the runtime images', async () => {
    const { graph, nodeId } = fixture()
    const nodes = graph.nodes.map(node => node.id === nodeId && node.config.type === 'image-recognition'
      ? { ...node, config: { ...node.config, comparisonEnabled: true, comparisonSourceMode: 'upload' as const, comparisonImages: [{ dataUrl: tinyPng, name: '参考一.png' }, { dataUrl: tinyPng, name: '参考二.png' }] } }
      : node)
    const observed: string[] = []
    const state = await runBrowser({ ...graph, nodes }, driver('case-paid', observed), { onUpdate() {}, wait: async () => {} }, { variables: { photo: tinyPng } })
    expect(state.status).toBe('succeeded')
    expect(observed[0]).toBe(`reference:${tinyPng}|reference:${tinyPng}|input:${tinyPng}`)
    expect(state.outputs[nodeId]?.imageResult).toMatchObject({ comparisonEnabled: true, comparisonImageCount: 2 })
  })

  it('can read the comparison image from a variable and optional field path', async () => {
    const { graph, nodeId } = fixture()
    const nodes = graph.nodes.map(node => node.id === nodeId && node.config.type === 'image-recognition'
      ? { ...node, config: { ...node.config, comparisonEnabled: true, comparisonSourceMode: 'variable' as const, comparisonImageSource: { kind: 'variable' as const, name: 'reference' }, comparisonImagePath: 'assets' } }
      : node)
    const observed: string[] = []
    const state = await runBrowser({ ...graph, nodes }, driver('case-paid', observed), { onUpdate() {}, wait: async () => {} }, { variables: { photo: tinyPng, reference: { assets: [{ url: tinyPng }, { imageUrl: tinyPng }] } } })
    expect(state.status).toBe('succeeded')
    expect(observed[0]).toBe(`reference:${tinyPng}|reference:${tinyPng}|input:${tinyPng}`)
    expect(state.outputs[nodeId]?.imageResult).toMatchObject({ imageCount: 1, comparisonEnabled: true, comparisonImageCount: 2 })
  })

  it('accepts a JSON-stringified image array from a runtime comparison variable', async () => {
    const { graph, nodeId } = fixture()
    const nodes = graph.nodes.map(node => node.id === nodeId && node.config.type === 'image-recognition'
      ? { ...node, config: { ...node.config, comparisonEnabled: true, comparisonSourceMode: 'variable' as const, comparisonImageSource: { kind: 'variable' as const, name: 'reference' }, comparisonImagePath: '' } }
      : node)
    const observed: string[] = []
    const state = await runBrowser({ ...graph, nodes }, driver('case-paid', observed), { onUpdate() {}, wait: async () => {} }, { variables: { photo: tinyPng, reference: JSON.stringify([tinyPng, tinyPng]) } })
    expect(state.status).toBe('succeeded')
    expect(observed[0]).toBe(`reference:${tinyPng}|reference:${tinyPng}|input:${tinyPng}`)
  })

  it('reports an invalid comparison field path instead of a generic empty-image error', async () => {
    const { graph, nodeId } = fixture()
    const nodes = graph.nodes.map(node => node.id === nodeId && node.config.type === 'image-recognition'
      ? { ...node, config: { ...node.config, comparisonEnabled: true, comparisonSourceMode: 'variable' as const, comparisonImageSource: { kind: 'variable' as const, name: 'reference' }, comparisonImagePath: 'missing.path' } }
      : node)
    const state = await runBrowser({ ...graph, nodes }, driver('case-paid', []), { onUpdate() {}, wait: async () => {} }, { variables: { photo: tinyPng, reference: JSON.stringify([tinyPng]) } })
    expect(state.status).toBe('failed')
    expect(state.logs.some(line => line.message.includes('字段路径「missing.path」未读取到值'))).toBe(true)
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
