import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpOnlyDriver } from './playwright-driver.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('Agent structured input and output', () => {
  const llm = {
    id: 'agent-test', name: 'Agent 测试', enabled: true, model: 'thinking-model',
    baseUrl: 'http://127.0.0.1:3333/v1', chatPath: '/chat/completions', apiKey: '', maxTokens: 300,
  }
  const outputs = [
    { name: 'category', valueType: 'string' as const, description: '业务分类' },
    { name: 'confidence', valueType: 'number' as const, description: '0 到 1 的置信度' },
  ]

  it('sends the resolved task and validates named output fields in JSON mode', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as {
        response_format?: { type?: string }
        tool_choice?: unknown
        messages?: readonly { content?: string }[]
      }
      expect(request.response_format?.type).toBe('json_object')
      expect(request.tool_choice).toBeUndefined()
      const content = request.messages?.map(message => message.content ?? '').join('\n') ?? ''
      expect(content).toContain('判断订单 A-100 的售后业务分类')
      expect(content).toContain('category（string）')
      expect(content).toContain('confidence（number）')
      return new Response(JSON.stringify({
        id: 'chatcmpl-agent-json', object: 'chat.completion', created: 1, model: 'thinking-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"category":"damage","confidence":0.92}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpOnlyDriver().generateAgent?.(
      '判断订单 A-100 的售后业务分类',
      '你是售后分类助手',
      outputs,
      llm,
    )

    expect(result).toEqual({ category: 'damage', confidence: 0.92 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to function calling when Agent JSON mode is unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'json_object not supported', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-agent-tool', object: 'chat.completion', created: 1, model: 'thinking-model',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'call-agent', type: 'function', function: { name: 'agent_result', arguments: '{"category":"shipping","confidence":0.88}' } }],
        } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpOnlyDriver().generateAgent?.('对订单 A-200 分类', '系统规则', outputs, llm)

    expect(result).toEqual({ category: 'shipping', confidence: 0.88 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const fallback = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as { tool_choice?: unknown }
    expect(fallback.tool_choice).toBeDefined()
  })
})

describe('AI condition structured output', () => {
  const llm = {
    id: 'test', name: '测试', enabled: true, model: 'thinking-model',
    baseUrl: 'http://127.0.0.1:3333/v1', chatPath: '/chat/completions', apiKey: '', maxTokens: 100,
  }

  it('uses JSON mode first with an explicit JSON instruction for thinking models', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as {
        response_format?: { type?: string }
        tool_choice?: unknown
        messages?: readonly { content?: string }[]
      }
      expect(request.response_format?.type).toBe('json_object')
      expect(request.tool_choice).toBeUndefined()
      expect(request.messages?.some(message => /json/i.test(message.content ?? ''))).toBe(true)
      return new Response(JSON.stringify({
        id: 'chatcmpl-condition-json', object: 'chat.completion', created: 1, model: 'thinking-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"matched":true,"reason":"满足要求"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpOnlyDriver().generateCondition?.('这是一条反馈', '是否需要转人工', llm)

    expect(result).toEqual({ matched: true, reason: '满足要求' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to function calling when JSON mode is unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'json_object not supported', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-condition-tool', object: 'chat.completion', created: 1, model: 'test-model',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'call-condition', type: 'function', function: { name: 'condition_result', arguments: '{"matched":false,"reason":"不满足要求"}' } }],
        } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpOnlyDriver().generateCondition?.('普通反馈', '是否有威胁', llm)

    expect(result).toEqual({ matched: false, reason: '不满足要求' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const fallbackRequest = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as { tool_choice?: unknown }
    expect(fallbackRequest.tool_choice).toBeDefined()
  })
})

describe('AI switch structured output', () => {
  it('uses JSON mode first with an explicit JSON instruction for thinking models', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { response_format?: { type?: string }; tool_choice?: unknown; messages?: readonly { content?: string }[] }
      expect(request.response_format?.type).toBe('json_object')
      expect(request.tool_choice).toBeUndefined()
      expect(request.messages?.some(message => /json/i.test(message.content ?? ''))).toBe(true)
      return new Response(JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'thinking-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"branch":"case-1","reason":"带有辱骂语气"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const driver = createHttpOnlyDriver()
    const result = await driver.generateSwitch?.('我去你的', [
      { id: 'case-0', name: '打招呼', prompt: '打招呼的话' },
      { id: 'case-1', name: '骂人的话', prompt: '骂人的话' },
    ], '', {
      id: 'test', name: '测试', enabled: true, model: 'thinking-model',
      baseUrl: 'http://127.0.0.1:3333/v1', chatPath: '/chat/completions', apiKey: '', maxTokens: 100,
    }, '客户等级：VIP\n订单状态：已付款')
    expect(result).toEqual({ branch: 'case-1', reason: '带有辱骂语气' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const request = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { messages: readonly { content: string }[] }
    expect(request.messages.some(message => message.content.includes('补充数据与上下文：\n客户等级：VIP\n订单状态：已付款'))).toBe(true)
  })

  it('falls back to function calling when JSON mode is unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'json_object not supported', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-tool', object: 'chat.completion', created: 1, model: 'test-model',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-switch', type: 'function', function: { name: 'switch_decision', arguments: '{"branch":"case-0","reason":"符合第一个场景"}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await createHttpOnlyDriver().generateSwitch?.('你好', [
      { id: 'case-0', name: '打招呼', prompt: '打招呼的话' },
    ], '', {
      id: 'test', name: '测试', enabled: true, model: 'test-model',
      baseUrl: 'http://127.0.0.1:3333/v1', chatPath: '/chat/completions', apiKey: '', maxTokens: 100,
    })
    expect(result).toEqual({ branch: 'case-0', reason: '符合第一个场景' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const fallbackRequest = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as { tool_choice?: unknown }
    expect(fallbackRequest.tool_choice).toBeDefined()
  })
})

describe('image recognition structured output', () => {
  const image = 'data:image/png;base64,iVBORw0KGgo='
  const images = [{ dataUrl: image, label: '待识别图片 1', role: 'input' as const }]
  const cases = [{ id: 'paid', name: '付款', prompt: '付款成功截图' }]
  const llm = {
    id: 'vision', name: '视觉模型', enabled: true, model: 'thinking-model',
    baseUrl: 'http://127.0.0.1:3333/v1', chatPath: '/chat/completions', apiKey: 'session-token', maxTokens: 500,
  }
  const decision = {
    comparisonStatus: 'completed' as const,
    comparisonSummary: '显示付款成功',
    comparisons: [],
    imageCaseEvaluations: [{ inputImageIndex: 1, branch: 'case-paid', matched: true, contradicts: false, confidence: 0.96, evidence: '显示付款成功' }],
    caseEvaluations: [{ branch: 'case-paid', matched: true, confidence: 0.96, evidence: '图片 1：显示付款成功' }],
  }

  it('uses JSON mode first and sends the image with an explicit JSON instruction', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer session-token')
      const request = JSON.parse(String(init.body)) as {
        response_format?: { type?: string }; tool_choice?: unknown; max_tokens?: number
        messages?: readonly { content?: string | readonly { type?: string; image_url?: { url?: string } }[] }[]
      }
      expect(request.response_format?.type).toBe('json_object')
      expect(request.tool_choice).toBeUndefined()
      expect(request.max_tokens).toBeGreaterThanOrEqual(4_096)
      expect(request.messages?.some(message => typeof message.content === 'string' && /json/i.test(message.content))).toBe(true)
      expect(request.messages?.some(message => Array.isArray(message.content)
        && message.content.some(part => part.type === 'image_url' && part.image_url?.url === image))).toBe(true)
      return new Response(JSON.stringify({
        id: 'chatcmpl-image-json', object: 'chat.completion', created: 1, model: 'thinking-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(decision) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpOnlyDriver().recognizeImage?.(images, '', cases, llm)

    expect(result).toEqual(decision)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends the reference and all runtime images in one comparison request', async () => {
    const secondImage = 'data:image/png;base64,iVBORw0KGgoAAA=='
    const reference = 'data:image/png;base64,iVBORw0KGgoBBB=='
    const secondReference = 'data:image/png;base64,iVBORw0KGgoCCC=='
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { messages?: readonly { content?: string | readonly { type?: string; text?: string; image_url?: { url?: string } }[] }[] }
      const content = request.messages?.find(message => Array.isArray(message.content))?.content
      expect(Array.isArray(content)).toBe(true)
      if (!Array.isArray(content)) throw new Error('缺少多模态消息')
      expect(content.filter(part => part.type === 'image_url').map(part => part.image_url?.url)).toEqual([reference, secondReference, image, secondImage])
      expect(content.filter(part => part.type === 'text').map(part => part.text).join('\n')).toContain('共有 2 张参考图片')
      expect(content.filter(part => part.type === 'text').map(part => part.text).join('\n')).toContain('重点比较文字和金额')
      const comparisonDecision = {
        comparisonStatus: 'completed', comparisonSummary: '综合图片后符合',
        comparisons: [{ inputImageIndex: 1, referenceImageIndex: 1, comparable: true, reason: '视角一致', differences: [{ location: '文字区域', description: '金额不同', evidence: '参考图与待识别图金额不同' }] }],
        imageCaseEvaluations: [
          { inputImageIndex: 1, branch: 'case-paid', matched: true, contradicts: false, confidence: 0.9, evidence: '第一张图片符合' },
          { inputImageIndex: 2, branch: 'case-paid', matched: false, contradicts: false, confidence: 0.8, evidence: '第二张图片不相关' },
        ],
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl-image-multiple', object: 'chat.completion', created: 1, model: 'thinking-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(comparisonDecision) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpOnlyDriver().recognizeImage?.([
      { dataUrl: reference, label: '标准图', role: 'reference' },
      { dataUrl: secondReference, label: '标准图 2', role: 'reference' },
      ...images,
      { dataUrl: secondImage, label: '待识别图片 2', role: 'input' },
    ], '', cases, llm, '重点比较文字和金额')

    expect(result).toMatchObject({ comparisonStatus: 'completed', comparisonSummary: '综合图片后符合', caseEvaluations: [{ branch: 'case-paid', matched: true }] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not aggregate a scene as matched when another image provides explicit contrary evidence', async () => {
    const secondImage = 'data:image/png;base64,iVBORw0KGgoDDD=='
    const rawDecision = {
      comparisonStatus: 'completed', comparisonSummary: '一张是包装，另一张展示产品本体', comparisons: [],
      imageCaseEvaluations: [
        { inputImageIndex: 1, branch: 'case-paid', matched: true, contradicts: false, confidence: 0.9, evidence: '第一张提供支持证据' },
        { inputImageIndex: 2, branch: 'case-paid', matched: false, contradicts: true, confidence: 0.98, evidence: '第二张提供明确反证' },
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'chatcmpl-image-contradiction', object: 'chat.completion', created: 1, model: 'thinking-model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(rawDecision) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const result = await createHttpOnlyDriver().recognizeImage?.([...images, { dataUrl: secondImage, label: '待识别图片 2', role: 'input' }], '', cases, llm)

    expect(result?.caseEvaluations).toEqual([{ branch: 'case-paid', matched: false, confidence: 0.9, evidence: '图片 2：第二张提供明确反证' }])
  })

  it('falls back to function calling if JSON mode is rejected', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'json_object not supported', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-image-tool', object: 'chat.completion', created: 1, model: 'test-model',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-image', type: 'function', function: { name: 'image_decision', arguments: JSON.stringify(decision) } }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await createHttpOnlyDriver().recognizeImage?.(images, '', cases, llm)).toEqual(decision)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const fallback = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as { tool_choice?: unknown }
    expect(fallback.tool_choice).toBeDefined()
  })

  it('retries JSON mode when both the first JSON response and function result are unusable', async () => {
    const truncated = '{"comparisonStatus":"completed","comparisons":['
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-truncated', object: 'chat.completion', created: 1, model: 'test-model',
        choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: truncated } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-empty-tool', object: 'chat.completion', created: 1, model: 'test-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-image-retry', object: 'chat.completion', created: 1, model: 'test-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(decision) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await createHttpOnlyDriver().recognizeImage?.(images, '', cases, llm)).toEqual(decision)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reports both failures without exposing the image or the session token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: `JSON mode rejected ${image}`, type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Function calling rejected session-token', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Retry still rejected', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    let failure: unknown
    try { await createHttpOnlyDriver().recognizeImage?.(images, '', cases, llm) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('JSON Mode')
    expect(message).toContain('Function Calling')
    expect(message).toContain('JSON Mode 重试')
    expect(message).toContain('JSON mode rejected')
    expect(message).toContain('Function calling rejected')
    expect(message).not.toContain(image)
    expect(message).not.toContain('session-token')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
