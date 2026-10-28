export const DEFAULT_IMAGE_RECOGNITION_MAX_IMAGES = 3
export const MAX_IMAGE_RECOGNITION_MAX_IMAGES = 8

export function normalizeImageRecognitionMaxImages(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_IMAGE_RECOGNITION_MAX_IMAGES
  return Math.min(MAX_IMAGE_RECOGNITION_MAX_IMAGES, Math.max(1, Math.floor(value)))
}
