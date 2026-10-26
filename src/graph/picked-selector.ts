const FINGERPRINT_PREFIXES = ['text-exact:rpa-context:', 'rpa-fingerprint:'] as const

interface SelectorFingerprintIdentity {
  readonly css?: unknown
  readonly parentPath?: unknown
  readonly tag?: unknown
  readonly role?: unknown
}

function parseFingerprint(selector: string): SelectorFingerprintIdentity | undefined {
  const prefix = FINGERPRINT_PREFIXES.find(item => selector.startsWith(item))
  if (prefix === undefined) return undefined
  try {
    return JSON.parse(decodeURIComponent(selector.slice(prefix.length))) as SelectorFingerprintIdentity
  } catch {
    return undefined
  }
}

function fingerprintIdentity(selector: string): string | undefined {
  const parsed = parseFingerprint(selector)
  if (parsed === undefined || typeof parsed.css !== 'string' || typeof parsed.tag !== 'string') return undefined
  return JSON.stringify({
    tag: parsed.tag,
    css: parsed.css,
    parentPath: typeof parsed.parentPath === 'string' ? parsed.parentPath : '',
  })
}

/** Fingerprint text may change when a dropdown opens; its DOM identity does not. */
export function pickedSelectorsTargetSameElement(left: string, right: string): boolean {
  if (left === right) return true
  const leftIdentity = fingerprintIdentity(left)
  return leftIdentity !== undefined && leftIdentity === fingerprintIdentity(right)
}

export function shouldInsertDropdownTrigger(previousClickSelectors: readonly string[], triggerSelector: string): boolean {
  return !previousClickSelectors.some(selector => pickedSelectorsTargetSameElement(selector, triggerSelector))
}

export function isPickedDropdownOption(selector: string): boolean {
  const parsed = parseFingerprint(selector)
  return parsed?.tag === 'option' || parsed?.role === 'option' || parsed?.role === 'menuitem' || parsed?.role === 'treeitem'
}

export function looksLikeDropdownTrigger(selector: string): boolean {
  const parsed = parseFingerprint(selector)
  if (parsed === undefined) return false
  const tag = typeof parsed.tag === 'string' ? parsed.tag.toLowerCase() : ''
  const role = typeof parsed.role === 'string' ? parsed.role.toLowerCase() : ''
  if (tag === 'label' || role === 'treeitem' || role === 'option' || role === 'menuitem') return false
  return role === 'combobox' || role === 'button' || tag === 'button' || tag === 'select' || tag === 'input'
}

export function shouldInsertPickedDropdownSteps(triggerSelector: string | undefined, optionSelector: string | undefined, previousClickSelectors: readonly string[]): boolean {
  return triggerSelector !== undefined
    && optionSelector !== undefined
    && looksLikeDropdownTrigger(triggerSelector)
    && isPickedDropdownOption(optionSelector)
    && shouldInsertDropdownTrigger(previousClickSelectors, triggerSelector)
}
