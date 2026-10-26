export function displayPickedSelector(value: string): string {
  const scopedTextPrefix = 'text-exact:rpa-context:'
  const fingerprintPrefix = 'rpa-fingerprint:'
  const encoded = value.startsWith(scopedTextPrefix)
    ? value.slice(scopedTextPrefix.length)
    : value.startsWith(fingerprintPrefix)
      ? value.slice(fingerprintPrefix.length)
      : undefined
  if (encoded === undefined) return value
  try {
    const fingerprint = JSON.parse(decodeURIComponent(encoded)) as { css?: unknown; text?: unknown; parentPath?: unknown; textIndex?: unknown }
    if (value.startsWith(scopedTextPrefix) && typeof fingerprint.text === 'string') {
      const index = typeof fingerprint.textIndex === 'number' && fingerprint.textIndex > 0 ? ` · 第${fingerprint.textIndex + 1}个同名` : ''
      const parent = typeof fingerprint.parentPath === 'string' && fingerprint.parentPath !== '' ? ` · 父级:${fingerprint.parentPath}` : ''
      return `text-exact:${fingerprint.text}${index}${parent}`
    }
    return typeof fingerprint.css === 'string' ? fingerprint.css : value
  } catch {
    return value
  }
}
