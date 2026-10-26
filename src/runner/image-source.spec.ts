import { describe, expect, it, vi } from 'vitest'
import { MAX_IMAGE_COUNT, normalizeImageSource, normalizeImageSourcesWithProbe, normalizeImageSourceWithProbe } from './image-source.ts'

const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

describe('normalizeImageSource', () => {
  it('accepts data URLs, raw Base64 and nested image objects', async () => {
    const expected = `data:image/png;base64,${tinyPng}`
    expect(await normalizeImageSource(expected)).toBe(expected)
    expect(await normalizeImageSource(tinyPng)).toBe(expected)
    expect(await normalizeImageSource({ data: { imageUrl: expected } })).toBe(expected)
  })

  it('downloads image URLs and keeps the image bytes out of error messages', async () => {
    const fetcher = vi.fn(async () => new Response(Buffer.from(tinyPng, 'base64'), { headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch
    expect(await normalizeImageSource('https://example.com/a.png', fetcher)).toBe(`data:image/png;base64,${tinyPng}`)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(await normalizeImageSourceWithProbe('https://example.com/a.png', fetcher)).toEqual({
      dataUrl: `data:image/png;base64,${tinyPng}`,
      probe: { status: 200, mime: 'image/png', bytes: 8 },
    })
    await expect(normalizeImageSource('not-an-image')).rejects.toThrow('仅支持 PNG')
  })

  it('rejects inaccessible links and non-image responses before calling the vision model', async () => {
    const notFound = vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
    await expect(normalizeImageSourceWithProbe('https://example.com/missing.png', notFound)).rejects.toThrow('访问探针失败（HTTP 404）')

    const html = vi.fn(async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    await expect(normalizeImageSourceWithProbe('https://example.com/photo.png', html)).rejects.toThrow('返回内容不是支持的图片（Content-Type: text/html）')

    const empty = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch
    await expect(normalizeImageSourceWithProbe('https://example.com/empty.png', empty)).rejects.toThrow('响应没有图片内容')
  })

  it('rejects empty and unsupported image values', async () => {
    await expect(normalizeImageSource(null)).rejects.toThrow('图片变量为空')
    await expect(normalizeImageSource(Buffer.from('hello').toString('base64'))).rejects.toThrow('仅支持 PNG')
  })

  it('normalizes ordered image arrays and image collection objects', async () => {
    const expected = `data:image/png;base64,${tinyPng}`
    await expect(normalizeImageSourcesWithProbe([expected, { imageUrl: expected }])).resolves.toEqual([{ dataUrl: expected }, { dataUrl: expected }])
    await expect(normalizeImageSourcesWithProbe({ images: [expected, expected] })).resolves.toHaveLength(2)
    await expect(normalizeImageSourcesWithProbe(JSON.stringify([expected, expected]))).resolves.toHaveLength(2)
  })

  it('rejects empty or oversized image collections', async () => {
    await expect(normalizeImageSourcesWithProbe([])).rejects.toThrow('图片数组为空')
    await expect(normalizeImageSourcesWithProbe(Array.from({ length: MAX_IMAGE_COUNT + 1 }, () => `data:image/png;base64,${tinyPng}`))).rejects.toThrow(`一次最多识别 ${MAX_IMAGE_COUNT} 张图片`)
  })
})
