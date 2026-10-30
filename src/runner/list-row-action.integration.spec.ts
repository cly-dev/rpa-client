import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { openPlaywrightSession } from './playwright-driver.ts'

describe.skipIf(process.env.RPA_BROWSER_INTEGRATION !== '1' || !existsSync(chromium.executablePath()))('list-row-action browser integration', () => {
  it('updates matched rows and rescans the DOM after deleting an unmatched row', async () => {
    const within = async <T>(promise: Promise<T>, label: string): Promise<T> => Promise.race([
      promise,
      new Promise<never>((_, reject) => { setTimeout(() => { reject(new Error(`${label}超时`)) }, 5_000) }),
    ])
    const session = await openPlaywrightSession({ headless: true })
    try {
      const html = `<!doctype html><meta charset="utf-8"><div class="GridContainer__GridContainer--empty"></div><div id="items" class="GridContainer__GridContainer--orders">
        <div class="row ComplaintDetailListItem__listItem--hX9UYqj"><div class="ComplaintDetailListItem__listItemField--y9u06Pe"><span class="sku ComplaintDetailListItem__listingSku--dlA_w1W">商品编码：SKU-A（套装）</span></div><input class="qty" value="1"><button class="commit" onclick="this.parentElement.querySelector('.out').textContent=this.parentElement.querySelector('.qty').value">保存</button><span class="out"></span><button class="delete" onclick="this.parentElement.remove()">删除</button></div>
        <div class="row ComplaintDetailListItem__listItem--hX9UYqj"><div class="ComplaintDetailListItem__listItemField--y9u06Pe"><span class="sku ComplaintDetailListItem__listingSku--dlA_w1W">SKU-B</span></div><input class="qty" value="1"><button class="commit" onclick="this.parentElement.querySelector('.out').textContent=this.parentElement.querySelector('.qty').value">保存</button><span class="out"></span><button class="delete" onclick="this.parentElement.remove()">删除</button></div>
        <div class="row ComplaintDetailListItem__listItem--hX9UYqj"><div class="ComplaintDetailListItem__listItemField--y9u06Pe"><span class="sku ComplaintDetailListItem__listingSku--dlA_w1W">SKU-C</span></div><input class="qty" value="1"><button class="commit" onclick="this.parentElement.querySelector('.out').textContent=this.parentElement.querySelector('.qty').value">保存</button><span class="out"></span><button class="delete" onclick="this.parentElement.remove()">删除</button></div>
      </div>`
      await session.driver.openPage(`data:text/html,${encodeURIComponent(html)}`)

      const containerPick = session.pickElement(undefined, 'list-container')
      await session.driver.waitFor(2_000, '#__rpa_picker_panel__', 'visible')
      await within(session.driver.click('.row:nth-child(2) .sku'), '点击列表容器')
      await within(session.driver.click('#__rpa_picker_panel__ [data-action="confirm"]'), '确认列表容器')
      const pickedContainer = await within(containerPick, '返回列表容器选择器')
      expect(pickedContainer.selector).toBe('#items')
      expect(pickedContainer.selector).not.toContain('text-exact')

      const rowPick = session.pickElement(undefined, 'list-row', { scopeSelector: pickedContainer.selector })
      await session.driver.waitFor(2_000, '#__rpa_picker_panel__', 'visible')
      await within(session.driver.click('.row:nth-child(2) .sku'), '点击样例行')
      await within(session.driver.click('#__rpa_picker_panel__ [data-action="confirm"]'), '确认样例行')
      expect((await session.driver.elementState!('#__rpa_picker_panel__')).exists).toBe(false)
      const pickedRow = await within(rowPick, '返回行选择器')
      expect(pickedRow).toMatchObject({
        selector: '[class*="ComplaintDetailListItem__listItem--"]',
        rowSelectorMode: 'class-contains',
        rowSelectorValue: 'ComplaintDetailListItem__listItem',
      })

      const fieldPick = session.pickElement(undefined, 'row-element', { scopeSelector: '[class*="GridContainer__GridContainer"]', rowSelectorMode: pickedRow.rowSelectorMode, rowSelector: pickedRow.selector })
      await session.driver.waitFor(2_000, '#__rpa_picker_panel__', 'visible')
      await within(session.driver.click('.row:nth-child(2) .qty'), '点击行内字段')
      await within(session.driver.click('#__rpa_picker_panel__ [data-action="confirm"]'), '确认行内字段')
      const pickedField = await within(fieldPick, '返回行内选择器')
      expect(pickedField.selector).toBe('input.qty')

      const matchFieldPick = session.pickElement(undefined, 'row-element', { scopeSelector: '[class*="GridContainer__GridContainer"]', rowSelectorMode: pickedRow.rowSelectorMode, rowSelector: pickedRow.rowSelectorValue })
      await session.driver.waitFor(2_000, '#__rpa_picker_panel__', 'visible')
      await within(session.driver.click('.row:nth-child(2) .sku'), '点击行内匹配字段')
      await within(session.driver.click('#__rpa_picker_panel__ [data-action="confirm"]'), '确认行内匹配字段')
      const pickedMatchField = await within(matchFieldPick, '返回行内匹配字段选择器')
      expect(pickedMatchField).toMatchObject({
        selector: '[class*="ComplaintDetailListItem__listingSku--"]',
        relativeSelectorMode: 'class-contains',
        relativeSelectorValue: 'ComplaintDetailListItem__listingSku',
      })

      const operationLogs: string[] = []
      const result = await session.driver.operateListRows!({
        containerSelector: '#items', rowSelectorMode: 'class-contains', rowSelector: 'ComplaintDetailListItem__listItem',
        matchFields: [{ selector: '[class*="ComplaintDetailListItem__listingSku--"]', matchMode: 'contains', readMode: 'text', trim: true, ignoreCase: false }],
        items: [
          { index: 0, matchValues: ['SKU-A'], actionValues: ['2', ''] },
          { index: 1, matchValues: ['SKU-C'], actionValues: ['5', ''] },
        ],
        actions: [{ type: 'type', selector: '.qty', inputMode: 'replace' }, { type: 'click', selector: '.commit' }],
        unmatchedMode: 'delete', deleteSelector: '.delete', confirmSelector: '', waitAfterDeleteMs: 0, maxDeleteCount: 2,
        missingMatchAction: 'stop', duplicateMatchAction: 'all', emptySourceAction: 'stop', timeoutMs: 5_000,
        trace: message => { operationLogs.push(message) },
      })

      expect(result).toMatchObject({ totalPageRows: 3, matchedCount: 2, updatedCount: 2, deletedCount: 1, finalPageRows: 2 })
      expect(await session.driver.extract('#items')).toContain('SKU-A')
      expect(await session.driver.extract('#items')).not.toContain('SKU-B')
      expect(await session.driver.extract('#items')).toContain('SKU-C')
      expect(await session.driver.extract('.row:nth-child(1) .out')).toBe('2')
      expect(await session.driver.extract('.row:nth-child(2) .out')).toBe('5')
      expect(operationLogs.some(message => message.includes('首次扫描页面：找到 3 个页面行'))).toBe(true)
      expect(operationLogs.some(message => message.includes('匹配目标数据第 1 条：页面命中 1 行'))).toBe(true)
      expect(operationLogs.some(message => message.includes('删除预检：未匹配页面行 1 条'))).toBe(true)
      expect(operationLogs.some(message => message.includes('列表行操作汇总'))).toBe(true)

      await session.driver.openPage(`data:text/html,${encodeURIComponent(html)}`)
      const emptyResult = await session.driver.operateListRows!({
        containerSelector: '#items', rowSelectorMode: 'class-contains', rowSelector: 'ComplaintDetailListItem__listItem',
        matchFields: [{ selector: '[class*="ComplaintDetailListItem__listingSku--"]', matchMode: 'exact', readMode: 'text', trim: true, ignoreCase: false }],
        items: [], actions: [], unmatchedMode: 'delete', deleteSelector: '.delete', confirmSelector: '', waitAfterDeleteMs: 0, maxDeleteCount: 3,
        missingMatchAction: 'stop', duplicateMatchAction: 'all', emptySourceAction: 'keep', timeoutMs: 5_000,
      })
      expect(emptyResult).toMatchObject({ deletedCount: 0, finalPageRows: 3 })
    } finally {
      await session.close()
    }
  }, 20_000)
})
