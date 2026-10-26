import { describe, expect, it } from 'vitest'
import { isStableClassName, isStableElementId, lastParentPathSegment, relaxUnstableParentPath, selectFingerprintCandidate, treeNodePathSegment, uniqueExactTextOwners, type ElementFingerprint, type FingerprintCandidate } from './playwright-driver.ts'

const fingerprint: ElementFingerprint = {
  version: 1,
  css: 'div:nth-of-type(2) > button:nth-of-type(1)',
  parentPath: '#dialog-a > footer',
  tag: 'button',
  text: '确定',
  role: 'button',
  attributes: { 'aria-label': '确定' },
  classes: ['primary'],
  context: { tag: 'section', text: '删除商品', attributes: { 'data-id': 'delete-panel' } },
  nearbyText: ['商品编号 A10086'],
}

function candidate(overrides: Partial<FingerprintCandidate> = {}): FingerprintCandidate {
  return {
    index: 0,
    visible: true,
    tag: 'button',
    text: '确定',
    role: 'button',
    attributes: { 'aria-label': '确定' },
    classes: ['primary'],
    fallbackMatch: false,
    parentMatch: false,
    overlayMatch: false,
    ancestors: [],
    nearbyText: [],
    ...overrides,
  }
}

describe('element fingerprint deterministic selection', () => {
  it('keeps business classes and rejects bundler hashes', () => {
    expect(isStableClassName('dialog-footer')).toBe(true)
    expect(isStableClassName('ant-btn-primary')).toBe(true)
    expect(isStableClassName('arco-drawer')).toBe(true)
    expect(isStableClassName('slideRight-appear-done')).toBe(false)
    expect(isStableClassName('slideRight-enter-done')).toBe(false)
    expect(isStableClassName('css-a1b2c3')).toBe(false)
    expect(isStableClassName('Button_primary__x7K2p')).toBe(false)
    expect(isStableClassName('_button_a1b2c3_1')).toBe(false)
  })

  it('keeps stable business IDs and rejects framework-generated IDs', () => {
    expect(isStableElementId('order-status-select')).toBe(true)
    expect(isStableElementId('submitButton')).toBe(true)
    expect(isStableElementId('rc_select_12')).toBe(false)
    expect(isStableElementId('arco-tree-select-popup-1')).toBe(false)
    expect(isStableElementId(':r3:')).toBe(false)
    expect(isStableElementId('550e8400-e29b-41d4-a716-446655440000')).toBe(false)
  })

  it('rejects indistinguishable same-text buttons without guessing', () => {
    expect(() => selectFingerprintCandidate(fingerprint, [candidate({ parentMatch: true }), candidate({ index: 1, parentMatch: true })])).toThrow('元素定位存在歧义')
  })

  it('scopes exact text matches to the picked parent DOM', () => {
    const expected = candidate({ parentMatch: true })
    const sameTextElsewhere = candidate({ index: 1 })

    expect(selectFingerprintCandidate(fingerprint, [sameTextElsewhere, expected])).toBe(expected)
  })

  it('does not treat containing text as a text-exact match', () => {
    const exact = candidate({ parentMatch: true })
    const containing = candidate({ index: 1, text: '确定并继续', parentMatch: true })

    expect(selectFingerprintCandidate(fingerprint, [containing, exact])).toBe(exact)
  })

  it('narrows by stable attributes without assigning scores', () => {
    const expected = candidate({ attributes: { 'aria-label': '确定' } })
    const other = candidate({ index: 1, attributes: { 'aria-label': '取消' } })

    expect(selectFingerprintCandidate({ ...fingerprint, parentPath: undefined }, [other, expected])).toBe(expected)
  })

  it('uses a unique CSS match only as the final deterministic fallback', () => {
    const picked = candidate({ fallbackMatch: true })
    const sameText = candidate({ index: 1 })

    expect(selectFingerprintCandidate({ ...fingerprint, parentPath: undefined }, [picked, sameText])).toBe(picked)
  })

  it('ignores hidden candidates when visibility is required', () => {
    const hidden = candidate({ visible: false, parentMatch: true })
    const visible = candidate({ index: 1, parentMatch: true })

    expect(selectFingerprintCandidate(fingerprint, [hidden, visible])).toBe(visible)
  })

  it('never falls back to page-wide exact text when the picked parent no longer matches', () => {
    expect(selectFingerprintCandidate(fingerprint, [candidate(), candidate({ index: 1 })])).toBeUndefined()
  })

  it('replays a unique exact-text option after an Arco popup ID rotates', () => {
    const stale = candidate({ parentMatch: false })
    expect(selectFingerprintCandidate(fingerprint, [stale])).toBe(stale)
  })

  it('does not click a different same-text tree node when the picked nth parent is missing', () => {
    const visibleOther = candidate({ parentMatch: false, overlayMatch: true, tag: 'span' })
    expect(selectFingerprintCandidate({
      ...fingerprint,
      tag: 'span',
      text: '确定',
      parentPath: 'div.arco-tree > div.arco-tree-node.arco-tree-node-is-leaf:nth-of-type(30)',
      attributes: {},
      classes: [],
      role: '',
    }, [visibleOther])).toBeUndefined()
  })

  it('strips generated popup IDs from a picked parent path', () => {
    expect(relaxUnstableParentPath('#arco-tree-select-popup-1 > div.arco-tree:nth-of-type(1) > span.arco-tree-node-title:nth-of-type(3)'))
      .toBe('div.arco-tree:nth-of-type(1) > span.arco-tree-node-title:nth-of-type(3)')
  })

  it('keeps the picked tree node index instead of collapsing to the whole tree', () => {
    expect(lastParentPathSegment('html > body > div.arco-tree > div.arco-tree-node.arco-tree-node-is-leaf:nth-of-type(30)'))
      .toBe('div.arco-tree-node.arco-tree-node-is-leaf:nth-of-type(30)')
    expect(lastParentPathSegment('html > body > div.arco-tree:nth-of-type(1)'))
      .toBe('div.arco-tree:nth-of-type(1)')
  })

  it('recovers the tree node nth from css when parentPath stopped at the tree', () => {
    expect(treeNodePathSegment({
      css: 'html > body > div.arco-tree > div.arco-tree-node.arco-tree-node-is-leaf:nth-of-type(13)',
      parentPath: 'html > body > div.arco-tree:nth-of-type(1)',
    })).toBe('div.arco-tree-node.arco-tree-node-is-leaf:nth-of-type(13)')
  })

  it('counts same-text tree options, not nested title spans', () => {
    const items = [
      { id: 'node-1', text: '买错', parent: undefined as string | undefined },
      { id: 'title-1', text: '买错', parent: 'node-1' },
      { id: 'title-text-1', text: '买错', parent: 'title-1' },
      { id: 'node-2', text: '买错', parent: undefined },
      { id: 'title-2', text: '买错', parent: 'node-2' },
      { id: 'title-text-2', text: '买错', parent: 'title-2' },
    ]
    const owners = uniqueExactTextOwners(items, '买错', item => item.text, (outer, inner) => {
      let current: string | undefined = inner.parent
      while (current !== undefined) {
        if (current === outer.id) return true
        current = items.find(item => item.id === current)?.parent
      }
      return false
    })
    expect(owners.map(item => item.id)).toEqual(['node-1', 'node-2'])
  })

  it('pins a tree node by nth-of-type even when another same-text option is visible', () => {
    const first = candidate({
      index: 0,
      tag: 'div',
      text: '买错',
      role: 'treeitem',
      parentMatch: false,
      overlayMatch: true,
      attributes: {},
      classes: ['arco-tree-node'],
    })
    const second = candidate({
      index: 1,
      tag: 'div',
      text: '买错',
      role: 'treeitem',
      parentMatch: true,
      overlayMatch: true,
      attributes: {},
      classes: ['arco-tree-node'],
    })
    expect(selectFingerprintCandidate({
      ...fingerprint,
      tag: 'div',
      text: '买错',
      role: 'treeitem',
      parentPath: 'div.arco-tree > div.arco-tree-node.arco-tree-node-is-leaf:nth-of-type(30)',
      attributes: {},
      classes: ['arco-tree-node'],
    }, [first, second])).toBe(second)
  })

  it('collapses nested spans that share the same exact text', () => {
    const outer = candidate({
      tag: 'span',
      classes: ['arco-tree-node-title'],
      attributes: {},
      role: '',
    })
    const inner = candidate({
      index: 1,
      tag: 'span',
      classes: ['arco-tree-node-title-text'],
      attributes: {},
      role: '',
      ancestors: [{ tag: 'span', text: '确定', attributes: {}, classes: ['arco-tree-node-title'] }],
    })
    expect(selectFingerprintCandidate({ ...fingerprint, tag: 'span', parentPath: undefined, role: '', attributes: {}, classes: [] }, [outer, inner])).toBe(inner)
  })

  it('prefers the open tree option over the same label on the trigger', () => {
    const trigger = candidate({ index: 0, tag: 'span', role: '', attributes: {}, classes: [] })
    const option = candidate({
      index: 1,
      tag: 'span',
      role: '',
      attributes: {},
      classes: ['arco-tree-node-title'],
      overlayMatch: true,
      ancestors: [{ tag: 'div', text: '买错', attributes: {}, classes: ['arco-tree'] }],
    })
    expect(selectFingerprintCandidate({
      ...fingerprint,
      tag: 'span',
      text: '确定',
      parentPath: '#arco-tree-select-popup-1 > div.arco-tree > span',
      role: '',
      attributes: {},
      classes: [],
    }, [trigger, option])).toBe(option)
  })
})
