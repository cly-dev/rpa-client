import { describe, expect, it } from 'vitest'
import { isPickedDropdownOption, looksLikeDropdownTrigger, pickedSelectorsTargetSameElement, shouldInsertDropdownTrigger, shouldInsertPickedDropdownSteps } from './picked-selector.ts'

function fingerprint(text: string, css = '#status', role = 'combobox'): string {
  return `text-exact:rpa-context:${encodeURIComponent(JSON.stringify({ version: 1, tag: 'div', role, css, parentPath: '#form', text }))}`
}

describe('picked dropdown selectors', () => {
  it('recognizes a dropdown trigger after its displayed value changes', () => {
    expect(pickedSelectorsTargetSameElement(fingerprint('请选择'), fingerprint('选项 A'))).toBe(true)
  })

  it('does not merge different dropdowns', () => {
    expect(pickedSelectorsTargetSameElement(fingerprint('请选择', '#first'), fingerprint('请选择', '#second'))).toBe(false)
  })

  it('supports unchanged legacy selectors', () => {
    expect(pickedSelectorsTargetSameElement('#status', '#status')).toBe(true)
  })

  it('does not click a dropdown trigger twice when preparation already opened it', () => {
    expect(shouldInsertDropdownTrigger([fingerprint('请选择')], fingerprint('选项 A'))).toBe(false)
  })

  it('adds the trigger when the option was picked without a preceding dropdown click', () => {
    expect(shouldInsertDropdownTrigger(['#login'], fingerprint('请选择'))).toBe(true)
  })

  it('recognizes option fingerprints', () => {
    expect(isPickedDropdownOption(fingerprint('选项 A', '#option-a', 'option'))).toBe(true)
    expect(isPickedDropdownOption(fingerprint('买错', '#reason-tree', 'treeitem'))).toBe(true)
    expect(isPickedDropdownOption(fingerprint('请选择'))).toBe(false)
  })

  it('does not treat a drawer form label as a dropdown trigger', () => {
    expect(looksLikeDropdownTrigger(fingerprint('销售平台单号', 'label:nth-of-type(1)', ''))).toBe(false)
    expect(shouldInsertPickedDropdownSteps(
      fingerprint('销售平台单号', 'label:nth-of-type(1)', ''),
      fingerprint('买错', '#reason-tree', 'treeitem'),
      [],
    )).toBe(false)
  })

  it('still inserts a real combobox trigger before a tree option', () => {
    expect(shouldInsertPickedDropdownSteps(
      fingerprint('请选择', '#status', 'combobox'),
      fingerprint('买错', '#reason-tree', 'treeitem'),
      [],
    )).toBe(true)
  })
})
