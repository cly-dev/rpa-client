import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { openPlaywrightSession } from './playwright-driver.ts'

describe.skipIf(process.env.RPA_BROWSER_INTEGRATION !== '1' || !existsSync(chromium.executablePath()))('scoped popup selection', () => {
  const cases = [
    { name: 'prefers the picked popup when two visible popups contain the same text', html: '<div id="wanted" class="arco-select-popup"><div role="option" onclick="this.id=\'clicked\'">买错</div></div><div class="arco-select-popup"><div role="option">买错</div></div>', parent: '#wanted.arco-select-popup' },
    { name: 'deduplicates multiple matching labels inside a single selectable row', html: '<div class="arco-tree-select-popup"><div role="treeitem" onclick="this.id=\'clicked\'"><span>买错</span><span>买错</span></div></div>', parent: '.arco-tree-select-popup' },
    { name: 'keeps a stale picked leaf distinct from a same-named category', html: '<div class="arco-tree-select-popup"><div class="arco-tree-node">买错</div>' + '<div class="arco-tree-node arco-tree-node-is-leaf">其他</div>'.repeat(11) + '<div class="arco-tree-node arco-tree-node-is-leaf" onclick="this.id=\'clicked\'">买错</div></div>', parent: 'html > body > div.arco-tree-select-popup > div.arco-tree-node.arco-tree-node-is-leaf:nth-of-type(13)' },
    { name: 'falls back after a structural popup path changes', html: '<div class="arco-select-popup"><div role="option" onclick="this.id=\'clicked\'">买错</div></div>', parent: 'html > body > div.arco-select-popup:nth-of-type(9)' },
  ]
  for (const c of cases) it(c.name, async () => {
    const session = await openPlaywrightSession({ headless: true })
    try {
      await session.driver.openPage(`data:text/html;charset=utf-8,${encodeURIComponent(c.html)}`)
      await session.driver.click(`text-exact:买错 · 父级:${c.parent}`, 2000)
      expect(await session.driver.elementState!('#clicked')).toMatchObject({ exists: true })
    } finally { await session.close() }
  })
  it('refuses two different selectable rows even when their text is identical', async () => {
    const session = await openPlaywrightSession({ headless: true })
    try {
      await session.driver.openPage(`data:text/html;charset=utf-8,${encodeURIComponent('<div class="arco-tree-select-popup"><div role="treeitem" onclick="this.id=\'clicked\'">买错</div><div role="treeitem" onclick="this.id=\'clicked\'">买错</div></div>')}`)
      await expect(session.driver.click('text-exact:买错 · 父级:.arco-tree-select-popup', 2000)).rejects.toThrow('2 个独立选项')
      expect(await session.driver.elementState!('#clicked')).toMatchObject({ exists: false })
    } finally { await session.close() }
  })
})
