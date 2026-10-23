import type { Response } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { waitForBufferedPageResponse, type BufferedPageResponse } from './playwright-driver.ts'

function bufferedResponse(options: {
  method: string
  status: number
  body: string
  contentType?: string
  url?: string
}): BufferedPageResponse {
  const response = {
    text: vi.fn(async () => options.body),
    headers: vi.fn(() => ({ 'content-type': options.contentType ?? '' })),
    request: vi.fn(() => ({ postData: () => null })),
  } as unknown as Response
  return {
    url: options.url ?? 'https://example.com/account/public/seller/login/v2',
    method: options.method,
    status: options.status,
    response,
  }
}

const config = {
  urlPattern: '/account/public/seller/login/v2',
  matchMode: 'contains' as const,
  method: 'ANY',
  responseType: 'json' as const,
  timeoutMs: 200,
}

describe('buffered page response listener', () => {
  it('skips an empty CORS preflight and captures the following JSON response', async () => {
    const preflight = bufferedResponse({ method: 'OPTIONS', status: 204, body: '' })
    const login = bufferedResponse({ method: 'POST', status: 200, body: '{"code":0,"data":{"token":"ok"}}', contentType: 'application/json' })

    await expect(waitForBufferedPageResponse([preflight, login], config)).resolves.toEqual({
      data: { code: 0, data: { token: 'ok' } },
      url: login.url,
      method: 'POST',
      status: 200,
    })
  })

  it('accepts a valid JSON response with a UTF-8 BOM', async () => {
    const login = bufferedResponse({ method: 'POST', status: 200, body: '\uFEFF{"code":0}', contentType: 'application/json' })
    await expect(waitForBufferedPageResponse([login], config)).resolves.toMatchObject({ data: { code: 0 } })
  })

  it('reports candidate details when every matching response is invalid JSON', async () => {
    const gateway = bufferedResponse({ method: 'POST', status: 502, body: '<html>Bad Gateway</html>', contentType: 'text/html' })
    await expect(waitForBufferedPageResponse([gateway], { ...config, timeoutMs: 100 })).rejects.toThrow(
      '匹配到 1 个接口响应，但均不是有效 JSON；最后一次：POST https://example.com/account/public/seller/login/v2，HTTP 502，Content-Type text/html',
    )
  })
})
