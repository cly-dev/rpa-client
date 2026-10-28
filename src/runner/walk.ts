import type { ApprovalDecision, ApprovalPrompt, JsonValue, NodeOutputs, NodeRunStatus, WorkflowGraph, WorkflowNode } from '@graph/types.ts'
import { NODE_CATALOG } from '@graph/catalog.ts'

const MAX_LOG_LENGTH = 4_800

function outputShape(value: JsonValue): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `数组(${value.length}项)`
  if (typeof value === 'object') return `对象(${Object.keys(value).length}字段)`
  if (typeof value === 'string') return `文本(${value.length}字)`
  return typeof value
}

function nodeSetup(node: WorkflowNode): string {
  const config = node.config
  switch (config.type) {
    case 'start': return `初始 URL：${config.url.trim() ? '已配置' : '未配置'}`
    case 'open-page': return `目标 URL：${config.url.trim() ? '已配置' : '未配置'}`
    case 'page-action': return `页面步骤：${config.steps.length} 个（${config.steps.map(step => step.type).join(' → ') || '空'}）`
    case 'click': return `选择器：${(typeof config.selector === 'string' ? config.selector : config.selector.value).trim() ? '已配置' : '未配置'}`
    case 'type': return `选择器：${(typeof config.selector === 'string' ? config.selector : config.selector.value).trim() ? '已配置' : '未配置'}；输入内容不记录`
    case 'api-request': return `请求方式：${config.method}；查询参数：${config.queryParams?.length ?? 0} 个；请求体：${config.body.trim() ? '已配置' : '无'}`
    case 'api-listen': return `监听方式：${config.method}；匹配方式：${config.matchMode}；超时：${config.timeoutMs}ms`
    case 'for-each': return `最大循环：${config.maxItems} 项；单项失败：${config.onItemError}`
    case 'condition': return `判断方式：${config.mode ?? 'value'}；条件数：${config.clauses?.length ?? 1}`
    case 'switch': return `判断方式：${config.mode ?? 'value'}；分支数：${config.cases.length}`
    case 'image-recognition': return `图片来源：${config.image.kind}；场景数：${config.cases.length}`
    case 'call-subflow': return `子流程：${config.workflowId || '未选择'}${config.workflowVersion === undefined ? '' : ` v${config.workflowVersion}`}`
    case 'approval': return `审批字段：${config.fields.length} 个；超时：${config.timeoutMinutes} 分钟`
    case 'handoff': return '等待人工接管'
    case 'set-variable': return `目标变量：${config.name || '未命名'}；取值路径：${config.path.trim() ? '已配置' : '无'}`
    case 'agent': return `AI 配置：${config.llmId || '使用默认配置'}；提示词变量引用；结构化输出：${config.outputs?.length ?? 0} 个`
    case 'code': return `代码输入：${config.inputs?.length ?? 1} 个；声明输出：${config.outputs?.length ?? 1} 个`
    case 'extract': return `抽取方式：${config.mode ?? 'text'}；产出：${config.outputName}`
    case 'transform': return `转换操作：${config.operation}；产出：${config.outputName}`
    case 'wait': {
      const selector = (typeof config.selector === 'string' ? config.selector : config.selector.value).trim()
      const mode = config.mode ?? (selector ? 'visible' : 'duration')
      return mode === 'duration' ? `固定等待：${config.ms}ms` : `等待元素${mode === 'visible' ? '出现' : '消失'}；超时：${config.ms}ms；选择器：${selector ? '已配置' : '未配置'}`
    }
    case 'continue-loop': return '完成当前循环项并进入下一轮'
    case 'end': return '终止流程'
    default: return '使用默认节点配置'
  }
}

export interface RunLogLine {
  readonly at: number
  readonly nodeId: string
  readonly nodeName: string
  readonly message: string
  readonly notificationEvent?: 'node.succeeded' | 'node.failed'
  readonly notificationValues?: Readonly<Record<string, JsonValue>>
}

export interface RunState {
  readonly status: 'running' | 'waiting-approval' | 'succeeded' | 'failed'
  readonly currentNodeId?: string
  readonly nodes: Readonly<Record<string, NodeRunStatus>>
  readonly outputs: Readonly<Record<string, NodeOutputs>>
  readonly inputs?: Readonly<Record<string, JsonValue>>
  readonly variables?: Readonly<Record<string, JsonValue>>
  readonly page?: { readonly url: string; readonly title?: string }
  readonly debugBrowser?: { readonly opened: boolean; readonly message?: string }
  readonly logs: readonly RunLogLine[]
}

export interface RunHandlers {
  onUpdate(state: RunState): void
  wait(ms: number): Promise<void>
  requestApproval?(prompt: ApprovalPrompt): Promise<ApprovalDecision>
}

export interface StepResult {
  readonly message: string
  /** Additional state-change messages shown in the run log. */
  readonly logs?: readonly string[]
  readonly outputs?: NodeOutputs
  readonly branch?: string
  readonly halt?: 'succeeded' | 'failed'
  readonly status?: NodeRunStatus
  readonly approval?: ApprovalPrompt
}

export async function walkGraph(
  graph: WorkflowGraph,
  handlers: RunHandlers,
  step: (node: WorkflowNode, outputs: Readonly<Record<string, NodeOutputs>>) => Promise<StepResult>,
  options: { readonly stopAfterNodeId?: string } = {},
): Promise<RunState> {
  const nodes: Record<string, NodeRunStatus> = Object.fromEntries(graph.nodes.map(node => [node.id, 'pending' as const]))
  const outputs: Record<string, NodeOutputs> = {}
  let logs: RunLogLine[] = []
  let current = graph.nodes.find(node => node.id === graph.entryNodeId)
  const visited = new Set<string>()
  const visitCounts = new Map<string, number>()
  const activeLoopIds: string[] = []
  const notified = new Set<string>()

  const emit = (status: RunState['status'], currentNodeId?: string): RunState => {
    const state = { status, currentNodeId, nodes: { ...nodes }, outputs: { ...outputs }, logs }
    handlers.onUpdate(state)
    return state
  }

  const log = (nodeId: string, nodeName: string, message: string, notificationEvent?: RunLogLine['notificationEvent']): void => {
    const safeMessage = message.length > MAX_LOG_LENGTH ? `${message.slice(0, MAX_LOG_LENGTH - 20)}…（日志已截断）` : message
    logs = [...logs, { at: Date.now(), nodeId, nodeName, message: safeMessage, ...(notificationEvent ? { notificationEvent } : {}) }]
  }

  const notifyOnce = (node: WorkflowNode, event: NonNullable<RunLogLine['notificationEvent']>): RunLogLine['notificationEvent'] => {
    const enabled = node.notifications?.enabled !== false && (event === 'node.succeeded' ? node.notifications?.onSuccess : node.notifications?.onFailure)
    const key = `${node.id}:${event}`
    if (!enabled || notified.has(key)) return undefined
    notified.add(key)
    return event
  }

  while (current !== undefined) {
    const node = current
    if (visited.has(node.id) && node.type !== 'for-each') {
      log(node.id, node.name, '检测到环，已停止')
      nodes[node.id] = 'failed'
      return emit('failed', node.id)
    }
    if (node.type === 'for-each' && visited.has(node.id)) visited.clear()
    visited.add(node.id)
    const visitCount = (visitCounts.get(node.id) ?? 0) + 1
    visitCounts.set(node.id, visitCount)
    nodes[node.id] = 'running'
    const startedAt = Date.now()
    log(node.id, node.name, `开始执行「${NODE_CATALOG[node.type].title}」（节点 ID：${node.id}；第 ${visitCount} 次执行）`)
    log(node.id, node.name, `配置概要：${nodeSetup(node)}；策略配置：最多尝试 ${Math.max(1, node.execution.maxAttempts)} 次、超时 ${node.execution.timeoutMs}ms（按节点支持情况生效）`)
    if (node.config.type === 'extract' && node.config.ai?.enabled === true) {
      log(node.id, node.name, 'AI 抽取中，正在分析列表内容…')
    }
    emit('running', node.id)
    await handlers.wait(80)

    let result: StepResult
    try {
      result = await step(node, outputs)
      if (result.approval !== undefined) {
        if (handlers.requestApproval === undefined) throw new Error('当前执行环境不支持人工审批')
        log(node.id, node.name, result.message)
        nodes[node.id] = 'waiting-user'
        emit('waiting-approval', node.id)
        const decision = await handlers.requestApproval(result.approval)
        const approved = decision.decision === 'approved'
        result = {
          message: decision.decision === 'approved' ? `审批已通过：${decision.approverName}` : decision.decision === 'rejected' ? `审批已拒绝：${decision.approverName}${decision.comment ? `（${decision.comment}）` : ''}` : '审批已超时',
          branch: decision.decision,
          outputs: { approved, decision: decision.decision, comment: decision.comment, approverId: decision.approverId ?? '', approverName: decision.approverName, decidedAt: decision.decidedAt },
        }
        nodes[node.id] = 'running'
        emit('running', node.id)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const detail = `节点「${node.name}」(${node.type})执行失败：${reason}`
      log(node.id, node.name, `执行耗时：${Date.now() - startedAt}ms`)
      log(node.id, node.name, detail, notifyOnce(node, 'node.failed'))
      nodes[node.id] = 'failed'
      return emit('failed', node.id)
    }
    log(node.id, node.name, result.message)
    for (const message of result.logs ?? []) log(node.id, node.name, message)
    if (result.outputs !== undefined) {
      outputs[node.id] = result.outputs
      const entries = Object.entries(result.outputs)
      log(node.id, node.name, `产出概要：${entries.length === 0 ? '无' : entries.slice(0, 20).map(([name, value]) => `${name}=${outputShape(value)}`).join('，')}${entries.length > 20 ? `，另有 ${entries.length - 20} 项` : ''}（不记录具体值）`)
    } else log(node.id, node.name, '产出概要：无')
    nodes[node.id] = result.status ?? (result.halt === 'failed' ? 'failed' : 'succeeded')
    const notificationEvent = nodes[node.id] === 'succeeded' ? notifyOnce(node, 'node.succeeded')
      : nodes[node.id] === 'failed' || nodes[node.id] === 'waiting-user' ? notifyOnce(node, 'node.failed') : undefined
    log(node.id, node.name, `执行耗时：${Date.now() - startedAt}ms；状态：${nodes[node.id]}`, notificationEvent)
    if (result.halt !== undefined) {
      const activeLoopId = activeLoopIds.at(-1)
      const loop = activeLoopId === undefined ? undefined : graph.nodes.find(item => item.id === activeLoopId)
      if (result.halt === 'failed' && loop?.config.type === 'for-each' && loop.config.onItemError === 'skip') {
        log(node.id, node.name, '当前循环项失败，已跳过并继续下一项')
        current = loop
        continue
      }
      if (result.halt === 'failed') log(node.id, node.name, `节点「${node.name}」(${node.type})执行失败：${result.message}`)
      return emit(result.halt, node.id)
    }

    if (node.id === options.stopAfterNodeId) {
      if (nodes[node.id] === 'failed') return emit('failed', node.id)
      log(node.id, node.name, '目标节点执行完成，已停止本次运行')
      return emit('succeeded', node.id)
    }

    if (node.type === 'continue-loop') {
      const activeLoopId = activeLoopIds.at(-1)
      const loop = activeLoopId === undefined ? undefined : graph.nodes.find(item => item.id === activeLoopId)
      if (loop?.type !== 'for-each') {
        log(node.id, node.name, '本次循环结束节点只能在循环体内使用')
        nodes[node.id] = 'failed'
        return emit('failed', node.id)
      }
      log(node.id, node.name, '本次循环已结束，返回循环节点判断下一轮')
      current = loop
      continue
    }

    const port = result.branch
      ?? (node.type === 'end' ? undefined : 'default')
    if (node.type === 'for-each' && port === 'body' && activeLoopIds.at(-1) !== node.id) activeLoopIds.push(node.id)
    if (node.type === 'for-each' && port === 'done') {
      const index = activeLoopIds.lastIndexOf(node.id)
      if (index >= 0) activeLoopIds.splice(index, 1)
    }
    if (node.type === 'end' || port === undefined) {
      log(node.id, node.name, '流程已到达结束节点')
      return emit('succeeded', node.id)
    }
    const edge = graph.edges.find(item => item.sourceNodeId === node.id && item.sourcePort === port)
      ?? (result.branch === undefined ? graph.edges.find(item => item.sourceNodeId === node.id) : undefined)
    const next = edge === undefined ? undefined : graph.nodes.find(item => item.id === edge.targetNodeId)
    if (next === undefined) {
      log(node.id, node.name, `出口「${port}」没有有效的后续连线，流程中断`)
      return emit('failed', node.id)
    }
    log(node.id, node.name, `出口「${port}」→ 下一节点「${next.name}」（${next.type}）`)
    current = next
  }

  log('', '', '没有下一个节点，流程中断')
  return emit('failed')
}
