import { NODE_CATALOG, newId } from '@graph/catalog.ts'
import type { AgentOutputField, ElementLocator, JsonValue, ListRowMatchedAction, LoopConditionClause, NodeOutputs, WorkflowGraph, WorkflowNode, WorkflowLlmConfig } from '@graph/types.ts'
import { asText, walkJsonPath, walkPath } from './bindings.ts'
import { walkGraph, type RunHandlers, type RunState, type StepResult } from './walk.ts'
import { assignVariable, initialContextValues, resolveBindingInContext, resolveExpression, resolveRequestBody, resolveRequestBodyPreview, runtimeInputValues, type WorkflowContext } from './context.ts'
import { expandSubflows } from '@graph/expand-subflows.ts'
import { notificationContentReferences } from '@graph/webhook-body-template.ts'
import { usablePageUrl, workflowNeedsExistingPage } from './page-requirement.ts'
import { runWorkflowCode } from './code-runtime.ts'
import { decodeImageCollectionValue, normalizeImageSources } from './image-source.ts'
import { findSwitchCaseIndex } from '@graph/switch-cases.ts'
import { loopIterationTotal } from './loop.ts'
import { ApiResponseError } from './api-response-error.ts'
import { isPickedDropdownOption, pickedSelectorsTargetSameElement } from '@graph/picked-selector.ts'
import { normalizeImageRecognitionMaxImages } from '@graph/image-recognition-limits.ts'

export interface VisionImageInput {
  readonly dataUrl: string
  readonly label: string
  readonly role: 'input' | 'reference'
}

export interface VisionDifference {
  readonly location: string
  readonly description: string
  readonly evidence: string
}

export interface VisionComparison {
  readonly inputImageIndex: number
  readonly referenceImageIndex: number | null
  readonly comparable: boolean
  readonly reason: string
  readonly differences: readonly VisionDifference[]
}

export interface VisionCaseEvaluation {
  readonly branch: string
  readonly matched: boolean
  readonly confidence: number
  readonly evidence: string
}

export interface VisionImageCaseEvaluation extends VisionCaseEvaluation {
  readonly inputImageIndex: number
  readonly contradicts: boolean
}

export interface VisionRecognitionDecision {
  readonly comparisonStatus: 'completed' | 'partially_comparable' | 'not_comparable'
  readonly comparisonSummary: string
  readonly comparisons: readonly VisionComparison[]
  readonly imageCaseEvaluations: readonly VisionImageCaseEvaluation[]
  readonly caseEvaluations: readonly VisionCaseEvaluation[]
}

export interface ListRowOperationRequest {
  readonly containerSelector: string
  readonly rowSelectorMode: 'css' | 'class-contains'
  readonly rowSelector: string
  readonly matchFields: readonly { readonly selector: string; readonly matchMode: 'exact' | 'contains'; readonly readMode: 'text' | 'value' | 'attribute'; readonly attribute?: string; readonly trim: boolean; readonly ignoreCase: boolean }[]
  readonly items: readonly { readonly index: number; readonly matchValues: readonly string[]; readonly actionValues: readonly string[] }[]
  readonly actions: readonly ({ readonly type: 'type'; readonly selector: string; readonly inputMode: 'replace' | 'append' } | { readonly type: 'click'; readonly selector: string } | { readonly type: 'select'; readonly selector: string })[]
  readonly unmatchedMode: 'keep' | 'delete'
  readonly deleteSelector: string
  readonly confirmSelector: string
  readonly waitAfterDeleteMs: number
  readonly maxDeleteCount: number
  readonly missingMatchAction: 'skip' | 'stop'
  readonly duplicateMatchAction: 'first' | 'all'
  readonly emptySourceAction: 'keep' | 'delete-all' | 'stop'
  readonly timeoutMs: number
  readonly trace?: (message: string) => void
}

export interface ListRowOperationResult {
  readonly totalPageRows: number
  readonly targetDataCount: number
  readonly matchedCount: number
  readonly updatedCount: number
  readonly deletedCount: number
  readonly finalPageRows: number
  readonly missingItems: readonly number[]
  readonly duplicateItems: readonly number[]
  readonly deletedKeys: readonly string[]
}

export interface BrowserDriver {
  openPage(url: string, timeoutMs?: number): Promise<void>
  hover?(selector: string, timeoutMs?: number): Promise<void>
  click(selector: string, timeoutMs?: number): Promise<void>
  selectOption?(selector: string, value: string, timeoutMs?: number): Promise<void>
  type(selector: string, text: string, timeoutMs?: number, inputMode?: 'replace' | 'append'): Promise<void>
  extract(selector: string): Promise<string>
  extractList?(rowSelector: string, fields: readonly { name: string; selector: string; attribute?: string }[]): Promise<readonly Record<string, import('@graph/types.ts').JsonValue>[]>
  extractListAuto?(containerSelector: string): Promise<readonly Record<string, import('@graph/types.ts').JsonValue>[]>
  extractListAi?(containerSelector: string, fields: readonly string[], prompt: string, llm: WorkflowLlmConfig): Promise<readonly Record<string, import('@graph/types.ts').JsonValue>[]>
  generateText?(prompt: string, llm: WorkflowLlmConfig, systemPrompt?: string): Promise<string>
  generateAgent?(task: string, systemPrompt: string, outputs: readonly AgentOutputField[], llm: WorkflowLlmConfig): Promise<Readonly<Record<string, JsonValue>>>
  generateCondition?(content: string, requirement: string, llm: WorkflowLlmConfig): Promise<{ matched: boolean; reason: string }>
  generateSwitch?(content: string, cases: readonly { id: string; name: string; prompt: string }[], systemPrompt: string, llm: WorkflowLlmConfig, supplementalContext?: string): Promise<{ branch: string; reason: string }>
  recognizeImage?(images: readonly VisionImageInput[], instruction: string, cases: readonly { id: string; name: string; prompt: string }[], llm: WorkflowLlmConfig, comparisonPrompt?: string): Promise<VisionRecognitionDecision>
  operateListRows?(request: ListRowOperationRequest): Promise<ListRowOperationResult>
  waitFor(ms: number, selector: string, state?: 'visible' | 'hidden'): Promise<void>
  waitForUrl?(pattern: string, timeoutMs: number): Promise<void>
  elementState?(selector: string): Promise<{ exists: boolean; visible: boolean; text: string }>
  waitForPageSettled?(timeoutMs?: number): Promise<boolean>
  currentUrl?(): string
  onUrlChange?(listener: (url: string) => void): () => void
  currentTitle?(): Promise<string>
  waitForResponse?(config: { urlPattern: string; matchMode: 'contains' | 'equals' | 'regex'; method: string; responseType: 'json' | 'text'; requestParams?: readonly { name: string; value: string }[]; timeoutMs: number }): Promise<{ data: import('@graph/types.ts').JsonValue; url: string; method: string; status: number }>
  requestApi?(config: { url: string; method: string; queryParams?: readonly { name: string; value: string }[]; headers?: readonly { name: string; value: string }[]; body: string; responseType: 'json' | 'text'; timeoutMs: number }): Promise<{ data: import('@graph/types.ts').JsonValue; url: string; status: number }>
}

export interface BrowserRunOptions {
  readonly executionId?: string
  readonly inputs?: Readonly<Record<string, JsonValue>>
  readonly variables?: Readonly<Record<string, JsonValue>>
  readonly outputs?: Readonly<Record<string, NodeOutputs>>
  readonly allowExistingPage?: boolean
  readonly subflows?: readonly WorkflowGraph[]
  readonly stopAfterNodeId?: string
}

const SENSITIVE_LOG_KEY = /password|passwd|pwd|secret|token|authorization|cookie|api[-_]?key|access[-_]?key|session|密码|令牌|密钥|口令|凭证/i

function redactLogValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactLogValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_LOG_KEY.test(key) ? '******' : redactLogValue(item)]))
  }
  return value
}

function formatLogValue(value: JsonValue | string, limit = 3_600): string {
  let formatted: string
  if (typeof value === 'string') {
    try { formatted = JSON.stringify(redactLogValue(JSON.parse(value) as JsonValue), null, 2) }
    catch {
      formatted = value
        .replace(/("(?:password|passwd|pwd|secret|token|authorization|cookie|api[-_]?key|access[-_]?key|session|密码|令牌|密钥|口令|凭证)"\s*:\s*)"[^"]*"/gi, '$1"******"')
        .replace(/((?:password|passwd|pwd|secret|token|api[-_]?key|密码|令牌|密钥|口令|凭证)\s*[:=]\s*)[^\s&,}]+/gi, '$1******')
    }
  } else formatted = JSON.stringify(redactLogValue(value), null, 2)
  formatted = formatted.replace(/data:image\/[^\s"']+;base64,[A-Za-z0-9+/=]+/gi, '[图片内容已隐藏]')
  return formatted.length > limit ? `${formatted.slice(0, limit)}\n…（日志已截断，原始内容共 ${formatted.length} 字符）` : formatted
}

function redactLogUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username) parsed.username = '******'
    if (parsed.password) parsed.password = '******'
    for (const name of parsed.searchParams.keys()) if (SENSITIVE_LOG_KEY.test(name)) parsed.searchParams.set(name, '******')
    return parsed.toString()
  } catch {
    return url.replace(/((?:password|token|secret|api[-_]?key|密码|令牌|密钥)=)[^&#]*/gi, '$1******')
  }
}

function selectorText(selector: string | ElementLocator): string {
  return typeof selector === 'string' ? selector : selector.value
}

function rowTemplateText(value: JsonValue): string {
  if (typeof value === 'string') return value
  if (value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function resolveRowTemplate(template: string, item: JsonValue, index: number, context: WorkflowContext): string {
  const local = template
    .replace(/\{\{\s*item(?:\.([^{}]+))?\s*\}\}/g, (_match, path: string | undefined) => rowTemplateText(path === undefined ? item : walkJsonPath(item, path.trim())))
    .replace(/\{\{\s*(?:rowIndex|itemIndex)\s*\}\}/g, String(index))
  return rowTemplateText(resolveExpression(local, context))
}

function resolveMatchedActionValue(action: ListRowMatchedAction, item: JsonValue, index: number, context: WorkflowContext): string {
  if (action.type === 'click') return ''
  const dataPath = action.dataPath?.trim() ?? ''
  if (dataPath !== '') return rowTemplateText(walkJsonPath(item, dataPath))
  return resolveRowTemplate(action.value, item, index, context)
}

function mergeVisionComparisons(comparisons: readonly VisionComparison[]): VisionComparison[] {
  const merged: VisionComparison[] = []
  const indexByKey = new Map<string, number>()
  for (const item of comparisons) {
    const key = `${item.inputImageIndex}:${item.referenceImageIndex ?? 'none'}`
    const existingIndex = indexByKey.get(key)
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length)
      merged.push(item)
      continue
    }
    const existing = merged[existingIndex]
    if (existing === undefined) continue
    merged[existingIndex] = {
      inputImageIndex: existing.inputImageIndex,
      referenceImageIndex: existing.referenceImageIndex,
      comparable: existing.comparable || item.comparable,
      reason: existing.reason.trim() !== '' ? existing.reason : item.reason,
      differences: [...existing.differences, ...item.differences].slice(0, 20),
    }
  }
  return merged
}

function displaySelector(selector: string): string {
  const scopedTextPrefix = 'text-exact:rpa-context:'
  const encoded = selector.startsWith(scopedTextPrefix)
    ? selector.slice(scopedTextPrefix.length)
    : selector.startsWith('rpa-fingerprint:')
      ? selector.slice('rpa-fingerprint:'.length)
      : undefined
  if (encoded === undefined) return selector
  try {
    const fingerprint = JSON.parse(decodeURIComponent(encoded)) as { css?: unknown; text?: unknown }
    if (selector.startsWith(scopedTextPrefix) && typeof fingerprint.text === 'string') return `text-exact:${fingerprint.text}`
    return typeof fingerprint.css === 'string' ? fingerprint.css : '已拾取元素'
  } catch { return '已拾取元素' }
}

function resolveImageBindingValue(binding: import('@graph/types.ts').ValueBinding, path: string, context: WorkflowContext, label: string): JsonValue {
  const bound = resolveBindingInContext(binding, context)
  const resolved = typeof bound === 'string' ? resolveExpression(bound, context) : bound
  const decoded = decodeImageCollectionValue(resolved)
  if (decoded === null || (typeof decoded === 'string' && decoded.trim() === '')) throw new Error(`${label}为空；请确认运行时输入或来源变量已经传值`)
  const value = walkJsonPath(decoded, path)
  if (value === null && path.trim() !== '') throw new Error(`${label}字段路径「${path}」未读取到值；数组本身不需要填写字段路径`)
  return value
}

export function isEmptyValue(value: import('@graph/types.ts').JsonValue | undefined): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

function isJsonValue(value: unknown): value is import('@graph/types.ts').JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return typeof value === 'object' && value !== null && Object.values(value).every(isJsonValue)
}

function transformExtractValue(value: import('@graph/types.ts').JsonValue, transform: NonNullable<Extract<WorkflowNode['config'], { type: 'extract' }>['transform']>): import('@graph/types.ts').JsonValue {
  const apply = (input: import('@graph/types.ts').JsonValue): import('@graph/types.ts').JsonValue => {
    if (typeof input !== 'string') return input
    if (transform.operation === 'trim') return input.trim()
    if (transform.operation === 'uppercase') return input.toUpperCase()
    if (transform.operation === 'lowercase') return input.toLowerCase()
    if (transform.operation === 'regex') {
      const match = new RegExp(transform.pattern ?? '').exec(input)
      return match?.[1] ?? match?.[0] ?? ''
    }
    if (transform.operation === 'replace') return input.replaceAll(transform.pattern ?? '', transform.replacement ?? '')
    if (transform.operation === 'json-parse') return JSON.parse(input) as import('@graph/types.ts').JsonValue
    return JSON.stringify(input)
  }
  if (Array.isArray(value)) return value.map(item => transformExtractValue(item, transform))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transformExtractValue(item, transform)]))
  return apply(value)
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`超时 ${ms}ms`)) }, ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function attempt(
  node: WorkflowNode,
  work: (trace: (message: string) => void) => Promise<StepResult>,
  driver: BrowserDriver,
  context: WorkflowContext,
  timeoutMs = node.execution.timeoutMs,
): Promise<StepResult> {
  if (driver.currentUrl !== undefined) context.page.url = driver.currentUrl()
  const tries = Math.max(1, node.execution.maxAttempts)
  let last = '执行失败'
  const attemptLogs: string[] = []
  for (let index = 0; index < tries; index += 1) {
    const progress: string[] = []
    let active = true
    const trace = (message: string): void => { if (active) progress.push(message) }
    try {
      const result = await withTimeout(work(trace), timeoutMs)
      active = false
      return { ...result, logs: [...attemptLogs, ...progress, ...(result.logs ?? [])] }
    } catch (error) {
      active = false
      last = error instanceof Error ? error.message : String(error)
      if (node.config.type === 'page-action') last = `页面操作步骤执行失败（${node.config.steps.map((step, stepIndex) => `${stepIndex + 1}.${step.type}`).join(' → ')}）：${last}`
      attemptLogs.push(...progress, `第 ${index + 1}/${tries} 次尝试失败：${last}`)
      const count = Number(context.failures[node.id] ?? 0) + 1
      context.failures[node.id] = count
      context.variables.failureCount = count
      context.variables[`failureCount_${node.id}`] = count
    }
  }
  const waiting = node.execution.onError === 'human-handoff'
  return {
    message: waiting ? `失败，已停下来等人：${last}` : `失败：${last}`,
    logs: attemptLogs,
    halt: 'failed',
    status: waiting ? 'waiting-user' : 'failed',
  }
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error(`${label}不能为空`)
  return trimmed
}

function loopConditionMatches(expression: string, context: WorkflowContext): boolean {
  const source = expression.trim()
  if (source === '') return true
  const evaluate = (part: string): boolean => {
    const match = /^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/.exec(part.trim())
    if (match === null) return Boolean(resolveExpression(part.trim(), context))
    const read = (raw: string): import('@graph/types.ts').JsonValue => {
      const value = raw.trim().replace(/^['"]|['"]$/g, '')
      if (/^\{\{.*\}\}$/.test(raw.trim())) return resolveExpression(raw.trim(), context)
      if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true'
      if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
      return resolveExpression(`{{${value}}}`, context)
    }
    const left = read(match[1]); const right = read(match[3])
    if (match[2] === '>' || match[2] === '<' || match[2] === '>=' || match[2] === '<=') {
      const a = Number(left); const b = Number(right)
      return match[2] === '>' ? a > b : match[2] === '<' ? a < b : match[2] === '>=' ? a >= b : a <= b
    }
    return match[2] === '===' || match[2] === '==' ? left === right : left !== right
  }
  return source.split(/\s+(?:&&|and)\s+/i).every(group => group.split(/\s+(?:\|\||or)\s+/i).some(evaluate))
}

function loopClausesMatch(clauses: readonly LoopConditionClause[], logic: 'and' | 'or', context: WorkflowContext): boolean {
  const results = clauses.map(clause => {
    const raw = resolveBindingInContext(clause.binding, context)
    let actual: import('@graph/types.ts').JsonValue = clause.path?.trim() === '' || clause.path === undefined ? raw : walkJsonPath(raw, clause.path)
    if (clause.transform) {
      const left = Number(actual)
      const right = Number(resolveExpression(clause.transform.value, context))
      if (Number.isFinite(left) && Number.isFinite(right)) {
        actual = clause.transform.operation === 'add' ? left + right
          : clause.transform.operation === 'subtract' ? left - right
            : clause.transform.operation === 'multiply' ? left * right
              : right === 0 ? Number.NaN : left / right
      } else actual = Number.NaN
    }
    const configuredExpected = clause.value ?? ''
    const expected = typeof configuredExpected === 'string' ? resolveExpression(configuredExpected, context) : configuredExpected
    const text = asText(actual)
    if (clause.operator === 'isEmpty') return isEmptyValue(actual)
    if (clause.operator === 'isNotEmpty') return !isEmptyValue(actual)
    if (clause.operator === 'contains') return text.includes(String(expected))
    if (clause.operator === 'greaterThan') return Number(actual) > Number(expected)
    if (clause.operator === 'greaterThanOrEqual') return Number(actual) >= Number(expected)
    if (clause.operator === 'lessThan') return Number(actual) < Number(expected)
    if (clause.operator === 'lessThanOrEqual') return Number(actual) <= Number(expected)
    if (clause.operator === 'notEquals') return actual !== expected && text !== String(expected)
    return actual === expected || text === String(expected)
  })
  return logic === 'or' ? results.some(Boolean) : results.every(Boolean)
}

function loopValues(config: Extract<WorkflowNode['config'], { type: 'for-each' }>, item: import('@graph/types.ts').JsonValue, index: number): Record<string, import('@graph/types.ts').JsonValue> {
  const values: Record<string, import('@graph/types.ts').JsonValue> = {
    item,
    index,
    [config.itemVar.trim() || 'item']: item,
    [config.indexVar.trim() || 'index']: index,
  }
  for (const name of config.declaredVariables ?? []) if (name.trim() !== '') values[name] = walkJsonPath(item, name)
  return values
}

function setLoopVariables(context: WorkflowContext, config: Extract<WorkflowNode['config'], { type: 'for-each' }>, item: import('@graph/types.ts').JsonValue, index: number): void {
  assignVariable(context, config.itemVar.trim() || 'item', item)
  assignVariable(context, config.indexVar.trim() || 'index', index)
  assignVariable(context, 'currentItem', item)
  assignVariable(context, 'currentIndex', index)
  for (const name of config.declaredVariables ?? []) if (name.trim() !== '') assignVariable(context, name, walkJsonPath(item, name))
}

async function liveStep(
  node: WorkflowNode,
  outputs: Readonly<Record<string, NodeOutputs>>,
  driver: BrowserDriver,
  context: WorkflowContext,
  loops: Map<string, { index: number; total: number }>,
): Promise<StepResult> {
  // 页面可能在上一个点击、提交或脚本执行后发生了重定向。
  // 条件节点和变量绑定都应该读取当前页面，而不是上一个节点留下的快照。
  if (driver.currentUrl !== undefined) context.page.url = driver.currentUrl()
  if (node.config.type === 'start') {
    const url = String(resolveExpression(node.config.url, context)).trim()
    if (url === '') return { message: context.page.url ? `沿用当前页面 ${redactLogUrl(context.page.url)}` : '未配置初始 URL，跳过打开浏览器', outputs: { url: context.page.url } }
    await driver.openPage(url)
    context.page.url = url
    return { message: `已打开初始页面 ${redactLogUrl(url)}`, outputs: { url } }
  }
  if (node.config.type === 'call-subflow') {
    const name = /^调用 (.+) v\d+$/.exec(node.name)?.[1] ?? node.config.workflowId
    return { message: `进入子流程「${name}」（ID：${node.config.workflowId}，版本：${node.config.workflowVersion === undefined ? '未指定' : `v${node.config.workflowVersion}`}）` }
  }
  if (node.config.type === 'for-each') {
    const collection = resolveBindingInContext(node.config.collection, context)
    const items = Array.isArray(collection) ? collection : []
    const state = loops.get(node.id) ?? { index: 0, total: loopIterationTotal(node.config, items.length) }
    if (state.index >= state.total) {
      loops.delete(node.id)
      const completedCount = Math.min(state.index, state.total)
      const lastIndex = completedCount > 0 ? completedCount - 1 : 0
      const lastItem = completedCount > 0 ? items[lastIndex] ?? null : null
      setLoopVariables(context, node.config, lastItem, lastIndex)
      const reason = items.length === 0 ? '列表为空' : state.total < items.length ? '达到最大条数' : '列表已处理完'
      return { message: `循环${reason}，共处理 ${completedCount} 项`, branch: 'done', outputs: loopValues(node.config, lastItem, lastIndex) }
    }
    const item = items[state.index] ?? null
    const index = state.index
    // 空名称不应阻断循环执行；使用稳定的默认变量名兜底。
    // 页面操作统一使用 currentItem/currentIndex 引用当前循环上下文。
    setLoopVariables(context, node.config, item, index)
    const condition = node.config.conditionClauses !== undefined && node.config.conditionClauses.length > 0
      ? loopClausesMatch(node.config.conditionClauses, node.config.conditionLogic ?? 'and', context)
      : loopConditionMatches(node.config.condition ?? '', context)
    if (!condition) {
      loops.delete(node.id)
      const completedCount = Math.min(state.index, state.total)
      const lastIndex = completedCount > 0 ? completedCount - 1 : 0
      const lastItem = completedCount > 0 ? items[lastIndex] ?? null : null
      setLoopVariables(context, node.config, lastItem, lastIndex)
      return { message: `循环条件不满足，共处理 ${completedCount} 项`, branch: 'done', outputs: loopValues(node.config, lastItem, lastIndex) }
    }
    loops.set(node.id, { index: index + 1, total: state.total })
    return { message: `开始处理第 ${index + 1}/${state.total} 项`, branch: 'body', outputs: loopValues(node.config, item, index) }
  }
  if (node.config.type === 'end') {
    return { message: `${NODE_CATALOG[node.type].title}` }
  }
  if (node.config.type === 'approval') {
    const timeoutMinutes = Math.max(1, node.config.timeoutMinutes)
    return {
      message: `等待当前执行人审批：${String(resolveExpression(node.config.title, context))}`,
      approval: {
        id: newId('approval'),
        executionId: context.runtime.executionId,
        workflowId: context.runtime.workflowId,
        nodeId: node.id,
        nodeName: node.name,
        title: String(resolveExpression(node.config.title, context)),
        description: String(resolveExpression(node.config.description, context)),
        fields: node.config.fields.map(field => ({ label: field.label, value: field.path?.trim() ? walkJsonPath(resolveBindingInContext(field.value, context), field.path) : resolveBindingInContext(field.value, context) })),
        requireCommentOnReject: node.config.requireCommentOnReject,
        timeoutAt: new Date(Date.now() + timeoutMinutes * 60_000).toISOString(),
        notifications: node.notifications,
      },
    }
  }
  if (node.config.type === 'api-listen') {
    if (driver.waitForResponse === undefined) throw new Error('当前浏览器驱动不支持接口监听')
    const config = node.config
    return attempt(node, async (trace): Promise<StepResult> => {
      trace(`等待接口响应：${config.method}；${config.matchMode} 匹配；超时 ${config.timeoutMs}ms`)
      const response = await driver.waitForResponse!({ urlPattern: String(resolveExpression(config.urlPattern, context)), matchMode: config.matchMode, method: config.method, responseType: config.responseType, requestParams: (config.requestParams ?? []).filter(item => item.name.trim() !== '').map(item => ({ name: item.name, value: String(resolveExpression(item.value, context)) })), timeoutMs: config.timeoutMs })
      const value = config.jsonPath.trim() === '' ? response.data : walkJsonPath(response.data, config.jsonPath)
      const outputName = config.outputName || 'tableData'
      const outputs: Record<string, import('@graph/types.ts').JsonValue> = { [outputName]: value }
      if ((config.rawOutputName ?? 'responseData').trim() !== '') outputs[config.rawOutputName ?? 'responseData'] = response.data
      for (const field of config.fields ?? []) if (field.name.trim() !== '') outputs[field.name] = walkJsonPath(response.data, field.path)
      return { message: `已捕获接口响应并写入 ${outputName}`, logs: [`接口请求：${response.method} ${redactLogUrl(response.url)}`, `接口响应：HTTP ${response.status}`, `接口原始返回：\n${formatLogValue(response.data)}`, config.jsonPath.trim() === '' ? '未配置主 JSON 路径，主变量保留完整响应' : `主变量路径：${config.jsonPath}`, ...(config.fields ?? []).filter(field => field.name.trim() !== '').map(field => `字段变量：${field.name} ← ${field.path}`)], outputs }
    }, driver, context, config.timeoutMs + 1_000)
  }
  if (node.config.type === 'api-request') {
    if (driver.requestApi === undefined) throw new Error('当前浏览器驱动不支持接口请求')
    const config = node.config
    return attempt(node, async (trace): Promise<StepResult> => {
      const resolvePairs = (items: readonly { name: string; value: string }[] | undefined) => (items ?? []).filter(item => item.name.trim() !== '').map(item => ({ name: item.name, value: String(resolveExpression(item.value, context)) }))
      const url = String(resolveExpression(config.url, context))
      const queryParams = resolvePairs(config.queryParams)
      const visibleQuery = queryParams.map(item => ({ name: item.name, value: SENSITIVE_LOG_KEY.test(item.name) ? '******' : item.value }))
      const bodyPreview = resolveRequestBodyPreview(config.body, context)
      const sentBody = !['GET', 'HEAD'].includes(config.method.toUpperCase()) && bodyPreview.trim() !== ''
      trace(`请求接口：${config.method} ${redactLogUrl(url)}`)
      trace(`请求参数（Query）：${visibleQuery.length === 0 ? '（无）' : formatLogValue(JSON.stringify(visibleQuery))}`)
      trace(`请求参数（Body）：${sentBody ? `\n${formatLogValue(bodyPreview, 12_000)}` : '（未发送）'}`)
      const request = { url, method: config.method, queryParams, headers: resolvePairs(config.headers), body: resolveRequestBody(config.body, context), responseType: config.responseType, timeoutMs: config.timeoutMs }
      let response: Awaited<ReturnType<NonNullable<BrowserDriver['requestApi']>>>
      try { response = await driver.requestApi!(request) }
      catch (error) {
        if (error instanceof ApiResponseError) trace(`响应结果：HTTP ${error.status} ${redactLogUrl(error.url)}\n${formatLogValue(error.data, 12_000)}`)
        else trace('响应结果：（未收到接口响应）')
        throw error
      }
      trace(`响应结果：HTTP ${response.status} ${redactLogUrl(response.url)}\n${formatLogValue(response.data, 12_000)}`)
      if (response.status < 200 || response.status >= 300) throw new Error(`接口返回 HTTP ${response.status}`)
      const value = config.jsonPath.trim() === '' ? response.data : walkJsonPath(response.data, config.jsonPath)
      const outputName = config.outputName || 'responseData'
      const result: Record<string, import('@graph/types.ts').JsonValue> = { [outputName]: value }
      const rawOutputName = config.rawOutputName ?? 'rawResponseData'
      if (rawOutputName.trim() !== '') result[rawOutputName] = response.data
      for (const field of config.fields ?? []) if (field.name.trim() !== '') result[field.name] = walkJsonPath(response.data, field.path)
      return { message: `已请求接口并产出 ${Object.keys(result).length} 个变量`, logs: [
        config.jsonPath.trim() === '' ? '主变量保留完整响应' : `主变量路径：${config.jsonPath}`,
        ...(rawOutputName.trim() === '' ? [] : [`原始响应变量：${rawOutputName}`]),
        ...(config.fields ?? []).filter(field => field.name.trim() !== '').map(field => `字段变量：${field.name} ← ${field.path}`),
      ], outputs: result }
    }, driver, context, config.timeoutMs)
  }
  if (node.config.type === 'agent') {
    const outputs = node.config.outputs ?? []
    if (!(node.config.task ?? '').trim() || outputs.length === 0) throw new Error('Agent 结构化配置不完整，请配置任务内容和输出字段')
    const llm = (node.config.llmId !== undefined ? context.llms?.[node.config.llmId] : undefined)
      ?? context.llm
      ?? (context.llms === undefined ? undefined : Object.values(context.llms)[0])
    if (llm === undefined) throw new Error('Agent 节点未找到可用的 AI 配置')
    if (driver.generateAgent === undefined) throw new Error('当前运行器不支持 Agent 结构化模型调用')
    const task = String(resolveExpression(node.config.task, context))
    const systemPrompt = String(resolveExpression(node.config.systemPrompt, context))
    const result = await driver.generateAgent(task, systemPrompt, outputs, llm)
    if (!isJsonValue(result)) throw new Error('Agent 返回了不支持的结构化结果')
    const expected = new Set(outputs.map(field => field.name))
    const missing = outputs.filter(field => !Object.hasOwn(result, field.name)).map(field => field.name)
    const unexpected = Object.keys(result).filter(name => !expected.has(name))
    if (missing.length > 0 || unexpected.length > 0) throw new Error(`Agent 返回字段与配置不一致${missing.length > 0 ? `；缺少：${missing.join('、')}` : ''}${unexpected.length > 0 ? `；多出：${unexpected.join('、')}` : ''}`)
    const structured = Object.fromEntries(outputs.map(field => [field.name, result[field.name]]))
    return { message: `Agent 已生成 ${outputs.length} 个结构化字段`, outputs: structured }
  }
  if (node.config.type === 'image-recognition') {
    const config = node.config
    const llm = (config.llmId !== undefined ? context.llms?.[config.llmId] : undefined)
      ?? context.llm
      ?? (context.llms === undefined ? undefined : Object.values(context.llms)[0])
    if (llm === undefined) throw new Error('图片识别节点未找到可用的视觉 AI 配置')
    if (driver.recognizeImage === undefined) throw new Error('当前运行器不支持图片识别')
    if (config.cases.length === 0 || config.cases.some(item => !item.id.trim() || !item.name.trim() || !item.prompt.trim())) throw new Error('图片识别的每个分支都需要名称和判断要求')
    const maxImages = normalizeImageRecognitionMaxImages(config.maxImages)
    const value = resolveImageBindingValue(config.image, config.path, context, '待识别图片来源')
    const imageSources = await normalizeImageSources(value, { maxCount: maxImages, truncate: true })
    let comparisonSources: Awaited<ReturnType<typeof normalizeImageSources>> = []
    let comparisonNames: readonly string[] = []
    if (config.comparisonEnabled === true) {
      let comparisonValue: JsonValue
      if (config.comparisonSourceMode === 'variable') {
        if (config.comparisonImageSource === undefined) throw new Error('已启用图片对比，请先选择对比图片来源变量')
        comparisonValue = resolveImageBindingValue(config.comparisonImageSource, config.comparisonImagePath ?? '', context, '对比图片来源变量')
      } else {
        const uploaded = config.comparisonImages?.filter(item => item.dataUrl.trim()) ?? []
        const legacy = config.comparisonImage?.trim() ? [{ dataUrl: config.comparisonImage, name: config.comparisonImageName ?? '' }] : []
        const selected = uploaded.length > 0 ? uploaded : legacy
        if (selected.length === 0) throw new Error('已启用图片对比，请先上传至少一张对比图片')
        comparisonValue = selected.map(item => item.dataUrl)
        comparisonNames = selected.map(item => item.name)
      }
      try { comparisonSources = await normalizeImageSources(comparisonValue) }
      catch (error) { throw new Error(`对比图片处理失败：${error instanceof Error ? error.message : String(error)}`) }
    }
    const cases = config.cases.map(item => ({ ...item, prompt: String(resolveExpression(item.prompt, context)) }))
    const images: VisionImageInput[] = [
      ...comparisonSources.map((source, index) => ({ dataUrl: source.dataUrl, label: config.comparisonSourceMode === 'variable' ? `变量参考图 ${index + 1}` : comparisonNames[index]?.trim() || `对比参考图 ${index + 1}`, role: 'reference' as const })),
      ...imageSources.map((source, index) => ({ dataUrl: source.dataUrl, label: `待识别图片 ${index + 1}`, role: 'input' as const })),
    ]
    const comparisonPrompt = config.comparisonEnabled === true
      ? String(resolveExpression(config.comparisonPrompt ?? '', context))
      : undefined
    const decision = await driver.recognizeImage(images, String(resolveExpression(config.instruction, context)), cases, llm, comparisonPrompt)
    const expectedBranches = cases.map(item => `case-${item.id}`)
    const expectedBranchSet = new Set(expectedBranches)
    const evaluationBranches = decision.caseEvaluations.map(item => item.branch)
    const unknownBranch = evaluationBranches.find(branch => !expectedBranchSet.has(branch))
    if (unknownBranch !== undefined) throw new Error(`视觉模型返回了未知场景「${unknownBranch}」`)
    if (new Set(evaluationBranches).size !== evaluationBranches.length) throw new Error('视觉模型重复返回了同一个场景判断')
    const missingBranch = expectedBranches.find(branch => !evaluationBranches.includes(branch))
    if (missingBranch !== undefined) throw new Error(`视觉模型没有判断场景「${missingBranch}」`)
    if (decision.caseEvaluations.length !== cases.length) throw new Error('视觉模型返回的场景判断数量与节点配置不一致')
    const comparisons = mergeVisionComparisons(decision.comparisons)
    const invalidComparison = comparisons.find(item => item.inputImageIndex < 1 || item.inputImageIndex > imageSources.length || item.referenceImageIndex !== null && (item.referenceImageIndex < 1 || item.referenceImageIndex > comparisonSources.length))
    if (invalidComparison !== undefined) throw new Error('视觉模型返回了超出图片数量范围的对比序号')
    if (comparisonSources.length > 0) {
      const comparedInputIndexes = comparisons.map(item => item.inputImageIndex)
      const missingInputIndex = imageSources.findIndex((_source, index) => !comparedInputIndexes.includes(index + 1))
      if (missingInputIndex >= 0) throw new Error(`视觉模型没有返回待识别图片 ${missingInputIndex + 1} 的对比结果`)
      if (comparisons.some(item => item.comparable && item.referenceImageIndex === null)) throw new Error('视觉模型将图片标记为可比较，但没有指定参考图片')
    }
    const expectedImageEvaluationCount = imageSources.length * cases.length
    if (decision.imageCaseEvaluations.length !== expectedImageEvaluationCount) throw new Error(`视觉模型返回的逐图场景判断数量不完整，预期 ${expectedImageEvaluationCount} 条，实际 ${decision.imageCaseEvaluations.length} 条`)
    const imageEvaluationKeys = decision.imageCaseEvaluations.map(item => `${item.inputImageIndex}:${item.branch}`)
    if (new Set(imageEvaluationKeys).size !== imageEvaluationKeys.length) throw new Error('视觉模型重复返回了同一张图片的场景判断')
    const invalidImageEvaluation = decision.imageCaseEvaluations.find(item => item.inputImageIndex < 1 || item.inputImageIndex > imageSources.length || !expectedBranchSet.has(item.branch))
    if (invalidImageEvaluation !== undefined) throw new Error('视觉模型返回了无效的逐图场景判断')
    const missingImageEvaluation = imageSources.flatMap((_source, index) => expectedBranches.map(branchId => `${index + 1}:${branchId}`)).find(key => !imageEvaluationKeys.includes(key))
    if (missingImageEvaluation !== undefined) throw new Error(`视觉模型缺少逐图场景判断「${missingImageEvaluation}」`)
    const inconsistentEvaluation = decision.caseEvaluations.find(item => {
      const related = decision.imageCaseEvaluations.filter(imageEvaluation => imageEvaluation.branch === item.branch)
      return item.matched !== (related.some(imageEvaluation => imageEvaluation.matched) && !related.some(imageEvaluation => imageEvaluation.contradicts))
    })
    if (inconsistentEvaluation !== undefined) throw new Error(`视觉模型的综合判断与逐图判断不一致：「${inconsistentEvaluation.branch}」`)
    const chosen = cases.find(item => decision.caseEvaluations.find(evaluation => evaluation.branch === `case-${item.id}`)?.matched === true)
    const chosenEvaluation = chosen === undefined ? undefined : decision.caseEvaluations.find(item => item.branch === `case-${chosen.id}`)
    const branch = chosen === undefined ? 'else' : `case-${chosen.id}`
    const label = chosen?.name ?? '否则'
    const reason = (chosenEvaluation?.evidence || decision.comparisonSummary).trim().slice(0, 500)
    const outputName = config.outputName.trim() || 'imageResult'
    const result = { branch, label, reason, imageCount: imageSources.length, comparisonEnabled: comparisonSources.length > 0, comparisonImageCount: comparisonSources.length, comparisonStatus: decision.comparisonStatus, comparisonSummary: decision.comparisonSummary, comparisons, imageCaseEvaluations: decision.imageCaseEvaluations, caseEvaluations: decision.caseEvaluations, confidence: chosenEvaluation?.confidence ?? 0 }
    const evaluationLogs = cases.map(item => {
      const evaluation = decision.caseEvaluations.find(candidate => candidate.branch === `case-${item.id}`)
      const matchedImages = decision.imageCaseEvaluations.filter(candidate => candidate.branch === `case-${item.id}` && candidate.matched).map(candidate => candidate.inputImageIndex)
      return `场景判断「${item.name}」：${evaluation?.matched === true ? `命中（图片 ${matchedImages.join('、')}）` : '不命中'}（置信度 ${Math.round((evaluation?.confidence ?? 0) * 100)}%）`
    })
    return { message: `已综合识别 ${imageSources.length} 张图片，进入「${label}」${reason ? `：${reason}` : ''}`, branch, outputs: { [outputName]: result }, logs: [`本节点最多识别 ${maxImages} 张待识别图片`, ...evaluationLogs, `图片识别实际分支：${branch}`] }
  }
  if (node.config.type === 'condition') {
    const check = async (): Promise<{ matched: boolean; message: string }> => {
      if (driver.currentUrl !== undefined) context.page.url = driver.currentUrl()
      if (node.config.mode === 'ai') {
        const llm = (node.config.llmId !== undefined ? context.llms?.[node.config.llmId] : undefined)
          ?? context.llm
          ?? (context.llms === undefined ? undefined : Object.values(context.llms)[0])
        if (llm === undefined) throw new Error('AI 条件节点未找到可用的 AI 配置')
        if (driver.generateCondition === undefined) throw new Error('当前运行器不支持 AI 条件结构化判断')
        const value = walkJsonPath(resolveBindingInContext(node.config.left, context), node.config.path)
        const content = typeof value === 'string' ? value : JSON.stringify(value)
        const prompt = String(resolveExpression(node.config.aiPrompt ?? '', context))
        if (prompt.trim() === '') throw new Error('AI 条件节点需要填写判断提示词')
        const decision = await driver.generateCondition(content, prompt, llm)
        const reason = decision.reason.trim()
        return {
          matched: decision.matched,
          message: `AI 判断${decision.matched ? '满足' : '不满足'}条件${reason === '' ? '' : `：${reason}`}`,
        }
      }
      if (node.config.clauses !== undefined && node.config.clauses.length > 0 && node.config.mode !== 'url' && node.config.mode !== 'element') {
        const results = node.config.clauses.map(clause => {
          const actual = walkJsonPath(resolveBindingInContext(clause.binding, context), clause.path ?? '')
          const expected = clause.value ?? ''
          if (clause.operator === 'isEmpty') return isEmptyValue(actual)
          if (clause.operator === 'isNotEmpty') return !isEmptyValue(actual)
          if (clause.operator === 'contains') return asText(actual).includes(String(expected))
          if (clause.operator === 'notEquals') return typeof expected === 'boolean' ? actual !== expected : actual !== expected && asText(actual) !== String(expected)
          if (clause.operator === 'greaterThan') return Number(asText(actual)) > Number(expected)
          if (clause.operator === 'lessThan') return Number(asText(actual)) < Number(expected)
          return typeof expected === 'boolean' ? actual === expected : actual === expected || asText(actual) === String(expected)
        })
        const matched = node.config.logic === 'or' ? results.some(Boolean) : results.every(Boolean)
        return { matched, message: matched ? '多条件判断满足' : '多条件判断不满足' }
      }
      if (node.config.mode === 'url') {
        const url = driver.currentUrl?.() ?? context.page.url
        const matched = node.config.operator === 'contains' ? url.includes(node.config.equals) : url === node.config.equals
        return { matched, message: matched ? `URL 条件满足：${url}` : `URL 条件不满足：${url}` }
      }
      if (node.config.mode === 'element') {
        if (driver.elementState === undefined) throw new Error('当前浏览器驱动不支持元素判断')
        const state = await driver.elementState(String(resolveExpression(selectorText(node.config.selector ?? ''), context)))
        const matched = node.config.operator === 'visible' ? state.visible : state.exists
        return { matched, message: matched ? '页面元素条件满足' : '页面元素条件不满足' }
      }
      const value = walkPath(resolveBindingInContext(node.config.left, context), node.config.path)
      const matched = value === node.config.equals
      return { matched, message: matched ? `条件满足（${value}）` : `条件不满足（${value}）` }
    }
    let result = await check()
    if (!result.matched && node.config.waitForCondition === true) {
      const timeout = Math.max(0, node.config.waitTimeoutMs ?? 10000)
      const interval = Math.max(50, node.config.pollIntervalMs ?? 500)
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        await new Promise(resolve => { setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))) })
        result = await check()
        if (result.matched) break
      }
      if (!result.matched) result = { ...result, message: `${result.message}（等待 ${timeout}ms 后超时）` }
    }
    const branch = result.matched ? 'matched' : 'else'
    return { message: `${result.message}，将进入「${branch}」分支`, branch, logs: [`条件节点实际分支：${branch}`] }
  }
  if (node.config.type === 'switch') {
    const config = node.config
    const value = walkJsonPath(resolveBindingInContext(config.left, context), config.path)
    if (config.mode === 'ai') {
      const llm = (config.llmId !== undefined ? context.llms?.[config.llmId] : undefined)
        ?? context.llm
        ?? (context.llms === undefined ? undefined : Object.values(context.llms)[0])
      if (llm === undefined) throw new Error('多路判断未找到可用的 AI 配置')
      if (driver.generateSwitch === undefined) throw new Error('当前运行器不支持 AI 场景结构化判断')
      const cases = config.cases.map((name, index) => ({ id: `case-${index}`, name, prompt: String(resolveExpression(config.casePrompts?.[index] ?? '', context)) }))
      if (cases.length === 0 || cases.some(item => item.prompt.trim() === '')) throw new Error('AI 多路判断的每个分支都需要填写场景提示词')
      const data = typeof value === 'string' ? value : JSON.stringify(value)
      const resolvedSupplementalContext = resolveExpression(config.aiContext ?? '', context)
      const supplementalContext = typeof resolvedSupplementalContext === 'string'
        ? resolvedSupplementalContext
        : JSON.stringify(resolvedSupplementalContext, null, 2)
      const decision = await driver.generateSwitch(data, cases, String(resolveExpression(config.aiSystemPrompt ?? '', context)), llm, supplementalContext)
      const chosen = cases.find(item => item.id === decision.branch)
      if (chosen === undefined && decision.branch !== 'else') throw new Error(`AI 多路判断返回了未知分支「${decision.branch}」`)
      const reason = decision.reason.trim().slice(0, 500)
      const reasonOutputName = config.reasonOutputName?.trim() || 'reason'
      return { message: chosen === undefined ? `AI 判断进入「否则」${reason ? `：${reason}` : ''}` : `AI 判断进入「${chosen.name}」${reason ? `：${reason}` : ''}`, branch: chosen?.id ?? 'else', outputs: { [reasonOutputName]: reason }, logs: [`AI 场景判断结果：${chosen?.name ?? '否则'}`, `判断依据已写入变量：${reasonOutputName}`] }
    }
    const index = findSwitchCaseIndex(config, value)
    return { message: index >= 0 ? `走分支 ${index + 1}（${value}）` : `走否则分支（${value}）`, branch: index >= 0 ? `case-${index}` : 'else' }
  }
  if (node.config.type === 'list-row-action') {
    const config = node.config
    return attempt(node, async (trace): Promise<StepResult> => {
      if (driver.operateListRows === undefined) throw new Error('当前浏览器驱动不支持列表行操作')
      const bound = resolveBindingInContext(config.source, context)
      const source = config.sourcePath.trim() === '' ? bound : walkJsonPath(bound, config.sourcePath)
      if (!Array.isArray(source)) throw new Error('目标数据必须是数组；请检查数据源和字段路径')
      const items = source.map((item, index) => ({
        index,
        matchValues: config.matchFields.map(field => rowTemplateText(walkJsonPath(item, field.dataPath))),
        actionValues: config.matchedActions.map(action => resolveMatchedActionValue(action, item, index, context)),
      }))
      const classContainsSelector = (value: string): string => {
        const normalized = value.trim()
        const selectorMatch = normalized.match(/^\[class\*=(["'])(.*?)\1\]$/)
        const classValue = selectorMatch?.[2] ?? normalized
        const boundaryValue = classValue.includes('__') && !classValue.includes('--') ? `${classValue}--` : classValue
        return `[class*=${JSON.stringify(boundaryValue)}]`
      }
      trace(`准备同步列表：目标数据 ${items.length} 条；匹配字段 ${config.matchFields.length} 个；匹配后操作 ${config.matchedActions.length} 个`)
      trace(`列表作用域：容器=${config.containerSelector?.trim() || '整个页面'}；行规则=${config.rowSelectorMode === 'class-contains' ? `class 包含「${config.rowSelector}」` : config.rowSelector}`)
      config.matchFields.forEach((field, index) => { trace(`匹配字段 ${index + 1}：页面=${field.selectorMode === 'class-contains' ? `class 包含「${field.rowSelector}」` : field.rowSelector}；数据路径=${field.dataPath}；匹配=${field.matchMode === 'contains' ? '包含' : '完全匹配'}；读取=${field.readMode}`) })
      config.matchedActions.forEach((action, index) => { trace(`匹配后操作 ${index + 1}：${action.type}；行内目标=${action.selector}${action.type !== 'click' && action.dataPath?.trim() ? `；数据字段=${action.dataPath.trim()}` : ''}`) })
      trace(`异常策略：缺失=${config.missingMatchAction}；重复=${config.duplicateMatchAction}；空数据=${config.emptySourceAction}；未匹配页面行=${config.unmatchedMode}`)
      const result = await driver.operateListRows({
        containerSelector: String(resolveExpression(config.containerSelector ?? '', context)),
        rowSelectorMode: config.rowSelectorMode === 'class-contains' ? 'class-contains' : 'css',
        rowSelector: requireText(String(resolveExpression(config.rowSelector, context)), '行选择器'),
        matchFields: config.matchFields.map(field => {
          const selectorValue = String(resolveExpression(field.rowSelector, context))
          return { selector: field.selectorMode === 'class-contains' ? classContainsSelector(selectorValue) : selectorValue, matchMode: field.matchMode === 'contains' ? 'contains' : 'exact', readMode: field.readMode, attribute: field.attribute, trim: field.trim !== false, ignoreCase: field.ignoreCase === true }
        }),
        items,
        actions: config.matchedActions.map(action => action.type === 'type' ? { type: 'type', selector: String(resolveExpression(action.selector, context)), inputMode: action.inputMode ?? 'replace' } : action.type === 'select' ? { type: 'select', selector: String(resolveExpression(action.selector, context)) } : { type: 'click', selector: String(resolveExpression(action.selector, context)) }),
        unmatchedMode: config.unmatchedMode,
        deleteSelector: String(resolveExpression(config.deleteSelector, context)),
        confirmSelector: String(resolveExpression(config.confirmSelector ?? '', context)),
        waitAfterDeleteMs: config.waitAfterDeleteMs,
        maxDeleteCount: config.maxDeleteCount,
        missingMatchAction: config.missingMatchAction,
        duplicateMatchAction: config.duplicateMatchAction,
        emptySourceAction: config.emptySourceAction,
        timeoutMs: node.execution.timeoutMs,
        trace,
      })
      trace(`列表行操作完成：匹配 ${result.matchedCount} 行，更新 ${result.updatedCount} 行，删除 ${result.deletedCount} 行，剩余 ${result.finalPageRows} 行`)
      return { message: `列表行操作完成：更新 ${result.updatedCount} 行，删除 ${result.deletedCount} 行`, outputs: { [config.outputName || 'listOperationResult']: result as unknown as JsonValue } }
    }, driver, context, Math.max(node.execution.timeoutMs, node.execution.timeoutMs * Math.max(1, config.matchedActions.length + config.maxDeleteCount)))
  }
  if (node.config.type === 'page-action') {
    const config = node.config
    return attempt(node, async (trace): Promise<StepResult> => {
      const result: Record<string, import('@graph/types.ts').JsonValue> = {}
      let lastOpenedUrl = ''
      for (const [stepIndex, step] of config.steps.entries()) {
        trace(`页面步骤 ${stepIndex + 1}/${config.steps.length} 开始：${step.type}`)
        try {
          const previousStep = config.steps[stepIndex - 1]
          const nextStep = config.steps[stepIndex + 1]
          const duplicatedDropdownTrigger = step.type === 'click'
            && previousStep?.type === 'click'
            && nextStep?.type === 'click'
            && pickedSelectorsTargetSameElement(selectorText(previousStep.selector), selectorText(step.selector))
            && isPickedDropdownOption(selectorText(nextStep.selector))
          if (duplicatedDropdownTrigger) {
            trace(`页面步骤 ${stepIndex + 1}/${config.steps.length} 跳过：下拉框已由前一步展开`)
            continue
          }
          if (step.type === 'open') {
            lastOpenedUrl = String(resolveExpression(step.url, context)).trim()
            if (lastOpenedUrl === '') throw new Error('打开网址为空；请检查 URL 字段和其中引用的变量')
            await driver.openPage(lastOpenedUrl, node.execution.timeoutMs)
          }
          if (step.type === 'hover') await driver.hover?.(String(resolveExpression(selectorText(step.selector), context)), node.execution.timeoutMs)
          if (step.type === 'wait') await driver.waitFor(step.ms, String(resolveExpression(selectorText(step.selector ?? ''), context)))
          if (step.type === 'click') {
            if (step.beforeHover) await driver.hover?.(String(resolveExpression(selectorText(step.beforeHover), context)), node.execution.timeoutMs)
            if (step.waitForVisible) await driver.waitFor(node.execution.timeoutMs, String(resolveExpression(selectorText(step.waitForVisible), context)))
            const target = String(resolveExpression(selectorText(step.selector), context))
            if (step.optionValue !== undefined && driver.selectOption !== undefined) await driver.selectOption(target, String(resolveExpression(step.optionValue, context)), node.execution.timeoutMs)
            else await driver.click(target, node.execution.timeoutMs)
          }
          if (step.type === 'type') {
            let text: string
            if (step.ai?.enabled === true) {
              const llm = (step.ai.llmId !== undefined ? context.llms?.[step.ai.llmId] : undefined)
                ?? context.llm
                ?? (context.llms === undefined ? undefined : Object.values(context.llms)[0])
              if (step.ai.prompt.trim() === '') throw new Error('AI 生成内容的提示词不能为空')
              if (llm === undefined) throw new Error('AI 生成内容未找到可用的 AI 配置')
              if (driver.generateText === undefined) throw new Error('当前浏览器驱动不支持 AI 文本生成')
              text = await driver.generateText(String(resolveExpression(step.ai.prompt, context)), llm)
            } else {
              const bound = resolveBindingInContext(step.value, context)
              text = asText(resolveExpression(asText(bound), context))
            }
            const inputMode = step.inputMode ?? 'replace'
            trace(`页面步骤 ${stepIndex + 1}/${config.steps.length} 输入方式：${inputMode === 'append' ? '拼接到原内容后面' : '替换原内容'}`)
            await driver.type(String(resolveExpression(selectorText(step.selector), context)), text, node.execution.timeoutMs, inputMode)
          }
          if (step.type === 'extract') {
            const selectedLlm = step.ai?.llmId !== undefined ? context.llms?.[step.ai.llmId] : context.llm
            if (step.ai?.enabled === true) {
              if (step.ai.fields.length === 0) throw new Error(`页面操作抽取「${step.outputName}」未配置 AI 字段`)
              if (driver.extractListAi === undefined || selectedLlm === undefined) throw new Error(`页面操作抽取「${step.outputName}」未找到 AI 配置`)
              result[step.outputName] = await driver.extractListAi(String(resolveExpression(selectorText(step.selector), context)), step.ai.fields, step.ai.prompt ?? '', selectedLlm)
            } else result[step.outputName] = await driver.extract(String(resolveExpression(selectorText(step.selector), context)))
          }
          if ((step.waitAfterMs ?? 0) > 0) await driver.waitFor(step.waitAfterMs ?? 0, '')
          if (driver.currentUrl !== undefined) context.page.url = driver.currentUrl()
          trace(`页面步骤 ${stepIndex + 1}/${config.steps.length} 完成：${step.type}`)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          const pageUrl = driver.currentUrl?.() ?? ''
          const navigation = lastOpenedUrl === '' ? '' : `；请求打开：${redactLogUrl(lastOpenedUrl)}；浏览器当前地址：${pageUrl ? redactLogUrl(pageUrl) : '(空)'} `
          throw new Error(`第 ${stepIndex + 1} 步 ${step.type} 失败：${reason}${navigation}`)
        }
      }
      return { message: `已完成 ${config.steps.length} 个页面操作`, outputs: Object.keys(result).length > 0 ? result : undefined }
    }, driver, context, Math.max(node.execution.timeoutMs, node.execution.timeoutMs * config.steps.length))
  }
  return attempt(node, async (trace): Promise<StepResult> => {
    const config = node.config
    if (config.type === 'open-page') {
      const url = requireText(String(resolveExpression(config.url, context)), 'URL')
      trace(`准备打开页面：${redactLogUrl(url)}`)
      await driver.openPage(url)
      return { message: `已打开 ${redactLogUrl(url)}`, outputs: { url } satisfies NodeOutputs }
    }
    if (config.type === 'click') {
      const selector = requireText(String(resolveExpression(selectorText(config.selector), context)), '选择器')
      trace(`准备点击元素：选择器已解析（${selector.length} 字）`)
      const hover = String(resolveExpression(selectorText(config.beforeHover ?? ''), context))
      if (hover.trim() !== '') {
        if (driver.hover === undefined) throw new Error('当前浏览器驱动不支持 Hover')
        await driver.hover(hover)
      }
      const waitVisible = String(resolveExpression(selectorText(config.waitForVisible ?? ''), context))
      if (waitVisible.trim() !== '') await driver.waitFor(node.execution.timeoutMs, waitVisible)
      await driver.click(selector)
      return { message: `已点击 ${displaySelector(selector)}` }
    }
    if (config.type === 'type') {
      const selector = requireText(String(resolveExpression(selectorText(config.selector), context)), '选择器')
      const text = walkPath(resolveExpression(String(resolveBindingInContext(config.text, context)), context), config.path)
      trace(`准备输入：选择器已解析（${selector.length} 字）；内容 ${String(text).length} 字（内容不记录）`)
      await driver.type(selector, text)
      return { message: `已向元素输入 ${String(text).length} 字（内容不记录）` }
    }
    if (config.type === 'set-variable') {
      const bound = resolveBindingInContext(config.value, context)
      const raw = typeof bound === 'string' && (config.value.kind === 'literal' || config.interpolate === true) ? resolveExpression(bound, context) : bound
      let value = config.path.trim() === '' ? raw : walkPath(raw, config.path)
      if (config.requiredInput !== undefined) {
        const empty = isEmptyValue(value)
        const type = config.requiredInput.type
        // Account identifiers are often entered or produced as numbers even
        // when a subflow declares them as strings. Normalize them at the
        // boundary so downstream nodes consistently receive a string.
        if (type === 'string' && typeof value === 'number' && Number.isFinite(value)) value = String(value)
        // Conversely, runtime text inputs may contain only digits while the
        // subflow declares the input as numeric. Coerce only valid finite
        // numeric text; arbitrary strings still fail the declared type check.
        if (type === 'number' && typeof value === 'string' && value.trim() !== '') {
          const numericValue = Number(value)
          if (Number.isFinite(numericValue)) value = numericValue
        }
        const typeMatches = type === 'array' ? Array.isArray(value)
          : type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
            : typeof value === type
        if ((empty && type === 'string') || (value === null && type !== 'object') || !typeMatches) {
          throw new Error(`子流程必填输入「${config.requiredInput.name}」需要${type}类型的值`)
        }
      }
      assignVariable(context, config.name, value)
      return { message: `已设置变量 ${config.name}`, logs: [`变量值概要：${config.name} = ${value === null ? 'null' : Array.isArray(value) ? `数组(${value.length}项)` : typeof value === 'object' ? `对象(${Object.keys(value).length}字段)` : typeof value === 'string' ? `文本(${value.length}字)` : typeof value}（具体值不记录）`] }
    }
    if (config.type === 'transform') {
      const input = resolveBindingInContext(config.input, context)
      const text = typeof input === 'string' ? input : JSON.stringify(input)
      const pattern = String(resolveExpression(config.pattern, context))
      const replacement = String(resolveExpression(config.replacement, context))
      let result: unknown = text
      if (config.operation === 'trim') result = text.trim()
      if (config.operation === 'uppercase') result = text.toUpperCase()
      if (config.operation === 'lowercase') result = text.toLowerCase()
      if (config.operation === 'regex') {
        const match = new RegExp(pattern).exec(text)
        result = match?.[1] ?? match?.[0] ?? ''
      }
      if (config.operation === 'replace') result = text.replaceAll(pattern, replacement)
      if (config.operation === 'json-parse') result = JSON.parse(text) as unknown
      if (config.operation === 'json-stringify') result = JSON.stringify(input)
      if (!isJsonValue(result)) throw new Error('转换结果不是有效 JSON 值')
      return { message: `已完成${config.operation}转换`, outputs: { [config.outputName || 'result']: result } }
    }
    if (config.type === 'code') {
      const input: Record<string, import('@graph/types.ts').JsonValue> = {}
      for (const item of config.inputs ?? []) if (item.name.trim() !== '') input[item.name] = resolveBindingInContext(item.binding, context)
      if ((config.inputs ?? []).length === 0) input.value = resolveBindingInContext(config.input, context)
      const raw = runWorkflowCode(config.code, input, context.variables, node.execution.timeoutMs)
      const declared = config.outputs ?? []
      const rawObject = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Readonly<Record<string, import('@graph/types.ts').JsonValue>> : undefined
      const result: Readonly<Record<string, import('@graph/types.ts').JsonValue>> = declared.length === 0 && config.outputs === undefined
        ? { [config.outputName || 'result']: raw }
        : (rawObject === undefined ? (() => { throw new Error('代码必须返回对象，并包含已声明的输出字段') })() : declared.length === 0 ? rawObject : Object.fromEntries(declared.map(item => {
          if (!item.name.trim()) throw new Error('请为代码输出填写变量名')
          if (!(item.name in rawObject)) throw new Error(`代码未返回已声明变量「${item.name}」`)
          const value = rawObject[item.name]
          const matches = item.valueType === undefined || item.valueType === 'any' || (item.valueType === 'array' ? Array.isArray(value) : item.valueType === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value) : typeof value === item.valueType)
          if (!matches) throw new Error(`代码输出「${item.name}」不是声明的${item.valueType}类型`)
          return [item.name, value]
        })))
      return { message: '代码执行完成', outputs: result }
    }
    if (config.type === 'extract') {
      if (config.mode === 'list') {
        const container = requireText(String(resolveExpression(config.rowSelector ?? '', context)), '列表容器')
        const selectedLlm = (config.ai?.llmId !== undefined ? context.llms?.[config.ai.llmId] : undefined)
          ?? context.llm
          ?? (context.llms === undefined ? undefined : Object.values(context.llms)[0])
        let rows: readonly Record<string, import('@graph/types.ts').JsonValue>[]
        if (config.ai?.enabled) {
          if (config.ai.fields.length === 0) throw new Error('AI 抽取至少需要配置一个输出字段')
          if (driver.extractListAi === undefined || selectedLlm === undefined) throw new Error('AI 抽取未找到可用的 AI 配置，请先在 AI 配置面板中添加配置')
          if (!selectedLlm.enabled) throw new Error(`AI 配置「${selectedLlm.name}」未启用，请先打开“启用全局 AI”`)
          rows = await driver.extractListAi(container, config.ai.fields, config.ai.prompt ?? '', selectedLlm)
        } else {
          const resolvedFields = (config.fields ?? []).map(field => ({ ...field, selector: String(resolveExpression(field.selector, context)), attribute: field.attribute === undefined ? undefined : String(resolveExpression(field.attribute, context)) }))
          rows = resolvedFields.length > 0 && driver.extractList !== undefined
            ? await driver.extractList(container, resolvedFields)
            : driver.extractListAuto !== undefined ? await driver.extractListAuto(container) : []
        }
        const result = config.transform === undefined ? rows : transformExtractValue(rows, config.transform)
        return { message: `已抽取 ${rows.length} 条列表数据${config.ai?.enabled ? '（AI）' : ''}${config.transform === undefined ? '' : '并完成转换'}`, outputs: { [config.outputName || 'items']: result } satisfies NodeOutputs }
      }
      const selector = requireText(String(resolveExpression(selectorText(config.selector), context)), '选择器')
      const text = await driver.extract(selector)
      const result = config.transform === undefined ? text : transformExtractValue(text, config.transform)
      return { message: `抽取 ${displaySelector(selector)}${config.transform === undefined ? '' : '并完成转换'}`, outputs: { [config.outputName || 'text']: result } satisfies NodeOutputs }
    }
    if (config.type === 'wait') {
      const selector = String(resolveExpression(selectorText(config.selector), context))
      const mode = config.mode ?? (selector.trim() ? 'visible' : 'duration')
      const startedAt = Date.now()
      if (mode === 'duration') await driver.waitFor(config.ms, '')
      else {
        const target = requireText(selector, '等待元素选择器')
        await driver.waitFor(config.ms, target, mode)
      }
      const elapsed = Date.now() - startedAt
      if (mode === 'duration') return { message: `已等待 ${config.ms}ms` }
      return { message: `元素已${mode === 'visible' ? '出现' : '消失'}：${displaySelector(selector)}（等待 ${elapsed}ms）` }
    }
    return { message: `${NODE_CATALOG[node.type].title}` }
  }, driver, context)
}

/**
 * Walk the graph and drive a real browser through the injected driver.
 * @param graph - current editor graph.
 * @param driver - page actions.
 * @param handlers - UI progress hooks.
 */
export async function runBrowser(
  graph: WorkflowGraph,
  driver: BrowserDriver,
  handlers: RunHandlers,
  options: BrowserRunOptions = {},
): Promise<RunState> {
  const runnableGraph = expandSubflows(graph, options.subflows ?? [])
  const entry = graph.nodes.find(node => node.id === graph.entryNodeId)
  const stopAtEmptyStart = options.stopAfterNodeId === graph.entryNodeId && entry?.config.type === 'start' && entry.config.url.trim() === ''
  if (!stopAtEmptyStart && workflowNeedsExistingPage([runnableGraph]) && (!options.allowExistingPage || (driver.currentUrl !== undefined && !usablePageUrl(driver.currentUrl())))) {
    throw new Error('流程和子流程都没有配置开始 URL，且没有可沿用的浏览器页面；请先打开目标页面，或在开始节点填写初始 URL。')
  }
  const context: WorkflowContext = {
    inputs: runtimeInputValues(runnableGraph.context?.inputs, options.inputs),
    variables: { ...initialContextValues(runnableGraph.context?.variables), ...options.variables },
    failures: {},
    successes: {},
    outputs: { ...options.outputs },
    page: { url: options.allowExistingPage ? driver.currentUrl?.() ?? '' : '' },
    runtime: { executionId: options.executionId ?? `local-${Date.now()}`, workflowId: graph.workflowId },
    llm: runnableGraph.llm,
    llms: Object.fromEntries((runnableGraph.llms ?? (runnableGraph.llm === undefined ? [] : [runnableGraph.llm])).map(item => [item.id, item])),
  }
  const notificationValuesFor = (nodeId: string, event?: NonNullable<import('./walk.ts').RunLogLine['notificationEvent']>): Record<string, import('@graph/types.ts').JsonValue> => {
    const node = runnableGraph.nodes.find(item => item.id === nodeId)
    const marker = nodeId.split('::').at(-2)
    const owner = marker === undefined ? undefined : options.subflows?.find(item => `${item.workflowId.replace(/[^A-Za-z0-9_]/g, '_')}_v${item.version}` === marker)
    const defaultTemplate = owner?.webhook?.messageTemplate || runnableGraph.webhook?.messageTemplate || ''
    const templateFor = (trigger: import('@graph/types.ts').NodeNotificationTrigger): string => {
      const statusTemplate = node?.notifications?.messageTemplates?.[trigger]
      return (statusTemplate === undefined ? node?.notifications?.messageTemplate : statusTemplate)?.trim() || defaultTemplate
    }
    const template = event === undefined
      ? (['onApprovalPending', 'onApprovalApproved', 'onApprovalRejected', 'onApprovalTimeout'] as const)
          .filter(trigger => node?.notifications?.[trigger] === true)
          .map(templateFor)
          .join('\n')
      : templateFor(event === 'node.succeeded' ? 'onSuccess' : 'onFailure')
    const values: Record<string, import('@graph/types.ts').JsonValue> = {}
    let totalLength = 0
    for (const path of notificationContentReferences(template)) {
      if (path === 'event' || path.startsWith('event.') || path in values) continue
      const inputName = path.startsWith('inputs.') ? path.slice(7).split(/[.\[]/, 1)[0] : ''
      const variableName = (path.startsWith('variables.') ? path.slice(10) : path).split(/[.\[]/, 1)[0]
      if (runnableGraph.context?.inputs?.some(item => item.secret && item.name === inputName)) continue
      if (runnableGraph.context?.variables?.some(item => item.secret && item.name === variableName)) continue
      if (/(?:password|secret|token|cookie|authorization|api[_-]?key)/i.test(path)) continue
      const value = resolveExpression(`{{${path}}}`, context)
      const size = JSON.stringify(value).length
      if (size > 4_096 || totalLength + size > 16_384) continue
      values[path] = value
      totalLength += size
    }
    return values
  }
  let latestState: RunState | undefined
  const stopUrlListener = driver.onUrlChange?.(url => {
    context.page.url = url
    if (latestState !== undefined) handlers.onUpdate({ ...latestState, page: { ...context.page } })
  })
  const loops = new Map<string, { index: number; total: number }>()
  const state = await walkGraph(runnableGraph, {
    ...handlers,
    onUpdate: next => {
      Object.assign(context.outputs, next.outputs)
      const logs = next.logs.map(log => log.notificationEvent ? { ...log, notificationValues: notificationValuesFor(log.nodeId, log.notificationEvent) } : log)
      latestState = { ...next, logs, inputs: { ...context.inputs }, variables: { ...context.variables }, page: { ...context.page } }
      handlers.onUpdate(latestState)
    },
    requestApproval: handlers.requestApproval === undefined ? undefined : prompt => handlers.requestApproval!({ ...prompt, notificationValues: notificationValuesFor(prompt.nodeId) }),
  }, async (node, outputs) => {
    const beforeUrl = context.page.url
    const result = await liveStep(node, { ...options.outputs, ...outputs }, driver, context, loops)
    if (driver.currentUrl !== undefined) context.page.url = driver.currentUrl()
    // The page title is diagnostic metadata. A tab closing during this read
    // must not turn an otherwise successful node into a page.title failure.
    if (driver.currentTitle !== undefined) {
      try { context.page.title = await driver.currentTitle() }
      catch { context.page.title = undefined }
    }
    // 节点产出同时注册为流程变量，条件节点和后续页面操作可以直接使用 {{tableData}}、{{authToken}}。
    if (result.outputs !== undefined) {
      const updateTargets = new Map<string, string>()
      const config = node.config
      if (config.type === 'api-request' || config.type === 'api-listen' || config.type === 'extract' || config.type === 'transform' || config.type === 'code' || config.type === 'agent' || config.type === 'image-recognition') {
        if (config.type === 'agent') {
          for (const item of config.outputs ?? []) if ((item.outputMode === 'update' || item.outputMode === 'declare') && item.updateVariable?.trim()) updateTargets.set(item.name, item.updateVariable)
        } else if ((config.outputMode === 'update' || config.outputMode === 'declare') && config.updateVariable?.trim()) updateTargets.set(config.outputName, config.updateVariable)
        if (config.type === 'code') for (const item of config.outputs ?? []) if ((item.outputMode === 'update' || item.outputMode === 'declare') && item.updateVariable?.trim()) updateTargets.set(item.name, item.updateVariable)
      } else if (config.type === 'page-action') {
        for (const step of config.steps) if (step.type === 'extract' && (step.outputMode === 'update' || step.outputMode === 'declare') && step.updateVariable?.trim()) updateTargets.set(step.outputName, step.updateVariable)
      }
      for (const [name, value] of Object.entries(result.outputs)) {
        const target = updateTargets.get(name)
        if (target !== undefined) assignVariable(context, target, value)
        else if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) assignVariable(context, name, value)
      }
    }
    if (result.halt !== 'failed' && result.status !== 'failed' && result.status !== 'waiting-user') {
      const count = Number(context.successes[node.id] ?? 0) + 1
      context.successes[node.id] = count
      context.variables.successCount = count
      context.variables[`successCount_${node.id}`] = count
    }
    const logs: string[] = [...(result.logs ?? [])]
    if (beforeUrl !== context.page.url) {
      logs.push(`页面 URL 已更新：${beforeUrl ? redactLogUrl(beforeUrl) : '(空)'} → ${redactLogUrl(context.page.url)}`)
    }
    return logs.length === 0 ? result : { ...result, logs }
  }, { stopAfterNodeId: options.stopAfterNodeId })
  stopUrlListener?.()
  return { ...state, logs: latestState?.logs ?? state.logs, inputs: { ...context.inputs }, variables: { ...context.variables }, page: { ...context.page } }
}
