import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_COUNT, normalizeImageSource, normalizeImageSources } from './image-source.ts'

const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

describe('normalizeImageSource', () => {
  it('accepts data URLs, raw Base64 and nested image objects', async () => {
    const expected = `data:image/png;base64,${tinyPng}`
    expect(await normalizeImageSource(expected)).toBe(expected)
    expect(await normalizeImageSource(tinyPng)).toBe(expected)
    expect(await normalizeImageSource({ data: { imageUrl: expected } })).toBe(expected)
  })

  it('passes image URLs directly to the vision model without probing them', async () => {
    expect(await normalizeImageSource('https://example.com/a.png?token=secret')).toBe('https://example.com/a.png?token=secret')
    await expect(normalizeImageSource('not-an-image')).rejects.toThrow('仅支持 PNG')
  })

  it('rejects empty and unsupported image values', async () => {
    await expect(normalizeImageSource(null)).rejects.toThrow('图片变量为空')
    await expect(normalizeImageSource(Buffer.from('hello').toString('base64'))).rejects.toThrow('仅支持 PNG')
  })

  it('normalizes ordered image arrays and image collection objects', async () => {
    const expected = `data:image/png;base64,${tinyPng}`
    await expect(normalizeImageSources([expected, { imageUrl: expected }])).resolves.toEqual([{ dataUrl: expected }, { dataUrl: expected }])
    await expect(normalizeImageSources({ images: [expected, expected] })).resolves.toHaveLength(2)
    await expect(normalizeImageSources(JSON.stringify([expected, expected]))).resolves.toHaveLength(2)
  })

  it('rejects empty or oversized image collections', async () => {
    await expect(normalizeImageSources([])).rejects.toThrow('图片数组为空')
    await expect(normalizeImageSources(Array.from({ length: MAX_IMAGE_COUNT + 1 }, () => `data:image/png;base64,${tinyPng}`))).rejects.toThrow(`一次最多识别 ${MAX_IMAGE_COUNT} 张图片`)
  })

  it('keeps the first configured number of images when truncation is enabled', async () => {
    const expected = `data:image/png;base64,${tinyPng}`
    await expect(normalizeImageSources(
      [expected, expected, expected, expected],
      { maxCount: 3, truncate: true },
    )).resolves.toHaveLength(3)
  })
})
