export interface ListRowMatchRule {
  readonly matchMode: 'exact' | 'contains'
  readonly trim: boolean
  readonly ignoreCase: boolean
}

function normalize(value: string, rule: ListRowMatchRule): string {
  let result = rule.trim ? value.trim() : value
  if (rule.ignoreCase) result = result.toLocaleLowerCase()
  return result
}

/** Every configured field must match. Contains means page value contains target value. */
export function listRowValuesMatch(
  rules: readonly ListRowMatchRule[],
  pageValues: readonly string[],
  targetValues: readonly string[],
): boolean {
  return rules.every((rule, index) => {
    const pageValue = normalize(pageValues[index] ?? '', rule)
    const targetValue = normalize(targetValues[index] ?? '', rule)
    if (rule.matchMode === 'contains') {
      // Avoid the JavaScript "anything includes empty string" behavior,
      // which could otherwise update or delete unrelated rows.
      return targetValue === '' ? pageValue === '' : pageValue.includes(targetValue)
    }
    return pageValue === targetValue
  })
}
