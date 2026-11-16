import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { openPlaywrightSession } from './playwright-driver.ts'

describe.skipIf(process.env.RPA_BROWSER_INTEGRATION !== '1' || !existsSync(chromium.executablePath()))('drawer click browser regression', () => {
  const picked = 'text-exact:提交 · 父级:html > body:nth-of-type(1) > div.arco-drawer-wrapper:nth-of-type(6)'

  it('clicks the unique visible drawer button after portal indices change, ignoring hidden and background buttons', async () => {
    const session = await openPlaywrightSession({ headless: true })
    try {
      await session.driver.openPage(`data:text/html;charset=utf-8,${encodeURIComponent(`<button>提交</button><div class="arco-drawer-wrapper" style="display:none"><button>提交</button></div><div class="arco-drawer-wrapper"><button onclick="this.id='submitted'">提交</button></div>`)}`)
      await session.driver.click(picked, 1000)
      expect(await session.driver.elementState!('#submitted')).toMatchObject({ exists: true })
    } finally { await session.close() }
  })

  it('waits for the drawer button to appear asynchronously', async () => {
    const session = await openPlaywrightSession({ headless: true })
    try {
      await session.driver.openPage(`data:text/html;charset=utf-8,${encodeURIComponent(`<div class="arco-drawer-wrapper"></div><script>setTimeout(()=>{const b=document.createElement('button');b.textContent='提交';b.onclick=()=>b.id='submitted';document.querySelector('div').append(b)},200)</script>`)}`)
      await session.driver.click(picked, 1500)
      expect(await session.driver.elementState!('#submitted')).toMatchObject({ exists: true })
    } finally { await session.close() }
  })

  it('refuses ambiguous submit buttons without clicking either', async () => {
    const session = await openPlaywrightSession({ headless: true })
    try {
      await session.driver.openPage(`data:text/html;charset=utf-8,${encodeURIComponent(`<div class="arco-drawer-wrapper"><button onclick="this.id='submitted'">提交</button></div><div class="arco-drawer-wrapper"><button onclick="this.id='submitted'">提交</button></div>`)}`)
      await expect(session.driver.click(picked, 1000)).rejects.toThrow('匹配到 2 个元素')
      expect(await session.driver.elementState!('#submitted')).toMatchObject({ exists: false })
    } finally { await session.close() }
  })

  it('preserves an explicit inner form scope', async () => {
    const session = await openPlaywrightSession({ headless: true })
    try {
      await session.driver.openPage(`data:text/html;charset=utf-8,${encodeURIComponent(`<div class="arco-drawer-wrapper"><div id="wanted"><button onclick="this.id='submitted'">提交</button></div><button>提交</button></div>`)}`)
      await session.driver.click('text-exact:提交 · 父级:#wanted', 1000)
      expect(await session.driver.elementState!('#submitted')).toMatchObject({ exists: true })
    } finally { await session.close() }
  })
})
