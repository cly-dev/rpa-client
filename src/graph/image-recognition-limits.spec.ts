import { describe, expect, it } from 'vitest'
import { normalizeImageRecognitionMaxImages } from './image-recognition-limits.ts'

describe('normalizeImageRecognitionMaxImages', () => {
  it('defaults to 3 and clamps configured values to the supported range', () => {
    expect(normalizeImageRecognitionMaxImages(undefined)).toBe(3)
    expect(normalizeImageRecognitionMaxImages(Number.NaN)).toBe(3)
    expect(normalizeImageRecognitionMaxImages(0)).toBe(1)
    expect(normalizeImageRecognitionMaxImages(6.8)).toBe(6)
    expect(normalizeImageRecognitionMaxImages(99)).toBe(8)
  })
})
