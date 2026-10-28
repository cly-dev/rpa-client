import type { JsonValue } from '@graph/types.ts'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_IMAGE_COUNT = 8
export const MAX_IMAGE_TOTAL_BYTES = 24 * 1024 * 1024
type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export interface NormalizedImageSource { readonly dataUrl: string }
export interface NormalizeImageSourcesOptions {
  readonly maxCount?: number
  /** Ignore values after maxCount instead of rejecting the whole collection. */
  readonly truncate?: boolean
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

/** Converts JSON workflow values to an image URL or bounded data URL for vision models. */
export async function normalizeImageSource(value: JsonValue): Promise<string> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as { readonly [key: string]: JsonValue }
    for (const key of ['imageUrl', 'image_url', 'url', 'src', 'base64', 'data']) {
      const nested = record[key]
      if (nested !== undefined && nested !== null && (typeof nested !== 'string' || nested.trim() !== '')) return normalizeImageSource(nested)
    }
  }
  if (typeof value !== 'string' || value.trim() === '') throw new Error('图片变量为空；请选择包含图片 URL、Base64 或图片对象的变量')
  const text = value.trim()
  const data = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,(.*)$/is.exec(text)
  if (data !== null) return fromBase64(data[1] ?? '')
  if (/^https?:\/\//i.test(text)) return text
  return fromBase64(text)
}

function collectImageValues(value: JsonValue): JsonValue[] {
  const decoded = decodeImageCollectionValue(value)
  if (decoded !== value) return collectImageValues(decoded)
  if (Array.isArray(value)) return value.flatMap(collectImageValues)
  if (value !== null && typeof value === 'object') {
    const record = value as { readonly [key: string]: JsonValue }
    for (const key of ['images', 'imageUrls', 'image_urls', 'urls']) {
      const nested = record[key]
      if (Array.isArray(nested)) return nested.flatMap(collectImageValues)
    }
  }
  return [value]
}

/** Accept JSON text produced by runtime text inputs, such as `["https://..."]`. */
export function decodeImageCollectionValue(value: JsonValue): JsonValue {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!(text.startsWith('[') || text.startsWith('{'))) return value
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean') return parsed
    if (Array.isArray(parsed)) return parsed as JsonValue
    if (typeof parsed === 'object') return parsed as JsonValue
  } catch { /* Let the normal image validation report malformed input below. */ }
  return value
}

function dataUrlBytes(dataUrl: string): number {
  if (!dataUrl.startsWith('data:image/')) return 0
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? 0 : Buffer.from(dataUrl.slice(comma + 1), 'base64').byteLength
}

/** Converts one image or a nested image array into an ordered, bounded collection. */
export async function normalizeImageSources(value: JsonValue, options: NormalizeImageSourcesOptions = {}): Promise<readonly NormalizedImageSource[]> {
  const collected = collectImageValues(value)
  if (collected.length === 0) throw new Error('图片数组为空；请至少提供一张图片')
  const maxCount = Math.min(MAX_IMAGE_COUNT, Math.max(1, Math.floor(options.maxCount ?? MAX_IMAGE_COUNT)))
  if (collected.length > maxCount && options.truncate !== true) throw new Error(`一次最多识别 ${maxCount} 张图片，当前共 ${collected.length} 张`)
  const values = options.truncate === true ? collected.slice(0, maxCount) : collected
  const sources = await Promise.all(values.map(async (item, imageIndex) => {
    try { return { dataUrl: await normalizeImageSource(item) } }
    catch (error) { throw new Error(`第 ${imageIndex + 1} 张图片处理失败：${error instanceof Error ? error.message : String(error)}`) }
  }))
  const totalBytes = sources.reduce((total, source) => total + dataUrlBytes(source.dataUrl), 0)
  if (totalBytes > MAX_IMAGE_TOTAL_BYTES) throw new Error(`全部图片合计超过 ${MAX_IMAGE_TOTAL_BYTES / 1024 / 1024} MB，请减少图片数量或大小`)
  return sources
}
