import type { Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { downloadUploadFile, FileDownloadError } from './file-download.ts'
import { safeErrorMessage } from './error-message.ts'

const url = 'https://cdn.example.com/product.jpg?token=private-query'
const tls = new Error('apiRequestContext.get: Client network socket disconnected before secure TLS connection was established\nCall log:\n  - cookie: Authorization=Bearer private-cookie; SHOP=1')
function setup() {
  const response = { ok: () => true, status: () => 200, headers: () => ({ 'content-type': 'image/jpeg' }), body: vi.fn(async () => Buffer.from('image')), dispose: vi.fn(async () => {}) }
  const get = vi.fn(async (_url: string, _options?: { timeout: number }) => response)
  const temporary = { goto: vi.fn(async () => response), close: vi.fn(async () => {}) }
  const newPage = vi.fn(async () => temporary)
  const page = { context: () => ({ request: { get }, newPage }) } as unknown as Page
  return { page, get, newPage, temporary, response }
}

describe('upload file downloading', () => {
  it('retries a transient TLS error inside the download without creating a browser tab when recovered', async () => {
    const s = setup()
    s.get.mockRejectedValueOnce(tls)
    const logs: string[] = []
    const result = await downloadUploadFile(s.page, url, 5000, line => logs.push(line))
    expect(result.buffer.toString()).toBe('image')
    expect(s.get).toHaveBeenCalledTimes(2)
    expect(s.newPage).not.toHaveBeenCalled()
    expect(s.response.dispose).toHaveBeenCalledOnce()
    expect(logs.join('\n')).not.toContain('private-cookie')
  })
  it('falls back to Chromium after API TLS failures and always closes its temporary tab', async () => {
    const s = setup()
    s.get.mockRejectedValue(tls)
    const result = await downloadUploadFile(s.page, url, 5000)
    expect(result.buffer.toString()).toBe('image')
    expect(s.get).toHaveBeenCalledTimes(2)
    expect(s.temporary.goto).toHaveBeenCalledWith(url, expect.objectContaining({ waitUntil: 'load' }))
    expect(s.temporary.close).toHaveBeenCalledOnce()
  })
  it('does not retry a missing file or silently weaken TLS checks', async () => {
    const s = setup()
    s.response.ok = () => false
    s.response.status = () => 404
    await expect(downloadUploadFile(s.page, url, 5000)).rejects.toThrow('HTTP 404')
    expect(s.get).toHaveBeenCalledOnce()
    expect(s.newPage).not.toHaveBeenCalled()
    expect(s.get.mock.calls[0]?.[1]).not.toHaveProperty('ignoreHTTPSErrors')
  })
  it('rejects oversized downloads before reading the response body', async () => {
    const s = setup()
    s.response.headers = () => ({ 'content-type': 'image/jpeg', 'content-length': String(26 * 1024 * 1024) })
    await expect(downloadUploadFile(s.page, url, 5000)).rejects.toThrow('25 MB')
    expect(s.response.body).not.toHaveBeenCalled()
    expect(s.response.dispose).toHaveBeenCalledOnce()
  })
  it('stops a stalled fallback within the shared deadline and hides raw request credentials', async () => {
    const s = setup()
    s.get.mockRejectedValue(tls)
    s.temporary.goto.mockImplementation(() => new Promise(() => {}))
    const error = await downloadUploadFile(s.page, url, 40).catch(error => error)
    expect(error).toBeInstanceOf(FileDownloadError)
    expect(error.retryable).toBe(false)
    expect(error.message).not.toMatch(/private-cookie|private-query|Call log/)
    expect(s.temporary.close).toHaveBeenCalledOnce()
  })
})

it('redacts cookie headers, bearer credentials and signed URL parameters from Playwright errors', () => {
  const message = safeErrorMessage(new Error('TLS failure\nCall log:\n\u001b[2m  - cookie: Authorization=Bearer cookie-value; SHOP=2022\u001b[22m\n  - authorization: Bearer header-value\n  - → GET https://example.com/image?token=token-value&signature=signature-value\n  - accept: */*'))
  expect(message).toContain('TLS failure')
  expect(message).toContain('accept: */*')
  expect(message).not.toMatch(/cookie-value|header-value|token-value|signature-value|SHOP=2022/)
})
