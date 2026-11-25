import type { APIResponse, Page, Response } from 'playwright'

export class FileDownloadError extends Error {
  readonly retryable = false
}

const MAX_BYTES = 25 * 1024 * 1024
const transient = /TLS|socket|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|timed?\s*out|timeout|net::ERR_/i

/** Download independently of row mutations; use Chromium when the API transport fails. */
export async function downloadUploadFile(page: Page, url: string, timeoutMs: number, trace?: (message: string) => void): Promise<{ buffer: Buffer; headers: Record<string, string> }> {
  const deadline = Date.now() + Math.max(1, timeoutMs)
  const host = new URL(url).hostname
  let last = '网络连接失败'
  const remaining = (): number => Math.max(1, deadline - Date.now())
  const timed = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('图片下载超时')), remaining())
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
  const read = async (response: APIResponse | Response): Promise<{ buffer: Buffer; headers: Record<string, string> }> => {
    if (!response.ok()) {
      const status = response.status()
      if (status === 408 || status === 429 || status >= 500) throw new Error(`临时网络错误 HTTP ${status}`)
      throw new FileDownloadError(`图片下载失败（${host}）：HTTP ${status}`)
    }
    const headers = response.headers()
    if (Number(headers['content-length'] ?? 0) > MAX_BYTES) throw new FileDownloadError('下载文件超过 25 MB，已停止上传')
    const buffer = await timed(response.body())
    if (!buffer.length) throw new FileDownloadError('下载文件为空，已停止上传')
    if (buffer.length > MAX_BYTES) throw new FileDownloadError('下载文件超过 25 MB，已停止上传')
    return { buffer, headers }
  }
  for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt += 1) {
    let response: APIResponse | undefined
    try {
      trace?.(`下载上传文件：接口通道，第 ${attempt + 1}/2 次`)
      response = await timed(page.context().request.get(url, { timeout: Math.min(10_000, Math.max(1, Math.floor(remaining() / (3 - attempt)))) }))
      return await read(response)
    } catch (error) {
      if (error instanceof FileDownloadError) throw error
      const detail = error instanceof Error ? error.message : String(error)
      // Never copy Playwright's request log: it contains the session cookies.
      last = /TLS|secure connection/i.test(detail) ? 'HTTPS 安全连接建立前被断开' : /timeout|超时/i.test(detail) ? '下载超时' : '网络连接失败'
      if (!transient.test(detail) && !/临时网络错误/.test(detail)) throw new FileDownloadError(`图片下载失败（${host}）：${last}`)
      trace?.(`接口下载未成功：${last}；仅重试下载，不重复页面操作`)
    } finally { await response?.dispose().catch(() => undefined) }
    const delay = 400 * (attempt + 1)
    if (remaining() <= delay + 100) break
    await new Promise(resolve => setTimeout(resolve, delay))
  }
  if (Date.now() < deadline) {
    let temporary: Page | undefined
    let closed = false
    try {
      trace?.('切换 Chromium 浏览器通道下载文件')
      const creation = page.context().newPage().then(created => {
        if (closed) { void created.close().catch(() => undefined); throw new Error('图片下载超时') }
        temporary = created
        return created
      })
      const browserPage = await timed(creation)
      const response = await timed(browserPage.goto(url, { waitUntil: 'load', timeout: remaining() }))
      if (!response) throw new Error('图片下载未收到响应')
      return await read(response)
    } catch (error) {
      if (error instanceof FileDownloadError) throw error
      last = error instanceof Error && /timeout|超时/i.test(error.message) ? '下载超时' : '接口和浏览器两个通道均未能下载文件'
    } finally {
      closed = true
      await temporary?.close().catch(() => undefined)
    }
  }
  throw new FileDownloadError(`图片下载失败（${host}）：${last}。请检查该设备的网络或代理，以及图片地址是否可访问；已停止，避免重复执行前面的行操作。`)
}
