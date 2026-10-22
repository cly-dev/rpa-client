import { NODE_CATALOG } from './catalog.ts'
import type { ValidationIssue, ValueBinding, WorkflowGraph } from './types.ts'
import { switchCaseType, switchCaseValue } from './switch-cases.ts'
import { subflowInputTypeWarning } from './subflow-input-types.ts'
import { jsonRequestBodyTemplateError } from './json-request-template.ts'
import { notificationContentError, validDingTalkRobotUrl, webhookBodyTemplateError } from './webhook-body-template.ts'

const MESSAGES: Record<ValidationIssue['code'], string> = {
  'empty-name': '节点名称不能为空',
  'entry-count': '一张图必须恰好有一个开始节点',
  'terminal-count': '一张图至少要有一个结束节点',
  'entry-mismatch': '入口必须指向开始节点',
  'dangling-edge': '连线引用了不存在的节点',
  'unknown-port': '连线使用了该节点没有的出口',
  'occupied-output': '同一个节点出口只能连接一个入口',
  'missing-outgoing': '非结束节点需要至少一条出边',
  'missing-incoming': '非开始节点需要至少一条入边',
  'unconnected-output': '节点出口没有连接后续节点',
  'unreachable-node': '节点无法从开始节点到达',
  'invalid-target': '连线指向了不接受入线的节点',
  'agent-prompt-empty': 'Agent 节点需要系统提示',
  'condition-ai-prompt-empty': 'AI 条件节点需要填写判断提示词',
  'unknown-binding': '变量绑定引用了不存在的节点或端口',
  'duplicate-id': '节点或连线 id 重复',
  'unknown-subflow': '请选择一个已发布的子流程和固定版本',
  'switch-empty-case': '多路判断至少需要一个分支值',
  'switch-invalid-case': '多路判断的数字或布尔匹配值无效',
  'switch-duplicate-case': '多路判断存在重复的精确匹配值，后续重复分支无法命中',
  'image-recognition-invalid': '图片识别需要图片来源、结果变量名，以及至少一个填写完整且不重复的分支',
  'missing-entry-workflow': '入口流程不存在',
  'subflow-cycle': '子流程调用存在循环',
  'declared-variable-empty': '声明流程变量时必须填写变量名',
  'wait-selector-empty': '等待元素出现或消失时必须配置元素选择器',
  'api-request-url-invalid': '接口请求需要有效的 HTTP(S) 请求 URL',
  'api-request-timeout-invalid': '接口请求超时必须大于 0 毫秒',
  'api-request-parameter-empty': '接口请求的查询参数或请求头缺少名称',
  'api-request-body-invalid': '接口请求体不是有效的 JSON 模板',
  'subflow-required-input': '子流程必填输入需要配置传入值',
  'subflow-input-type-mismatch': '子流程输入映射的传入值类型不兼容',
  'webhook-url-invalid': 'Webhook 地址必须是有效的 HTTP(S) URL',
  'webhook-url-missing': '已启用通知，请先在流程 Webhook 设置中填写地址',
  'webhook-body-invalid': 'Webhook 消息体模板无效',
}

function validApiUrl(url: string): boolean {
  const trimmed = url.trim()
  if (trimmed === '') return false
  // 动态 URL 在运行时才能解析；静态 URL 可提前校验协议和格式。
  if (/^\{\{[^{}]+\}\}/.test(trimmed)) return true
  const candidate = trimmed.replace(/\{\{[^{}]+\}\}/g, 'value')
  if (candidate.includes('{{') || candidate.includes('}}')) return false
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch { return false }
}

function issue(
  code: ValidationIssue['code'],
  extra: Pick<ValidationIssue, 'nodeId' | 'edgeId'> = {},
): ValidationIssue {
  return { code, message: MESSAGES[code], ...extra }
}

function bindingsOf(graph: WorkflowGraph, nodeId: string): ValueBinding[] {
  const node = graph.nodes.find(item => item.id === nodeId)
  if (node === undefined) return []
  const fromInputs = Object.values(node.inputBindings ?? {})
  if (node.config.type === 'type') return [...fromInputs, node.config.text]
  if (node.config.type === 'condition') return [...fromInputs, node.config.left]
  if (node.config.type === 'image-recognition') return [...fromInputs, node.config.image]
  if (node.config.type === 'call-subflow') return [...fromInputs, ...(node.config.inputMappings ?? []).map(mapping => mapping.source)]
  if (node.config.type === 'approval') return [...fromInputs, ...node.config.fields.map(field => field.value)]
  return fromInputs
}

function bindingOk(graph: WorkflowGraph, binding: ValueBinding): boolean {
  if (binding.kind !== 'node-output') return true
  const source = graph.nodes.find(node => node.id === binding.nodeId)
  if (source === undefined) return false
  return dataOutputNames(source).includes(binding.port)
}

function dataOutputNames(node: WorkflowGraph['nodes'][number]): string[] {
  const fallback = NODE_CATALOG[node.type].dataOutputs.map(port => port.name)
  if (node.config.type === 'extract') return [node.config.outputName || 'text']
  if (node.config.type === 'image-recognition') return [node.config.outputName || 'imageResult']
  if (node.config.type === 'transform') return [node.config.outputName || 'result']
  if (node.config.type === 'code') return node.config.outputs?.length ? node.config.outputs.map(item => item.name).filter(Boolean) : [node.config.outputName || 'result']
  if (node.config.type === 'api-request') return [node.config.outputName || 'responseData', ...(node.config.rawOutputName?.trim() ? [node.config.rawOutputName] : []), ...(node.config.fields ?? []).map(field => field.name).filter(Boolean)]
  if (node.config.type === 'api-listen') return [node.config.outputName || 'tableData', ...(node.config.rawOutputName?.trim() ? [node.config.rawOutputName] : []), ...(node.config.fields ?? []).map(field => field.name).filter(Boolean)]
  if (node.config.type === 'page-action') return node.config.steps.filter(step => step.type === 'extract').map(step => step.outputName).filter(Boolean)
  return fallback
}

/**
 * Structural checks the editor and file loader share.
 * @param graph - candidate workflow graph.
 * @returns issues in stable order; empty when the graph may be saved.
 */
export function validateGraph(graph: WorkflowGraph, subflows: readonly WorkflowGraph[] = []): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const webhookUrl = graph.webhook?.url.trim() ?? ''
  const hasNotifications = graph.webhook?.onFinished === true || graph.nodes.some(node => node.notifications?.enabled !== false && (node.notifications?.onSuccess || node.notifications?.onFailure || node.notifications?.onApprovalPending || node.notifications?.onApprovalApproved || node.notifications?.onApprovalRejected || node.notifications?.onApprovalTimeout))
  if (hasNotifications && webhookUrl === '') issues.push(issue('webhook-url-missing'))
  if (webhookUrl !== '') {
    try {
      const parsed = new URL(webhookUrl)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) issues.push(issue('webhook-url-invalid'))
    } catch { issues.push(issue('webhook-url-invalid')) }
  }
  if (graph.webhook?.provider === 'dingtalk' && webhookUrl !== '' && !validDingTalkRobotUrl(webhookUrl)) issues.push({ ...issue('webhook-url-invalid'), message: '钉钉机器人地址应为 https://oapi.dingtalk.com/robot/send?access_token=...' })
  const webhookBodyError = graph.webhook?.provider === 'dingtalk'
    ? notificationContentError(graph.webhook.messageTemplate ?? '')
    : webhookBodyTemplateError(graph.webhook?.bodyTemplate ?? '', graph.webhook?.provider)
  if (webhookBodyError !== undefined) issues.push({ ...issue('webhook-body-invalid'), message: webhookBodyError })
  const starts = graph.nodes.filter(node => node.type === 'start')
  const ends = graph.nodes.filter(node => node.type === 'end')
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()

  for (const node of graph.nodes) {
    const notificationError = node.notifications?.enabled === false ? undefined : notificationContentError(node.notifications?.messageTemplate ?? '')
    if (notificationError !== undefined) issues.push({ ...issue('webhook-body-invalid', { nodeId: node.id }), message: notificationError })
    if (nodeIds.has(node.id)) issues.push(issue('duplicate-id', { nodeId: node.id }))
    nodeIds.add(node.id)
    if (node.name.trim() === '') issues.push(issue('empty-name', { nodeId: node.id }))
    if (node.config.type === 'agent' && node.config.systemPrompt.trim() === '') {
      issues.push(issue('agent-prompt-empty', { nodeId: node.id }))
    }
    if (node.config.type === 'condition' && node.config.mode === 'ai' && (node.config.aiPrompt ?? '').trim() === '') {
      issues.push(issue('condition-ai-prompt-empty', { nodeId: node.id }))
    }
    if (node.config.type === 'switch' && node.config.mode !== 'ai') {
      const config = node.config
      if (config.cases.length === 0) issues.push(issue('switch-empty-case', { nodeId: node.id }))
      const values = config.cases.map((_, index) => switchCaseValue(config, index))
      if (values.some(value => value === undefined)) issues.push(issue('switch-invalid-case', { nodeId: node.id }))
      const keys = values.map((value, index) => JSON.stringify([switchCaseType(config, index), value]))
      if (new Set(keys).size !== keys.length) issues.push(issue('switch-duplicate-case', { nodeId: node.id }))
    }
    if (node.config.type === 'image-recognition') {
      const config = node.config
      const ids = config.cases.map(item => item.id)
      if (config.outputName.trim() === '' || config.cases.length === 0 || config.cases.some(item => !item.id.trim() || !item.name.trim() || !item.prompt.trim()) || new Set(ids).size !== ids.length || (config.image.kind === 'literal' && typeof config.image.value === 'string' && config.image.value.trim() === '')) {
        issues.push(issue('image-recognition-invalid', { nodeId: node.id }))
      }
    }
    if (node.config.type === 'call-subflow' && (node.config.workflowId.trim() === '' || node.config.workflowVersion === undefined || node.config.workflowVersion < 1)) {
      issues.push(issue('unknown-subflow', { nodeId: node.id }))
    }
    if (node.config.type === 'call-subflow' && node.config.workflowId === graph.workflowId) {
      issues.push(issue('subflow-cycle', { nodeId: node.id }))
    }
    if (node.config.type === 'wait' && node.config.mode !== undefined && node.config.mode !== 'duration' && (typeof node.config.selector === 'string' ? node.config.selector : node.config.selector.value).trim() === '') {
      issues.push(issue('wait-selector-empty', { nodeId: node.id }))
    }
    if (node.config.type === 'call-subflow') {
      const config = node.config
      const child = subflows.find(item => item.workflowId === config.workflowId && item.version === config.workflowVersion)
      const missing = (child?.context?.inputs ?? []).filter(input => {
        if (!input.required || input.defaultValue !== undefined) return false
        const mapping = config.inputMappings?.find(item => item.inputName === input.name)
        return mapping === undefined || (mapping.source.kind === 'literal' && (mapping.source.value === null || (typeof mapping.source.value === 'string' && mapping.source.value.trim() === '')))
      })
      if (missing.length > 0) issues.push({ ...issue('subflow-required-input', { nodeId: node.id }), message: `子流程必填输入未配置：${missing.map(input => input.description || input.name).join('、')}` })
      for (const input of child?.context?.inputs ?? []) {
        const mapping = config.inputMappings?.find(item => item.inputName === input.name)
        if (mapping === undefined) continue
        if (missing.some(item => item.name === input.name)) continue
        const warning = subflowInputTypeWarning(graph, input, mapping.source)
        if (warning !== undefined) issues.push({ ...issue('subflow-input-type-mismatch', { nodeId: node.id }), message: warning })
      }
    }
    if (node.config.type === 'api-request') {
      const config = node.config
      if (!validApiUrl(config.url)) issues.push(issue('api-request-url-invalid', { nodeId: node.id }))
      if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) issues.push(issue('api-request-timeout-invalid', { nodeId: node.id }))
      if ([...(config.queryParams ?? []), ...(config.headers ?? [])].some(item => item.name.trim() === '')) issues.push(issue('api-request-parameter-empty', { nodeId: node.id }))
      const bodyError = jsonRequestBodyTemplateError(config.body)
      if (bodyError !== undefined) issues.push({ ...issue('api-request-body-invalid', { nodeId: node.id }), message: bodyError })
    }
    const declaredTargets = node.config.type === 'page-action'
      ? node.config.steps.filter(step => step.type === 'extract' && step.outputMode === 'declare').map(step => step.type === 'extract' ? step.updateVariable : '')
      : node.config.type === 'code'
        ? node.config.outputs?.filter(output => output.outputMode === 'declare').map(output => output.updateVariable ?? '') ?? []
        : node.config.type === 'api-request' || node.config.type === 'api-listen' || node.config.type === 'extract' || node.config.type === 'transform' || node.config.type === 'agent' || node.config.type === 'image-recognition'
        ? node.config.outputMode === 'declare' ? [node.config.updateVariable] : []
        : []
    if (declaredTargets.some(name => name === undefined || name.trim() === '')) issues.push(issue('declared-variable-empty', { nodeId: node.id }))
    if (bindingsOf(graph, node.id).some(binding => !bindingOk(graph, binding))) {
      issues.push(issue('unknown-binding', { nodeId: node.id }))
    }
  }

  if (starts.length !== 1) issues.push(issue('entry-count'))
  if (ends.length < 1) issues.push(issue('terminal-count'))
  const start = starts[0]
  if (start !== undefined && graph.entryNodeId !== start.id) issues.push(issue('entry-mismatch'))

  const outgoing = new Map<string, number>()
  const incoming = new Map<string, number>()
  const usedOutputs = new Set<string>()
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) issues.push(issue('duplicate-id', { edgeId: edge.id }))
    edgeIds.add(edge.id)
    const source = graph.nodes.find(node => node.id === edge.sourceNodeId)
    const target = graph.nodes.find(node => node.id === edge.targetNodeId)
    if (source === undefined || target === undefined) {
      issues.push(issue('dangling-edge', { edgeId: edge.id }))
      continue
    }
    const ports = source.config.type === 'image-recognition'
      ? [...source.config.cases.map(item => `case-${item.id}`), 'else']
      : source.config.type === 'switch'
      ? [...source.config.cases.map((_, index) => `case-${index}`), 'else']
      : NODE_CATALOG[source.type].flowOutputs.map(port => port.name)
    if (!ports.includes(edge.sourcePort)) issues.push(issue('unknown-port', { edgeId: edge.id }))
    const outputKey = `${edge.sourceNodeId}:${edge.sourcePort}`
    if (usedOutputs.has(outputKey)) issues.push(issue('occupied-output', { edgeId: edge.id }))
    else usedOutputs.add(outputKey)
    outgoing.set(source.id, (outgoing.get(source.id) ?? 0) + 1)
    incoming.set(target.id, (incoming.get(target.id) ?? 0) + 1)
  }

  for (const node of graph.nodes) {
    if (NODE_CATALOG[node.type].flowOutputs.length > 0 && (outgoing.get(node.id) ?? 0) < 1) {
      issues.push(issue('missing-outgoing', { nodeId: node.id }))
    }
    if (node.type !== 'start' && (incoming.get(node.id) ?? 0) < 1) {
      issues.push(issue('missing-incoming', { nodeId: node.id }))
    }
  }

  return issues
}

export function firstIssue(graph: WorkflowGraph, subflows: readonly WorkflowGraph[] = []): ValidationIssue | undefined {
  return validateGraph(graph, subflows)[0]
}

/** Publishing requires every possible exit to be connected and every node to be reachable. */
export function validatePublishConnections(graph: WorkflowGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]))
  const edgesBySource = new Map<string, WorkflowGraph['edges'][number][]>()
  for (const edge of graph.edges) {
    const source = nodeById.get(edge.sourceNodeId)
    const target = nodeById.get(edge.targetNodeId)
    if (source === undefined || target === undefined) continue
    if (!NODE_CATALOG[target.type].acceptsIncoming) {
      issues.push({ ...issue('invalid-target', { nodeId: target.id, edgeId: edge.id }), message: `连线不能指向节点「${target.name}」，该节点不接受入线` })
    }
    const edges = edgesBySource.get(edge.sourceNodeId) ?? []
    edges.push(edge)
    edgesBySource.set(edge.sourceNodeId, edges)
  }

  for (const node of graph.nodes) {
    const ports = node.config.type === 'switch'
      ? [...node.config.cases.map((item, index) => ({ name: `case-${index}`, label: item.trim() || `分支 ${index + 1}` })), { name: 'else', label: '否则' }]
      : node.config.type === 'image-recognition'
        ? [...node.config.cases.map((item, index) => ({ name: `case-${item.id}`, label: item.name?.trim() || `分支 ${index + 1}` })), { name: 'else', label: '否则' }]
        : NODE_CATALOG[node.type].flowOutputs
    for (const port of ports) {
      if ((edgesBySource.get(node.id) ?? []).some(edge => edge.sourcePort === port.name)) continue
      issues.push({ ...issue('unconnected-output', { nodeId: node.id }), message: `节点「${node.name}」的「${port.label}」出口没有连接后续节点` })
    }
  }

  const seen = new Set<string>()
  const validEntry = nodeById.get(graph.entryNodeId)?.type === 'start'
  const pending = validEntry ? [graph.entryNodeId] : []
  while (pending.length > 0) {
    const nodeId = pending.pop()!
    if (seen.has(nodeId)) continue
    seen.add(nodeId)
    for (const edge of edgesBySource.get(nodeId) ?? []) pending.push(edge.targetNodeId)
  }
  if (validEntry) for (const node of graph.nodes) {
    if (!seen.has(node.id)) issues.push({ ...issue('unreachable-node', { nodeId: node.id }), message: `节点「${node.name}」无法从开始节点到达，请检查画布连线` })
  }
  return issues
}

export function firstPublishIssue(graph: WorkflowGraph, subflows: readonly WorkflowGraph[] = []): ValidationIssue | undefined {
  return firstIssue(graph, subflows) ?? validatePublishConnections(graph)[0]
}

/** Root workflows need an initial page for standalone execution; child flows may omit it. */
export function missingStartUrl(graph: WorkflowGraph): boolean {
  const start = graph.nodes.find(node => node.config.type === 'start')
  return start?.config.type !== 'start' || start.config.url.trim() === ''
}
