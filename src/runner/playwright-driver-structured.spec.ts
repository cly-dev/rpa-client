import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpOnlyDriver } from './playwright-driver.ts'

afterEach(() => { vi.unstubAllGlobals() })

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
  const cases = [{ id: 'paid', name: '付款', prompt: '付款成功截图' }]
  const llm = {
    id: 'vision', name: '视觉模型', enabled: true, model: 'thinking-model',
    baseUrl: 'http://127.0.0.1:3333/v1', chatPath: '/chat/completions', apiKey: 'session-token', maxTokens: 500,
  }

  it('uses JSON mode first and sends the image with an explicit JSON instruction', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer session-token')
      const request = JSON.parse(String(init.body)) as {
        response_format?: { type?: string }; tool_choice?: unknown
        messages?: readonly { content?: string | readonly { type?: string; image_url?: { url?: string } }[] }[]
      }
      expect(request.response_format?.type).toBe('json_object')
      expect(request.tool_choice).toBeUndefined()
      expect(request.messages?.some(message => typeof message.content === 'string' && /json/i.test(message.content))).toBe(true)
      expect(request.messages?.some(message => Array.isArray(message.content)
        && message.content.some(part => part.type === 'image_url' && part.image_url?.url === image))).toBe(true)
      return new Response(JSON.stringify({
        id: 'chatcmpl-image-json', object: 'chat.completion', created: 1, model: 'thinking-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"branch":"case-paid","reason":"显示付款成功"}' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpOnlyDriver().recognizeImage?.(image, '', cases, llm)

    expect(result).toEqual({ branch: 'case-paid', reason: '显示付款成功' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to function calling if JSON mode is rejected', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'json_object not supported', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-image-tool', object: 'chat.completion', created: 1, model: 'test-model',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-image', type: 'function', function: { name: 'image_decision', arguments: '{"branch":"case-paid","reason":"显示付款成功"}' } }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await createHttpOnlyDriver().recognizeImage?.(image, '', cases, llm)).toEqual({ branch: 'case-paid', reason: '显示付款成功' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const fallback = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as { tool_choice?: unknown }
    expect(fallback.tool_choice).toBeDefined()
  })

  it('reports both failures without exposing the image or the session token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: `JSON mode rejected ${image}`, type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Function calling rejected session-token', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    let failure: unknown
    try { await createHttpOnlyDriver().recognizeImage?.(image, '', cases, llm) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('JSON Mode')
    expect(message).toContain('Function Calling')
    expect(message).toContain('JSON mode rejected')
    expect(message).toContain('Function calling rejected')
    expect(message).not.toContain(image)
    expect(message).not.toContain('session-token')
  })
})
