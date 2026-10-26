import { DEFAULT_AGENT_PROMPT, DEFAULT_EXECUTION, type JsonValue, type NodeConfig, type NodeType, type ValueBinding } from './types.ts'

export interface FlowOutput {
  readonly name: string
  readonly label: string
}

export interface DataPort {
  readonly name: string
  readonly label: string
}

export interface NodeDefinition {
  readonly type: NodeType
  readonly title: string
  readonly description: string
  readonly kind: 'entry' | 'action' | 'decision' | 'terminal'
  readonly acceptsIncoming: boolean
  readonly palette: boolean
  readonly flowOutputs: readonly FlowOutput[]
  readonly dataInputs: readonly DataPort[]
  readonly dataOutputs: readonly DataPort[]
}

const DEFAULT_FLOW: readonly FlowOutput[] = [{ name: 'default', label: '下一步' }]

export const NODE_CATALOG: Record<NodeType, NodeDefinition> = {
  start: {
    type: 'start',
    title: '开始',
    description: '流程唯一入口',
    kind: 'entry',
    acceptsIncoming: false,
    palette: false,
    flowOutputs: DEFAULT_FLOW,
    dataInputs: [],
    dataOutputs: [],
  },
  'page-action': {
    type: 'page-action', title: '页面操作', description: '打开、点击、输入、等待和抽取', kind: 'action', acceptsIncoming: true, palette: true,
    flowOutputs: DEFAULT_FLOW, dataInputs: [], dataOutputs: [{ name: 'result', label: '结果' }],
  },
  'api-listen': {
    type: 'api-listen', title: '接口监听', description: '等待并提取页面接口响应', kind: 'action', acceptsIncoming: true, palette: true,
    flowOutputs: DEFAULT_FLOW, dataInputs: [], dataOutputs: [{ name: 'data', label: '接口数据' }],
  },
  'api-request': {
    type: 'api-request', title: '接口请求', description: '主动调用接口并保存响应', kind: 'action', acceptsIncoming: true, palette: true,
    flowOutputs: DEFAULT_FLOW, dataInputs: [], dataOutputs: [{ name: 'data', label: '接口数据' }],
  },
  'for-each': {
    type: 'for-each', title: '循环', description: '逐项执行循环体，由「本次循环结束」进入下一轮', kind: 'action', acceptsIncoming: true, palette: true,
    flowOutputs: [{ name: 'body', label: '循环体' }, { name: 'done', label: '完成' }], dataInputs: [{ name: 'collection', label: '列表数据' }], dataOutputs: [{ name: 'item', label: '当前项' }, { name: 'index', label: '当前索引' }],
  },
  'open-page': {
    type: 'open-page',
    title: '打开页面',
    description: '打开一个 URL',
    kind: 'action',
    acceptsIncoming: true,
    palette: true,
    flowOutputs: DEFAULT_FLOW,
    dataInputs: [],
    dataOutputs: [{ name: 'url', label: 'URL' }],
  },
  click: {
    type: 'click',
    title: '点击',
    description: '点击页面上的元素',
    kind: 'action',
    acceptsIncoming: true,
    palette: true,
    flowOutputs: DEFAULT_FLOW,
    dataInputs: [],
    dataOutputs: [],
  },
  type: {
    type: 'type',
    title: '输入',
    description: '向输入框写入文本',
    kind: 'action',
    acceptsIncoming: true,
    palette: true,
    flowOutputs: DEFAULT_FLOW,
    dataInputs: [{ name: 'text', label: '文本' }],
    dataOutputs: [],
  },
  extract: {
    type: 'extract',
    title: '抽取',
    description: '从页面抽出文本',
    kind: 'action',
    acceptsIncoming: true,
    palette: true,
    flowOutputs: DEFAULT_FLOW,
    dataInputs: [],
    dataOutputs: [{ name: 'text', label: '文本' }],
  },
  wait: {
    type: 'wait',
    title: '等待条件',
    description: '等待元素出现、消失或固定时长',
    kind: 'action',
    acceptsIncoming: true,
    palette: true,
    flowOutputs: DEFAULT_FLOW,
    dataInputs: [],
    dataOutputs: [],
  },
  agent: {
    type: 'agent',
    title: 'Agent',
    description: '交给模型，输出 JSON 供下游使用',
    kind: 'decision',
    acceptsIncoming: true,
    palette: true,
    flowOutputs: DEFAULT_FLOW,
    dataInputs: [],
    dataOutputs: [{ name: 'json', label: 'AI 结果' }],
  },
  condition: {
    type: 'condition',
    title: '条件',
    description: '比较上游变量后分支',
    kind: 'decision',
    acceptsIncoming: true,
    palette: true,
    flowOutputs: [
      { name: 'matched', label: '匹配' },
      { name: 'else', label: '否则' },
    ],
    dataInputs: [{ name: 'left', label: '比较值' }],
    dataOutputs: [],
  },
  switch: {
    type: 'switch', title: '多路判断', description: '按值选择多个分支', kind: 'decision', acceptsIncoming: true, palette: true,
    flowOutputs: [{ name: 'case-0', label: '分支 1' }, { name: 'else', label: '否则' }], dataInputs: [{ name: 'left', label: '判断值' }], dataOutputs: [],
  },
  'image-recognition': {
    type: 'image-recognition', title: '图片识别', description: '读取变量中的图片，按视觉内容选择分支', kind: 'decision', acceptsIncoming: true, palette: true,
    flowOutputs: [{ name: 'else', label: '否则' }], dataInputs: [{ name: 'image', label: '图片' }], dataOutputs: [{ name: 'imageResult', label: '识别结果' }],
  },
  'call-subflow': {
    type: 'call-subflow', title: '调用子流程', description: '复用另一条流程', kind: 'action', acceptsIncoming: true, palette: true,
    flowOutputs: DEFAULT_FLOW, dataInputs: [], dataOutputs: [],
  },
  approval: {
    type: 'approval', title: '人工审批', description: '暂停流程，等待当前执行人通过或拒绝', kind: 'decision', acceptsIncoming: true, palette: true,
    flowOutputs: [{ name: 'approved', label: '通过' }, { name: 'rejected', label: '拒绝' }, { name: 'timeout', label: '超时' }], dataInputs: [],
    dataOutputs: [{ name: 'approved', label: '是否通过' }, { name: 'decision', label: '审批结果' }, { name: 'comment', label: '审批意见' }],
  },
  handoff: {
    type: 'handoff', title: '人工接管', description: '暂停并等待人工处理', kind: 'action', acceptsIncoming: true, palette: true,
    flowOutputs: DEFAULT_FLOW, dataInputs: [], dataOutputs: [],
  },
  'set-variable': {
    type: 'set-variable', title: '设置变量', description: '将值写入流程上下文', kind: 'action', acceptsIncoming: true, palette: true,
    flowOutputs: DEFAULT_FLOW, dataInputs: [{ name: 'value', label: '变量值' }], dataOutputs: [],
  },
  transform: {
    type: 'transform', title: '数据转换', description: '处理页面或节点输出', kind: 'action', acceptsIncoming: true, palette: true,
    flowOutputs: DEFAULT_FLOW, dataInputs: [{ name: 'input', label: '输入值' }], dataOutputs: [{ name: 'result', label: '结果' }],
  },
  code: {
    type: 'code', title: '用户代码', description: '用 JavaScript 自定义处理数据', kind: 'action', acceptsIncoming: true, palette: true,
    flowOutputs: DEFAULT_FLOW, dataInputs: [{ name: 'input', label: '输入值' }], dataOutputs: [{ name: 'result', label: '结果' }],
  },
  'continue-loop': {
    type: 'continue-loop',
    title: '本次循环结束',
    description: '结束当前轮，自动进入下一轮；无需连回循环入口',
    kind: 'terminal',
    acceptsIncoming: true,
    palette: true,
    flowOutputs: [],
    dataInputs: [],
    dataOutputs: [],
  },
  end: {
    type: 'end',
    title: '结束',
    description: '流程终止',
    kind: 'terminal',
    acceptsIncoming: true,
    palette: true,
    flowOutputs: [],
    dataInputs: [],
    dataOutputs: [],
  },
}

const HIDDEN_LEGACY = new Set<NodeType>(['open-page', 'click', 'type'])
export const PALETTE_TYPES = (Object.values(NODE_CATALOG).filter(definition => definition.palette && !HIDDEN_LEGACY.has(definition.type))).map(
  definition => definition.type,
)

export function literalBinding(value: JsonValue = ''): ValueBinding {
  return { kind: 'literal', value }
}

export function nodeOutputBinding(nodeId: string, port: string): ValueBinding {
  return { kind: 'node-output', nodeId, port }
}

export function defaultBindings(type: NodeType): Record<string, ValueBinding> {
  switch (type) {
    case 'type':
      return { text: literalBinding('') }
    case 'condition':
      return { left: literalBinding('') }
    case 'image-recognition':
      return { image: literalBinding('') }
    case 'set-variable':
      return { value: literalBinding('') }
    case 'transform':
      return { input: literalBinding('') }
    case 'code':
      return { input: literalBinding('') }
    default:
      return {}
  }
}

export function defaultConfig(type: NodeType): NodeConfig {
  switch (type) {
    case 'start':
      return { type: 'start', url: 'https://example.com' }
    case 'page-action':
      return { type: 'page-action', steps: [] }
    case 'api-listen':
      return { type: 'api-listen', urlPattern: '', matchMode: 'contains', method: 'ANY', responseType: 'json', jsonPath: 'data.records', outputName: 'tableData', rawOutputName: 'responseData', fields: [], requestParams: [], timeoutMs: 10000 }
    case 'api-request':
      return { type: 'api-request', url: '', method: 'GET', queryParams: [], headers: [], body: '', responseType: 'json', jsonPath: '', outputName: 'responseData', rawOutputName: 'rawResponseData', fields: [], timeoutMs: 15000 }
    case 'for-each':
      return { type: 'for-each', collection: literalBinding([]), condition: '', itemVar: 'item', indexVar: 'index', declaredVariables: [], maxItems: 100, retryCount: 2, onItemError: 'skip' }
    case 'open-page':
      return { type: 'open-page', url: '' }
    case 'click':
      return { type: 'click', selector: '', beforeHover: '', waitForVisible: '' }
    case 'type':
      return { type: 'type', selector: '', text: literalBinding(''), path: '' }
    case 'extract':
      return { type: 'extract', selector: '', outputName: 'text', mode: 'text', rowSelector: '', fields: [], transform: undefined, ai: undefined }
    case 'wait':
      return { type: 'wait', mode: 'visible', ms: 10000, selector: '' }
    case 'agent':
      return { type: 'agent', systemPrompt: DEFAULT_AGENT_PROMPT, userPrompt: '请根据提示完成任务，并以 JSON 格式返回结果。', outputName: 'json', dryAction: 'note' }
    case 'condition':
      return { type: 'condition', left: literalBinding(''), path: '', equals: '', mode: 'value', selector: '', operator: 'equals', clauses: [{ binding: literalBinding(''), operator: 'equals', value: '' }], logic: 'and', waitForCondition: false, waitTimeoutMs: 10000, pollIntervalMs: 500, aiPrompt: '', llmId: undefined }
    case 'switch':
      return { type: 'switch', left: literalBinding(''), path: '', cases: [''], caseTypes: ['string'], caseIds: [newId('case')], aiContext: '' }
    case 'image-recognition':
      return { type: 'image-recognition', image: literalBinding(''), path: '', comparisonEnabled: false, comparisonSourceMode: 'upload', comparisonImage: '', comparisonImageName: '', comparisonImages: [], comparisonImageSource: literalBinding(''), comparisonImagePath: '', comparisonPrompt: '', instruction: '', cases: [{ id: newId('case'), name: '', prompt: '' }], outputName: 'imageResult' }
    case 'call-subflow':
      return { type: 'call-subflow', workflowId: '', workflowVersion: undefined, inputMappings: [] }
    case 'approval':
      return { type: 'approval', title: '请确认是否继续执行', description: '请检查以下信息后进行审批。', fields: [], requireCommentOnReject: true, timeoutMinutes: 30 }
    case 'handoff':
      return { type: 'handoff', note: '' }
    case 'set-variable':
      return { type: 'set-variable', name: '', value: literalBinding(''), path: '' }
    case 'transform':
      return { type: 'transform', input: literalBinding(''), operation: 'trim', pattern: '', replacement: '', outputName: 'result' }
    case 'code':
      return { type: 'code', preset: 'identity', input: literalBinding(''), inputs: [], outputs: [{ name: 'result', valueType: 'any', outputMode: 'produce' }], code: 'return { result: input.value };', outputName: 'result' }
    case 'continue-loop':
      return { type: 'continue-loop' }
    case 'end':
      return { type: 'end' }
  }
}

export function defaultName(type: NodeType): string {
  return NODE_CATALOG[type].title
}

export function defaultExecution() {
  return DEFAULT_EXECUTION
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`
}
