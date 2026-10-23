import { NODE_TYPES, type JsonValue, type NodeConfig, type NodeType, type OutputVariableMode, type ValueBinding, type WorkflowGraph } from './types.ts'

export type ParseResult = { readonly ok: true; readonly graph: WorkflowGraph } | { readonly ok: false; readonly error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} 必须是非空字符串`)
  return value
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} 必须是数字`)
  return value
}

function asNodeType(value: unknown): NodeType {
  if (typeof value === 'string' && (NODE_TYPES as readonly string[]).includes(value)) return value as NodeType
  throw new Error(`未知节点类型：${String(value)}`)
}

function parseOutputMode(value: unknown): OutputVariableMode {
  return value === 'update' || value === 'declare' ? value : 'produce'
}

export function parseBinding(value: unknown, path: string): ValueBinding {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error(`${path} 绑定无效`)
  if (value.kind === 'literal') return { kind: 'literal', value: (value.value ?? null) as JsonValue }
  if (value.kind === 'workflow-input') return { kind: 'workflow-input', name: asString(value.name, `${path}.name`) }
  if (value.kind === 'variable') return { kind: 'variable', name: asString(value.name, `${path}.name`) }
  if (value.kind === 'node-output') {
    return { kind: 'node-output', nodeId: asString(value.nodeId, `${path}.nodeId`), port: asString(value.port, `${path}.port`) }
  }
  if (value.kind === 'runtime' && (value.path === 'page.url' || value.path === 'page.title' || value.path === 'runtime.executionId')) return { kind: 'runtime', path: value.path }
  throw new Error(`${path} 绑定 kind 无效`)
}

function parseOptionalBinding(value: unknown, path: string, fallback: ValueBinding): ValueBinding {
  return value === undefined ? fallback : parseBinding(value, path)
}

function parseConfig(type: NodeType, value: unknown, path: string): NodeConfig {
  if (!isRecord(value)) throw new Error(`${path} 必须是对象`)
  const empty = { kind: 'literal' as const, value: '' }
  switch (type) {
    case 'start':
      return { type: 'start', url: typeof value.url === 'string' ? value.url : '' }
    case 'page-action':
      return { type: 'page-action', steps: Array.isArray(value.steps) ? value.steps.filter(isRecord).map(step => {
        if (step.type !== 'type' || !isRecord(step.ai)) return step as any
        return { ...step, ai: { enabled: step.ai.enabled === true, prompt: typeof step.ai.prompt === 'string' ? step.ai.prompt : '', llmId: typeof step.ai.llmId === 'string' ? step.ai.llmId : undefined } }
      }) as any : [] }
    case 'api-listen':
      return { type: 'api-listen', urlPattern: typeof value.urlPattern === 'string' ? value.urlPattern : '', matchMode: value.matchMode === 'equals' || value.matchMode === 'regex' ? value.matchMode : 'contains', method: typeof value.method === 'string' ? value.method : 'ANY', responseType: value.responseType === 'text' ? 'text' : 'json', jsonPath: typeof value.jsonPath === 'string' ? value.jsonPath : '', outputName: typeof value.outputName === 'string' && value.outputName.trim() !== '' ? value.outputName : 'tableData', outputMode: parseOutputMode(value.outputMode), updateVariable: typeof value.updateVariable === 'string' ? value.updateVariable : '', rawOutputName: typeof value.rawOutputName === 'string' ? value.rawOutputName : 'responseData', fields: Array.isArray(value.fields) ? value.fields.filter(item => isRecord(item) && typeof item.name === 'string' && typeof item.path === 'string').map(item => ({ name: item.name as string, path: item.path as string })) : [], requestParams: Array.isArray(value.requestParams) ? value.requestParams.filter(item => isRecord(item) && typeof item.name === 'string' && typeof item.value === 'string').map(item => ({ name: item.name as string, value: item.value as string })) : [], timeoutMs: typeof value.timeoutMs === 'number' ? value.timeoutMs : 10000 }
    case 'api-request':
      return { type: 'api-request', url: typeof value.url === 'string' ? value.url : '', method: typeof value.method === 'string' ? value.method : 'GET', queryParams: Array.isArray(value.queryParams) ? value.queryParams.filter(item => isRecord(item) && typeof item.name === 'string' && typeof item.value === 'string').map(item => ({ name: item.name as string, value: item.value as string })) : [], headers: Array.isArray(value.headers) ? value.headers.filter(item => isRecord(item) && typeof item.name === 'string' && typeof item.value === 'string').map(item => ({ name: item.name as string, value: item.value as string })) : [], body: typeof value.body === 'string' ? value.body : '', responseType: value.responseType === 'text' ? 'text' : 'json', jsonPath: typeof value.jsonPath === 'string' ? value.jsonPath : '', outputName: typeof value.outputName === 'string' && value.outputName.trim() !== '' ? value.outputName : 'responseData', outputMode: parseOutputMode(value.outputMode), updateVariable: typeof value.updateVariable === 'string' ? value.updateVariable : '', rawOutputName: typeof value.rawOutputName === 'string' ? value.rawOutputName : 'rawResponseData', fields: Array.isArray(value.fields) ? value.fields.filter(item => isRecord(item) && typeof item.name === 'string' && typeof item.path === 'string').map(item => ({ name: item.name as string, path: item.path as string })) : [], timeoutMs: typeof value.timeoutMs === 'number' ? value.timeoutMs : 15000 }
    case 'for-each':
      return { type: 'for-each', collection: parseOptionalBinding(value.collection, `${path}.collection`, empty), condition: typeof value.condition === 'string' ? value.condition : '', conditionClauses: Array.isArray(value.conditionClauses) ? value.conditionClauses as import('./types.ts').LoopConditionClause[] : undefined, conditionLogic: value.conditionLogic === 'or' ? 'or' : 'and', itemVar: typeof value.itemVar === 'string' ? value.itemVar : 'item', indexVar: typeof value.indexVar === 'string' ? value.indexVar : 'index', declaredVariables: Array.isArray(value.declaredVariables) ? value.declaredVariables.filter((item): item is string => typeof item === 'string') : [], maxItems: typeof value.maxItems === 'number' ? value.maxItems : 100, retryCount: typeof value.retryCount === 'number' ? value.retryCount : 2, onItemError: value.onItemError === 'stop' ? 'stop' : 'skip' }
    case 'open-page':
      return { type: 'open-page', url: typeof value.url === 'string' ? value.url : '' }
    case 'click':
      return { type: 'click', selector: typeof value.selector === 'string' ? value.selector : '', beforeHover: typeof value.beforeHover === 'string' ? value.beforeHover : '', waitForVisible: typeof value.waitForVisible === 'string' ? value.waitForVisible : '' }
    case 'type':
      return {
        type: 'type',
        selector: typeof value.selector === 'string' ? value.selector : '',
        text: parseOptionalBinding(value.text, `${path}.text`, empty),
        path: typeof value.path === 'string' ? value.path : '',
      }
    case 'extract': {
      const transform = isRecord(value.transform) ? value.transform : undefined
      const operation = transform?.operation === 'uppercase' || transform?.operation === 'lowercase' || transform?.operation === 'regex' || transform?.operation === 'replace' || transform?.operation === 'json-parse' || transform?.operation === 'json-stringify' ? transform.operation : 'trim'
      const ai = isRecord(value.ai) ? { enabled: value.ai.enabled === true, fields: Array.isArray(value.ai.fields) ? value.ai.fields.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [], prompt: typeof value.ai.prompt === 'string' ? value.ai.prompt : '', llmId: typeof value.ai.llmId === 'string' ? value.ai.llmId : undefined } : undefined
      return { type: 'extract', selector: typeof value.selector === 'string' ? value.selector : '', outputName: typeof value.outputName === 'string' && value.outputName.trim() !== '' ? value.outputName : 'text', outputMode: parseOutputMode(value.outputMode), updateVariable: typeof value.updateVariable === 'string' ? value.updateVariable : '', mode: value.mode === 'value' || value.mode === 'html' || value.mode === 'list' ? value.mode : 'text', rowSelector: typeof value.rowSelector === 'string' ? value.rowSelector : '', fields: Array.isArray(value.fields) ? value.fields.filter(item => isRecord(item) && typeof item.name === 'string' && typeof item.selector === 'string').map(item => ({ name: item.name as string, selector: item.selector as string, attribute: typeof item.attribute === 'string' ? item.attribute : undefined })) : [], transform: transform === undefined ? undefined : { operation, pattern: typeof transform.pattern === 'string' ? transform.pattern : '', replacement: typeof transform.replacement === 'string' ? transform.replacement : '' }, ai }
    }
    case 'wait':
      return {
        type: 'wait',
        mode: value.mode === 'duration' || value.mode === 'visible' || value.mode === 'hidden' ? value.mode : undefined,
        ms: typeof value.ms === 'number' && Number.isFinite(value.ms) ? value.ms : 1000,
        selector: typeof value.selector === 'string' ? value.selector : '',
      }
    case 'agent':
      return { type: 'agent', systemPrompt: typeof value.systemPrompt === 'string' ? value.systemPrompt : '', userPrompt: typeof value.userPrompt === 'string' ? value.userPrompt : '请根据提示完成任务，并以 JSON 格式返回结果。', llmId: typeof value.llmId === 'string' ? value.llmId : undefined, outputName: typeof value.outputName === 'string' && value.outputName.trim() !== '' ? value.outputName : 'json', outputMode: parseOutputMode(value.outputMode), updateVariable: typeof value.updateVariable === 'string' ? value.updateVariable : '', dryAction: value.dryAction === 'handoff' || value.dryAction === 'email' ? value.dryAction : 'note' }
    case 'condition':
      return {
        type: 'condition',
        left: parseOptionalBinding(value.left, `${path}.left`, empty),
        path: typeof value.path === 'string' ? value.path : '',
        equals: typeof value.equals === 'string' ? value.equals : '',
        mode: value.mode === 'url' || value.mode === 'element' || value.mode === 'ai' ? value.mode : 'value',
        selector: typeof value.selector === 'string' ? value.selector : '',
        aiPrompt: typeof value.aiPrompt === 'string' ? value.aiPrompt : '',
        llmId: typeof value.llmId === 'string' ? value.llmId : undefined,
        operator: value.operator === 'contains' || value.operator === 'visible' || value.operator === 'exists' ? value.operator : 'equals',
        logic: value.logic === 'or' ? 'or' : 'and',
        waitForCondition: value.waitForCondition === true,
        waitTimeoutMs: typeof value.waitTimeoutMs === 'number' && Number.isFinite(value.waitTimeoutMs) ? value.waitTimeoutMs : 10000,
        pollIntervalMs: typeof value.pollIntervalMs === 'number' && Number.isFinite(value.pollIntervalMs) ? value.pollIntervalMs : 500,
        clauses: Array.isArray(value.clauses) ? value.clauses.filter(item => isRecord(item)).map(item => ({ binding: parseOptionalBinding(item.binding, `${path}.clauses.binding`, empty), path: typeof item.path === 'string' ? item.path : '', operator: item.operator === 'notEquals' || item.operator === 'contains' || item.operator === 'greaterThan' || item.operator === 'lessThan' || item.operator === 'isEmpty' || item.operator === 'isNotEmpty' ? item.operator : 'equals', value: (item.value ?? '') as import('./types.ts').JsonValue })) : undefined,
      }
    case 'switch':
      return { type: 'switch', mode: value.mode === 'ai' ? 'ai' : 'value', left: parseOptionalBinding(value.left, `${path}.left`, empty), path: typeof value.path === 'string' ? value.path : '', cases: Array.isArray(value.cases) ? value.cases.filter((item): item is string => typeof item === 'string') : [''], caseTypes: Array.isArray(value.caseTypes) ? value.caseTypes.map(item => item === 'number' || item === 'boolean' || item === 'null' ? item : 'string') : undefined, caseIds: Array.isArray(value.caseIds) ? value.caseIds.map((item, index) => typeof item === 'string' && item.trim() ? item : `legacy-${index}`) : undefined, casePrompts: Array.isArray(value.casePrompts) ? value.casePrompts.filter((item): item is string => typeof item === 'string') : [], llmId: typeof value.llmId === 'string' ? value.llmId : undefined, aiSystemPrompt: typeof value.aiSystemPrompt === 'string' ? value.aiSystemPrompt : '', aiContext: typeof value.aiContext === 'string' ? value.aiContext : '' }
    case 'image-recognition':
      return { type: 'image-recognition', image: parseOptionalBinding(value.image, `${path}.image`, empty), path: typeof value.path === 'string' ? value.path : '', instruction: typeof value.instruction === 'string' ? value.instruction : '', cases: Array.isArray(value.cases) ? value.cases.filter(isRecord).map((item, index) => ({ id: typeof item.id === 'string' && item.id.trim() ? item.id : String(index), name: typeof item.name === 'string' ? item.name : '', prompt: typeof item.prompt === 'string' ? item.prompt : '' })) : [], llmId: typeof value.llmId === 'string' ? value.llmId : undefined, outputName: typeof value.outputName === 'string' && value.outputName.trim() ? value.outputName : 'imageResult', outputMode: parseOutputMode(value.outputMode), updateVariable: typeof value.updateVariable === 'string' ? value.updateVariable : '' }
    case 'call-subflow':
      return { type: 'call-subflow', workflowId: typeof value.workflowId === 'string' ? value.workflowId : '', workflowVersion: typeof value.workflowVersion === 'number' && Number.isInteger(value.workflowVersion) && value.workflowVersion > 0 ? value.workflowVersion : undefined, inputMappings: Array.isArray(value.inputMappings) ? value.inputMappings.filter(isRecord).map(item => ({ inputName: typeof item.inputName === 'string' ? item.inputName : '', source: parseOptionalBinding(item.source, `${path}.inputMappings.source`, empty) })) : [] }
    case 'approval':
      return { type: 'approval', title: typeof value.title === 'string' ? value.title : '请确认是否继续执行', description: typeof value.description === 'string' ? value.description : '', fields: Array.isArray(value.fields) ? value.fields.filter(isRecord).map((item, index) => ({ label: typeof item.label === 'string' ? item.label : '', value: parseOptionalBinding(item.value, `${path}.fields[${index}].value`, empty), path: typeof item.path === 'string' ? item.path : '' })) : [], requireCommentOnReject: value.requireCommentOnReject !== false, timeoutMinutes: typeof value.timeoutMinutes === 'number' && Number.isFinite(value.timeoutMinutes) ? Math.max(1, value.timeoutMinutes) : 30 }
    case 'handoff':
      return { type: 'handoff', note: typeof value.note === 'string' ? value.note : '' }
    case 'set-variable':
      return { type: 'set-variable', name: typeof value.name === 'string' ? value.name : '', value: parseOptionalBinding(value.value, `${path}.value`, empty), path: typeof value.path === 'string' ? value.path : '', requiredInput: isRecord(value.requiredInput) && typeof value.requiredInput.name === 'string' && ['string', 'number', 'boolean', 'object', 'array'].includes(String(value.requiredInput.type)) ? { name: value.requiredInput.name, type: value.requiredInput.type as 'string' | 'number' | 'boolean' | 'object' | 'array' } : undefined }
    case 'transform':
      return { type: 'transform', input: parseOptionalBinding(value.input, `${path}.input`, empty), operation: value.operation === 'uppercase' || value.operation === 'lowercase' || value.operation === 'regex' || value.operation === 'replace' || value.operation === 'json-parse' || value.operation === 'json-stringify' ? value.operation : 'trim', pattern: typeof value.pattern === 'string' ? value.pattern : '', replacement: typeof value.replacement === 'string' ? value.replacement : '', outputName: typeof value.outputName === 'string' && value.outputName.trim() !== '' ? value.outputName : 'result', outputMode: parseOutputMode(value.outputMode), updateVariable: typeof value.updateVariable === 'string' ? value.updateVariable : '' }
    case 'code':
      return { type: 'code', preset: ['identity', 'trim', 'uppercase', 'lowercase', 'timestamp', 'json-parse', 'custom'].includes(String(value.preset)) ? value.preset as 'identity' | 'trim' | 'uppercase' | 'lowercase' | 'timestamp' | 'json-parse' | 'custom' : undefined, input: parseOptionalBinding(value.input, `${path}.input`, empty), inputs: Array.isArray(value.inputs) ? value.inputs.filter(isRecord).map((item, index) => ({ name: typeof item.name === 'string' ? item.name : '', binding: parseOptionalBinding(item.binding, `${path}.inputs[${index}].binding`, empty) })) : [], outputs: Array.isArray(value.outputs) ? value.outputs.filter(isRecord).map(item => ({ name: typeof item.name === 'string' ? item.name : '', valueType: ['string', 'number', 'boolean', 'object', 'array'].includes(String(item.valueType)) ? item.valueType as 'string' | 'number' | 'boolean' | 'object' | 'array' : 'any', outputMode: parseOutputMode(item.outputMode), updateVariable: typeof item.updateVariable === 'string' ? item.updateVariable : '' })) : undefined, code: typeof value.code === 'string' ? value.code : 'return input;', outputName: typeof value.outputName === 'string' && value.outputName.trim() !== '' ? value.outputName : 'result', outputMode: parseOutputMode(value.outputMode), updateVariable: typeof value.updateVariable === 'string' ? value.updateVariable : '' }
    case 'continue-loop':
      return { type: 'continue-loop' }
    case 'end':
      return { type: 'end' }
  }
}

/**
 * Admit a workflow graph from a file or IPC payload.
 * @param value - parsed JSON value.
 * @returns the graph or a user-facing error.
 */
export function parseWorkflow(value: unknown): ParseResult {
  try {
    if (!isRecord(value)) throw new Error('根对象无效')
    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error('nodes / edges 必须是数组')
    const nodes = value.nodes.map((raw, index) => {
      if (!isRecord(raw)) throw new Error(`nodes[${index}] 无效`)
      const type = asNodeType(raw.type)
      const bindingsRaw = isRecord(raw.inputBindings) ? raw.inputBindings : {}
      const inputBindings: Record<string, ValueBinding> = {}
      for (const [key, binding] of Object.entries(bindingsRaw)) {
        inputBindings[key] = parseBinding(binding, `nodes[${index}].inputBindings.${key}`)
      }
      const execution = isRecord(raw.execution) ? raw.execution : {}
      const position = isRecord(raw.position) ? raw.position : {}
      return {
        id: asString(raw.id, `nodes[${index}].id`),
        type,
        name: asString(raw.name, `nodes[${index}].name`),
        position: { x: asNumber(position.x, `nodes[${index}].position.x`), y: asNumber(position.y, `nodes[${index}].position.y`) },
        inputBindings,
        config: parseConfig(type, raw.config, `nodes[${index}].config`),
        execution: {
          timeoutMs: typeof execution.timeoutMs === 'number' ? execution.timeoutMs : 30_000,
          maxAttempts: typeof execution.maxAttempts === 'number' ? execution.maxAttempts : 1,
          onError: execution.onError === 'fail-run' ? 'fail-run' as const : 'human-handoff' as const,
        },
        notifications: isRecord(raw.notifications) ? {
          enabled: typeof raw.notifications.enabled === 'boolean' ? raw.notifications.enabled : undefined,
          onSuccess: raw.notifications.onSuccess === true,
          onFailure: raw.notifications.onFailure === true,
          onApprovalPending: raw.notifications.onApprovalPending === true,
          onApprovalApproved: raw.notifications.onApprovalApproved === true,
          onApprovalRejected: raw.notifications.onApprovalRejected === true,
          onApprovalTimeout: raw.notifications.onApprovalTimeout === true,
          messageTemplate: typeof raw.notifications.messageTemplate === 'string' ? raw.notifications.messageTemplate : undefined,
        } : undefined,
      }
    })
    const edges = value.edges.map((raw, index) => {
      if (!isRecord(raw)) throw new Error(`edges[${index}] 无效`)
      const layoutPoints = Array.isArray(raw.layoutPoints)
        ? raw.layoutPoints.map((point, pointIndex) => {
          if (!isRecord(point)) throw new Error(`edges[${index}].layoutPoints[${pointIndex}] 无效`)
          return { x: asNumber(point.x, `edges[${index}].layoutPoints[${pointIndex}].x`), y: asNumber(point.y, `edges[${index}].layoutPoints[${pointIndex}].y`) }
        })
        : undefined
      return {
        id: asString(raw.id, `edges[${index}].id`),
        sourceNodeId: asString(raw.sourceNodeId, `edges[${index}].sourceNodeId`),
        sourcePort: asString(raw.sourcePort, `edges[${index}].sourcePort`),
        targetNodeId: asString(raw.targetNodeId, `edges[${index}].targetNodeId`),
        ...(layoutPoints === undefined ? {} : { layoutPoints }),
      }
    })
    return {
      ok: true,
      graph: {
        workflowId: asString(value.workflowId, 'workflowId'),
        name: asString(value.name, 'name'),
        version: typeof value.version === 'number' ? value.version : 1,
        entryNodeId: asString(value.entryNodeId, 'entryNodeId'),
        nodes,
        edges,
        webhook: isRecord(value.webhook) ? {
          url: typeof value.webhook.url === 'string' ? value.webhook.url : '',
          onFinished: value.webhook.onFinished === true,
          bodyTemplate: typeof value.webhook.bodyTemplate === 'string' ? value.webhook.bodyTemplate : undefined,
          provider: value.webhook.provider === 'dingtalk' ? 'dingtalk' : 'generic',
          messageTemplate: typeof value.webhook.messageTemplate === 'string' ? value.webhook.messageTemplate : undefined,
        } : undefined,
        context: isRecord(value.context) ? {
          inputs: Array.isArray(value.context.inputs) ? value.context.inputs.filter(item => isRecord(item) && typeof item.name === 'string').map(item => ({ name: item.name as string, type: item.type === 'number' || item.type === 'boolean' || item.type === 'object' || item.type === 'array' ? item.type : 'string', required: item.required === true, defaultValue: item.defaultValue as JsonValue | undefined, secret: item.secret === true, description: typeof item.description === 'string' ? item.description : '' })) : [],
          variables: Array.isArray(value.context.variables) ? value.context.variables.filter(item => isRecord(item) && typeof item.name === 'string').map(item => ({ name: item.name as string, type: item.type === 'number' || item.type === 'boolean' || item.type === 'object' || item.type === 'array' ? item.type : 'string', required: item.required === true, defaultValue: item.defaultValue as JsonValue | undefined, secret: item.secret === true, description: typeof item.description === 'string' ? item.description : '' })) : [],
        } : undefined,
        llm: isRecord(value.llm) ? {
          id: typeof value.llm.id === 'string' ? value.llm.id : 'default-llm',
          name: typeof value.llm.name === 'string' ? value.llm.name : '默认 AI',
          enabled: value.llm.enabled === true,
          provider: value.llm.provider === 'openai' || value.llm.provider === 'anthropic' || value.llm.provider === 'custom' ? value.llm.provider : 'openai-compatible',
          model: typeof value.llm.model === 'string' ? value.llm.model : '',
          baseUrl: typeof value.llm.baseUrl === 'string' ? value.llm.baseUrl : '',
          chatPath: typeof value.llm.chatPath === 'string' && value.llm.chatPath.trim() !== '' ? value.llm.chatPath : '/v1/chat/completions',
          apiKey: typeof value.llm.apiKey === 'string' ? value.llm.apiKey : '',
          temperature: typeof value.llm.temperature === 'number' ? value.llm.temperature : 0.2,
          maxTokens: typeof value.llm.maxTokens === 'number' ? value.llm.maxTokens : 2048,
        } : undefined,
        llms: Array.isArray(value.llms) ? value.llms.filter(isRecord).map((item, index) => ({ id: typeof item.id === 'string' ? item.id : `llm-${index + 1}`, name: typeof item.name === 'string' ? item.name : `AI ${index + 1}`, enabled: item.enabled === true, model: typeof item.model === 'string' ? item.model : '', baseUrl: typeof item.baseUrl === 'string' ? item.baseUrl : '', chatPath: typeof item.chatPath === 'string' && item.chatPath.trim() !== '' ? item.chatPath : '/v1/chat/completions', apiKey: typeof item.apiKey === 'string' ? item.apiKey : '', maxTokens: typeof item.maxTokens === 'number' ? item.maxTokens : 2048 })) : (isRecord(value.llm) ? [{ id: typeof value.llm.id === 'string' ? value.llm.id : 'default-llm', name: typeof value.llm.name === 'string' ? value.llm.name : '默认 AI', enabled: value.llm.enabled === true, model: typeof value.llm.model === 'string' ? value.llm.model : '', baseUrl: typeof value.llm.baseUrl === 'string' ? value.llm.baseUrl : '', chatPath: typeof value.llm.chatPath === 'string' && value.llm.chatPath.trim() !== '' ? value.llm.chatPath : '/v1/chat/completions', apiKey: typeof value.llm.apiKey === 'string' ? value.llm.apiKey : '', maxTokens: typeof value.llm.maxTokens === 'number' ? value.llm.maxTokens : 2048 }] : undefined),
      },
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '无法解析流程图' }
  }
}
