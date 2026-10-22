import type { JsonValue } from '@graph/types.ts'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export interface ImageAccessProbe { readonly status: number; readonly mime: ImageMime; readonly bytes: number }
export interface NormalizedImageSource { readonly dataUrl: string; readonly probe?: ImageAccessProbe }

export class ImageAccessProbeError extends Error {
  constructor(message: string, readonly url: string) {
    super(message)
    this.name = 'ImageAccessProbeError'
  }
}

function detectMime(bytes: Uint8Array): ImageMime | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)).startsWith('GIF8')) return 'image/gif'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp'
  return undefined
}

function fromBase64(value: string): string {
  const clean = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (!clean || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('图片变量不是有效的 Base64 图片')
  if (clean.length > MAX_IMAGE_BYTES * 4 / 3 + 8) throw new Error('图片超过 8 MB，请使用更小的图片')
  const bytes = Buffer.from(clean, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MB 或内容为空')
  const mime = detectMime(bytes)
  if (mime === undefined) throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片')
  return `data:${mime};base64,${bytes.toString('base64')}`
}

async function fromUrl(value: string, fetcher: typeof fetch): Promise<NormalizedImageSource> {
  let response: Response
  try { response = await fetcher(value, { signal: AbortSignal.timeout(15_000) }) }
  catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('图片链接访问探针超时（15 秒）')
    throw new Error('图片链接访问探针失败，请检查地址、网络和访问权限')
  }
  if (!response.ok) throw new Error(`图片链接访问探针失败（HTTP ${response.status}）`)
  if (response.body === null) throw new Error('图片链接访问探针失败：响应没有图片内容')
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MB，请使用更小的图片')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      size += chunk.byteLength
      if (size > MAX_IMAGE_BYTES) throw new Error('图片超过 8 MB，请使用更小的图片')
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('图片超过')) throw error
    throw new Error('图片链接访问探针失败：读取响应内容中断')
  } finally { await reader.cancel().catch(() => undefined) }
  if (size === 0) throw new Error('图片链接访问探针失败：响应没有图片内容')
  const bytes = Buffer.concat(chunks)
  const mime = detectMime(bytes)
  if (mime === undefined) {
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().slice(0, 80) || '未知'
    throw new Error(`图片链接访问探针失败：返回内容不是支持的图片（Content-Type: ${contentType}）`)
  }
  return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, probe: { status: response.status, mime, bytes: size } }
}

/** Converts JSON workflow values to a bounded image data URL for vision models. */
export async function normalizeImageSourceWithProbe(value: JsonValue, fetcher: typeof fetch = fetch): Promise<NormalizedImageSource> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as { readonly [key: string]: JsonValue }
    for (const key of ['imageUrl', 'image_url', 'url', 'src', 'base64', 'data']) {
      const nested = record[key]
      if (nested !== undefined && nested !== null && (typeof nested !== 'string' || nested.trim() !== '')) return normalizeImageSourceWithProbe(nested, fetcher)
    }
  }
  if (typeof value !== 'string' || value.trim() === '') throw new Error('图片变量为空；请选择包含图片 URL、Base64 或图片对象的变量')
  const text = value.trim()
  const data = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,(.*)$/is.exec(text)
  if (data !== null) return { dataUrl: fromBase64(data[1] ?? '') }
  if (/^https?:\/\//i.test(text)) {
    try { return await fromUrl(text, fetcher) }
    catch (error) {
      if (error instanceof ImageAccessProbeError) throw error
      throw new ImageAccessProbeError(error instanceof Error ? error.message : '图片链接访问探针失败', text)
    }
  }
  return { dataUrl: fromBase64(text) }
}

export async function normalizeImageSource(value: JsonValue, fetcher: typeof fetch = fetch): Promise<string> {
  return (await normalizeImageSourceWithProbe(value, fetcher)).dataUrl
}
