import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { openPlaywrightSession } from './playwright-driver.ts'
import { displayPickedSelector } from '../renderer/studio/selector-display.ts'
import { parseWorkflow } from '../graph/parse.ts'

it.skipIf(process.env.RPA_BROWSER_INTEGRATION !== '1' || !existsSync(chromium.executablePath()))('keeps the picked option key across saving, DOM reordering and dropdown waits', async () => {
  const session = await openPlaywrightSession({ headless: true })
  const row = (key: string) => `<div role="treeitem" data-key="${key}" class="arco-tree-node arco-tree-node-is-leaf" onclick="this.setAttribute('data-clicked','yes')"><span class="arco-tree-node-title"><span class="arco-tree-node-title-text">买错</span></span></div>`
  const html = (reversed = false) => `<meta charset="utf-8"><div class="arco-tree-select-popup"><div class="arco-tree">${reversed ? row('reason-b') + '<div>新增分类</div>' + row('reason-a') : row('reason-a') + row('reason-b')}</div></div>`
  try {
    await session.driver.openPage(`data:text/html;charset=utf-8,${encodeURIComponent(html())}`)
    const selecting = session.pickElement(undefined, 'element')
    await session.driver.waitFor(2000, '#__rpa_picker_panel__', 'visible')
    await session.driver.click('[data-key="reason-b"] .arco-tree-node-title-text')
    await session.driver.click('#__rpa_picker_panel__ [data-action="confirm"]')
    const picked = await selecting
    expect(picked.selector).toContain('text-exact:rpa-context:')
    expect(displayPickedSelector(picked.selector)).toContain('买错')
    const node = { id: 'action', type: 'page-action', name: '选择原因', position: { x: 0, y: 0 }, config: { type: 'page-action', steps: [{ type: 'click', selector: picked.selector }] } }
    const saved = parseWorkflow(JSON.parse(JSON.stringify({ workflowId: 'test', name: 'test', version: 1, entryNodeId: 'action', nodes: [node], edges: [] })))
    expect(saved.ok).toBe(true)
    if (!saved.ok || saved.graph.nodes[0]?.config.type !== 'page-action') throw new Error('roundtrip failed')
    const selector = saved.graph.nodes[0].config.steps[0]!.selector as string
    await session.driver.openPage(`data:text/html;charset=utf-8,${encodeURIComponent(html(true))}`)
    await session.driver.waitFor(2000, selector, 'visible')
    await session.driver.click(selector, 2000)
    expect(await session.driver.elementState!('[data-key="reason-b"][data-clicked="yes"]')).toMatchObject({ exists: true })
    expect(await session.driver.elementState!('[data-key="reason-a"][data-clicked="yes"]')).toMatchObject({ exists: false })
  } finally { await session.close() }
}, 20000)
