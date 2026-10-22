import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { z } from 'zod'
import type { BrowserDriver } from './browser-run.ts'
import { ApiResponseError } from './api-response-error.ts'
import { browserExecutablePath, checkBrowserReadiness } from './browser-readiness.ts'
import type { JsonValue, WorkflowLlmConfig } from '@graph/types.ts'

export interface PlaywrightSession {
  readonly driver: BrowserDriver
  isUsable(): boolean
  pickElement(url?: string, mode?: 'element' | 'list'): Promise<PickedElement>
  openDebugCopy(): Promise<PlaywrightSession>
  close(): Promise<void>
}

export interface PickedElement {
  readonly tagName: string
  readonly text: string
  readonly id: string
  readonly className: string
  readonly ariaLabel: string
  readonly role: string
  readonly placeholder: string
  readonly selector: string
  readonly url: string
  readonly title: string
  readonly optionValue?: string
  readonly triggerSelector?: string
  readonly optionSelector?: string
}

type ApiRequestOptions = Parameters<NonNullable<BrowserDriver['requestApi']>>[0]

type ExactTextPage = Pick<Page, 'getByText'> & Partial<Pick<Page, 'url' | 'title' | 'frames'>>

async function exactTextTimeoutDiagnostics(page: ExactTextPage, text: string): Promise<string> {
  const details: string[] = []
  try {
    if (page.url !== undefined) {
      const currentUrl = new URL(page.url())
      const safeUrl = currentUrl.origin === 'null'
        ? `${currentUrl.protocol}${currentUrl.pathname}`
        : `${currentUrl.origin}${currentUrl.pathname}`
      details.push(`当前页面：${safeUrl.slice(0, 160)}`)
    }
  } catch { /* The page may have closed while the click was waiting. */ }
  try {
    if (page.title !== undefined) details.push(`标题：${(await page.title()).replace(/\s+/g, ' ').slice(0, 80)}`)
  } catch { /* Keep the original timeout error when the page is unavailable. */ }
  try {
    const matches = page.getByText(text, { exact: true })
    details.push(`主页面精确匹配：${await matches.count()} 项，可见：${await matches.visible().count()} 项`)
  } catch { /* The page may have closed while collecting diagnostics. */ }
  try {
    if (page.frames !== undefined) details.push(`iframe：${Math.max(0, page.frames().length - 1)} 个`)
  } catch { /* The page may have closed while collecting diagnostics. */ }
  return details.length > 0 ? `；${details.join('；')}` : ''
}

/** Keep text-based picker locators retryable instead of snapshotting their visibility. */
export async function clickExactVisibleText(page: ExactTextPage, text: string, timeoutMs: number): Promise<void> {
  if (text.trim() === '') throw new Error('精确文本选择器不能为空')
  try {
    await page.getByText(text, { exact: true }).visible().last().click({ timeout: timeoutMs })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      const diagnostics = await exactTextTimeoutDiagnostics(page, text)
      throw new Error(`等待可见文本「${text}」超时（${timeoutMs} 毫秒）${diagnostics}。请检查页面是否已加载、按钮文案或选择器`, { cause: error })
    }
    throw error
  }
}

async function requestApiDirect(config: ApiRequestOptions, baseUrl = ''): Promise<{ data: JsonValue; url: string; status: number }> {
  let target: URL
  try { target = new URL(config.url, baseUrl || undefined) } catch { throw new Error('接口 URL 必须是完整网址，或可相对当前页面解析的网址') }
  for (const item of config.queryParams ?? []) target.searchParams.set(item.name, item.value)
  const headers = Object.fromEntries((config.headers ?? []).map(item => [item.name, item.value]))
  let body: string | undefined
  if (config.body.trim() !== '' && !['GET', 'HEAD'].includes(config.method.toUpperCase())) {
    body = config.body
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { parsed = undefined }
    if (typeof parsed === 'object' && parsed !== null && !Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
  }
  let response: Response
  try {
    response = await fetch(target, {
      method: config.method,
      headers,
      body,
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`HTTP 请求未能建立连接：${detail}`)
  }
  const raw = await response.text()
  if (config.responseType === 'text') return { data: raw, url: response.url, status: response.status }
  try {
    return { data: JSON.parse(raw) as JsonValue, url: response.url, status: response.status }
  } catch {
    throw new ApiResponseError(`接口响应不是有效 JSON（HTTP ${response.status}）`, response.status, response.url, raw)
  }
}

async function generateText(prompt: string, llm: WorkflowLlmConfig, systemPrompt?: string): Promise<string> {
  if (!llm.enabled) throw new Error(`AI 配置「${llm.name}」未启用`)
  if (llm.model.trim() === '') throw new Error(`AI 配置「${llm.name}」未填写模型`)
  const path = llm.chatPath?.trim() || '/v1/chat/completions'
  const endpoint = /^https?:\/\//i.test(path) ? path : `${(llm.baseUrl.trim() || 'http://localhost:3000').replace(/\/$/, '')}/${path.replace(/^\/+/, '')}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (llm.apiKey.trim() !== '') headers.Authorization = `Bearer ${llm.apiKey}`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: llm.model, temperature: llm.temperature ?? 0.2, max_tokens: llm.maxTokens, messages: [ ...(systemPrompt === undefined ? [] : [{ role: 'system', content: systemPrompt }]), { role: 'user', content: systemPrompt === undefined ? `${prompt}\n\n请只返回要输入的内容，不要添加引号、解释或 Markdown。` : prompt }] }),
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`AI 内容生成失败（${response.status}）${detail ? `：${detail}` : ''}`)
  }
  const payload = await response.json() as { choices?: readonly { message?: { content?: string | readonly { type?: string; text?: string }[] } }[] }
  const content = payload.choices?.[0]?.message?.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : ''
  if (text.trim() === '') throw new Error('AI 返回内容为空')
  return text.trim()
}

const conditionResultSchema = z.object({
  matched: z.boolean().describe('判断内容是否满足判断要求'),
  reason: z.string().max(500).describe('简短说明判断依据，不要输出思考过程'),
})

function langChainBaseUrl(llm: WorkflowLlmConfig): string {
  const path = llm.chatPath?.trim() || '/v1/chat/completions'
  const endpoint = /^https?:\/\//i.test(path)
    ? path
    : `${(llm.baseUrl.trim() || 'http://localhost:3000').replace(/\/$/, '')}/${path.replace(/^\/+/, '')}`
  if (!/\/chat\/completions\/?$/i.test(endpoint)) {
    throw new Error('AI 结构化输出需要 OpenAI 兼容的 /chat/completions 接口')
  }
  return endpoint.replace(/\/chat\/completions\/?$/i, '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function imageCallError(error: unknown, imageDataUrl: string, apiKey: string): string {
  let message = errorMessage(error).replaceAll(imageDataUrl, '[图片数据已隐藏]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi, '[图片数据已隐藏]')
  if (apiKey.trim()) message = message.replaceAll(apiKey.trim(), '[凭证已隐藏]')
  return message.slice(0, 1200)
}

async function generateCondition(content: string, requirement: string, llm: WorkflowLlmConfig): Promise<{ matched: boolean; reason: string }> {
  if (!llm.enabled) throw new Error(`AI 配置「${llm.name}」未启用`)
  if (llm.model.trim() === '') throw new Error(`AI 配置「${llm.name}」未填写模型`)

  const model = new ChatOpenAI({
    model: llm.model,
    apiKey: llm.apiKey.trim() || 'not-required',
    temperature: 0,
    maxTokens: llm.maxTokens,
    maxRetries: 1,
    configuration: { baseURL: langChainBaseUrl(llm) },
  })
  const messages = [
    new SystemMessage('你是严格的条件判断器。只根据判断内容和判断要求作答。必须只返回 JSON 对象，包含 matched（布尔值）和 reason（简短依据）两个字段；不要输出 Markdown、额外文字或思考过程。'),
    new HumanMessage(`判断内容：\n${content}\n\n判断要求：\n${requirement}`),
  ]

  try {
    return await model.withStructuredOutput(conditionResultSchema, {
      name: 'condition_result',
      method: 'jsonMode',
    }).invoke(messages)
  } catch (jsonModeError) {
    try {
      return await model.withStructuredOutput(conditionResultSchema, {
        name: 'condition_result',
        method: 'functionCalling',
        strict: true,
      }).invoke(messages)
    } catch (functionCallingError) {
      throw new Error(`AI 条件结构化输出失败（JSON Mode：${errorMessage(jsonModeError)}；Function Calling：${errorMessage(functionCallingError)}）`)
    }
  }
}

async function generateSwitch(
  content: string,
  cases: readonly { id: string; name: string; prompt: string }[],
  systemPrompt: string,
  llm: WorkflowLlmConfig,
): Promise<{ branch: string; reason: string }> {
  if (!llm.enabled) throw new Error(`AI 配置「${llm.name}」未启用`)
  if (!llm.model.trim()) throw new Error(`AI 配置「${llm.name}」未填写模型`)
  if (cases.length === 0) throw new Error('AI 多路判断至少需要一个候选分支')
  const allowed = ['else', ...cases.map(item => item.id)] as [string, ...string[]]
  const schema = z.object({
    branch: z.enum(allowed).describe('选择一个候选分支 ID；全部不符合时选择 else'),
    reason: z.string().max(500).describe('简短说明判断依据，不要输出思考过程'),
  })
  const model = new ChatOpenAI({
    model: llm.model,
    apiKey: llm.apiKey.trim() || 'not-required',
    temperature: 0,
    maxTokens: llm.maxTokens,
    maxRetries: 1,
    configuration: { baseURL: langChainBaseUrl(llm) },
  })
  const branches = cases.map(item => `${item.id}：${item.name}\n判断要求：${item.prompt}`).join('\n\n')
  const messages = [
    new SystemMessage(`你是严格的业务场景分类器。只根据输入和候选分支的判断要求，按顺序选择第一个符合的分支；都不符合才选择 else。必须只返回 JSON 对象，包含 branch（分支 ID）和 reason（简短依据）两个字段；不要输出 Markdown、额外文字或思考过程。${systemPrompt.trim() ? `\n补充规则：${systemPrompt.trim()}` : ''}`),
    new HumanMessage(`输入内容：\n${content}\n\n候选分支（按优先级排序）：\n${branches}\n\nbranch 只能选择上述分支 ID 或 else，并以 JSON 格式返回。`),
  ]
  try {
    return await model.withStructuredOutput(schema, { name: 'switch_decision', method: 'jsonMode' }).invoke(messages)
  } catch (jsonModeError) {
    try {
      return await model.withStructuredOutput(schema, { name: 'switch_decision', method: 'functionCalling', strict: true }).invoke(messages)
    } catch (functionCallingError) {
      throw new Error(`AI 多路判断结构化输出失败（JSON Mode：${errorMessage(jsonModeError)}；Function Calling：${errorMessage(functionCallingError)}）`)
    }
  }
}

const imageDecisionSchema = z.object({
  branch: z.string().describe('选择一个候选分支 ID，或者 else'),
  reason: z.string().max(500).describe('只写图片中可见的简短判断依据，不输出思考过程'),
})

async function recognizeImage(
  imageDataUrl: string,
  instruction: string,
  cases: readonly { id: string; name: string; prompt: string }[],
  llm: WorkflowLlmConfig,
): Promise<{ branch: string; reason: string }> {
  if (!llm.enabled) throw new Error(`AI 配置「${llm.name}」未启用`)
  if (llm.model.trim() === '') throw new Error(`AI 配置「${llm.name}」未填写模型`)
  const model = new ChatOpenAI({
    model: llm.model,
    apiKey: llm.apiKey.trim() || 'not-required',
    temperature: 0,
    maxTokens: llm.maxTokens,
    maxRetries: 1,
    configuration: { baseURL: langChainBaseUrl(llm) },
  })
  const branches = cases.map(item => `case-${item.id}：${item.name}\n判断要求：${item.prompt}`).join('\n\n')
  const messages = [
    new SystemMessage('你是严格的图片分类器。只依据图片中可见的内容判断，不猜测图片之外的信息。按候选分支顺序选择第一个满足条件的分支；都不满足时选择 else。必须只返回 JSON 对象，包含 branch（分支 ID）和 reason（简短依据），不要输出 Markdown 或思考过程。'),
    new HumanMessage({ content: [
      { type: 'text', text: `${instruction.trim() ? `统一要求：${instruction.trim()}\n\n` : ''}候选分支（按优先级排序）：\n${branches}\n\nbranch 只能选择上面列出的一个分支 ID 或 else，并以 JSON 格式返回。` },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ] }),
  ]
  try {
    return await model.withStructuredOutput(imageDecisionSchema, { name: 'image_decision', method: 'jsonMode' }).invoke(messages)
  } catch (jsonModeError) {
    try {
      return await model.withStructuredOutput(imageDecisionSchema, { name: 'image_decision', method: 'functionCalling', strict: true }).invoke(messages)
    } catch (functionCallingError) {
      throw new Error(`图片识别结构化输出失败（JSON Mode：${imageCallError(jsonModeError, imageDataUrl, llm.apiKey)}；Function Calling：${imageCallError(functionCallingError, imageDataUrl, llm.apiKey)}）`)
    }
  }
}

/** A driver for API/logic-only workflows; it does not start Chromium. */
export function createHttpOnlyDriver(): BrowserDriver {
  let baseUrl = ''
  const noPage = (): never => { throw new Error('当前流程需要浏览器页面操作，但本次运行未启动浏览器') }
  return {
    async openPage(url: string): Promise<void> { baseUrl = url },
    async click(): Promise<void> { noPage() },
    async type(): Promise<void> { noPage() },
    async extract(): Promise<string> { return noPage() },
    async waitFor(): Promise<void> { noPage() },
    currentUrl(): string { return baseUrl },
    requestApi: config => requestApiDirect(config, baseUrl),
    generateText,
    generateCondition,
    generateSwitch,
    recognizeImage,
  }
}

function createDriver(page: Page): BrowserDriver {
  const responseBuffer: { url: string; method: string; status: number; response: import('playwright').Response }[] = []
  page.on('response', response => {
    responseBuffer.push({ url: response.url(), method: response.request().method().toUpperCase(), status: response.status(), response })
    if (responseBuffer.length > 200) responseBuffer.shift()
  })
  return {
    async openPage(url: string, timeoutMs = 30_000): Promise<void> {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      await page.bringToFront()
    },
    async waitForResponse(config): Promise<JsonValue> {
      const deadline = Date.now() + Math.max(100, config.timeoutMs)
      const matches = (item: typeof responseBuffer[number]): boolean => {
        if (config.method !== 'ANY' && item.method !== config.method.toUpperCase()) return false
        const urlMatched = config.matchMode === 'equals' ? item.url === config.urlPattern : config.matchMode === 'regex' ? (() => { try { return new RegExp(config.urlPattern).test(item.url) } catch { return false } })() : item.url.includes(config.urlPattern)
        if (!urlMatched) return false
        for (const param of config.requestParams ?? []) {
          let actual: string | undefined
          try { actual = new URL(item.url).searchParams.get(param.name) ?? undefined } catch { /* ignore malformed URL */ }
          if (actual === undefined) {
            const body = item.response.request().postData() ?? ''
            try {
              const parsed = JSON.parse(body) as Record<string, unknown>
              actual = parsed[param.name] === undefined ? undefined : String(parsed[param.name])
            } catch {
              const form = new URLSearchParams(body)
              actual = form.get(param.name) ?? undefined
            }
          }
          if (actual !== param.value) return false
        }
        return true
      }
      const seen = new Set<import('playwright').Response>()
      while (Date.now() < deadline) {
        const item = responseBuffer.find(candidate => !seen.has(candidate.response) && matches(candidate))
        if (item !== undefined) {
          seen.add(item.response)
          if (config.responseType === 'text') return { data: await item.response.text(), url: item.url, method: item.method, status: item.status }
          try { return { data: await item.response.json() as JsonValue, url: item.url, method: item.method, status: item.status } } catch { throw new Error(`接口响应不是有效 JSON：${item.url}`) }
        }
        await new Promise(resolve => { setTimeout(resolve, 100) })
      }
      throw new Error(`等待接口响应超时：${config.urlPattern}`)
    },
    requestApi: config => requestApiDirect(config, page.url()),
    generateText,
    generateCondition,
    generateSwitch,
    recognizeImage,
    async click(selector: string, timeoutMs = 30_000): Promise<void> {
      const beforeUrl = page.url()
      if (selector.startsWith('text-exact:')) {
        const text = selector.slice('text-exact:'.length)
        await clickExactVisibleText(page, text, timeoutMs)
      } else {
        await page.locator(selector).first().click({ timeout: timeoutMs })
      }
      // 不等待 loadState：站点若持续加载，Playwright 默认的 load 等待会卡满 30 秒。
      // 只给 URL 跳转或 SPA 路由一个短暂机会，其余情况直接继续。
      await Promise.race([
        page.waitForURL(url => url.toString() !== beforeUrl, { timeout: 2500 }).catch(() => undefined),
        page.waitForTimeout(180),
      ])
    },
    async selectOption(selector: string, value: string, timeoutMs = 30_000): Promise<void> {
      await page.locator(selector).first().selectOption(value, { timeout: timeoutMs })
    },
    async hover(selector: string, timeoutMs = 30_000): Promise<void> {
      await page.locator(selector).first().hover({ timeout: timeoutMs })
    },
    async type(selector: string, text: string, timeoutMs = 30_000): Promise<void> {
      const target = page.locator(selector).first()
      await target.fill(text, { timeout: timeoutMs })
    },
    async extract(selector: string): Promise<string> {
      return (await page.locator(selector).first().innerText()).trim()
    },
    async extractList(rowSelector: string, fields: readonly { name: string; selector: string; attribute?: string }[]): Promise<readonly Record<string, import('@graph/types.ts').JsonValue>[]> {
      return page.locator(rowSelector).evaluateAll((rows, fieldDefs) => rows.map(row => {
        const record: Record<string, import('@graph/types.ts').JsonValue> = {}
        for (const field of fieldDefs) {
          const element = row.querySelector(field.selector)
          record[field.name] = field.attribute
            ? (element?.getAttribute(field.attribute) ?? '')
            : (element?.textContent?.trim() ?? '')
        }
        return record
      }), fields)
    },
    async extractListAuto(containerSelector: string): Promise<readonly Record<string, import('@graph/types.ts').JsonValue>[]> {
      return page.locator(containerSelector).first().evaluate(container => {
        // Do not assume that rows are direct children of the picked element.
        // Tables and virtualized lists commonly add wrappers for headers,
        // scroll areas, or the table body. Find the deepest repeated sibling
        // group instead of blindly using `:scope > *`.
        const inspect = [container, ...Array.from(container.querySelectorAll('*')).slice(0, 800)]
        let rows: Element[] = []
        let bestScore = 0
        for (const parent of inspect) {
          const children = Array.from(parent.children).filter(item => (item.textContent ?? '').trim() !== '')
          if (children.length < 2) continue
          const groups = new Map<string, Element[]>()
          for (const item of children) {
            const key = `${item.tagName}:${Array.from(item.classList).slice(0, 3).join('.')}`
            groups.set(key, [...(groups.get(key) ?? []), item])
          }
          const group = [...groups.values()].sort((a, b) => b.length - a.length)[0]
          if (group === undefined || group.length < 2) continue
          const score = group.length * 20 + Math.min(children.length, 30) + (parent === container ? 0 : 1)
          if (score > bestScore) { bestScore = score; rows = group }
        }
        if (rows.length === 0) rows = Array.from(container.children).filter(item => (item.textContent ?? '').trim() !== '')
        return rows.map((row, rowIndex) => {
          const record: Record<string, import('@graph/types.ts').JsonValue> = {}
          const leaves = Array.from(row.querySelectorAll('*')).filter(element => element.children.length === 0 && (element.textContent ?? '').trim() !== '')
          const values = leaves.length > 0 ? leaves : [row]
          values.slice(0, 20).forEach((element, index) => { record[`field${index + 1}`] = (element.textContent ?? '').trim() })
          const link = row.querySelector('a[href]')
          if (link !== null) record.detailUrl = link.getAttribute('href') ?? ''
          const key = row.getAttribute('data-id') ?? row.getAttribute('data-key') ?? row.getAttribute('id')
          if (key !== null && key !== '') record.id = key
          record._index = rowIndex
          return record
        })
      })
    },
    async extractListAi(containerSelector: string, fields: readonly string[], prompt: string, llm: WorkflowLlmConfig): Promise<readonly Record<string, JsonValue>[]> {
      if (!llm.enabled) throw new Error(`AI 配置「${llm.name}」未启用，请先打开“启用全局 AI”`)
      if (llm.model.trim() === '') throw new Error(`AI 配置「${llm.name}」未填写模型`)
      const html = await page.locator(containerSelector).first().evaluate(element => element.outerHTML.slice(0, 160_000))
      const path = (llm.chatPath?.trim() || '/v1/chat/completions')
      const endpoint = /^https?:\/\//i.test(path) ? path : `${(llm.baseUrl.trim() || 'http://localhost:3000').replace(/\/$/, '')}/${path.replace(/^\/+/, '')}`
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (llm.apiKey.trim() !== '') headers.Authorization = `Bearer ${llm.apiKey}`
      const messages = [{
        role: 'system',
        content: `${prompt.trim() || '请从网页列表中提取结构化数据。'}\n\n需要提取的字段：${fields.join('、')}。\n只能根据下面的 HTML 返回数据，不要编造不存在的内容。返回格式必须是 {"items":[{"字段名":"值"}]}，只返回 JSON。\n\nHTML：\n${html}`,
      }]
      const request = (withJsonFormat: boolean): Promise<Response> => fetch(endpoint, {
        method: 'POST', headers, body: JSON.stringify({
          model: llm.model,
          temperature: 0.2,
          max_tokens: llm.maxTokens,
          ...(withJsonFormat ? { response_format: { type: 'json_object' } } : {}), messages,
        }),
      })
      let response = await request(true)
      if (!response.ok && response.status === 400) response = await request(false)
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300)
        throw new Error(`AI 抽取请求失败（${response.status}）${detail ? `：${detail}` : ''}`)
      }
      const payload = await response.json() as { choices?: readonly { message?: { content?: string } }[] }
      const content = payload.choices?.[0]?.message?.content?.trim() ?? ''
      const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      const parsed = JSON.parse(cleaned) as { items?: unknown }
      if (!Array.isArray(parsed.items)) throw new Error('AI 返回结果不是 items 数组')
      return parsed.items.filter((item): item is Record<string, JsonValue> => typeof item === 'object' && item !== null && !Array.isArray(item))
    },
    async waitFor(ms: number, selector: string, state: 'visible' | 'hidden' = 'visible'): Promise<void> {
      if (selector.trim() === '') {
        await page.waitForTimeout(Math.max(0, ms))
        return
      }
      await page.locator(selector).first().waitFor({ state, timeout: Math.max(1, ms) })
    },
    async waitForUrl(pattern: string, timeoutMs: number): Promise<void> {
      await page.waitForURL(url => url.toString().includes(pattern), { timeout: Math.max(1, timeoutMs) })
    },
    async elementState(selector: string): Promise<{ exists: boolean; visible: boolean; text: string }> {
      const locator = page.locator(selector).first()
      const exists = await locator.count() > 0
      if (!exists) return { exists: false, visible: false, text: '' }
      return { exists: true, visible: await locator.isVisible(), text: (await locator.innerText().catch(() => '')).trim() }
    },
    currentUrl(): string { return page.isClosed() || page.context().browser()?.isConnected() === false ? '' : page.url() },
    async currentTitle(): Promise<string> { return page.title() },
    onUrlChange(listener: (url: string) => void): () => void {
      const onNavigated = (frame: import('playwright').Frame): void => {
        if (frame === page.mainFrame()) listener(frame.url())
      }
      page.on('framenavigated', onNavigated)
      return () => { page.off('framenavigated', onNavigated) }
    },
  }
}

async function pickElement(page: Page, url?: string, mode: 'element' | 'list' = 'element'): Promise<PickedElement> {
  if (url !== undefined && url.trim() !== '') await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('domcontentloaded').catch(() => undefined)
  await page.bringToFront().catch(() => undefined)
  await page.waitForTimeout(250)
  return page.evaluate((pickMode) => new Promise<PickedElement>(resolve => {
    const panel = document.createElement('div')
    panel.id = '__rpa_picker_panel__'
    panel.innerHTML = '<div class="rpa-picker-title">RPA 元素拾取</div><span>移动鼠标预览，点击页面元素后确认</span><div class="rpa-picker-label">当前 Hover 元素</div><div class="rpa-picker-hover">未检测到</div><div class="rpa-picker-label">已选中元素</div><div class="rpa-picker-status">尚未选择</div><code></code><div class="rpa-picker-actions"><button type="button" data-action="confirm">确认拾取</button><button type="button" data-action="cancel">取消</button></div>'
    Object.assign(panel.style, { position: 'fixed', zIndex: '2147483647', top: '16px', right: '16px', width: '240px', padding: '12px', borderRadius: '10px', background: '#111827', color: '#fff', font: '13px/1.4 Segoe UI, sans-serif', boxShadow: '0 8px 24px rgba(0,0,0,.3)' })
    const span = panel.querySelector('span') as HTMLElement
    const code = panel.querySelector('code') as HTMLElement
    const confirm = panel.querySelector('[data-action="confirm"]') as HTMLButtonElement
    const cancel = panel.querySelector('[data-action="cancel"]') as HTMLButtonElement
    const hoverInfo = panel.querySelector('.rpa-picker-hover') as HTMLElement
    const status = panel.querySelector('.rpa-picker-status') as HTMLElement
    Object.assign(panel.querySelector('.rpa-picker-title')?.['style'] ?? {}, { fontWeight: '700', fontSize: '14px' })
    Object.assign(span.style, { display: 'block', marginTop: '5px', color: '#d1d5db' })
    Object.assign(panel.querySelector('.rpa-picker-label')?.['style'] ?? {}, { marginTop: '9px', color: '#9ca3af', fontSize: '11px' })
    Object.assign(hoverInfo.style, { marginTop: '3px', color: '#fbbf24', overflowWrap: 'anywhere' })
    Object.assign(status.style, { marginTop: '3px', color: '#34d399', overflowWrap: 'anywhere' })
    Object.assign(code.style, { display: 'block', marginTop: '6px', color: '#93c5fd', overflowWrap: 'anywhere' })
    Object.assign(panel.querySelector('.rpa-picker-actions')?.['style'] ?? {}, { display: 'flex', gap: '6px', marginTop: '10px' })
    Object.assign(confirm.style, { border: '0', borderRadius: '6px', padding: '6px 9px', cursor: 'pointer', background: '#4f46e5', color: '#fff' })
    Object.assign(cancel.style, { border: '0', borderRadius: '6px', padding: '6px 9px', cursor: 'pointer', background: '#374151', color: '#fff' })
    document.documentElement.appendChild(panel)
    const style = document.createElement('style')
    style.textContent = '[data-rpa-picker-hover]{outline:2px solid #4f46e5!important;cursor:crosshair!important}'
    document.head.appendChild(style)
    const selector = (element: Element): string => {
      const html = element as HTMLElement
      const unique = (candidate: string): string | undefined => {
        try { return document.querySelectorAll(candidate).length === 1 ? candidate : undefined } catch { return undefined }
      }
      if (html.id) return `#${CSS.escape(html.id)}`
      for (const [attribute, value] of [['data-testid', html.getAttribute('data-testid')], ['name', html.getAttribute('name')], ['aria-label', html.getAttribute('aria-label')], ['placeholder', html.getAttribute('placeholder')], ['autocomplete', html.getAttribute('autocomplete')], ['title', html.getAttribute('title')]]) {
        if (value !== null && value !== '') {
          const candidate = unique(`[${attribute}="${CSS.escape(value)}"]`)
          if (candidate !== undefined) return candidate
        }
      }
      if (html.tagName.toLowerCase() === 'input') {
        const type = html.getAttribute('type') || 'text'
        const candidate = unique(`input[type="${CSS.escape(type)}"]`)
        if (candidate !== undefined) return candidate
      }
      const role = html.getAttribute('role')
      if (role !== null && role !== '') {
        const candidate = unique(`[role="${CSS.escape(role)}"]`)
        if (candidate !== undefined) return candidate
      }
      const text = (html.innerText || '').trim().replace(/\s+/g, ' ')
      // Buttons and links are usually safest to replay by their visible
      // label. This avoids framework-generated class names entirely.
      if (text !== '' && text.length <= 80 && ['button', 'a', 'label', '[role="button"]'].some(kind => kind === html.tagName.toLowerCase() || html.matches(kind))) {
        return `text-exact:${text}`
      }
      // Containers often have no id/ARIA metadata. Prefer a unique class
      // combination over a bare tag such as `div`, which is almost never a
      // reliable list selector. Ignore very short utility classes.
      const classes = Array.from(html.classList).map(item => {
        // CSS-module / bundler suffixes commonly look like
        // `searchBtn___UEnOG`; keep only the semantic prefix.
        const prefix = item.split(/___|--/)[0]
        return prefix.length > 1 ? prefix : item
      }).filter(item => item.length > 1 && !/^css-|^jsx-|^[a-f0-9]{8,}$/i.test(item) && !/^[A-Z][A-Za-z0-9]{4,}$/.test(item)).slice(0, 3)
      if (classes.length > 0) {
        const candidate = unique(`${html.tagName.toLowerCase()}${classes.map(item => `.${CSS.escape(item)}`).join('')}`)
        if (candidate !== undefined) return candidate
      }
      if (text !== '' && text.length <= 80 && !['input', 'textarea', 'select'].includes(html.tagName.toLowerCase())) return `text-exact:${text}`
      return html.tagName.toLowerCase()
    }
    const optionLocator = (element: Element): string => {
      const value = element.getAttribute('data-value')
      if (value !== null && value !== '') return `[data-value="${CSS.escape(value)}"]`
      const text = (element.textContent || '').trim().replace(/\s+/g, ' ')
      return text === '' ? selector(element) : `text-exact:${text}`
    }
    const interactiveTarget = (element: Element): HTMLElement => {
      if (element.tagName.toLowerCase() === 'option' && element.parentElement !== null) return element.parentElement as HTMLElement
      const control = element.closest('button,input,select,textarea,[role="button"],[role="combobox"],[role="option"],[role="menuitem"],[data-select-option],[contenteditable="true"]')
      return (control ?? element) as HTMLElement
    }
    const listContainerTarget = (element: Element): HTMLElement => {
      // Prefer semantic list roots. A click on a cell or option should bind
      // the whole table/list, not the individual row or control inside it.
      let semantic: Element | undefined
      let currentSemantic: Element | null = element
      while (currentSemantic !== null) {
        const tag = currentSemantic.tagName.toLowerCase()
        const role = currentSemantic.getAttribute('role')?.toLowerCase() ?? ''
        if (tag === 'table') semantic = currentSemantic
        else if (semantic === undefined && (tag === 'ul' || tag === 'ol')) semantic = currentSemantic
        else if (semantic === undefined && (role === 'list' || role === 'grid' || role === 'tree' || role === 'listbox')) semantic = currentSemantic
        currentSemantic = currentSemantic.parentElement
      }
      if (semantic !== undefined) return semantic as HTMLElement
      let best: Element | undefined
      let bestScore = 0
      let current: Element | null = element
      for (let depth = 0; current !== null && depth < 8; depth += 1, current = current.parentElement) {
        const children = Array.from(current.children).filter(child => (child.textContent ?? '').trim() !== '')
        if (children.length < 2) continue
        const signatures = new Map<string, number>()
        for (const child of children) {
          const signature = `${child.tagName}:${Array.from(child.classList).slice(0, 3).join('.')}`
          signatures.set(signature, (signatures.get(signature) ?? 0) + 1)
        }
        const repeated = Math.max(0, ...signatures.values())
        if (repeated < 2) continue
        const score = repeated * 20 + Math.min(children.length, 20) - depth
        if (score > bestScore) { best = current; bestScore = score }
      }
      return (best ?? element) as HTMLElement
    }
    const targetForMode = (element: Element): HTMLElement => pickMode === 'list' ? listContainerTarget(element) : interactiveTarget(element)
    let highlighted: Element | undefined
    const over = (event: Event): void => { const raw = event.target as Element | null; if (raw === null || panel.contains(raw)) return; const target = targetForMode(raw); if (highlighted !== undefined && highlighted !== target) highlighted.removeAttribute('data-rpa-picker-hover'); highlighted = target; target.setAttribute('data-rpa-picker-hover', 'true'); span.textContent = pickMode === 'list' ? '移动鼠标预览，系统会识别重复行所在的列表' : '移动鼠标预览，点击页面元素后确认'; hoverInfo.textContent = `${target.tagName.toLowerCase()} · ${selector(target)}` }
    const out = (event: Event): void => { const target = event.target as Element | null; if (target !== null && !panel.contains(target)) target.removeAttribute('data-rpa-picker-hover') }
    let selected: HTMLElement | undefined
    let selectedOptionValue: string | undefined
    const cleanup = (): void => { document.removeEventListener('mouseover', over, true); document.removeEventListener('mouseout', out, true); document.removeEventListener('pointerdown', click, true); document.removeEventListener('mousedown', click, true); document.removeEventListener('click', click, true); style.remove(); panel.remove() }
    const click = (event: Event): void => {
      const raw = event.target as Element | null
      if (raw === null || panel.contains(raw)) return
      const target = targetForMode(raw)
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
      selected = target
      selectedOptionValue = raw.tagName.toLowerCase() === 'option' ? (raw as HTMLOptionElement).value : undefined
      span.textContent = '已选中页面元素，请确认或重新选择'
      hoverInfo.textContent = `${target.tagName.toLowerCase()} · ${selector(target)}`
      status.textContent = '请点击“确认拾取”完成选择'
      code.textContent = selector(target)
      code.textContent = selector(target)
      confirm.disabled = false
    }
    confirm.disabled = true
    confirm.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (selected === undefined) return; const element = selected; const popup = element.closest('[role="listbox"],[role="menu"],[role="tree"],[role="dialog"]'); const isOption = element.tagName.toLowerCase() === 'option' || element.matches('[role="option"],[role="menuitem"],[data-select-option]') || (popup !== null && element.hasAttribute('aria-selected')) || (popup !== null && element.hasAttribute('data-value')); const option = isOption ? element : null; const popupId = popup?.id; const controls = option?.getAttribute('aria-controls'); const trigger = (popupId !== undefined && popupId !== '' ? document.querySelector(`[aria-controls="${CSS.escape(popupId)}"]`) : null) ?? (controls ? document.querySelector(`[aria-controls="${CSS.escape(controls)}"]`) : null) ?? (option !== null ? document.querySelector('[aria-expanded="true"],[aria-haspopup="listbox"],[aria-haspopup="true"],[role="combobox"]') : null); cleanup(); resolve({ tagName: element.tagName.toLowerCase(), text: (element.innerText || '').trim().slice(0, 200), id: element.id || '', className: typeof element.className === 'string' ? element.className : '', ariaLabel: element.getAttribute('aria-label') || '', role: element.getAttribute('role') || '', placeholder: element.getAttribute('placeholder') || '', selector: selector(trigger ?? element), url: location.href, title: document.title, optionValue: selectedOptionValue, triggerSelector: trigger ? selector(trigger) : undefined, optionSelector: option && trigger ? optionLocator(option) : undefined }) }, { once: true })
    cancel.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); cleanup(); resolve({ tagName: '', text: '', id: '', className: '', ariaLabel: '', role: '', placeholder: '', selector: '', url: location.href, title: document.title }) }, { once: true })
    document.addEventListener('mouseover', over, true); document.addEventListener('mouseout', out, true); document.addEventListener('pointerdown', click, true); document.addEventListener('mousedown', click, true); document.addEventListener('click', click, true)
  }), mode)
}

function createPlaywrightSession(browser: Browser, context: BrowserContext, page: Page, executablePath: string): PlaywrightSession {
  return {
    driver: createDriver(page),
    isUsable(): boolean { return browser.isConnected() && !page.isClosed() },
    pickElement: (url?: string, mode?: 'element' | 'list') => pickElement(page, url, mode),
    async openDebugCopy(): Promise<PlaywrightSession> {
      const url = page.url()
      if (!/^https?:\/\//i.test(url)) throw new Error('失败时页面不是 HTTP(S) 地址，无法打开可交互的调试副本')
      const [storageState, snapshot, sessionEntries] = await Promise.all([
        context.storageState({ indexedDB: true }),
        page.screenshot({ timeout: 5_000 }).catch(() => undefined),
        page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)]))).catch(() => undefined),
      ])
      const debugBrowser = await chromium.launch({ headless: false, executablePath })
      try {
        const debugContext = await debugBrowser.newContext({ storageState, viewport: page.viewportSize() })
        if (sessionEntries !== undefined) {
          const origin = new URL(url).origin
          await debugContext.addInitScript(({ expectedOrigin, entries }) => {
            if (location.origin !== expectedOrigin) return
            for (const [key, value] of Object.entries(entries)) if (value !== null) sessionStorage.setItem(key, value)
          }, { expectedOrigin: origin, entries: sessionEntries })
        }
        if (snapshot !== undefined) {
          const snapshotPage = await debugContext.newPage()
          await snapshotPage.setContent(`<meta charset="utf-8"><title>失败瞬间截图</title><body style="margin:20px;font:14px sans-serif;background:#f5f5f5"><h2>失败瞬间截图</h2><p>此标签页是原页面的静态截图；另一标签页是按失败时地址恢复的可交互页面。</p><img alt="失败瞬间截图" style="max-width:100%;box-shadow:0 2px 12px #aaa" src="data:image/png;base64,${snapshot.toString('base64')}"></body>`)
        }
        const debugPage = await debugContext.newPage()
        // A fresh navigation is not a replay of the workflow; keep the window
        // available even if the target page itself fails to finish loading.
        await debugPage.goto(url, { waitUntil: 'commit', timeout: 15_000 }).catch(() => undefined)
        await debugPage.bringToFront()
        return createPlaywrightSession(debugBrowser, debugContext, debugPage, executablePath)
      } catch (error) {
        await debugBrowser.close().catch(() => undefined)
        throw error
      }
    },
    async close(): Promise<void> { await browser.close() },
  }
}

/** Launch Chromium for one live run. */
export async function openPlaywrightSession(options: { headless?: boolean; packaged?: boolean } = {}): Promise<PlaywrightSession> {
  const readiness = await checkBrowserReadiness(options.packaged)
  if (!readiness.available) throw new Error(readiness.message)
  const executablePath = browserExecutablePath(options.packaged)
  let browser: Browser
  try {
    browser = await chromium.launch({
      headless: options.headless ?? false,
      executablePath,
      // Use the regular Chromium build in both modes to reduce headed/headless differences.
      channel: options.headless ? 'chromium' : undefined,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`无法启动 Chromium，请联系管理员检查浏览器组件或系统权限。${detail}`)
  }
  const context: BrowserContext = await browser.newContext()
  const page = await context.newPage()
  return createPlaywrightSession(browser, context, page, executablePath)
}
