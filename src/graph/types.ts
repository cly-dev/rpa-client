export const NODE_TYPES = [
  'start',
  'open-page',
  'click',
  'type',
  'extract',
  'wait',
  'agent',
  'condition',
  'switch',
  'image-recognition',
  'call-subflow',
  'approval',
  'handoff',
  'set-variable',
  'transform',
  'code',
  'continue-loop',
  'end',
  'page-action',
  'for-each',
  'api-listen',
  'api-request',
] as const

export type NodeType = (typeof NODE_TYPES)[number]

export const ROUTE_ACTIONS = ['note', 'handoff', 'email'] as const

export type RouteAction = (typeof ROUTE_ACTIONS)[number]

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type OutputVariableMode = 'produce' | 'declare' | 'update'

export interface NodePosition {
  readonly x: number
  readonly y: number
}

export type ValueBinding =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'workflow-input'; readonly name: string }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'node-output'; readonly nodeId: string; readonly port: string }
  | { readonly kind: 'runtime'; readonly path: 'page.url' | 'page.title' | 'runtime.executionId' }

export interface NodeExecutionPolicy {
  readonly timeoutMs: number
  readonly maxAttempts: number
  readonly onError: 'fail-run' | 'human-handoff'
}

export type NodeNotificationTrigger = 'onSuccess' | 'onFailure' | 'onApprovalPending' | 'onApprovalApproved' | 'onApprovalRejected' | 'onApprovalTimeout'

export interface NodeNotificationConfig {
  readonly enabled?: boolean
  readonly onSuccess?: boolean
  readonly onFailure?: boolean
  readonly onApprovalPending?: boolean
  readonly onApprovalApproved?: boolean
  readonly onApprovalRejected?: boolean
  readonly onApprovalTimeout?: boolean
  /** Status-specific content. Keys match the corresponding notification switches. */
  readonly messageTemplates?: Readonly<Partial<Record<NodeNotificationTrigger, string>>>
  /** Legacy shared content retained as a fallback for older workflows. */
  readonly messageTemplate?: string
}

export interface WorkflowWebhookConfig {
  readonly url: string
  readonly onFinished?: boolean
  readonly bodyTemplate?: string
  readonly provider?: 'generic' | 'dingtalk'
  readonly messageTemplate?: string
}

export interface StartConfig {
  readonly type: 'start'
  readonly url: string
}

export interface OpenPageConfig {
  readonly type: 'open-page'
  readonly url: string
}

export type PageActionStep =
  | { readonly type: 'open'; readonly url: string; readonly waitAfterMs?: number }
  | { readonly type: 'click'; readonly selector: string | ElementLocator; readonly beforeHover?: string | ElementLocator; readonly waitForVisible?: string | ElementLocator; readonly optionValue?: string; readonly waitAfterMs?: number }
  | { readonly type: 'type'; readonly selector: string | ElementLocator; readonly value: ValueBinding; readonly ai?: GenerateTextConfig; readonly waitAfterMs?: number }
  | { readonly type: 'hover'; readonly selector: string | ElementLocator; readonly waitAfterMs?: number }
  | { readonly type: 'wait'; readonly ms: number; readonly selector?: string | ElementLocator; readonly waitAfterMs?: number }
  | { readonly type: 'extract'; readonly selector: string | ElementLocator; readonly outputName: string; readonly outputMode?: OutputVariableMode; readonly updateVariable?: string; readonly mode: 'text' | 'value' | 'html'; readonly ai?: ExtractAiConfig; readonly waitAfterMs?: number }

export interface PageActionConfig { readonly type: 'page-action'; readonly steps: readonly PageActionStep[] }
export interface ApiListenField { readonly name: string; readonly path: string }
export interface ApiRequestParam { readonly name: string; readonly value: string }
export interface ApiListenConfig { readonly type: 'api-listen'; readonly urlPattern: string; readonly matchMode: 'contains' | 'equals' | 'regex'; readonly method: string; readonly responseType: 'json' | 'text'; readonly jsonPath: string; readonly outputName: string; readonly outputMode?: OutputVariableMode; readonly updateVariable?: string; readonly rawOutputName?: string; readonly fields?: readonly ApiListenField[]; readonly requestParams?: readonly ApiRequestParam[]; readonly timeoutMs: number }
export interface ApiRequestConfig { readonly type: 'api-request'; readonly url: string; readonly method: string; readonly queryParams?: readonly ApiRequestParam[]; readonly headers?: readonly ApiRequestParam[]; readonly body: string; readonly responseType: 'json' | 'text'; readonly jsonPath: string; readonly outputName: string; readonly outputMode?: OutputVariableMode; readonly updateVariable?: string; readonly rawOutputName?: string; readonly fields?: readonly ApiListenField[]; readonly timeoutMs: number }
export interface LoopConditionClause { readonly binding: ValueBinding; readonly path?: string; readonly transform?: { readonly operation: 'add' | 'subtract' | 'multiply' | 'divide'; readonly value: string }; readonly operator: 'equals' | 'notEquals' | 'contains' | 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual' | 'isEmpty' | 'isNotEmpty'; readonly value?: JsonValue }
export interface ForEachConfig { readonly type: 'for-each'; readonly collection: ValueBinding; readonly condition?: string; readonly conditionClauses?: readonly LoopConditionClause[]; readonly conditionLogic?: 'and' | 'or'; readonly itemVar: string; readonly indexVar: string; readonly declaredVariables?: readonly string[]; readonly maxItems: number; readonly retryCount: number; readonly onItemError: 'skip' | 'stop' }

export type LocatorStrategy = 'css' | 'xpath' | 'text' | 'role' | 'label' | 'placeholder' | 'testId'

export interface ElementLocator {
  readonly strategy: LocatorStrategy
  readonly value: string
  readonly name?: string
}

export interface ClickConfig {
  readonly type: 'click'
  readonly selector: string | ElementLocator
  readonly beforeHover?: string | ElementLocator
  readonly waitForVisible?: string | ElementLocator
}

export interface TypeConfig {
  readonly type: 'type'
  readonly selector: string | ElementLocator
  readonly text: ValueBinding
  readonly path: string
}

export interface ExtractConfig {
  readonly type: 'extract'
  readonly selector: string | ElementLocator
  readonly outputName: string
  readonly outputMode?: OutputVariableMode
  readonly updateVariable?: string
  readonly mode: 'text' | 'value' | 'html' | 'list'
  readonly rowSelector?: string
  readonly fields?: readonly ExtractField[]
  readonly transform?: ExtractTransform
  readonly ai?: ExtractAiConfig
}

export interface ExtractField { readonly name: string; readonly selector: string; readonly attribute?: string }
export interface ExtractTransform {
  readonly operation: TransformOperation
  readonly pattern?: string
  readonly replacement?: string
}
export interface ExtractAiConfig {
  readonly enabled: boolean
  readonly fields: readonly string[]
  readonly prompt?: string
  readonly llmId?: string
}
export interface GenerateTextConfig { readonly enabled: boolean; readonly prompt: string; readonly llmId?: string }

export interface WaitConfig {
  readonly type: 'wait'
  /** Omitted in legacy workflows: selector means visible, otherwise duration. */
  readonly mode?: 'duration' | 'visible' | 'hidden'
  readonly ms: number
  readonly selector: string | ElementLocator
}

export interface AgentOutputField {
  readonly name: string
  readonly valueType: 'string' | 'number' | 'boolean' | 'object' | 'array'
  readonly description: string
  readonly outputMode?: OutputVariableMode
  readonly updateVariable?: string
}

export interface AgentConfig {
  readonly type: 'agent'
  readonly systemPrompt: string
  readonly task: string
  readonly outputs: readonly AgentOutputField[]
  readonly llmId?: string
  readonly dryAction: RouteAction
}

export interface ConditionConfig {
  readonly type: 'condition'
  readonly left: ValueBinding
  readonly path: string
  readonly equals: string
  readonly mode?: 'value' | 'url' | 'element' | 'ai'
  readonly selector?: string | ElementLocator
  readonly operator?: 'equals' | 'contains' | 'visible' | 'exists'
  readonly aiPrompt?: string
  readonly llmId?: string
  readonly clauses?: readonly ConditionClause[]
  readonly logic?: 'and' | 'or'
  /** When enabled, keep evaluating until the condition is true or times out. */
  readonly waitForCondition?: boolean
  readonly waitTimeoutMs?: number
  readonly pollIntervalMs?: number
}

export interface ConditionClause {
  readonly binding: ValueBinding
  readonly path?: string
  readonly operator: 'equals' | 'notEquals' | 'contains' | 'greaterThan' | 'lessThan' | 'isEmpty' | 'isNotEmpty'
  readonly value?: JsonValue
}

export interface SwitchConfig {
  readonly type: 'switch'
  readonly mode?: 'value' | 'ai'
  readonly left: ValueBinding
  readonly path: string
  readonly cases: readonly string[]
  /** Omitted in older workflows, where all case values are strings. */
  readonly caseTypes?: readonly ('string' | 'number' | 'boolean' | 'null')[]
  /** Stable editor identities; flow port names remain case-<index>. */
  readonly caseIds?: readonly string[]
  readonly casePrompts?: readonly string[]
  readonly llmId?: string
  readonly aiSystemPrompt?: string
  /** Supplemental business data and context supplied to the AI classifier. */
  readonly aiContext?: string
}

export interface ImageRecognitionCase {
  /** Stable identifier used by flow edges even when cases are reordered. */
  readonly id: string
  readonly name: string
  readonly prompt: string
}

export interface ImageRecognitionConfig {
  readonly type: 'image-recognition'
  readonly image: ValueBinding
  readonly path: string
  /** Maximum number of runtime input images included in one recognition call. */
  readonly maxImages?: number
  /** Optional reference-image comparison used together with all runtime images. */
  readonly comparisonEnabled?: boolean
  readonly comparisonSourceMode?: 'upload' | 'variable'
  /** Legacy single embedded image, retained for older saved workflows. */
  readonly comparisonImage?: string
  readonly comparisonImageName?: string
  readonly comparisonImages?: readonly { readonly dataUrl: string; readonly name: string }[]
  readonly comparisonImageSource?: ValueBinding
  readonly comparisonImagePath?: string
  /** Business-specific instructions for comparing runtime images with the reference image. */
  readonly comparisonPrompt?: string
  readonly instruction: string
  readonly cases: readonly ImageRecognitionCase[]
  readonly llmId?: string
  readonly outputName: string
  readonly outputMode?: OutputVariableMode
  readonly updateVariable?: string
}

export interface CallSubflowConfig {
  readonly type: 'call-subflow'
  readonly workflowId: string
  /** Exact published revision to execute; child updates never change this call silently. */
  readonly workflowVersion?: number
  readonly inputMappings?: readonly CallSubflowInputMapping[]
}

export interface CallSubflowInputMapping {
  readonly inputName: string
  readonly source: ValueBinding
}

export interface ApprovalField {
  readonly label: string
  readonly value: ValueBinding
  readonly path?: string
}

export interface ApprovalConfig {
  readonly type: 'approval'
  readonly title: string
  readonly description: string
  readonly fields: readonly ApprovalField[]
  readonly requireCommentOnReject: boolean
  readonly timeoutMinutes: number
}

export interface ApprovalPrompt {
  readonly id: string
  readonly executionId: string
  readonly workflowId: string
  readonly nodeId: string
  readonly nodeName: string
  readonly title: string
  readonly description: string
  readonly fields: readonly { readonly label: string; readonly value: JsonValue }[]
  readonly requireCommentOnReject: boolean
  readonly timeoutAt?: string
  readonly notifications?: NodeNotificationConfig
  readonly notificationValues?: Readonly<Record<string, JsonValue>>
}

export interface ApprovalDecision {
  readonly decision: 'approved' | 'rejected' | 'timeout'
  readonly comment: string
  readonly approverId?: string
  readonly approverName: string
  readonly decidedAt: string
}

export interface HandoffConfig {
  readonly type: 'handoff'
  readonly note: string
}

export interface SetVariableConfig {
  readonly type: 'set-variable'
  readonly name: string
  readonly value: ValueBinding
  readonly path: string
  /** Evaluate template text for a runtime-injected subflow input. */
  readonly interpolate?: boolean
  /** Internal guard used by runtime-injected subflow inputs. */
  readonly requiredInput?: { readonly name: string; readonly type: 'string' | 'number' | 'boolean' | 'object' | 'array' }
}

export type TransformOperation = 'trim' | 'uppercase' | 'lowercase' | 'regex' | 'replace' | 'json-parse' | 'json-stringify'
export interface TransformConfig {
  readonly type: 'transform'
  readonly input: ValueBinding
  readonly operation: TransformOperation
  readonly pattern: string
  readonly replacement: string
  readonly outputName: string
  readonly outputMode?: OutputVariableMode
  readonly updateVariable?: string
}
export interface CodeConfig {
  readonly type: 'code'
  readonly preset?: 'identity' | 'trim' | 'uppercase' | 'lowercase' | 'timestamp' | 'json-parse' | 'custom'
  /** Legacy single-input binding retained when loading older workflows. */
  readonly input: ValueBinding
  readonly inputs?: readonly { readonly name: string; readonly binding: ValueBinding }[]
  readonly outputs?: readonly { readonly name: string; readonly valueType?: 'any' | 'string' | 'number' | 'boolean' | 'object' | 'array'; readonly outputMode?: OutputVariableMode; readonly updateVariable?: string }[]
  readonly code: string
  readonly outputName: string
  readonly outputMode?: OutputVariableMode
  readonly updateVariable?: string
}

export interface EndConfig {
  readonly type: 'end'
}

export interface ContinueLoopConfig {
  readonly type: 'continue-loop'
}

export type NodeConfig =
  | StartConfig
  | PageActionConfig
  | ApiListenConfig
  | ApiRequestConfig
  | ForEachConfig
  | OpenPageConfig
  | ClickConfig
  | TypeConfig
  | ExtractConfig
  | WaitConfig
  | AgentConfig
  | ConditionConfig
  | SwitchConfig
  | ImageRecognitionConfig
  | CallSubflowConfig
  | ApprovalConfig
  | HandoffConfig
  | SetVariableConfig
  | TransformConfig
  | CodeConfig
  | ContinueLoopConfig
  | EndConfig

export interface WorkflowNode {
  readonly id: string
  readonly type: NodeType
  readonly name: string
  readonly position: NodePosition
  readonly inputBindings: Readonly<Record<string, ValueBinding>>
  readonly config: NodeConfig
  readonly execution: NodeExecutionPolicy
  readonly notifications?: NodeNotificationConfig
}

export interface WorkflowEdge {
  readonly id: string
  readonly sourceNodeId: string
  readonly sourcePort: string
  readonly targetNodeId: string
  /** ELK-generated canvas route; omitted when the edge has not been formatted. */
  readonly layoutPoints?: readonly NodePosition[]
}

export interface WorkflowGraph {
  readonly workflowId: string
  readonly name: string
  readonly version: number
  readonly entryNodeId: string
  readonly nodes: readonly WorkflowNode[]
  readonly edges: readonly WorkflowEdge[]
  readonly webhook?: WorkflowWebhookConfig
  readonly context?: WorkflowContextDefinition
  readonly llm?: WorkflowLlmConfig
  readonly llms?: readonly WorkflowLlmConfig[]
}

export interface WorkflowLlmConfig {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly provider?: string
  readonly model: string
  readonly baseUrl: string
  readonly chatPath: string
  readonly apiKey: string
  readonly temperature?: number
  readonly maxTokens: number
}

export interface WorkflowContextVariable {
  readonly name: string
  readonly type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  readonly required?: boolean
  readonly defaultValue?: JsonValue
  readonly secret?: boolean
  readonly description?: string
}

export interface WorkflowContextDefinition {
  readonly inputs: readonly WorkflowContextVariable[]
  readonly variables: readonly WorkflowContextVariable[]
}

export interface WorkflowProject {
  readonly projectId: string
  readonly name: string
  readonly version: number
  readonly entryWorkflowId: string
  readonly workflows: readonly WorkflowGraph[]
}

export type ValidationCode =
  | 'empty-name'
  | 'entry-count'
  | 'terminal-count'
  | 'entry-mismatch'
  | 'dangling-edge'
  | 'unknown-port'
  | 'occupied-output'
  | 'missing-outgoing'
  | 'missing-incoming'
  | 'unconnected-output'
  | 'unreachable-node'
  | 'invalid-target'
  | 'agent-prompt-empty'
  | 'condition-ai-prompt-empty'
  | 'unknown-binding'
  | 'duplicate-id'
  | 'unknown-subflow'
  | 'switch-empty-case'
  | 'switch-invalid-case'
  | 'switch-duplicate-case'
  | 'image-recognition-invalid'
  | 'missing-entry-workflow'
  | 'subflow-cycle'
  | 'declared-variable-empty'
  | 'wait-selector-empty'
  | 'api-request-url-invalid'
  | 'api-request-timeout-invalid'
  | 'api-request-parameter-empty'
  | 'api-request-body-invalid'
  | 'subflow-required-input'
  | 'subflow-input-type-mismatch'
  | 'webhook-url-invalid'
  | 'webhook-url-missing'
  | 'webhook-body-invalid'

export interface ValidationIssue {
  readonly code: ValidationCode
  readonly nodeId?: string
  readonly edgeId?: string
  readonly workflowId?: string
  readonly message: string
}

export type NodeRunStatus = 'pending' | 'running' | 'waiting-user' | 'succeeded' | 'failed' | 'skipped'

export type NodeOutputs = Readonly<Record<string, JsonValue>>

export const DEFAULT_EXECUTION: NodeExecutionPolicy = {
  timeoutMs: 30_000,
  maxAttempts: 1,
  onError: 'human-handoff',
}

export const DEFAULT_AGENT_PROMPT = [
  '你是严谨的业务处理助手。',
  '只根据系统提示、任务内容及其中已经解析的变量数据生成结果，不得编造不存在的信息。',
  '严格遵循程序提供的输出字段、类型和字段说明。',
].join('\n')
