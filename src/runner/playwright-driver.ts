import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { z } from 'zod'
import type { BrowserDriver, ListRowOperationRequest, ListRowOperationResult, VisionImageInput, VisionRecognitionDecision } from './browser-run.ts'
import { ApiResponseError } from './api-response-error.ts'
import { browserExecutablePath, checkBrowserReadiness } from './browser-readiness.ts'
import { listRowValuesMatch } from './list-row-match.ts'
import type { AgentOutputField, JsonValue, WorkflowLlmConfig } from '@graph/types.ts'

export interface PlaywrightSession {
  readonly driver: BrowserDriver
  isUsable(): boolean
  pickElement(url?: string, mode?: ElementPickMode, options?: ElementPickOptions): Promise<PickedElement>
  openDebugCopy(): Promise<PlaywrightSession>
  close(): Promise<void>
}

export type ElementPickMode = 'element' | 'list' | 'list-container' | 'list-row' | 'row-element'

export interface ElementPickOptions {
  readonly scopeSelector?: string
  readonly rowSelectorMode?: 'css' | 'class-contains'
  readonly rowSelector?: string
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
  readonly rowSelectorMode?: 'css' | 'class-contains'
  readonly rowSelectorValue?: string
  readonly relativeSelectorMode?: 'css' | 'class-contains'
  readonly relativeSelectorValue?: string
}

type ApiRequestOptions = Parameters<NonNullable<BrowserDriver['requestApi']>>[0]
type ApiResponseWaitOptions = Parameters<NonNullable<BrowserDriver['waitForResponse']>>[0]

export interface BufferedPageResponse {
  readonly url: string
  readonly method: string
  readonly status: number
  readonly response: import('playwright').Response
}

type ExactTextPage = Pick<Page, 'getByText'> & Partial<Pick<Page, 'url' | 'title' | 'frames'>>

const ELEMENT_FINGERPRINT_PREFIX = 'rpa-fingerprint:'
const SCOPED_TEXT_EXACT_PREFIX = 'text-exact:rpa-context:'

const classContainsSelector = (value: string): string => {
  const normalized = value.trim()
  const selectorMatch = normalized.match(/^\[class\*=(["'])(.*?)\1\]$/)
  const classValue = selectorMatch?.[2] ?? normalized
  const boundaryValue = classValue.includes('__') && !classValue.includes('--') ? `${classValue}--` : classValue
  return `[class*=${JSON.stringify(boundaryValue)}]`
}

export interface ElementFingerprintContext {
  readonly tag: string
  readonly text: string
  readonly attributes: Readonly<Record<string, string>>
  readonly classes?: readonly string[]
}

export interface ElementFingerprint {
  readonly version: 1
  readonly css: string
  /** Exact parent DOM scope captured at pick time for text-exact replay. */
  readonly parentPath?: string
  readonly tag: string
  readonly text: string
  readonly role: string
  readonly attributes: Readonly<Record<string, string>>
  readonly classes: readonly string[]
  readonly context?: ElementFingerprintContext
  readonly contexts?: readonly ElementFingerprintContext[]
  readonly nearbyText: readonly string[]
  /** 0-based index among same-text tree/list options captured at pick time. */
  readonly textIndex?: number
}

export interface FingerprintCandidate {
  readonly index: number
  readonly visible: boolean
  readonly tag: string
  readonly text: string
  readonly role: string
  readonly attributes: Readonly<Record<string, string>>
  readonly classes: readonly string[]
  readonly fallbackMatch: boolean
  readonly parentMatch: boolean
  readonly overlayMatch: boolean
  readonly ancestors: readonly ElementFingerprintContext[]
  readonly nearbyText: readonly string[]
}

export interface PageSettleSnapshot {
  readonly now: number
  readonly activeRequests: number
  readonly lastNetworkActivityAt: number
  readonly domStableSince: number
}

export function pageIsSettled(snapshot: PageSettleSnapshot, quietMs = 400): boolean {
  return snapshot.activeRequests === 0
    && snapshot.now - snapshot.lastNetworkActivityAt >= quietMs
    && snapshot.now - snapshot.domStableSince >= quietMs
}

function normalizeFingerprintText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** Classes containing common bundler-generated hash segments are not safe for replay. */
export function isStableClassName(value: string): boolean {
  const name = value.trim()
  if (name.length < 2 || name.length > 100) return false
  if (/^(?:css|jsx|sc|emotion)-/i.test(name) || /^[a-f0-9]{6,}$/i.test(name) || /__[A-Za-z0-9_-]{5,}$/.test(name)) return false
  if (/(?:appear|enter|leave|exit)(?:-done|-active|-start)?$/i.test(name) || /(?:-appear|-enter|-leave|-exit)-/i.test(name)) return false
  return !name.split(/[_-]/).some(part => part.length >= 5 && /[a-z]/i.test(part) && /\d/.test(part) && /^[a-z0-9]+$/i.test(part))
}

/** Reject framework-generated IDs while keeping readable business IDs. */
export function isStableElementId(value: string): boolean {
  const id = value.trim()
  if (id.length < 2 || id.length > 100 || /^\d+$/.test(id)) return false
  if (/^:r[\w-]*:$/i.test(id) || /^(?:rc_select|react-select|headlessui|radix)[-_]/i.test(id) || /^(?:arco|mui|chakra)-.*-\d+$/i.test(id)) return false
  if (/^[a-f0-9]{12,}$/i.test(id) || /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) return false
  return true
}

/** Drop generated popup IDs so replay can match the next Arco/MUI portal instance. */
export function relaxUnstableParentPath(selector: string): string {
  return selector
    .replace(/#(?:arco|mui|chakra)-[\w-]*-\d+(?:\s*>\s*)?/gi, '')
    .replace(/#(?:rc_select_|react-select)[\w-]*(?:\s*>\s*)?/gi, '')
    .replace(/^\s*>\s*|\s*>\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Last DOM segment from a picked parent path, used to distinguish same-label tree nodes. */
export function lastParentPathSegment(parentPath: string | undefined): string {
  if (parentPath === undefined) return ''
  return parentPath.split('>').map(part => part.trim()).at(-1) ?? ''
}

/** Tree node nth-of-type from parentPath, or from css when an older pick stopped at the tree. */
export function treeNodePathSegment(fingerprint: Pick<ElementFingerprint, 'css' | 'parentPath'>): string {
  for (const path of [fingerprint.parentPath, fingerprint.css]) {
    const segment = lastParentPathSegment(path)
    if (/arco-tree-node/i.test(segment)) return segment
  }
  return ''
}

/** Collapse nested title/treeitem/node hits so “第N个同名” counts options, not inner spans. */
export function uniqueExactTextOwners<T>(
  items: readonly T[],
  expectedText: string,
  textOf: (item: T) => string,
  contains: (outer: T, inner: T) => boolean,
): T[] {
  const expected = normalizeFingerprintText(expectedText)
  const matches = items.filter(item => normalizeFingerprintText(textOf(item)) === expected)
  return matches.filter(item => !matches.some(other => other !== item && contains(other, item)))
}

export function isPickedFingerprintSelector(selector: string): boolean {
  const trimmed = selector.trim()
  if (parseReadableScopedTextSelector(trimmed) !== undefined) return true
  if (trimmed.startsWith(SCOPED_TEXT_EXACT_PREFIX) || trimmed.startsWith(ELEMENT_FINGERPRINT_PREFIX)) return true
  if (!trimmed.startsWith('text-exact:')) return false
  const text = trimmed.slice('text-exact:'.length)
  return text.startsWith('rpa-context:') || text.startsWith(ELEMENT_FINGERPRINT_PREFIX)
}

export interface ReadableScopedTextSelector {
  readonly text: string
  readonly parentPath: string
  readonly textIndex?: number
}

/** Parse the copyable selector shown in the properties panel. */
export function parseReadableScopedTextSelector(selector: string): ReadableScopedTextSelector | undefined {
  const prefix = 'text-exact:'
  const separator = ' · 父级:'
  const trimmed = selector.trim()
  if (!trimmed.startsWith(prefix)) return undefined
  const separatorAt = trimmed.indexOf(separator, prefix.length)
  if (separatorAt < 0) return undefined
  const label = trimmed.slice(prefix.length, separatorAt).trim()
  const indexed = /^(.*) · 第(\d+)个同名$/.exec(label)
  const text = (indexed?.[1] ?? label).trim()
  const textIndex = indexed === null ? undefined : Math.max(0, Number(indexed[2]) - 1)
  const parentPath = trimmed.slice(separatorAt + separator.length).trim()
  return text !== '' && parentPath !== '' ? { text, parentPath, ...(textIndex === undefined ? {} : { textIndex }) } : undefined
}

/** Legacy `text-exact:登录` clicks; fingerprint payloads must never be treated as page text. */
export function shouldClickByExactVisibleText(selector: string): boolean {
  const trimmed = selector.trim()
  return trimmed.startsWith('text-exact:') && !isPickedFingerprintSelector(trimmed)
}

function decodeFingerprintPayload(encoded: string): Partial<ElementFingerprint> | undefined {
  try {
    return JSON.parse(decodeURIComponent(encoded)) as Partial<ElementFingerprint>
  } catch {
    try {
      return JSON.parse(encoded) as Partial<ElementFingerprint>
    } catch {
      return undefined
    }
  }
}

function parseElementFingerprint(selector: string): ElementFingerprint | undefined {
  const trimmed = selector.trim()
  const encoded = trimmed.startsWith(SCOPED_TEXT_EXACT_PREFIX)
    ? trimmed.slice(SCOPED_TEXT_EXACT_PREFIX.length)
    : trimmed.startsWith(ELEMENT_FINGERPRINT_PREFIX)
      ? trimmed.slice(ELEMENT_FINGERPRINT_PREFIX.length)
      : undefined
  if (encoded === undefined) return undefined
  try {
    const value = decodeFingerprintPayload(encoded)
    if (value === undefined || value.version !== 1 || typeof value.css !== 'string' || typeof value.tag !== 'string') return undefined
    return {
      version: 1,
      css: value.css,
      parentPath: typeof value.parentPath === 'string' ? value.parentPath : undefined,
      tag: value.tag,
      text: typeof value.text === 'string' ? value.text : '',
      role: typeof value.role === 'string' ? value.role : '',
      attributes: typeof value.attributes === 'object' && value.attributes !== null ? value.attributes : {},
      classes: Array.isArray(value.classes) ? value.classes.filter((item): item is string => typeof item === 'string') : [],
      context: value.context !== undefined && typeof value.context === 'object' ? value.context : undefined,
      contexts: Array.isArray(value.contexts) ? value.contexts.filter((item): item is ElementFingerprintContext => typeof item === 'object' && item !== null && typeof item.tag === 'string') : undefined,
      nearbyText: Array.isArray(value.nearbyText) ? value.nearbyText.filter((item): item is string => typeof item === 'string') : [],
      textIndex: typeof value.textIndex === 'number' && Number.isInteger(value.textIndex) && value.textIndex >= 0 ? value.textIndex : undefined,
    }
  } catch { return undefined }
}

function hasSemanticFingerprint(fingerprint: ElementFingerprint): boolean {
  return fingerprint.text.trim() !== '' || fingerprint.role.trim() !== '' || Object.keys(fingerprint.attributes).length > 0 || fingerprint.context !== undefined || fingerprint.nearbyText.length > 0
}

function collapseNestedSameText(matches: readonly FingerprintCandidate[]): FingerprintCandidate[] {
  if (matches.length < 2) return [...matches]
  const owners = matches.filter(candidate => !matches.some(other => other.index !== candidate.index && other.ancestors.some(ctx =>
    ctx.tag === candidate.tag
    && normalizeFingerprintText(ctx.text) === normalizeFingerprintText(candidate.text)
    && candidate.classes.every(name => (ctx.classes ?? []).includes(name))
  )))
  return owners.length > 0 ? owners : [...matches]
}

export function selectFingerprintCandidate(fingerprint: ElementFingerprint, candidates: readonly FingerprintCandidate[], requireVisible = true): FingerprintCandidate | undefined {
  const expectedText = normalizeFingerprintText(fingerprint.text)
  let matches = candidates.filter(candidate => (!requireVisible || candidate.visible) && candidate.tag === fingerprint.tag)
  if (expectedText !== '') matches = matches.filter(candidate => normalizeFingerprintText(candidate.text) === expectedText)
  if (matches.length === 0) return undefined
  matches = collapseNestedSameText(matches)
  const overlay = matches.filter(candidate => candidate.overlayMatch)
  if (overlay.length > 0) matches = overlay

  const parentScoped = matches.filter(candidate => candidate.parentMatch)
  const parentPinsTreeNode = /arco-tree-node[^>]*:nth-of-type\(\d+\)/i.test(fingerprint.parentPath ?? '')
  if (expectedText !== '' && fingerprint.parentPath !== undefined) {
    if (parentScoped.length > 0) matches = parentScoped
    else if (parentPinsTreeNode || fingerprint.textIndex !== undefined || matches.length !== 1) {
      return undefined
    }
  } else if (parentScoped.length > 0) matches = parentScoped

  const stableAttributeOrder = ['id', 'data-testid', 'data-id', 'data-key', 'data-row-key', 'data-action', 'name', 'aria-label', 'placeholder', 'title', 'type']
  for (const name of stableAttributeOrder) {
    const value = fingerprint.attributes[name]
    if (value === undefined || value === '') continue
    if (name === 'id' && !isStableElementId(value)) continue
    const narrowed = matches.filter(candidate => candidate.attributes[name] === value)
    if (narrowed.length > 0) matches = narrowed
  }
  if (fingerprint.role !== '') {
    const narrowed = matches.filter(candidate => candidate.role === fingerprint.role)
    if (narrowed.length > 0) matches = narrowed
  }
  if (fingerprint.classes.length > 0) {
    const narrowed = matches.filter(candidate => fingerprint.classes.every(name => candidate.classes.includes(name)))
    if (narrowed.length > 0) matches = narrowed
  }
  if (matches.length === 1) return matches[0]

  const cssMatches = matches.filter(candidate => candidate.fallbackMatch)
  if (cssMatches.length === 1) return cssMatches[0]
  throw new Error(`元素定位存在歧义：精确文本和拾取时的父级 DOM 仍匹配到 ${matches.length} 个可见元素`)
}

async function fingerprintCandidates(page: Page, fingerprint: ElementFingerprint): Promise<readonly FingerprintCandidate[]> {
  const locator = page.locator(fingerprint.tag || '*')
  return locator.evaluateAll((elements, paths) => {
    const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 300)
    const stableClass = (value: string): boolean => {
      const name = value.trim()
      if (name.length < 2 || name.length > 100) return false
      if (/^(?:css|jsx|sc|emotion)-/i.test(name) || /^[a-f0-9]{6,}$/i.test(name) || /__[A-Za-z0-9_-]{5,}$/.test(name)) return false
      if (/(?:appear|enter|leave|exit)(?:-done|-active|-start)?$/i.test(name) || /(?:-appear|-enter|-leave|-exit)-/i.test(name)) return false
      return !name.split(/[_-]/).some(part => part.length >= 5 && /[a-z]/i.test(part) && /\d/.test(part) && /^[a-z0-9]+$/i.test(part))
    }
    const attributeNames = ['id', 'data-testid', 'data-id', 'data-key', 'data-row-key', 'data-action', 'name', 'aria-label', 'placeholder', 'title', 'autocomplete', 'type']
    const attributes = (element: Element): Record<string, string> => Object.fromEntries(attributeNames.flatMap(name => {
      const value = element.getAttribute(name)
      return value === null || value === '' ? [] : [[name, value]]
    }))
    const context = (element: Element): ElementFingerprintContext => ({ tag: element.tagName.toLowerCase(), text: normalize(element.textContent ?? ''), attributes: attributes(element), classes: Array.from(element.classList).filter(stableClass).slice(0, 5) })
    const semanticRole = (element: Element): string => {
      const explicit = element.getAttribute('role')
      if (explicit) return explicit
      const tag = element.tagName.toLowerCase()
      if (tag === 'button') return 'button'
      if (tag === 'a' && element.hasAttribute('href')) return 'link'
      if (tag === 'select') return 'combobox'
      if (tag === 'textarea') return 'textbox'
      if (tag === 'input') return ['button', 'submit', 'reset'].includes(element.getAttribute('type') ?? 'text') ? 'button' : 'textbox'
      return ''
    }
    const nearby = (element: Element): string[] => {
      const values = [element.previousElementSibling?.textContent, element.nextElementSibling?.textContent, element.parentElement?.querySelector(':scope > label, :scope > [class*="label"], :scope > legend')?.textContent]
      return values.filter((value): value is string => typeof value === 'string').map(normalize).filter(Boolean).slice(0, 3)
    }
    return elements.slice(0, 4000).map((element, index) => {
      const ancestors: ElementFingerprintContext[] = []
      let current = element.parentElement
      for (let depth = 0; current !== null && depth < 8; depth += 1, current = current.parentElement) ancestors.push(context(current))
      let fallbackMatch = false
      let parentMatch = false
      try { fallbackMatch = paths.fallback !== '' && element.matches(paths.fallback) } catch { /* Invalid legacy CSS should not break fingerprint recovery. */ }
      const parent = element.parentElement
      const matchesScope = (scope: string): boolean => {
        if (scope === '') return false
        try { if (element.matches(scope)) return true } catch { /* Compound parent paths may not be valid for matches(). */ }
        try { if (element.closest(scope) !== null) return true } catch { /* Compound parent paths may not be valid for closest(). */ }
        try { if (parent?.matches(scope) === true) return true } catch { /* Keep trying the last path segment. */ }
        const last = scope.split('>').map(part => part.trim()).at(-1) ?? ''
        if (last === '' || last === scope) return false
        try { return element.matches(last) || element.closest(last) !== null || parent?.matches(last) === true } catch { return false }
      }
      parentMatch = matchesScope(paths.parent) || matchesScope(paths.relaxedParent) || matchesScope(paths.parentSegment)
      const html = element as HTMLElement
      const style = getComputedStyle(html)
      const rect = html.getBoundingClientRect()
      // Arco/Ant popups often keep aria-hidden during open animation; trust layout instead.
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
        && Number(style.opacity || '1') > 0.01
        && rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
      const overlayMatch = html.closest('[role="tree"],[role="listbox"],[role="menu"],[role="dialog"],[id^="arco-tree-select-popup"],[id^="arco-select-popup"],.arco-trigger-popup,.arco-select-popup,.arco-tree-select-popup,.ant-select-dropdown,.el-select-dropdown,.el-tree') !== null
      return { index, visible, tag: element.tagName.toLowerCase(), text: normalize(html.innerText || element.textContent || ''), role: semanticRole(element), attributes: attributes(element), classes: Array.from(element.classList).filter(stableClass), fallbackMatch, parentMatch, overlayMatch, ancestors, nearbyText: nearby(element) }
    })
  }, { fallback: fingerprint.css, parent: fingerprint.parentPath ?? '', relaxedParent: fingerprint.parentPath ? relaxUnstableParentPath(fingerprint.parentPath) : '', parentSegment: treeNodePathSegment(fingerprint) })
}

function fingerprintLooksLikeTreeOption(fingerprint: ElementFingerprint): boolean {
  const haystack = `${fingerprint.css} ${fingerprint.parentPath ?? ''} ${fingerprint.classes.join(' ')} ${fingerprint.role}`
  return fingerprint.role === 'treeitem' || /(?:arco-tree|ant-tree|el-tree|tree-node|treeitem)/i.test(haystack)
}

export function shouldSkipExpandedTrigger(role: string | null, expanded: string | null): boolean {
  return expanded === 'true' && (role === 'combobox' || role === 'button')
}

function exactTextPattern(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}

async function firstExisting(locators: readonly Locator[]): Promise<Locator | undefined> {
  for (const locator of locators) {
    if (await locator.count().catch(() => 0) > 0) return locator.first()
  }
  return undefined
}

async function scrollTreeUntil(tree: Locator, ready: () => Promise<boolean>): Promise<boolean> {
  if (await ready()) return true
  const holder = tree.locator('.arco-tree-list-holder, .arco-tree-node-list, [class*="list-holder"]').first()
  const handle = (await holder.count().catch(() => 0) > 0 ? await holder.elementHandle() : await tree.elementHandle())
  if (handle === null) return false
  await handle.evaluate(element => { (element as HTMLElement).scrollTop = 0 })
  for (let step = 0; step < 40; step += 1) {
    await handle.evaluate(element => { (element as HTMLElement).scrollTop += 120 })
    if (await ready()) return true
  }
  return ready()
}

async function clickableTreeNode(node: Locator): Promise<Locator> {
  const titled = node.locator('.arco-tree-node-title, .arco-tree-node-title-text')
  return await firstExisting([titled, node]) ?? node
}

async function uniqueSameTextTreeNodes(tree: Locator, text: string): Promise<Locator> {
  return tree.locator('.arco-tree-node').filter({ hasText: exactTextPattern(text) })
}

async function resolveTreeOptionLocator(page: Page, fingerprint: ElementFingerprint): Promise<Locator | undefined> {
  const text = normalizeFingerprintText(fingerprint.text)
  if (text === '' || !fingerprintLooksLikeTreeOption(fingerprint)) return undefined
  const popupTree = page.locator('.arco-trigger-popup:visible .arco-tree, [id^="arco-tree-select-popup"]:visible .arco-tree, .arco-tree-select-popup:visible .arco-tree')
  const openTree = (await popupTree.count().catch(() => 0) > 0)
    ? popupTree.last()
    : page.locator('[role="tree"]:visible, .arco-tree:visible').last()
  if (await openTree.count().catch(() => 0) === 0) return undefined
  const key = fingerprint.attributes['data-key'] || fingerprint.attributes['data-value']
  if (key !== undefined && key !== '') {
    const byKey = openTree.locator(`[data-key="${CSS.escape(key)}"], [data-value="${CSS.escape(key)}"]`)
    await scrollTreeUntil(openTree, async () => await byKey.count().catch(() => 0) > 0)
    if (await byKey.count().catch(() => 0) > 0) return clickableTreeNode(byKey.first())
  }
  const nodeSegment = treeNodePathSegment(fingerprint)
  if (nodeSegment !== '') {
    const node = openTree.locator(nodeSegment)
    await scrollTreeUntil(openTree, async () => await node.count().catch(() => 0) > 0)
    if (await node.count().catch(() => 0) > 0) {
      const labeled = node.filter({ hasText: exactTextPattern(text) })
      if (await labeled.count().catch(() => 0) > 0) return clickableTreeNode(labeled.first())
    }
  }
  const nodes = await uniqueSameTextTreeNodes(openTree, text)
  if (fingerprint.textIndex !== undefined) {
    await scrollTreeUntil(openTree, async () => await nodes.count().catch(() => 0) > fingerprint.textIndex!)
    if (await nodes.count().catch(() => 0) > fingerprint.textIndex) return clickableTreeNode(nodes.nth(fingerprint.textIndex))
    return undefined
  }
  if (await nodes.count().catch(() => 0) === 1) return clickableTreeNode(nodes.first())
  return undefined
}

async function clickResolvedLocator(locator: Locator, timeoutMs: number): Promise<void> {
  const role = await locator.getAttribute('role').catch(() => null)
  const expanded = await locator.getAttribute('aria-expanded').catch(() => null)
  if (shouldSkipExpandedTrigger(role, expanded)) return
  const budget = Math.max(400, Math.min(5_000, timeoutMs))
  await locator.scrollIntoViewIfNeeded({ timeout: Math.min(2_000, budget) }).catch(() => undefined)
  try {
    await locator.click({ force: true, timeout: budget })
  } catch (error) {
    try {
      await locator.evaluate((element) => { (element as HTMLElement).click() })
    } catch {
      throw error
    }
  }
}

async function resolveTargetLocator(page: Page, selector: string, timeoutMs: number, requireVisible = true): Promise<Locator> {
  const readable = parseReadableScopedTextSelector(selector)
  if (readable !== undefined) {
    let parent: Locator
    try {
      parent = page.locator(readable.parentPath)
    } catch (error) {
      throw new Error(`父级 DOM 选择器无效：${readable.parentPath}`, { cause: error })
    }
    const matches = parent.getByText(readable.text, { exact: true })
    const candidates = requireVisible ? matches.visible() : matches
    const first = readable.textIndex === undefined ? candidates.first() : candidates.nth(readable.textIndex)
    await first.waitFor({ state: requireVisible ? 'visible' : 'attached', timeout: Math.max(1, timeoutMs) })
    const count = await candidates.count()
    if (readable.textIndex === undefined && count > 1) throw new Error(`父级 DOM 内精确文本「${readable.text}」仍匹配到 ${count} 个元素`)
    if (readable.textIndex !== undefined && count <= readable.textIndex) throw new Error(`父级 DOM 内精确文本「${readable.text}」只有 ${count} 个，找不到第 ${readable.textIndex + 1} 个`)
    return first
  }
  const fingerprint = parseElementFingerprint(selector)
  if (fingerprint === undefined) return requireVisible ? page.locator(selector).visible().first() : page.locator(selector).first()
  const locateBudget = timeoutMs >= 8_000 ? timeoutMs - 5_000 : timeoutMs > 1000 ? timeoutMs - 400 : timeoutMs
  const deadline = Date.now() + Math.max(1, locateBudget)
  do {
    const treeOption = await resolveTreeOptionLocator(page, fingerprint)
    if (treeOption !== undefined) return treeOption
    const candidate = selectFingerprintCandidate(fingerprint, await fingerprintCandidates(page, fingerprint), requireVisible)
    if (candidate !== undefined) return page.locator(fingerprint.tag || '*').nth(candidate.index)
    try {
      const fallback = page.locator(fingerprint.css)
      if (!hasSemanticFingerprint(fingerprint) && await fallback.count() === 1 && (!requireVisible || await fallback.isVisible())) return fallback
    } catch { /* Keep polling when the structural fallback is no longer valid. */ }
    await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  const label = fingerprint.text.trim() !== '' ? `「${fingerprint.text.trim()}」` : fingerprint.css
  throw new Error(`未找到与拾取指纹匹配的元素${label}。请确认下拉/树选择弹层已打开，或重新拾取该选项`)
}

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

/** Replay legacy text-only locators safely; ambiguous visible matches must never be guessed. */
export async function clickExactVisibleText(page: ExactTextPage, text: string, timeoutMs: number): Promise<void> {
  if (text.trim() === '') throw new Error('精确文本选择器不能为空')
  try {
    const visible = page.getByText(text, { exact: true }).visible()
    const first = visible.first()
    await first.waitFor({ state: 'visible', timeout: timeoutMs })
    const count = await visible.count()
    if (count > 1) throw new Error(`精确文本「${text}」匹配到 ${count} 个可见元素，无法确定目标。请重新拾取该元素，生成包含页面结构的唯一选择器`)
    await first.click({ timeout: timeoutMs })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      const diagnostics = await exactTextTimeoutDiagnostics(page, text)
      throw new Error(`等待可见文本「${text}」超时（${timeoutMs} 毫秒）${diagnostics}。请检查页面是否已加载、按钮文案或选择器`, { cause: error })
    }
    throw error
  }
}

type PickedSelectorPage = Pick<Page, 'getByText' | 'locator'>

/** Resolve selectors produced by the element picker before waiting on them. */
export async function waitForPickedSelector(
  page: PickedSelectorPage,
  selector: string,
  state: 'visible' | 'hidden',
  timeoutMs: number,
): Promise<void> {
  const timeout = Math.max(1, timeoutMs)
  const readable = parseReadableScopedTextSelector(selector)
  if (readable !== undefined) {
    const matches = page.locator(readable.parentPath).getByText(readable.text, { exact: true })
    await (readable.textIndex === undefined ? matches.first() : matches.nth(readable.textIndex)).waitFor({ state, timeout })
    return
  }
  if (isPickedFingerprintSelector(selector)) {
    throw new Error('拾取指纹无法按可见文本等待。请重新拾取该元素')
  }
  if (selector.startsWith('text-exact:')) {
    const text = selector.slice('text-exact:'.length)
    if (text.trim() === '') throw new Error('精确文本选择器不能为空')
    await page.getByText(text, { exact: true }).visible().first().waitFor({ state, timeout })
    return
  }
  await page.locator(selector).first().waitFor({ state, timeout })
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

function agentOutputSchema(field: AgentOutputField): z.ZodType {
  const schema = field.valueType === 'number' ? z.number()
    : field.valueType === 'boolean' ? z.boolean()
      : field.valueType === 'object' ? z.record(z.string(), z.json())
        : field.valueType === 'array' ? z.array(z.json())
          : z.string()
  return schema.describe(field.description.trim() || `输出字段 ${field.name}`)
}

async function generateAgent(
  task: string,
  systemPrompt: string,
  outputs: readonly AgentOutputField[],
  llm: WorkflowLlmConfig,
): Promise<Readonly<Record<string, JsonValue>>> {
  if (!llm.enabled) throw new Error(`AI 配置「${llm.name}」未启用`)
  if (llm.model.trim() === '') throw new Error(`AI 配置「${llm.name}」未填写模型`)
  if (outputs.length === 0) throw new Error('Agent 至少需要配置一个输出字段')
  const shape: Record<string, z.ZodType> = Object.fromEntries(outputs.map(field => [field.name, agentOutputSchema(field)]))
  const schema = z.object(shape).strict()
  const model = new ChatOpenAI({
    model: llm.model,
    apiKey: llm.apiKey.trim() || 'not-required',
    temperature: 0,
    maxTokens: llm.maxTokens,
    maxRetries: 1,
    configuration: { baseURL: langChainBaseUrl(llm) },
  })
  const outputContract = outputs.map(field => `- ${field.name}（${field.valueType}）：${field.description}`).join('\n')
  const messages = [
    new SystemMessage(`${systemPrompt.trim()}\n\n必须严格按照程序提供的 JSON Schema 返回一个 JSON 对象，不得增加、遗漏或重命名字段，不要输出 Markdown、解释或思考过程。`),
    new HumanMessage(`任务内容：\n${task.trim()}\n\n输出字段：\n${outputContract}\n\n请返回完整的 JSON 对象。`),
  ]
  try {
    return await model.withStructuredOutput(schema, { name: 'agent_result', method: 'jsonMode' }).invoke(messages) as Readonly<Record<string, JsonValue>>
  } catch (jsonModeError) {
    try {
      return await model.withStructuredOutput(schema, { name: 'agent_result', method: 'functionCalling', strict: true }).invoke(messages) as Readonly<Record<string, JsonValue>>
    } catch (functionCallingError) {
      try {
        const retryMessages = [...messages, new HumanMessage('上一次输出不符合结构。请严格保留全部指定字段及类型，只返回完整 JSON 对象。')]
        return await model.withStructuredOutput(schema, { name: 'agent_result_retry', method: 'jsonMode' }).invoke(retryMessages) as Readonly<Record<string, JsonValue>>
      } catch (retryError) {
        throw new Error(`Agent 结构化输出失败（JSON Mode：${errorMessage(jsonModeError)}；Function Calling：${errorMessage(functionCallingError)}；JSON Mode 重试：${errorMessage(retryError)}）`)
      }
    }
  }
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

function imageCallError(error: unknown, images: readonly VisionImageInput[], apiKey: string): string {
  let message = images.reduce((current, image) => current.replaceAll(image.dataUrl, '[图片数据已隐藏]'), errorMessage(error))
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
  supplementalContext = '',
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
  const contextSection = supplementalContext.trim() ? `\n\n补充数据与上下文：\n${supplementalContext.trim()}` : ''
  const messages = [
    new SystemMessage(`你是严格的业务场景分类器。只根据输入内容、补充数据与上下文以及候选分支的判断要求，按顺序选择第一个符合的分支；都不符合才选择 else。必须只返回 JSON 对象，包含 branch（分支 ID）和 reason（简短依据）两个字段；不要输出 Markdown、额外文字或思考过程。${systemPrompt.trim() ? `\n补充规则：${systemPrompt.trim()}` : ''}`),
    new HumanMessage(`输入内容：\n${content}${contextSection}\n\n候选分支（按优先级排序）：\n${branches}\n\nbranch 只能选择上述分支 ID 或 else，并以 JSON 格式返回。`),
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
  comparisonStatus: z.enum(['completed', 'partially_comparable', 'not_comparable']).describe('图片对比完成状态'),
  comparisonSummary: z.string().max(1000).describe('只描述与对比要求和场景有关的可见事实，不输出思考过程'),
  comparisons: z.array(z.object({
    inputImageIndex: z.number().int().positive().describe('待识别图片的 1 起始序号'),
    referenceImageIndex: z.number().int().positive().nullable().describe('最适合对比的参考图片序号；没有参考图或无法配对时为 null'),
    comparable: z.boolean().describe('该待识别图片是否具备可靠的比较条件'),
    reason: z.string().max(500).describe('可比较或不可比较的简短依据'),
    differences: z.array(z.object({
      location: z.string().max(200).describe('差异所在区域；无法定位时写整体'),
      description: z.string().max(500).describe('与用户对比要求有关的可见差异'),
      evidence: z.string().max(500).describe('参考图与待识别图之间可核验的视觉证据'),
    })).max(20),
  })).max(64),
  imageCaseEvaluations: z.array(z.object({
    inputImageIndex: z.number().int().positive().describe('待识别图片的 1 起始序号'),
    branch: z.string().describe('候选场景的完整分支 ID，例如 case-paid'),
    matched: z.boolean().describe('这一张待识别图片是否提供支持该场景的明确可见证据'),
    contradicts: z.boolean().describe('这一张图片是否存在足以排除整组图片属于该场景的明确反证；看不到、无关或无法判断不算反证'),
    confidence: z.number().min(0).max(1).describe('这一张图片的场景判断置信度，范围 0 到 1'),
    evidence: z.string().max(500).describe('这一张图片命中或不命中该场景的可见证据'),
  })).max(500),
})

function aggregateImageDecision(
  raw: z.infer<typeof imageDecisionSchema>,
  cases: readonly { id: string; name: string; prompt: string }[],
): VisionRecognitionDecision {
  const caseEvaluations = cases.map(item => {
    const branch = `case-${item.id}`
    const imageEvaluations = raw.imageCaseEvaluations.filter(evaluation => evaluation.branch === branch)
    const matchedEvaluations = imageEvaluations.filter(evaluation => evaluation.matched)
    const contradictingEvaluations = imageEvaluations.filter(evaluation => evaluation.contradicts)
    const matched = matchedEvaluations.length > 0 && contradictingEvaluations.length === 0
    const confidenceValues = (matched ? matchedEvaluations : imageEvaluations).map(evaluation => evaluation.confidence)
    const confidence = confidenceValues.length === 0 ? 0 : matched ? Math.max(...confidenceValues) : Math.min(...confidenceValues)
    const evidenceSource = matched ? matchedEvaluations : contradictingEvaluations.length > 0 ? contradictingEvaluations : imageEvaluations
    const evidence = evidenceSource.map(evaluation => `图片 ${evaluation.inputImageIndex}：${evaluation.evidence}`).join('；').slice(0, 500)
    return { branch, matched, confidence, evidence }
  })
  return { ...raw, caseEvaluations }
}

function requireImageDecision(value: unknown, source: string): z.infer<typeof imageDecisionSchema> {
  const parsed = imageDecisionSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues.slice(0, 3).map(item => `${item.path.join('.') || '根对象'}：${item.message}`).join('；')
  throw new Error(`${source}未返回有效的图片识别结构${issue ? `：${issue}` : ''}`)
}

async function recognizeImage(
  images: readonly VisionImageInput[],
  instruction: string,
  cases: readonly { id: string; name: string; prompt: string }[],
  llm: WorkflowLlmConfig,
  comparisonPrompt = '',
): Promise<VisionRecognitionDecision> {
  if (!llm.enabled) throw new Error(`AI 配置「${llm.name}」未启用`)
  if (llm.model.trim() === '') throw new Error(`AI 配置「${llm.name}」未填写模型`)
  if (images.length === 0) throw new Error('图片识别至少需要一张待识别图片')
  const references = images.filter(image => image.role === 'reference')
  const inputs = images.filter(image => image.role === 'input')
  if (inputs.length === 0) throw new Error('图片识别至少需要一张待识别图片')
  // Multi-image structured output grows quickly. A low generic model limit
  // otherwise truncates valid JSON midway through arrays.
  const recommendedTokens = Math.min(12_000, Math.max(4_096, 1_600 + inputs.length * 700 + inputs.length * Math.max(1, cases.length) * 220))
  const model = new ChatOpenAI({
    model: llm.model,
    apiKey: llm.apiKey.trim() || 'not-required',
    temperature: 0,
    maxTokens: Math.max(llm.maxTokens ?? 0, recommendedTokens),
    maxRetries: 1,
    configuration: { baseURL: langChainBaseUrl(llm) },
  })
  const branches = cases.map(item => `case-${item.id}：${item.name}\n判断要求：${item.prompt}`).join('\n\n')
  const comparisonSection = references.length === 0
    ? '\n\n本次没有参考图片。请直接观察全部待识别图片，并根据可见内容独立判断每个候选场景；comparisons 可以为空。'
    : `\n\n本次共有 ${references.length} 张参考图片。参考图片是对比基准，待识别图片是需要判断的内容。请为每张待识别图片至少返回 1 条 comparison。若有多张参考图，可以把同一张待识别图片分别与不同参考图对比；不要对同一张待识别图片和同一张参考图重复返回。\n图片对比要求：${comparisonPrompt.trim() || '比较图片中可见的主体、结构、配件和差异，忽略无关背景。'}`
  const imageContent = images.flatMap(image => [
    { type: 'text' as const, text: image.role === 'reference' ? `参考图片：${image.label}` : `待识别图片：${image.label}` },
    { type: 'image_url' as const, image_url: { url: image.dataUrl } },
  ])
  const messages = [
    new SystemMessage('你是严格的图片对比和场景判断器。全部待识别图片共同描述同一个业务对象，必须综合判断，只能依据可见内容和用户要求，不得猜测。先逐张观察，再提取与图片对比要求有关的可见差异。必须对“每一张待识别图片 × 每一个候选场景”分别返回一条 imageCaseEvaluations，不能只给整组图片一个笼统结论；branch 必须原样使用完整分支 ID。matched=true 表示该图片提供支持场景的明确证据；contradicts=true 仅表示该图片存在足以排除整组图片属于该场景的明确反证。看不到相关内容、角度不同、只有包装或无法判断时，应将 matched 和 contradicts 都设为 false，不能把缺少证据当作反证。例如：产品本体图会反驳“仅包装”，但包装图不会反驳“产品损坏”，因为包装图只是无法观察产品。即使某张图片已提供支持，也不得跳过其他场景或图片。图片无法与参考图比较只影响 comparisons，不阻止依据自身可见内容判断场景。程序将按“至少一张支持且没有一张明确反驳”聚合整组结果，再按配置优先级选路。顶层必须且只能包含 comparisonStatus、comparisonSummary、comparisons、imageCaseEvaluations。comparisons 每项必须包含 inputImageIndex、referenceImageIndex、comparable、reason、differences；同一张待识别图片可以对应多张参考图，但同一对图片不要重复。differences 每项必须包含 location、description、evidence。imageCaseEvaluations 每项必须包含 inputImageIndex、branch、matched、contradicts、confidence、evidence。禁止使用 image、selectedReferenceImage、subject、visibleSimilarities、visibleDifferences 等其他字段。必须返回完整闭合的 JSON，不要输出 Markdown、额外文字或思考过程。'),
    new HumanMessage({ content: [
      { type: 'text', text: `${instruction.trim() ? `统一要求：${instruction.trim()}\n\n` : ''}待识别图片共 ${inputs.length} 张。${comparisonSection}\n\n候选场景：\n${branches}\n\n请返回差异结果，并逐张判断全部 ${cases.length} 个候选场景，共返回 ${inputs.length * cases.length} 条 imageCaseEvaluations。` },
      ...imageContent,
    ] }),
  ]
  try {
    const raw = await model.withStructuredOutput(imageDecisionSchema, { name: 'image_decision', method: 'jsonMode' }).invoke(messages)
    return aggregateImageDecision(requireImageDecision(raw, 'JSON Mode'), cases)
  } catch (jsonModeError) {
    try {
      const raw = await model.withStructuredOutput(imageDecisionSchema, { name: 'image_decision', method: 'functionCalling', strict: true }).invoke(messages)
      return aggregateImageDecision(requireImageDecision(raw, 'Function Calling'), cases)
    } catch (functionCallingError) {
      try {
        const retryMessages = [...messages, new HumanMessage('上一次结构化输出失败。请压缩每条 reason、evidence 和 differences，只保留必要可见事实，并严格按照指定字段返回一个完整闭合的 JSON 对象。')]
        const raw = await model.withStructuredOutput(imageDecisionSchema, { name: 'image_decision_retry', method: 'jsonMode' }).invoke(retryMessages)
        return aggregateImageDecision(requireImageDecision(raw, 'JSON Mode 重试'), cases)
      } catch (retryError) {
        throw new Error(`图片识别结构化输出失败（JSON Mode：${imageCallError(jsonModeError, images, llm.apiKey)}；Function Calling：${imageCallError(functionCallingError, images, llm.apiKey)}；JSON Mode 重试：${imageCallError(retryError, images, llm.apiKey)}）`)
      }
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
    generateAgent,
    generateCondition,
    generateSwitch,
    recognizeImage,
  }
}

/**
 * Wait for a buffered page response. A URL can first receive a CORS preflight,
 * redirect, or transient gateway response, so an invalid JSON candidate must
 * not prevent a later matching application response from being captured.
 */
export async function waitForBufferedPageResponse(
  responseBuffer: readonly BufferedPageResponse[],
  config: ApiResponseWaitOptions,
): Promise<{ data: JsonValue; url: string; method: string; status: number }> {
  const deadline = Date.now() + Math.max(100, config.timeoutMs)
  const matches = (item: BufferedPageResponse): boolean => {
    if (config.method !== 'ANY' && item.method !== config.method.toUpperCase()) return false
    const urlMatched = config.matchMode === 'equals'
      ? item.url === config.urlPattern
      : config.matchMode === 'regex'
        ? (() => { try { return new RegExp(config.urlPattern).test(item.url) } catch { return false } })()
        : item.url.includes(config.urlPattern)
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
  let invalidJsonCount = 0
  let lastInvalid: BufferedPageResponse | undefined
  while (Date.now() < deadline) {
    const item = responseBuffer.find(candidate => !seen.has(candidate.response) && matches(candidate))
    if (item !== undefined) {
      seen.add(item.response)
      if (config.responseType === 'text') return { data: await item.response.text(), url: item.url, method: item.method, status: item.status }
      try {
        // Strip an optional UTF-8 BOM. JSON payloads with a BOM are common
        // enough in legacy services but JSON.parse does not accept it.
        const raw = (await item.response.text()).replace(/^\uFEFF/, '')
        return { data: JSON.parse(raw) as JsonValue, url: item.url, method: item.method, status: item.status }
      } catch {
        invalidJsonCount += 1
        lastInvalid = item
        continue
      }
    }
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
  if (lastInvalid !== undefined) {
    const contentType = lastInvalid.response.headers()['content-type'] ?? '未提供'
    throw new Error(`匹配到 ${invalidJsonCount} 个接口响应，但均不是有效 JSON；最后一次：${lastInvalid.method} ${lastInvalid.url}，HTTP ${lastInvalid.status}，Content-Type ${contentType}`)
  }
  throw new Error(`等待接口响应超时：${config.urlPattern}`)
}

function createDriver(page: Page): BrowserDriver {
  const responseBuffer: BufferedPageResponse[] = []
  const activeRequests = new Set<import('playwright').Request>()
  let lastNetworkActivityAt = Date.now()
  const tracksRequest = (request: import('playwright').Request): boolean => ['document', 'xhr', 'fetch', 'script', 'stylesheet', 'image', 'font'].includes(request.resourceType())
  page.on('request', request => {
    if (!tracksRequest(request)) return
    activeRequests.add(request)
    lastNetworkActivityAt = Date.now()
  })
  const finishRequest = (request: import('playwright').Request): void => {
    if (!activeRequests.delete(request)) return
    lastNetworkActivityAt = Date.now()
  }
  page.on('requestfinished', finishRequest)
  page.on('requestfailed', finishRequest)
  page.on('response', response => {
    responseBuffer.push({ url: response.url(), method: response.request().method().toUpperCase(), status: response.status(), response })
    if (responseBuffer.length > 200) responseBuffer.shift()
  })
  const typeIntoLocator = async (target: Locator, text: string, timeoutMs: number, inputMode: 'replace' | 'append'): Promise<void> => {
    if (inputMode === 'append') {
      const caretPositioned = await target.evaluate(element => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.focus()
          try {
            const end = element.value.length
            element.setSelectionRange(end, end)
            return true
          } catch { return false }
        }
        if (element instanceof HTMLElement && element.isContentEditable) {
          element.focus()
          const selection = window.getSelection()
          const range = document.createRange()
          range.selectNodeContents(element)
          range.collapse(false)
          selection?.removeAllRanges()
          selection?.addRange(range)
          return true
        }
        return false
      })
      if (!caretPositioned) {
        await target.focus({ timeout: timeoutMs })
        await target.press('End', { timeout: timeoutMs })
      }
      await target.pressSequentially(text, { timeout: timeoutMs })
    } else await target.fill(text, { timeout: timeoutMs })
  }
  const operateListRows = async (request: ListRowOperationRequest): Promise<ListRowOperationResult> => {
    const trace = (message: string): void => { request.trace?.(message) }
    const preview = (value: string, limit = 120): string => {
      const normalized = value.replace(/\s+/g, ' ').trim()
      return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`
    }
    const rowSelector = request.rowSelectorMode === 'class-contains'
      ? classContainsSelector(request.rowSelector)
      : request.rowSelector
    const rows = (): Locator => request.containerSelector.trim() === ''
      ? page.locator(rowSelector)
      : page.locator(request.containerSelector).locator(rowSelector)
    const normalize = (value: string, fieldIndex: number): string => {
      const field = request.matchFields[fieldIndex]
      let result = field?.trim === false ? value : value.trim()
      if (field?.ignoreCase === true) result = result.toLocaleLowerCase()
      return result
    }
    const keyOf = (values: readonly string[]): string => JSON.stringify(values.map(normalize))
    const valuesMatch = (pageValues: readonly string[], targetValues: readonly string[]): boolean => listRowValuesMatch(request.matchFields, pageValues, targetValues)
    const readRowValues = async (row: Locator, rowIndex: number): Promise<readonly string[]> => Promise.all(request.matchFields.map(async (field, fieldIndex) => {
      try {
        const candidates = field.selector.trim() === '' ? row : row.locator(field.selector)
        if (field.selector.trim() !== '' && await candidates.count() === 0) {
          throw new Error('当前行中未找到该元素；行规则可能误匹配了行内子元素，或字段 class 已发生变化')
        }
        const target = candidates.first()
        if (field.readMode === 'attribute') return (await target.getAttribute(field.attribute ?? '', { timeout: request.timeoutMs })) ?? ''
        if (field.readMode === 'value') return target.inputValue({ timeout: request.timeoutMs })
        return target.innerText({ timeout: request.timeoutMs })
      } catch (error) {
        const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
        throw new Error(`读取页面第 ${rowIndex + 1} 行的匹配字段 ${fieldIndex + 1} 失败（${field.selector || '当前行'}）：${detail}`)
      }
    }))
    const scan = async (reason?: string, includeRows = false): Promise<Array<{ index: number; key: string; label: string; values: readonly string[] }>> => {
      const collection = rows()
      const count = await collection.count()
      const result: Array<{ index: number; key: string; label: string; values: readonly string[] }> = []
      for (let index = 0; index < count; index += 1) {
        const values = await readRowValues(collection.nth(index), index)
        result.push({ index, key: keyOf(values), label: values.join(' | '), values })
      }
      if (reason !== undefined) trace(`${reason}：找到 ${count} 个页面行`)
      if (includeRows) {
        result.slice(0, 50).forEach(row => { trace(`页面第 ${row.index + 1} 行匹配值：${preview(row.label) || '（空）'}`) })
        if (result.length > 50) trace(`页面行明细仅展示前 50 条，另有 ${result.length - 50} 条未展开`)
      }
      return result
    }

    trace(`开始列表行操作：容器=${request.containerSelector.trim() || '整个页面'}；实际行选择器=${rowSelector}`)
    request.matchFields.forEach((field, index) => { trace(`页面匹配字段 ${index + 1}：选择器=${field.selector || '当前行'}；匹配方式=${field.matchMode === 'contains' ? '页面字段包含目标值' : '完全匹配'}；读取方式=${field.readMode}${field.readMode === 'attribute' ? `(${field.attribute ?? ''})` : ''}；去空格=${field.trim}；忽略大小写=${field.ignoreCase}`) })
    const initialRows = await scan('首次扫描页面', true)
    if (request.items.length === 0 && request.emptySourceAction === 'stop') throw new Error('目标数据为空，已按安全策略停止；如需保留或删除全部行，请修改“目标数据为空时”配置')
    const targetKeys = request.items.map(item => keyOf(item.matchValues))
    request.items.slice(0, 50).forEach(item => { trace(`目标数据第 ${item.index + 1} 条匹配值：${preview(item.matchValues.join(' | ')) || '（空）'}`) })
    if (request.items.length > 50) trace(`目标数据明细仅展示前 50 条，另有 ${request.items.length - 50} 条未展开`)
    const duplicateSourceKeys = targetKeys.filter((key, index) => targetKeys.indexOf(key) !== index)
    if (duplicateSourceKeys.length > 0) {
      trace(`目标数据重复业务键数量：${new Set(duplicateSourceKeys).size}`)
      throw new Error('目标数据中存在重复业务键，无法确定同一页面行应使用哪条数据')
    }
    const missingItems: number[] = []
    const duplicateItems: number[] = []
    let matchedCount = 0
    let updatedCount = 0

    for (const item of request.items) {
      let matches = (await scan()).filter(row => valuesMatch(row.values, item.matchValues))
      trace(`匹配目标数据第 ${item.index + 1} 条：页面命中 ${matches.length} 行${matches.length > 0 ? `（第 ${matches.map(row => row.index + 1).join('、')} 行）` : ''}`)
      if (matches.length === 0) {
        missingItems.push(item.index)
        trace(`目标数据第 ${item.index + 1} 条未匹配；处理策略=${request.missingMatchAction}`)
        if (request.missingMatchAction === 'stop') throw new Error(`目标数据第 ${item.index + 1} 条未匹配到页面行`)
        continue
      }
      if (matches.length > 1) {
        duplicateItems.push(item.index)
        trace(`目标数据第 ${item.index + 1} 条存在重复页面行；处理策略=${request.duplicateMatchAction === 'first' ? 'first' : 'all'}`)
        if (request.duplicateMatchAction === 'first') matches = matches.slice(0, 1)
      }
      matchedCount += matches.length
      for (let occurrence = 0; occurrence < matches.length; occurrence += 1) {
        for (const [actionIndex, action] of request.actions.entries()) {
          const currentMatches = (await scan()).filter(row => valuesMatch(row.values, item.matchValues))
          const current = currentMatches[Math.min(occurrence, currentMatches.length - 1)]
          if (current === undefined) throw new Error(`操作过程中页面行已消失（目标数据第 ${item.index + 1} 条）`)
          const row = rows().nth(current.index)
          const target = action.selector.trim() === '' ? row : row.locator(action.selector).first()
          const actionValue = item.actionValues[actionIndex] ?? ''
          trace(`目标数据第 ${item.index + 1} 条 → 页面第 ${current.index + 1} 行：执行操作 ${actionIndex + 1}/${request.actions.length} ${action.type}（${action.selector || '当前行'}）${action.type === 'type' ? `，输入长度 ${actionValue.length}，方式=${action.inputMode}` : action.type === 'select' ? `，选项=${preview(actionValue, 60)}` : ''}`)
          if (action.type === 'type') await typeIntoLocator(target, actionValue, request.timeoutMs, action.inputMode)
          else if (action.type === 'select') await target.selectOption(actionValue, { timeout: request.timeoutMs })
          else await clickResolvedLocator(target, request.timeoutMs)
          trace(`目标数据第 ${item.index + 1} 条：操作 ${actionIndex + 1} 完成`)
        }
        if (request.actions.length > 0) updatedCount += 1
      }
    }

    const deleteEnabled = request.items.length === 0
      ? request.emptySourceAction === 'delete-all'
      : request.unmatchedMode === 'delete'
    let deletedCount = 0
    const deletedKeys: string[] = []
    if (deleteEnabled) {
      const unmatched = (await scan('删除前重新扫描页面')).filter(row => !request.items.some(item => valuesMatch(row.values, item.matchValues)))
      trace(`删除预检：未匹配页面行 ${unmatched.length} 条；安全上限 ${request.maxDeleteCount} 条；删除按钮=${request.deleteSelector}${request.confirmSelector.trim() ? `；确认按钮=${request.confirmSelector}` : ''}`)
      if (unmatched.length > request.maxDeleteCount) throw new Error(`预计删除 ${unmatched.length} 行，超过最大允许数量 ${request.maxDeleteCount}，已停止执行`)
      while (true) {
        const currentRows = await scan()
        const unwanted = currentRows.find(row => !request.items.some(item => valuesMatch(row.values, item.matchValues)))
        if (unwanted === undefined) break
        trace(`准备删除当前页面第 ${unwanted.index + 1} 行；匹配值=${preview(unwanted.label) || '（空）'}`)
        const row = rows().nth(unwanted.index)
        await clickResolvedLocator(row.locator(request.deleteSelector).first(), request.timeoutMs)
        trace(`已点击第 ${unwanted.index + 1} 行删除按钮`)
        if (request.confirmSelector.trim() !== '') {
          await clickResolvedLocator(await resolveTargetLocator(page, request.confirmSelector, request.timeoutMs), request.timeoutMs)
          trace('已点击全局删除确认按钮')
        }
        deletedCount += 1
        deletedKeys.push(unwanted.label)
        if (request.waitAfterDeleteMs > 0) await page.waitForTimeout(request.waitAfterDeleteMs)
        trace(`删除完成 ${deletedCount}/${unmatched.length}；已重新扫描 DOM`)
        if (deletedCount > request.maxDeleteCount) throw new Error(`删除数量超过安全上限 ${request.maxDeleteCount}`)
      }
    } else trace(`未启用删除：${request.items.length === 0 ? `空数据策略=${request.emptySourceAction}` : `未匹配页面行策略=${request.unmatchedMode}`}`)
    const finalRows = await scan('最终扫描页面', true)
    trace(`列表行操作汇总：目标 ${request.items.length} 条；初始页面行 ${initialRows.length}；匹配 ${matchedCount} 行；更新 ${updatedCount} 行；删除 ${deletedCount} 行；最终页面行 ${finalRows.length}；缺失 ${missingItems.length} 条；重复 ${duplicateItems.length} 条`)
    return { totalPageRows: initialRows.length, targetDataCount: request.items.length, matchedCount, updatedCount, deletedCount, finalPageRows: finalRows.length, missingItems, duplicateItems, deletedKeys }
  }
  return {
    async openPage(url: string, timeoutMs = 30_000): Promise<void> {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      await page.bringToFront()
    },
    async waitForResponse(config): Promise<{ data: JsonValue; url: string; method: string; status: number }> {
      return waitForBufferedPageResponse(responseBuffer, config)
    },
    requestApi: config => requestApiDirect(config, page.url()),
    generateText,
    generateAgent,
    generateCondition,
    generateSwitch,
    recognizeImage,
    operateListRows,
    async waitForPageSettled(timeoutMs = 8_000): Promise<boolean> {
      const deadline = Date.now() + Math.max(400, timeoutMs)
      while (Date.now() < deadline) {
        if (page.isClosed()) return false
        const domStableSince = await page.evaluate(() => {
          type SettleWindow = Window & typeof globalThis & { __rpaSettleState?: { lastMutationAt: number; observer: MutationObserver } }
          const target = window as SettleWindow
          if (target.__rpaSettleState === undefined) {
            const state = { lastMutationAt: Date.now(), observer: new MutationObserver(() => { state.lastMutationAt = Date.now() }) }
            if (document.documentElement !== null) state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
            target.__rpaSettleState = state
          }
          return target.__rpaSettleState.lastMutationAt
        }).catch(() => Date.now())
        const now = Date.now()
        if (pageIsSettled({ now, activeRequests: activeRequests.size, lastNetworkActivityAt, domStableSince })) return true
        await page.waitForTimeout(100)
      }
      return false
    },
    async click(selector: string, timeoutMs = 30_000): Promise<void> {
      const beforeUrl = page.url()
      if (shouldClickByExactVisibleText(selector)) {
        const text = selector.trim().slice('text-exact:'.length)
        await clickExactVisibleText(page, text, Math.min(timeoutMs, 8_000))
      } else {
        await clickResolvedLocator(await resolveTargetLocator(page, selector, timeoutMs), timeoutMs)
      }
      // 不等待 loadState：站点若持续加载，Playwright 默认的 load 等待会卡满 30 秒。
      // 只给 URL 跳转或 SPA 路由一个短暂机会，其余情况直接继续。
      await Promise.race([
        page.waitForURL(url => url.toString() !== beforeUrl, { timeout: 2500 }).catch(() => undefined),
        page.waitForTimeout(180),
      ])
    },
    async selectOption(selector: string, value: string, timeoutMs = 30_000): Promise<void> {
      await (await resolveTargetLocator(page, selector, timeoutMs)).selectOption(value, { timeout: timeoutMs })
    },
    async hover(selector: string, timeoutMs = 30_000): Promise<void> {
      await (await resolveTargetLocator(page, selector, timeoutMs)).hover({ timeout: timeoutMs })
    },
    async type(selector: string, text: string, timeoutMs = 30_000, inputMode: 'replace' | 'append' = 'replace'): Promise<void> {
      const target = await resolveTargetLocator(page, selector, timeoutMs)
      await typeIntoLocator(target, text, timeoutMs, inputMode)
    },
    async extract(selector: string): Promise<string> {
      return (await (await resolveTargetLocator(page, selector, 30_000)).innerText()).trim()
    },
    async extractList(rowSelector: string, fields: readonly { name: string; selector: string; attribute?: string }[]): Promise<readonly Record<string, import('@graph/types.ts').JsonValue>[]> {
      const rows = parseElementFingerprint(rowSelector) === undefined ? page.locator(rowSelector) : await resolveTargetLocator(page, rowSelector, 30_000)
      return rows.evaluateAll((rows, fieldDefs) => rows.map(row => {
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
      return (await resolveTargetLocator(page, containerSelector, 30_000)).evaluate(container => {
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
      const html = await (await resolveTargetLocator(page, containerSelector, 30_000)).evaluate(element => element.outerHTML.slice(0, 160_000))
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
      const fingerprint = parseElementFingerprint(selector)
      if (fingerprint !== undefined) {
        if (state === 'visible') {
          const target = await resolveTargetLocator(page, selector, ms)
          await target.waitFor({ state: 'visible', timeout: Math.max(1, ms) })
          return
        }
        const candidate = selectFingerprintCandidate(fingerprint, await fingerprintCandidates(page, fingerprint), false)
        if (candidate === undefined) {
          try {
            const fallback = page.locator(fingerprint.css)
            if (!hasSemanticFingerprint(fingerprint) && await fallback.count() === 1 && await fallback.isVisible()) await fallback.waitFor({ state: 'hidden', timeout: Math.max(1, ms) })
          } catch (error) {
            if (error instanceof Error && error.name === 'TimeoutError') throw error
          }
          return
        }
        if (!candidate.visible) return
        await page.locator(fingerprint.tag || '*').nth(candidate.index).waitFor({ state: 'hidden', timeout: Math.max(1, ms) })
        return
      }
      await waitForPickedSelector(page, selector, state, ms)
    },
    async waitForUrl(pattern: string, timeoutMs: number): Promise<void> {
      await page.waitForURL(url => url.toString().includes(pattern), { timeout: Math.max(1, timeoutMs) })
    },
    async elementState(selector: string): Promise<{ exists: boolean; visible: boolean; text: string }> {
      let locator: Locator
      try { locator = await resolveTargetLocator(page, selector, 1, false) } catch (error) {
        if (error instanceof Error && error.message.includes('定位存在歧义')) throw error
        return { exists: false, visible: false, text: '' }
      }
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

async function pickElement(page: Page, url?: string, mode: ElementPickMode = 'element', options: ElementPickOptions = {}): Promise<PickedElement> {
  if (url !== undefined && url.trim() !== '') await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('domcontentloaded').catch(() => undefined)
  await page.bringToFront().catch(() => undefined)
  await page.waitForTimeout(250)
  const scopeAttribute = 'data-rpa-picker-list-scope'
  const rowAttribute = 'data-rpa-picker-list-row'
  let scope: Locator | undefined
  try {
    if (mode === 'list-row' || mode === 'row-element') {
      scope = options.scopeSelector?.trim()
        ? await resolveTargetLocator(page, options.scopeSelector, 8_000)
        : page.locator('body')
      await scope.evaluateAll((elements, attribute) => { elements.forEach(element => { element.setAttribute(attribute, 'true') }) }, scopeAttribute)
      if (mode === 'row-element') {
        if (!options.rowSelector?.trim()) throw new Error('请先拾取或填写行选择器，再拾取行内元素')
        const configuredRowSelector = options.rowSelectorMode === 'class-contains'
          ? classContainsSelector(options.rowSelector)
          : options.rowSelector
        const rows = scope.locator(configuredRowSelector)
        if (await rows.count() === 0) throw new Error(`当前页面没有找到列表行：${options.rowSelector}`)
        await rows.evaluateAll((elements, attribute) => { elements.forEach(element => { element.setAttribute(attribute, 'true') }) }, rowAttribute)
      }
    }
  let validationMessage = ''
  while (true) {
    const picked = await page.evaluate(({ pickMode, validationMessage }) => new Promise<PickedElement>(resolve => {
    const fingerprintPrefix = 'rpa-fingerprint:'
    const panel = document.createElement('div')
    panel.id = '__rpa_picker_panel__'
    panel.innerHTML = '<div class="rpa-picker-title">RPA 元素拾取</div><span>移动鼠标预览，点击页面元素后确认</span><div class="rpa-picker-label">当前 Hover 元素</div><div class="rpa-picker-hover">未检测到</div><div class="rpa-picker-label">已选中元素</div><div class="rpa-picker-status">尚未选择</div><code></code><div class="rpa-picker-actions"><button type="button" data-action="copy">复制选择器</button><button type="button" data-action="confirm">确认拾取</button><button type="button" data-action="cancel">取消</button></div>'
    Object.assign(panel.style, { position: 'fixed', zIndex: '2147483647', top: '16px', right: '16px', width: '240px', padding: '12px', borderRadius: '10px', background: '#111827', color: '#fff', font: '13px/1.4 Segoe UI, sans-serif', boxShadow: '0 8px 24px rgba(0,0,0,.3)' })
    const span = panel.querySelector('span') as HTMLElement
    const code = panel.querySelector('code') as HTMLElement
    const copy = panel.querySelector('[data-action="copy"]') as HTMLButtonElement
    const confirm = panel.querySelector('[data-action="confirm"]') as HTMLButtonElement
    const cancel = panel.querySelector('[data-action="cancel"]') as HTMLButtonElement
    const hoverInfo = panel.querySelector('.rpa-picker-hover') as HTMLElement
    const status = panel.querySelector('.rpa-picker-status') as HTMLElement
    if (validationMessage !== '') {
      const warning = document.createElement('div')
      warning.textContent = validationMessage
      Object.assign(warning.style, { marginTop: '8px', padding: '7px', borderRadius: '6px', background: '#7f1d1d', color: '#fecaca', fontSize: '12px' })
      panel.querySelector('.rpa-picker-title')?.insertAdjacentElement('afterend', warning)
    }
    Object.assign(panel.querySelector('.rpa-picker-title')?.['style'] ?? {}, { fontWeight: '700', fontSize: '14px' })
    Object.assign(span.style, { display: 'block', marginTop: '5px', color: '#d1d5db' })
    Object.assign(panel.querySelector('.rpa-picker-label')?.['style'] ?? {}, { marginTop: '9px', color: '#9ca3af', fontSize: '11px' })
    Object.assign(hoverInfo.style, { marginTop: '3px', color: '#fbbf24', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' })
    Object.assign(status.style, { marginTop: '3px', color: '#34d399', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' })
    Object.assign(code.style, { display: 'block', marginTop: '6px', color: '#93c5fd', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' })
    Object.assign(panel.querySelector('.rpa-picker-actions')?.['style'] ?? {}, { display: 'flex', gap: '6px', marginTop: '10px' })
    Object.assign(copy.style, { border: '0', borderRadius: '6px', padding: '6px 9px', cursor: 'pointer', background: '#0f766e', color: '#fff' })
    Object.assign(confirm.style, { border: '0', borderRadius: '6px', padding: '6px 9px', cursor: 'pointer', background: '#4f46e5', color: '#fff' })
    Object.assign(cancel.style, { border: '0', borderRadius: '6px', padding: '6px 9px', cursor: 'pointer', background: '#374151', color: '#fff' })
    document.documentElement.appendChild(panel)
    const style = document.createElement('style')
    style.textContent = '[data-rpa-picker-hover]{outline:2px solid #4f46e5!important;cursor:crosshair!important}'
    document.head.appendChild(style)
    const unique = (candidate: string): string | undefined => {
      try { return document.querySelectorAll(candidate).length === 1 ? candidate : undefined } catch { return undefined }
    }
    const stableClass = (value: string): boolean => {
      const name = value.trim()
      if (name.length < 2 || name.length > 100) return false
      if (/^(?:css|jsx|sc|emotion)-/i.test(name) || /^[a-f0-9]{6,}$/i.test(name) || /__[A-Za-z0-9_-]{5,}$/.test(name)) return false
      if (/(?:appear|enter|leave|exit)(?:-done|-active|-start)?$/i.test(name) || /(?:-appear|-enter|-leave|-exit)-/i.test(name)) return false
      return !name.split(/[_-]/).some(part => part.length >= 5 && /[a-z]/i.test(part) && /\d/.test(part) && /^[a-z0-9]+$/i.test(part))
    }
    const stableId = (value: string): boolean => {
      const id = value.trim()
      if (id.length < 2 || id.length > 100 || /^\d+$/.test(id)) return false
      if (/^:r[\w-]*:$/i.test(id) || /^(?:rc_select|react-select|headlessui|radix)[-_]/i.test(id) || /^(?:arco|mui|chakra)-.*-\d+$/i.test(id)) return false
      if (/^[a-f0-9]{12,}$/i.test(id) || /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) return false
      return true
    }
    const cssString = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const cssModuleClassFragment = (element: Element): string | undefined => {
      for (const name of Array.from(element.classList)) {
        const match = name.match(/([A-Za-z][A-Za-z0-9]*__[A-Za-z][A-Za-z0-9]*)--[A-Za-z0-9_-]+/)
        if (match?.[1]) return match[1]
      }
      return undefined
    }
    const structuralSelector = (element: Element): string => {
      if (element === document.documentElement) return 'html'
      const parts: string[] = []
      let current: Element | null = element
      while (current !== null && current !== document.documentElement) {
        const tag = current.tagName.toLowerCase()
        let part = tag
        if (stableId(current.id)) part = `#${CSS.escape(current.id)}`
        else if (current.parentElement !== null) {
          const stableClasses = Array.from(current.classList).filter(stableClass).slice(0, 3)
          if (stableClasses.length > 0) part += stableClasses.map(name => `.${CSS.escape(name)}`).join('')
          const sameTagSiblings = Array.from(current.parentElement.children).filter(sibling => sibling.tagName === current?.tagName)
          // Always preserve the picked sibling position. A component that was
          // unique while picking may be duplicated by a later render.
          part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`
        }
        parts.unshift(part)
        if (stableId(current.id)) break
        current = current.parentElement
      }
      if (current === document.documentElement) parts.unshift('html')
      return parts.join(' > ')
    }
    const isRepeatingContainer = (element: Element): boolean => {
      const role = element.getAttribute('role')?.toLowerCase() ?? ''
      if (['tree', 'listbox', 'menu', 'list', 'grid'].includes(role)) return true
      if (['UL', 'OL', 'TBODY'].includes(element.tagName)) return true
      if (/\b(?:arco-tree|ant-tree|el-tree)(?:\s|$)/.test(element.className.toString())) return true
      const children = Array.from(element.children).filter(child => (child.textContent ?? '').trim() !== '')
      if (children.length < 2) return false
      const groups = new Map<string, number>()
      for (const child of children) {
        const key = `${child.tagName}:${Array.from(child.classList).slice(0, 2).join('.')}`
        groups.set(key, (groups.get(key) ?? 0) + 1)
      }
      return Math.max(0, ...groups.values()) >= 2
    }
    const scopeForParentPath = (element: Element): Element | null => {
      let current: Element | null = element
      while (current !== null) {
        const parent: Element | null = current.parentElement
        if (parent !== null && isRepeatingContainer(parent)) return current
        current = parent
      }
      return element.parentElement
    }
    const selector = (element: Element): string => {
      const html = element as HTMLElement
      if (stableId(html.id)) {
        const candidate = unique(`#${CSS.escape(html.id)}`)
        if (candidate !== undefined) return candidate
      }
      for (const [attribute, value] of [['data-testid', html.getAttribute('data-testid')], ['data-id', html.getAttribute('data-id')], ['data-key', html.getAttribute('data-key')], ['data-row-key', html.getAttribute('data-row-key')], ['data-action', html.getAttribute('data-action')], ['name', html.getAttribute('name')], ['aria-label', html.getAttribute('aria-label')], ['placeholder', html.getAttribute('placeholder')], ['autocomplete', html.getAttribute('autocomplete')], ['title', html.getAttribute('title')]]) {
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
      // Containers often have no id/ARIA metadata. Prefer a unique class
      // combination over a bare tag such as `div`, which is almost never a
      // reliable list selector. Ignore very short utility classes.
      const classes = Array.from(html.classList).filter(stableClass).slice(0, 3)
      if (classes.length > 0) {
        const candidate = unique(`${html.tagName.toLowerCase()}${classes.map(item => `.${CSS.escape(item)}`).join('')}`)
        if (candidate !== undefined) return candidate
      }
      return structuralSelector(element)
    }
    const fingerprint = (element: Element): string => {
      const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 300)
      const attributeNames = ['id', 'data-testid', 'data-id', 'data-key', 'data-row-key', 'data-action', 'name', 'aria-label', 'placeholder', 'title', 'autocomplete', 'type']
      const attributes = (target: Element): Record<string, string> => Object.fromEntries(attributeNames.flatMap(name => {
        const value = target.getAttribute(name)
        return value === null || value === '' ? [] : [[name, value]]
      }))
      const nearbyText = (target: Element): string[] => [
        target.previousElementSibling?.textContent,
        target.nextElementSibling?.textContent,
        target.parentElement?.querySelector(':scope > label, :scope > [class*="label"], :scope > legend')?.textContent,
      ].filter((value): value is string => typeof value === 'string').map(normalize).filter(Boolean).slice(0, 3)
      const semanticRole = (target: Element): string => {
        const explicit = target.getAttribute('role')
        if (explicit) return explicit
        const tag = target.tagName.toLowerCase()
        if (tag === 'button') return 'button'
        if (tag === 'a' && target.hasAttribute('href')) return 'link'
        if (tag === 'select') return 'combobox'
        if (tag === 'textarea') return 'textbox'
        if (tag === 'input') return ['button', 'submit', 'reset'].includes(target.getAttribute('type') ?? 'text') ? 'button' : 'textbox'
        return ''
      }
      const contexts: ElementFingerprintContext[] = []
      let current = element.parentElement
      for (let depth = 0; current !== null && depth < 8; depth += 1, current = current.parentElement) {
        const tag = current.tagName.toLowerCase()
        const role = current.getAttribute('role')?.toLowerCase() ?? ''
        const attrs = attributes(current)
        const contextClasses = Array.from(current.classList).filter(stableClass).slice(0, 5)
        const heading = current.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > legend, :scope > [role="heading"], :scope > [class*="title"], :scope > [class*="header"]')?.textContent
        const semantic = ['dialog', 'form', 'tr', 'li', 'section', 'article'].includes(tag) || ['dialog', 'row', 'listitem', 'region', 'form'].includes(role) || normalize(heading ?? '') !== ''
        const stable = Object.keys(attrs).some(name => ['id', 'data-testid', 'data-id', 'data-key', 'data-row-key'].includes(name))
        if (!semantic && !stable && contextClasses.length === 0) continue
        const repeating = isRepeatingContainer(current)
        const ownText = Array.from(current.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? '').join(' ')
        contexts.push({ tag, text: repeating ? '' : normalize(heading || ownText), attributes: attrs, classes: contextClasses })
        if (contexts.length >= 6) break
      }
      const html = element as HTMLElement
      if (stableId(html.id)) {
        const idSelector = unique(`#${CSS.escape(html.id)}`)
        if (idSelector !== undefined) return idSelector
      }
      const row = element.closest('[role="treeitem"],[role="option"],[role="menuitem"],.arco-tree-node')
      const attrs = attributes(element)
      if (row !== null) {
        const key = row.getAttribute('data-key') || row.getAttribute('data-value')
        if (key !== null && key !== '' && attrs['data-key'] === undefined) attrs['data-key'] = key
      }
      const text = normalize(html.innerText || element.textContent || '')
      const tree = element.closest('.arco-tree, [role="tree"]')
      let textIndex: number | undefined
      if (tree !== null && text !== '') {
        const sameText = Array.from(tree.querySelectorAll('.arco-tree-node')).filter(item => normalize((item as HTMLElement).innerText || item.textContent || '') === text)
        const owners = sameText.filter(item => !sameText.some(other => other !== item && item.contains(other)))
        const hit = owners.findIndex(item => item === element || item.contains(element) || element.contains(item))
        if (hit >= 0) textIndex = hit
      }
      const scope = scopeForParentPath(element)
      const payload: ElementFingerprint = {
        version: 1,
        css: selector(element),
        parentPath: scope === null ? undefined : structuralSelector(scope),
        tag: element.tagName.toLowerCase(),
        text,
        role: semanticRole(element),
        attributes: attrs,
        classes: Array.from(element.classList).filter(stableClass).slice(0, 5),
        context: contexts[0],
        contexts,
        nearbyText: nearbyText(element),
        textIndex,
      }
      const encoded = encodeURIComponent(JSON.stringify(payload))
      return payload.text === '' ? `${fingerprintPrefix}${encoded}` : `text-exact:rpa-context:${encoded}`
    }
    const compactLabel = (element: Element): string => {
      const tag = element.tagName.toLowerCase()
      const id = stableId(element.id) ? `#${element.id}` : ''
      const role = element.getAttribute('role')
      const rolePart = role ? `[${role}]` : ''
      const text = ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24)
      return `${tag}${id}${rolePart}${text === '' ? '' : ` “${text}${text.length >= 24 ? '…' : ''}”`}`
    }
    const fingerprintPreview = (element: Element): string => {
      const value = fingerprint(element)
      if (!value.startsWith('text-exact:rpa-context:') && !value.startsWith(fingerprintPrefix)) return value
      const prefix = value.startsWith('text-exact:rpa-context:') ? 'text-exact:rpa-context:' : fingerprintPrefix
      try {
        const payload = JSON.parse(decodeURIComponent(value.slice(prefix.length))) as ElementFingerprint
        if (payload.text !== '') {
          const index = typeof payload.textIndex === 'number' && payload.textIndex > 0 ? ` · 第${payload.textIndex + 1}个同名` : ''
          const parent = payload.parentPath ? ` · 父级:${payload.parentPath}` : ''
          return `text-exact:${payload.text}${index}${parent}`
        }
        return payload.css
      } catch {
        return value
      }
    }
    const optionLocator = (element: Element): string => {
      const value = element.getAttribute('data-value')
      if (value !== null && value !== '') {
        const candidate = `[data-value="${CSS.escape(value)}"]`
        try { if (document.querySelectorAll(candidate).length === 1) return candidate } catch { /* Fall back to the structural selector. */ }
      }
      return selector(element)
    }
    const dropdownOverlay = (element: Element): Element | null => {
      const portal = element.closest('[id^="arco-tree-select-popup"],[id^="arco-select-popup"],.arco-trigger-popup,.arco-select-popup,.arco-tree-select-popup,.ant-select-dropdown')
      if (portal !== null) return portal
      const rolePopup = element.closest('[role="listbox"],[role="menu"]')
      if (rolePopup === null) return null
      const position = getComputedStyle(rolePopup).position
      return position === 'fixed' || position === 'absolute' ? rolePopup : null
    }
    const interactiveTarget = (element: Element): HTMLElement => {
      if (element.tagName.toLowerCase() === 'option' && element.parentElement !== null) return element.parentElement as HTMLElement
      const overlay = dropdownOverlay(element)
      if (overlay !== null) {
        const title = element.closest('.arco-tree-node-title,[role="option"],[role="menuitem"],[data-select-option]')
        if (title !== null) return title as HTMLElement
        const treeitem = element.closest('[role="treeitem"],.arco-tree-node')
        const nodeTitle = treeitem?.querySelector('.arco-tree-node-title')
        if (nodeTitle !== null && nodeTitle !== undefined) return nodeTitle as HTMLElement
        if (treeitem !== null) return treeitem as HTMLElement
      }
      const control = element.closest('button,input,select,textarea,[role="button"],[role="combobox"],[contenteditable="true"]')
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
    const pickerScope = (element?: Element): Element | null => element?.closest('[data-rpa-picker-list-scope="true"]') ?? document.querySelector('[data-rpa-picker-list-scope="true"]')
    const repeatedRowTarget = (element: Element): HTMLElement => {
      const scope = pickerScope(element)
      if (scope === null || !scope.contains(element)) return element as HTMLElement
      const semantic = element.closest('tr,[role="row"],li,[role="listitem"]')
      if (semantic !== null && semantic !== scope && scope.contains(semantic)) return semantic as HTMLElement
      let current: Element | null = element
      let fallback: Element = element
      let repeated: Element | undefined
      while (current !== null && current !== scope) {
        fallback = current
        const parent: Element | null = current.parentElement
        if (parent !== null) {
          const siblings: Element[] = Array.from(parent.children)
          const currentTag = current.tagName
          const sameTag = siblings.filter(item => item.tagName === currentTag)
          const stableClasses = Array.from(current.classList).filter(stableClass)
          const sameShape = stableClasses.length === 0 ? sameTag : sameTag.filter(item => stableClasses.every(name => item.classList.contains(name)))
          // Keep walking towards the list root. Inner table cells and repeated
          // controls may look alike too; the outermost repeated ancestor is
          // normally the reusable business row.
          if (sameShape.length >= 2) repeated = current
        }
        current = parent
      }
      return (repeated ?? fallback) as HTMLElement
    }
    const rowElementTarget = (element: Element): HTMLElement => {
      const row = element.closest('[data-rpa-picker-list-row="true"]')
      if (row === null) return element as HTMLElement
      return interactiveTarget(element)
    }
    const relativeSelector = (element: Element, root: Element, repeated: boolean): string => {
      const matches = (candidate: string): Element[] => {
        try { return Array.from(root.querySelectorAll(candidate)) } catch { return [] }
      }
      const accepts = (candidate: string): boolean => {
        const found = matches(candidate)
        return found.includes(element) && (repeated ? found.length >= 2 : found.length === 1)
      }
      const tag = element.tagName.toLowerCase()
      const attributes = ['data-testid', 'data-action', 'name', 'aria-label', 'placeholder', 'title', 'role']
      for (const attribute of attributes) {
        const value = element.getAttribute(attribute)
        if (value !== null && value !== '') {
          const candidate = `${tag}[${attribute}="${CSS.escape(value)}"]`
          if (accepts(candidate)) return candidate
        }
      }
      const classes = Array.from(element.classList).filter(stableClass).slice(0, 3)
      for (let length = classes.length; length > 0; length -= 1) {
        const candidate = `${tag}${classes.slice(0, length).map(name => `.${CSS.escape(name)}`).join('')}`
        if (accepts(candidate)) return candidate
      }
      if (accepts(tag)) return tag
      const parts: string[] = []
      let current: Element | null = element
      while (current !== null && current !== root) {
        const currentTag = current.tagName.toLowerCase()
        const currentClasses = Array.from(current.classList).filter(stableClass).slice(0, 2)
        let part = `${currentTag}${currentClasses.map(name => `.${CSS.escape(name)}`).join('')}`
        if (!repeated && current.parentElement !== null) {
          const siblings = Array.from(current.parentElement.children).filter(item => item.tagName === current?.tagName)
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
        }
        parts.unshift(part)
        const candidate = parts.join(' > ')
        if (accepts(candidate)) return candidate
        current = current.parentElement
      }
      return parts.join(' > ') || tag
    }
    const rowRule = (element: Element, root: Element): { mode: 'css' | 'class-contains'; value: string; selector: string } => {
      const classFragment = cssModuleClassFragment(element)
      if (classFragment !== undefined) {
        const selector = `[class*="${cssString(`${classFragment}--`)}"]`
        const matches = Array.from(root.querySelectorAll(selector))
        // A business list may currently contain only one row. The CSS Modules
        // component fragment is still a reusable rule even without a second
        // rendered sibling to prove repetition.
        if (matches.includes(element)) return { mode: 'class-contains', value: classFragment, selector }
      }
      const selector = relativeSelector(element, root, true)
      return { mode: 'css', value: selector, selector }
    }
    const rowElementRule = (element: Element, root: Element): { mode: 'css' | 'class-contains'; value: string; selector: string } => {
      const classFragment = cssModuleClassFragment(element)
      if (classFragment !== undefined) {
        const selector = `[class*="${cssString(`${classFragment}--`)}"]`
        if (Array.from(root.querySelectorAll(selector)).includes(element)) return { mode: 'class-contains', value: classFragment, selector }
      }
      const selector = relativeSelector(element, root, false)
      return { mode: 'css', value: selector, selector }
    }
    const listContainerSelector = (element: Element): string => {
      const classFragment = cssModuleClassFragment(element)
      if (classFragment !== undefined) {
        const candidate = `[class*="${cssString(`${classFragment}--`)}"]`
        try { if (document.querySelectorAll(candidate).length === 1) return candidate } catch { /* use structural selector */ }
      }
      return selector(element)
    }
    const targetForMode = (element: Element): HTMLElement => pickMode === 'list' || pickMode === 'list-container'
      ? listContainerTarget(element)
      : pickMode === 'list-row'
        ? repeatedRowTarget(element)
        : pickMode === 'row-element'
          ? rowElementTarget(element)
          : interactiveTarget(element)
    let highlighted: Element | undefined
    const over = (event: Event): void => { const raw = event.target as Element | null; if (raw === null || panel.contains(raw)) return; const target = targetForMode(raw); if (highlighted !== undefined && highlighted !== target) highlighted.removeAttribute('data-rpa-picker-hover'); highlighted = target; target.setAttribute('data-rpa-picker-hover', 'true'); span.textContent = pickMode === 'list' || pickMode === 'list-container' ? '移动鼠标预览，系统会识别重复行所在的列表父容器' : pickMode === 'list-row' ? '请选择一条样例行，系统会生成可复用的行规则' : pickMode === 'row-element' ? '请选择当前行内的字段、输入框或按钮' : '移动鼠标预览，点击页面元素后确认'; hoverInfo.textContent = compactLabel(target) }
    const out = (event: Event): void => { const target = event.target as Element | null; if (target !== null && !panel.contains(target)) target.removeAttribute('data-rpa-picker-hover') }
    let selected: HTMLElement | undefined
    let selectedOptionValue: string | undefined
    let selectedCopySelector = ''
    const cleanup = (): void => { document.removeEventListener('mouseover', over, true); document.removeEventListener('mouseout', out, true); document.removeEventListener('pointerdown', click, true); document.removeEventListener('mousedown', click, true); document.removeEventListener('click', click, true); style.remove(); panel.remove() }
    const click = (event: Event): void => {
      const raw = event.target as Element | null
      if (raw === null || panel.contains(raw)) return
      if (pickMode === 'list-row' && pickerScope(raw) === null) {
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
        status.textContent = '请选择列表容器内部的一条数据行'
        return
      }
      if (pickMode === 'row-element' && raw.closest('[data-rpa-picker-list-row="true"]') === null) {
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
        status.textContent = '请选择已识别数据行内部的元素'
        return
      }
      const target = targetForMode(raw)
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
      selected = target
      selectedOptionValue = raw.tagName.toLowerCase() === 'option' ? (raw as HTMLOptionElement).value : undefined
      span.textContent = '已选中页面元素，请确认或重新选择'
      hoverInfo.textContent = compactLabel(target)
      status.textContent = '请点击“确认拾取”完成选择'
      const overlay = dropdownOverlay(target)
      const optionRoot = overlay === null ? null : target.closest('option,[role="option"],[role="menuitem"],[role="treeitem"],[data-select-option]')
      const row = target.closest('[data-rpa-picker-list-row="true"]')
      const scope = pickerScope(target)
      selectedCopySelector = pickMode === 'list-container'
        ? listContainerSelector(target)
        : pickMode === 'list-row' && scope !== null
        ? rowRule(target, scope).selector
        : pickMode === 'row-element' && row !== null
          ? rowElementRule(optionRoot ?? target, row).selector
          : fingerprintPreview(optionRoot ?? target)
      code.textContent = selectedCopySelector
      copy.disabled = false
      confirm.disabled = false
    }
    copy.disabled = true
    confirm.disabled = true
    copy.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation()
      if (selectedCopySelector === '') return
      try {
        await navigator.clipboard.writeText(selectedCopySelector)
      } catch {
        const input = document.createElement('textarea')
        input.value = selectedCopySelector
        Object.assign(input.style, { position: 'fixed', left: '-9999px', top: '-9999px' })
        document.body.appendChild(input)
        input.select()
        document.execCommand('copy')
        input.remove()
      }
      status.textContent = '选择器已复制，可粘贴到其他节点复用'
    })
    confirm.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation()
      if (selected === undefined) return
      const element = selected
      const overlay = dropdownOverlay(element)
      const optionRoot = overlay === null ? null : element.closest('option,[role="option"],[role="menuitem"],[role="treeitem"],[data-select-option]')
      const isOption = optionRoot !== null || (overlay !== null && (element.tagName.toLowerCase() === 'option' || element.hasAttribute('aria-selected') || element.hasAttribute('data-value')))
      const option = isOption ? (optionRoot ?? element) : null
      let trigger: Element | null = null
      if (option !== null && overlay !== null) {
        if (overlay.id !== '') trigger = document.querySelector(`[aria-controls="${CSS.escape(overlay.id)}"]`)
        if (trigger === null) {
          const expanded = Array.from(document.querySelectorAll('[role="combobox"][aria-expanded="true"],[aria-expanded="true"][aria-haspopup="listbox"],[aria-expanded="true"][aria-haspopup="tree"]'))
            .filter(item => !overlay.contains(item))
          trigger = expanded.length === 1 ? expanded[0] : null
        }
      }
      const picked = option ?? element
      const pickedScope = pickerScope(picked)
      const pickedRowRule = pickMode === 'list-row' && pickedScope !== null ? rowRule(picked, pickedScope) : undefined
      const pickedRow = picked.closest('[data-rpa-picker-list-row="true"]')
      const pickedElementRule = pickMode === 'row-element' && pickedRow !== null ? rowElementRule(picked, pickedRow) : undefined
      cleanup()
      resolve({
        tagName: picked.tagName.toLowerCase(),
        text: (picked as HTMLElement).innerText.trim().slice(0, 200),
        id: picked.id || '',
        className: typeof picked.className === 'string' ? picked.className : '',
        ariaLabel: picked.getAttribute('aria-label') || '',
        role: picked.getAttribute('role') || '',
        placeholder: picked.getAttribute('placeholder') || '',
        selector: pickMode === 'list-container'
          ? listContainerSelector(picked)
          : pickedRowRule !== undefined
          ? pickedRowRule.selector
          : pickedElementRule !== undefined
            ? pickedElementRule.selector
            : fingerprint(picked),
        url: location.href,
        title: document.title,
        optionValue: selectedOptionValue,
        triggerSelector: trigger ? fingerprint(trigger) : undefined,
        optionSelector: option !== null && trigger !== null ? fingerprint(option) : undefined,
        rowSelectorMode: pickedRowRule?.mode,
        rowSelectorValue: pickedRowRule?.value,
        relativeSelectorMode: pickedElementRule?.mode,
        relativeSelectorValue: pickedElementRule?.value,
      })
    }, { once: true })
    cancel.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); cleanup(); resolve({ tagName: '', text: '', id: '', className: '', ariaLabel: '', role: '', placeholder: '', selector: '', url: location.href, title: document.title }) }, { once: true })
    document.addEventListener('mouseover', over, true); document.addEventListener('mouseout', out, true); document.addEventListener('pointerdown', click, true); document.addEventListener('mousedown', click, true); document.addEventListener('click', click, true)
    }), { pickMode: mode, validationMessage })
    if (picked.selector === '') return picked
    if (mode === 'list-container' || mode === 'list-row' || mode === 'row-element') return picked
    try {
      await resolveTargetLocator(page, picked.selector, 500)
      if (picked.triggerSelector !== undefined) await resolveTargetLocator(page, picked.triggerSelector, 500)
      if (picked.optionSelector !== undefined) await resolveTargetLocator(page, picked.optionSelector, 500)
      return picked
    } catch (error) {
      // The picker must not reject the user's explicit selection. The full
      // exact text and parent DOM scope are retained for deterministic replay.
      return picked
    }
  }
  } finally {
    await page.locator(`[${rowAttribute}]`).evaluateAll((elements, attribute) => { elements.forEach(element => { element.removeAttribute(attribute) }) }, rowAttribute).catch(() => undefined)
    await page.locator(`[${scopeAttribute}]`).evaluateAll((elements, attribute) => { elements.forEach(element => { element.removeAttribute(attribute) }) }, scopeAttribute).catch(() => undefined)
  }
}

function createPlaywrightSession(browser: Browser, context: BrowserContext, page: Page, executablePath: string): PlaywrightSession {
  return {
    driver: createDriver(page),
    isUsable(): boolean { return browser.isConnected() && !page.isClosed() },
    pickElement: (url?: string, mode?: ElementPickMode, options?: ElementPickOptions) => pickElement(page, url, mode, options),
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
