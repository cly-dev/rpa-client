import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { describe, expect, it } from 'vitest'

describe.skipIf(process.env.RPA_BROWSER_INTEGRATION !== '1' || !existsSync(chromium.executablePath()))('rich approval editor in browser', () => {
  it('edits, formats, restores, validates JSON, and sanitizes pasted HTML', async () => {
    const html = `<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';const {createRoot}=ReactDOM;
      import {approvalReviewFromPrompt} from '/src/graph/approval-review.ts';
      import {VariablesPanel} from '/src/renderer/studio/VariablesPanel.tsx';
      import {ApprovalContentEditor} from '/src/renderer/studio/ApprovalContentEditor.tsx';
      import {sanitizeReviewHtml,reviewPlainText} from '/src/renderer/studio/review-html.ts';
      window.legacyReview=approvalReviewFromPrompt;window.sanitizeReviewHtml=sanitizeReviewHtml;window.reviewPlainText=reviewPlainText;
      const root=createRoot(document.getElementById('root'));let mount=0;window.mountReview=(review)=>root.render(React.createElement(ApprovalContentEditor,{key:++mount,review,onChange:r=>window.reviewResult=r}));
      window.mountVariables=(graph)=>root.render(React.createElement(VariablesPanel,{key:++mount,graph}));
      window.mountReview({content:'<p>原始内容</p>',format:'rich-text',editable:true});
    </script></body></html>`
    const server = await createServer({ configFile: false, root: process.cwd(), esbuild: { jsx: 'automatic' }, resolve: { alias: { '@graph': process.cwd() + '/src/graph', '@runner': process.cwd() + '/src/runner' } }, optimizeDeps: { entries: [], include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'squire-rte', 'dompurify'] }, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'review-test', configureServer(s) { s.middlewares.use('/__review_test', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html) }) } }] })
    await server.listen()
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.setDefaultTimeout(5000)
      page.on('pageerror', e => errors.push(e.message))
      const address = server.httpServer!.address() as { port: number }
      await page.goto(`http://127.0.0.1:${address.port}/__review_test`)
      const editor = page.getByRole('textbox', { name: '审核内容' })
      await editor.waitFor({ timeout: 5000 })
      await editor.fill('修改后的回复')
      await editor.press('ControlOrMeta+A')
      await page.getByRole('button', { name: '加粗', exact: true }).click()
      await page.waitForFunction(() => /<(b|strong)>/.test((window as any).reviewResult?.content ?? ''))
      expect(await page.evaluate(() => (window as any).reviewResult)).toMatchObject({ plainText: '修改后的回复', modified: true })
      await page.getByRole('button', { name: '链接', exact: true }).click()
      await page.getByRole('textbox', { name: '链接地址' }).fill('https://example.com/review')
      await page.getByRole('button', { name: '插入链接', exact: true }).click()
      await page.waitForFunction(() => (window as any).reviewResult?.content.includes('https://example.com/review'))
      await page.getByRole('button', { name: '插入表格', exact: true }).click()
      await page.waitForFunction(() => (window as any).reviewResult?.content.includes('<table'))
      await page.getByRole('button', { name: '恢复原内容' }).click()
      await page.waitForFunction(() => (window as any).reviewResult?.modified === false)
      expect(await editor.textContent()).toContain('原始内容')
      const safe = await page.evaluate(() => (window as any).sanitizeReviewHtml('<p onclick="alert(1)">正文<script>alert(2)</script><a href="javascript:alert(3)">链接</a><img src=x onerror="alert(4)"><span style="color:red;background-image:url(https://example.com/x)">红色</span></p>'))
      expect(safe).not.toMatch(/onclick|script|javascript|onerror|<img|background-image/)
      expect(safe).toContain('color: red')
      expect(await page.evaluate(() => (window as any).reviewPlainText('<p>第一行</p><p>第二行<br>第三行</p>'))).toBe('第一行\n第二行\n第三行')
      await page.evaluate(() => (window as any).mountReview({content:{qty:1},format:'json',editable:true}))
      const json = page.locator('textarea[aria-label="审核内容"]')
      await json.fill('{bad')
      await page.waitForFunction(() => (window as any).reviewResult === undefined)
      await json.fill('{"qty":2}')
      await page.waitForFunction(() => (window as any).reviewResult?.content.qty === 2)
      await page.evaluate(() => (window as any).mountReview((window as any).legacyReview({fields:[{label:'客户回复内容',value:'旧审批原文'}],description:'请审核'})))
      await page.getByRole('button', { name: '编辑内容', exact: true }).click()
      await page.getByRole('textbox', { name: '审核内容', exact: true }).fill('旧审批编辑成功')
      await page.waitForFunction(() => (window as any).reviewResult?.plainText === '旧审批编辑成功')
      await page.evaluate(() => (window as any).mountVariables({ workflowId:'panel',name:'审核变量',version:1,entryNodeId:'review',edges:[],nodes:[{id:'review',name:'人工确认',type:'approval',position:{x:0,y:0},config:{type:'approval',outputName:'approvedReply',content:{kind:'literal',value:''}},execution:{}}]}))
      await page.getByRole('button', { name: '展开变量面板' }).click()
      expect(await page.locator('.variables-panel').textContent()).toContain('approvedReply')
      await page.locator('.variables-group-header').filter({ hasText: '人工审批' }).click()
      expect(await page.locator('.variable-item').count()).toBeGreaterThan(5)
      await page.locator('.variable-item').filter({ hasText: 'approvedReply' }).last().click()
      expect(await page.getByRole('dialog').textContent()).toContain('approvedReply')
      if (process.env.RPA_REVIEW_SCREENSHOT === '1') {
        await page.evaluate(async () => {
          const sheet = document.createElement('link'); sheet.rel = 'stylesheet'; sheet.href = '/src/renderer/styles.css?direct';
          const loaded = new Promise(resolve => { sheet.onload = resolve }); document.head.append(sheet); await loaded;
          document.getElementById('root')!.setAttribute('style', 'width:min(560px,calc(100vw - 32px));height:auto;margin:40px auto');
          (window as any).mountReview({content:'<p>Hi Alex,</p><p>感谢您的耐心等待。我们已确认您的退货申请，将为您提供 <strong>免费退货标签</strong>。</p><p>请将未使用的商品放回原包装，贴好标签后交至附近的快递网点。收到退货后，我们会尽快为您安排退款。</p><p>如需其他帮助，欢迎随时联系我们。</p>',format:'rich-text',editable:true});
        });
        await page.setViewportSize({width:680,height:620});
        await page.getByRole('textbox', {name:'审核内容',exact:true}).waitFor();
        await page.waitForFunction(() => (window as any).reviewResult?.modified === false);
        await page.locator('.approval-content-editor').screenshot({path:'/private/tmp/approval-editor-restyled.png'});
        await page.setViewportSize({width:390,height:700});
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.locator('.approval-content-editor').screenshot({path:'/private/tmp/approval-editor-restyled-mobile.png'});
      }
      expect(errors).toEqual([])
    } finally { await browser.close(); await server.close() }
  }, 30000)
})
