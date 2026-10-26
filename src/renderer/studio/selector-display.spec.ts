import { describe, expect, it } from 'vitest'
import { displayPickedSelector } from './selector-display.ts'

describe('displayPickedSelector', () => {
  it('shows both exact text and its parent DOM scope', () => {
    const encoded = encodeURIComponent(JSON.stringify({ text: '买错', parentPath: '#reason-tree > div.arco-tree > span.node', css: 'span.node-text' }))
    expect(displayPickedSelector(`text-exact:rpa-context:${encoded}`)).toBe('text-exact:买错 · 父级:#reason-tree > div.arco-tree > span.node')
  })

  it('shows which same-text tree option was picked', () => {
    const encoded = encodeURIComponent(JSON.stringify({ text: '买错', textIndex: 1, parentPath: 'div.arco-tree-node:nth-of-type(30)', css: 'span' }))
    expect(displayPickedSelector(`text-exact:rpa-context:${encoded}`)).toBe('text-exact:买错 · 第2个同名 · 父级:div.arco-tree-node:nth-of-type(30)')
  })

  it('keeps a stable ID selector unchanged', () => {
    expect(displayPickedSelector('#reasonSelect')).toBe('#reasonSelect')
  })
})
