import type { ImageRecognitionConfig } from './types.ts'

/** Image branch ports use stable IDs, so reordering does not change their wiring. */
export function reorderImageRecognitionCase(config: ImageRecognitionConfig, from: number, to: number): ImageRecognitionConfig {
  if (from < 0 || to < 0 || from >= config.cases.length || to >= config.cases.length || from === to) return config
  const cases = [...config.cases]
  const [item] = cases.splice(from, 1)
  if (item !== undefined) cases.splice(to, 0, item)
  return { ...config, cases }
}
