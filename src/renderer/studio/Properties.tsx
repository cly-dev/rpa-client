import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { NODE_CATALOG, newId, type DataPort } from '@graph/catalog.ts'
import { validateGraph, validatePublishConnections } from '@graph/validate.ts'
import { subflowInputTypeWarning } from '@graph/subflow-input-types.ts'
import type { CallSubflowInputMapping, LoopConditionClause, NodeConfig, NodeNotificationConfig, NodeNotificationTrigger, OutputVariableMode as OutputVariableModeType, PageActionStep, SwitchConfig, ValueBinding, WorkflowGraph, WorkflowNode } from '@graph/types.ts'
import { reorderSwitchCase, switchCaseId, switchCaseLabel, switchCaseType, switchCaseValue, type SwitchCaseType } from '@graph/switch-cases.ts'
import { reorderImageRecognitionCase } from '@graph/image-recognition-cases.ts'
import { DEFAULT_IMAGE_RECOGNITION_MAX_IMAGES, MAX_IMAGE_RECOGNITION_MAX_IMAGES, normalizeImageRecognitionMaxImages } from '@graph/image-recognition-limits.ts'
import { reorderPageActionStep } from '@graph/page-action-steps.ts'
import { getWorkflowRevision, listWorkflowRevisions, listWorkflows, listWorkspaces, RPA_SERVICE_URL, type WorkflowListItem, type WorkflowRevisionItem } from '../workflow-api.ts'
import { CodeNodeEditor } from './CodeNodeEditor.tsx'
import { RequestBodyEditor, availableVariables } from './RequestBodyEditor.tsx'
import { WebhookTestButton } from './WebhookTestButton.tsx'
import { notificationContentError } from '@graph/webhook-body-template.ts'
import { displaySubflowReferences, outputReferenceAliases, storeSubflowReferences } from './SubflowReferenceLabels.ts'
import { availableSubflowVariableNames } from './subflow-variables.ts'
import { upstreamNodes } from './upstream-nodes.ts'
import { reconcileSubflowMappings, type MappingReconciliation } from './subflow-version.ts'
import { importNodeJson } from './json-transfer.ts'
import { displayPickedSelector } from './selector-display.ts'

const SubflowVariableContext = createContext<readonly string[]>([])
const CurrentNodeIdContext = createContext('')
const MAX_COMPARISON_IMAGE_BYTES = 2 * 1024 * 1024
const COMPARISON_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片内容')) }
    reader.onerror = () => { reject(new Error('无法读取图片文件')) }
    reader.readAsDataURL(file)
  })
}

interface NodePatch {
  readonly name?: string
  readonly config?: NodeConfig
  readonly execution?: WorkflowNode['execution']
  readonly inputBindings?: Readonly<Record<string, ValueBinding>>
  readonly notifications?: NodeNotificationConfig
}

type PickerField = 'selector' | 'beforeHover' | 'waitForVisible' | 'rowSelector' | 'extractField'
  | 'listContainerSelector' | 'listRowSelector' | 'listMatchField' | 'listMatchedAction' | 'listDeleteSelector' | 'listConfirmSelector'

interface Props {
  readonly graph: WorkflowGraph
  readonly node: WorkflowNode | undefined
  readonly subflows?: readonly WorkflowGraph[]
  readonly subflowError?: string
  readonly llmError?: string
  readonly onChange: (id: string, patch: NodePatch) => void
  readonly onBatchSubflowVersion: (workflowId: string, version: number) => Promise<void>
  readonly batchSubflowBusy: boolean
  readonly onImport: (node: WorkflowNode) => void
  readonly onDelete?: (id: string) => void
  readonly onRun: (id: string) => void
  readonly onPick: (id: string, field: PickerField, stepIndex?: number) => void
}

export function Properties({ graph, node, subflows = [], subflowError, llmError, onChange, onBatchSubflowVersion, batchSubflowBusy, onImport, onDelete, onRun, onPick }: Props): ReactNode {
  const [jsonDialog, setJsonDialog] = useState<'view' | 'import'>()
  const [jsonDraft, setJsonDraft] = useState('')
  const [jsonError, setJsonError] = useState<string>()
  const [copyLabel, setCopyLabel] = useState('复制 JSON')
  if (node === undefined) {
    return (
      <aside className="properties">
        <div className="properties-empty-state"><span>⚙</span><h2>节点配置</h2><p>从画布选择一个节点，即可在这里配置参数、变量和运行策略。</p></div>
      </aside>
    )
  }

  const definition = NODE_CATALOG[node.type]
  const incoming = graph.edges.filter(edge => edge.targetNodeId === node.id)
  const outgoing = graph.edges.filter(edge => edge.sourceNodeId === node.id)
  const subflowVariableNames = availableSubflowVariableNames(graph, subflows, node.id)
  const nodeIssues = [...validateGraph(graph, subflows), ...validatePublishConnections(graph)].filter(issue => issue.nodeId === node.id)
  const hasNotificationTrigger = node.notifications?.onSuccess === true || node.notifications?.onFailure === true || node.notifications?.onApprovalPending === true || node.notifications?.onApprovalApproved === true || node.notifications?.onApprovalRejected === true || node.notifications?.onApprovalTimeout === true
  const notificationEnabled = node.notifications?.enabled ?? hasNotificationTrigger
  const notificationOptions: readonly { readonly trigger: NodeNotificationTrigger; readonly label: string }[] = [
    { trigger: 'onSuccess', label: '节点成功' },
    { trigger: 'onFailure', label: '节点失败' },
    ...(node.type === 'approval' ? [
      { trigger: 'onApprovalPending' as const, label: '待审批' },
      { trigger: 'onApprovalApproved' as const, label: '审批通过' },
      { trigger: 'onApprovalRejected' as const, label: '审批拒绝' },
      { trigger: 'onApprovalTimeout' as const, label: '审批超时' },
    ] : []),
  ]

  return (
    <CurrentNodeIdContext.Provider value={node.id}>
    <SubflowVariableContext.Provider value={subflowVariableNames}>
    <aside className="properties">
      <div className="properties-topbar"><div className="properties-title"><h2>节点配置</h2><span className="properties-kind">{definition.title}</span></div><button type="button" className="run-node-button" onClick={() => { onRun(node.id) }}>▶ 运行节点</button></div>
      <div className="properties-json-actions"><button type="button" onClick={() => { setJsonDraft(JSON.stringify(node, null, 2)); setJsonError(undefined); setCopyLabel('复制 JSON'); setJsonDialog('view') }}>查看节点 JSON</button><button type="button" onClick={() => { setJsonDraft(JSON.stringify(node, null, 2)); setJsonError(undefined); setJsonDialog('import') }}>导入节点 JSON</button></div>
      <p className="properties-description">{definition.description}</p>
      {nodeIssues.length > 0 ? <div className="properties-validation"><strong>此节点有 {nodeIssues.length} 项待处理</strong><ul>{nodeIssues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul></div> : null}
      {subflowError ? <p className="properties-hint">子流程变量未能加载：{subflowError}</p> : null}
      {llmError ? <p className="properties-hint">AI 配置未能从服务端加载：{llmError}</p> : null}
      <label className="properties-name-field">
        名称
        <input value={node.name} onChange={event => { onChange(node.id, { name: event.target.value }) }} />
      </label>
      <ConfigFields
        graph={graph}
        node={node}
        onChange={(config, inputBindings) => { onChange(node.id, { config, inputBindings }) }}
        onBatchSubflowVersion={onBatchSubflowVersion}
        batchSubflowBusy={batchSubflowBusy}
        onPick={(field, stepIndex) => { onPick(node.id, field, stepIndex) }}
      />
      <section className="node-notification-config">
        <div className="node-notification-header"><h3>Webhook 通知</h3><label className="node-notification-option"><input type="checkbox" checked={notificationEnabled} onChange={event => {
          const enabled = event.target.checked
          onChange(node.id, { notifications: { ...node.notifications, enabled, ...(enabled && !hasNotificationTrigger ? node.type === 'approval' ? { onApprovalPending: true } : { onSuccess: true } : {}) } })
        }} />启用 Webhook</label></div>
        {notificationEnabled ? <>
          <p className="properties-hint">发送到流程设置中的钉钉机器人地址；仅执行中心运行已发布版本时发送。</p>
          {hasNotificationTrigger && !graph.webhook?.url.trim() ? <p className="properties-hint node-notification-warning">已启用节点通知，请在右上角「更多操作 → Webhook 通知设置」填写地址后发布。</p> : null}
          {notificationOptions.map(({ trigger, label }) => {
            const checked = node.notifications?.[trigger] === true
            const template = node.notifications?.messageTemplates?.[trigger] ?? node.notifications?.messageTemplate ?? ''
            const templateError = notificationContentError(template)
            return <div key={trigger} className="node-notification-status"><label className="node-notification-option"><input type="checkbox" checked={checked} onChange={event => { onChange(node.id, { notifications: { ...node.notifications, [trigger]: event.target.checked } }) }} />{label}</label>{checked && (graph.webhook?.provider ?? 'dingtalk') === 'dingtalk' ? <div className="node-notification-message"><label>{label}通知内容<textarea spellCheck={false} value={template} placeholder="留空则使用流程默认文案" onChange={event => { onChange(node.id, { notifications: { ...node.notifications, messageTemplates: { ...node.notifications?.messageTemplates, [trigger]: event.target.value } } }) }} /></label><p className="properties-hint">支持变量，例如 {'{{event.node.name}}'}、{'{{inputs.orderId}}'}、{'{{变量名}}'}。仅在“{label}”状态下使用，留空则继承流程默认文案。</p><select aria-label={`插入${label}通知变量`} value="" onChange={event => { if (event.target.value) onChange(node.id, { notifications: { ...node.notifications, messageTemplates: { ...node.notifications?.messageTemplates, [trigger]: `${template}{{${event.target.value}}}` } } }) }}><option value="">＋ 插入变量</option><option value="event.node.name">节点名称</option><option value="event.message">事件说明</option>{availableVariables(graph, node.id, subflowVariableNames).map(name => <option key={name} value={name}>{name}</option>)}</select>{templateError ? <p className="webhook-body-error">{templateError}</p> : null}<WebhookTestButton url={graph.webhook?.url ?? ''} messageTemplate={template || graph.webhook?.messageTemplate || ''} workflowName={graph.name} nodeName={node.name} /></div> : null}</div>
          })}
        </> : <p className="properties-hint">开启后可设置通知时机和内容。</p>}
      </section>
      {node.type !== 'start' && node.type !== 'end' ? (
        <>
          <label>
            超时（毫秒）
            <input
              type="number"
              min={1}
              value={node.execution.timeoutMs}
              onChange={event => {
                onChange(node.id, { execution: { ...node.execution, timeoutMs: Number(event.target.value) } })
              }}
            />
          </label>
          <label>
            重试次数
            <input
              type="number"
              min={1}
              max={20}
              value={node.execution.maxAttempts}
              onChange={event => {
                onChange(node.id, { execution: { ...node.execution, maxAttempts: Number(event.target.value) } })
              }}
            />
          </label>
          <label>
            失败时
            <select
              value={node.execution.onError}
              onChange={event => {
                const onError = event.target.value === 'fail-run' ? 'fail-run' : 'human-handoff'
                onChange(node.id, { execution: { ...node.execution, onError } })
              }}
            >
              <option value="human-handoff">停下来等人</option>
              <option value="fail-run">失败整次运行</option>
            </select>
          </label>
        </>
      ) : null}
      <p className="properties-meta">入边 {incoming.length} · 出边 {outgoing.length} · {node.id}</p>
      {node.type === 'start' ? <p className="properties-hint">开始节点是入口，不能删除。</p> : null}
      {jsonDialog ? <div className="json-dialog-backdrop" role="presentation" onClick={() => { setJsonDialog(undefined) }}><section className="json-dialog" role="dialog" aria-modal="true" aria-label={jsonDialog === 'view' ? '查看节点 JSON' : '导入节点 JSON'} onClick={event => { event.stopPropagation() }}><header><div><h2>{jsonDialog === 'view' ? '查看节点 JSON' : '导入节点 JSON'}</h2><p>{jsonDialog === 'view' ? '可复制当前节点的完整配置。' : '粘贴同类型节点 JSON；节点 ID、位置和现有连线将保持不变。'}</p></div><button type="button" aria-label="关闭" onClick={() => { setJsonDialog(undefined) }}>×</button></header><textarea value={jsonDraft} readOnly={jsonDialog === 'view'} spellCheck={false} onChange={event => { setJsonDraft(event.target.value); setJsonError(undefined) }} />{jsonError ? <p className="json-dialog-error" role="alert">{jsonError}</p> : null}<footer><button type="button" onClick={() => { setJsonDialog(undefined) }}>取消</button>{jsonDialog === 'view' ? <button type="button" className="workbench-primary" onClick={() => { void navigator.clipboard.writeText(jsonDraft).then(() => { setCopyLabel('已复制') }).catch(() => { setCopyLabel('复制失败') }) }}>{copyLabel}</button> : <button type="button" className="workbench-primary" onClick={() => { try { onImport(importNodeJson(jsonDraft, node)); setJsonDialog(undefined) } catch (error) { setJsonError(error instanceof Error ? error.message : '节点 JSON 导入失败') } }}>确认导入</button>}</footer></section></div> : null}
    </aside>
    </SubflowVariableContext.Provider>
    </CurrentNodeIdContext.Provider>
  )
}

function ConfigFields({
  graph,
  node,
  onChange,
  onBatchSubflowVersion,
  batchSubflowBusy,
  onPick,
}: {
  graph: WorkflowGraph
  node: WorkflowNode
  onChange: (config: NodeConfig, inputBindings?: Readonly<Record<string, ValueBinding>>) => void
  onBatchSubflowVersion: (workflowId: string, version: number) => Promise<void>
  batchSubflowBusy: boolean
  onPick: (field: PickerField, stepIndex?: number) => void
}): ReactNode {
  const config = node.config
  const subflowVariableNames = useContext(SubflowVariableContext)
  switch (config.type) {
    case 'open-page':
      return <label>URL<input value={config.url} onChange={event => { onChange({ ...config, url: event.target.value }) }} /></label>
    case 'click':
      return <>
        <label>点击选择器<div className="picker-field"><input value={selectorText(config.selector)} onChange={event => { onChange({ ...config, selector: event.target.value }) }} /><button type="button" onClick={() => { onPick('selector') }}>拾取</button></div></label>
        <label>点击前 Hover（可选）<div className="picker-field"><input value={selectorText(config.beforeHover ?? '')} onChange={event => { onChange({ ...config, beforeHover: event.target.value }) }} placeholder="例如 .more-menu" /><button type="button" onClick={() => { onPick('beforeHover') }}>拾取</button></div></label>
        <label>Hover 后等待出现（可选）<div className="picker-field"><input value={selectorText(config.waitForVisible ?? '')} onChange={event => { onChange({ ...config, waitForVisible: event.target.value }) }} placeholder="例如 .menu-item" /><button type="button" onClick={() => { onPick('waitForVisible') }}>拾取</button></div></label>
        <p className="properties-hint">执行顺序：Hover → 等待目标出现 → 点击。</p>
      </>
    case 'type':
      return (
        <>
          <label>选择器<div className="picker-field"><input value={selectorText(config.selector)} onChange={event => { onChange({ ...config, selector: event.target.value }) }} /><button type="button" onClick={() => { onPick('selector') }}>拾取</button></div></label>
          <BindingField
            graph={graph}
            nodeId={node.id}
            label="文本"
            binding={config.text}
            onChange={text => { onChange({ ...config, text }, { ...node.inputBindings, text }) }}
          />
          <label>字段路径<input value={config.path} onChange={event => { onChange({ ...config, path: event.target.value }) }} /></label>
        </>
      )
    case 'extract':
      return <>
        <label>结果变量名<input value={config.outputName} onChange={event => { onChange({ ...config, outputName: event.target.value }) }} placeholder={config.mode === 'list' ? '例如 tickets' : '例如 title'} /></label>
        <OutputVariableMode graph={graph} mode={config.outputMode} target={config.updateVariable} onChange={(outputMode, updateVariable) => { onChange({ ...config, outputMode, updateVariable }) }} />
        <label>抽取方式<select value={config.mode} onChange={event => { const mode = event.target.value; onChange({ ...config, mode: mode === 'value' || mode === 'html' || mode === 'list' ? mode : 'text' }) }}><option value="text">单元素文本</option><option value="value">Value 属性</option><option value="html">HTML</option><option value="list">列表/表格</option></select></label>
        {config.mode !== 'list' ? <label>目标元素<div className="picker-field"><input value={selectorText(config.selector)} readOnly placeholder="点击拾取页面元素" /><button type="button" onClick={() => { onPick('selector') }}>拾取元素</button></div></label> : null}
        {config.mode === 'list' ? <><label>列表容器<div className="picker-field"><input value={config.rowSelector ?? ''} onChange={event => { onChange({ ...config, rowSelector: event.target.value }) }} placeholder="点击拾取整个列表区域" /><button type="button" onClick={() => { onPick('rowSelector') }}>拾取列表</button></div></label><label className="llm-switch"><input type="checkbox" checked={config.ai?.enabled === true} onChange={event => { onChange({ ...config, ai: { enabled: event.target.checked, fields: config.ai?.fields ?? [], prompt: config.ai?.prompt ?? '', llmId: config.ai?.llmId } }) }} />使用 AI 辅助抽取</label>{config.ai?.enabled ? <div className="extract-ai-config"><label>使用的 AI<select value={config.ai.llmId ?? graph.llms?.[0]?.id ?? ''} onChange={event => { onChange({ ...config, ai: { ...config.ai!, llmId: event.target.value } }) }}><option value="">默认 AI</option>{(graph.llms ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="ai-field-editor"><div className="ai-field-editor-title"><strong>输出字段</strong><button type="button" onClick={() => { onChange({ ...config, ai: { ...config.ai!, fields: [...config.ai!.fields, ''] } }) }}>＋添加字段</button></div>{config.ai.fields.map((field, index) => <div className="ai-field-row" key={`ai-field-${index}`}><input value={field} placeholder="例如：订单号" onChange={event => { onChange({ ...config, ai: { ...config.ai!, fields: config.ai!.fields.map((item, i) => i === index ? event.target.value : item) } }) }} /><button type="button" onClick={() => { onChange({ ...config, ai: { ...config.ai!, fields: config.ai!.fields.filter((_, i) => i !== index) } }) }}>删除</button></div>)}</div><label>补充提示词<textarea rows={3} value={config.ai.prompt ?? ''} onChange={event => { onChange({ ...config, ai: { ...config.ai!, prompt: event.target.value } }) }} placeholder="例如：订单号只保留编号；详情链接输出 href；没有值时返回空字符串。" /></label><p className="properties-hint">AI 会读取整个列表并返回结构化结果。运行当前节点后，可在产出预览中查看 AI 输出。</p></div> : <p className="properties-hint">可直接拾取整个列表，或启用 AI 自动识别字段。</p>}{(config.fields ?? []).length > 0 ? <div className="extract-fields"><strong>高级字段规则（可选）</strong>{(config.fields ?? []).map((field, index) => <div className="extract-field" key={`${field.name}-${index}`}><input value={field.name} placeholder="字段名" onChange={event => { onChange({ ...config, fields: (config.fields ?? []).map((item, i) => i === index ? { ...item, name: event.target.value } : item) }) }} /><div className="picker-field"><input value={field.selector} readOnly placeholder="点击拾取字段" /><button type="button" onClick={() => { onPick('extractField', index) }}>拾取</button></div><input value={field.attribute ?? ''} placeholder="属性（可选）" onChange={event => { onChange({ ...config, fields: (config.fields ?? []).map((item, i) => i === index ? { ...item, attribute: event.target.value || undefined } : item) }) }} /><button type="button" onClick={() => { onChange({ ...config, fields: (config.fields ?? []).filter((_, i) => i !== index) }) }}>删除</button></div>)}</div> : null}</> : null}
        <div className="extract-transform">
          {config.transform === undefined ? <button type="button" onClick={() => { onChange({ ...config, transform: { operation: 'trim', pattern: '', replacement: '' } }) }}>＋添加结果转换</button> : <>
            <div className="extract-transform-heading"><strong>结果转换</strong><button type="button" onClick={() => { onChange({ ...config, transform: undefined }) }}>移除</button></div>
            <select value={config.transform.operation} onChange={event => { onChange({ ...config, transform: { ...config.transform!, operation: event.target.value as typeof config.transform.operation } }) }}>
              <option value="trim">去除首尾空格</option><option value="uppercase">转大写</option><option value="lowercase">转小写</option><option value="regex">正则提取</option><option value="replace">文本替换</option><option value="json-parse">解析 JSON</option><option value="json-stringify">序列化 JSON</option>
            </select>
            {config.transform.operation === 'regex' || config.transform.operation === 'replace' ? <input value={config.transform.pattern ?? ''} placeholder="正则或查找文本" onChange={event => { onChange({ ...config, transform: { ...config.transform!, pattern: event.target.value } }) }} /> : null}
            {config.transform.operation === 'replace' ? <input value={config.transform.replacement ?? ''} placeholder="替换为" onChange={event => { onChange({ ...config, transform: { ...config.transform!, replacement: event.target.value } }) }} /> : null}
          </>}
        </div>
      </>
    case 'wait':
      {
        const mode = config.mode ?? (selectorText(config.selector).trim() ? 'visible' : 'duration')
        return <div className="wait-config">
          <label>等待方式<select value={mode} onChange={event => {
            const nextMode = event.target.value as 'duration' | 'visible' | 'hidden'
            onChange({ ...config, mode: nextMode, ms: nextMode === 'duration' ? Math.min(config.ms, 5000) : Math.max(config.ms, 10000) })
          }}><option value="visible">元素出现并可见</option><option value="hidden">元素消失或隐藏</option><option value="duration">固定等待时长</option></select></label>
          {mode === 'duration' ? <label>等待时长（毫秒）<input type="number" min={0} value={config.ms} onChange={event => { onChange({ ...config, ms: Math.max(0, Number(event.target.value)) }) }} /></label> : <>
            <label>目标元素<div className="picker-field"><input value={selectorText(config.selector)} onChange={event => { onChange({ ...config, selector: event.target.value }) }} placeholder="点击拾取，或填写 CSS 选择器" /><button type="button" onClick={() => { onPick('selector') }}>拾取元素</button></div></label>
            <label>最大等待时间（毫秒）<input type="number" min={1} value={config.ms} onChange={event => { onChange({ ...config, ms: Math.max(1, Number(event.target.value)) }) }} /></label>
            <p className="properties-hint">流程会停在此节点，直到元素{mode === 'visible' ? '出现且可见' : '隐藏或从页面移除'}；超过最大等待时间后按节点失败策略处理。</p>
          </>}
        </div>
      }
    case 'agent':
      return <AgentFields graph={graph} config={config} onChange={onChange} />
    case 'condition':
      if (config.mode === 'ai') return <div className="condition-form"><label>我想判断<select value="ai" onChange={event => { const mode = event.target.value as typeof config.mode; onChange({ ...config, mode }) }}><option value="value">一个变量的值</option><option value="url">当前页面 URL</option><option value="element">页面元素</option><option value="ai">AI 判断</option></select></label><ConditionAiFields graph={graph} node={node} config={config} onChange={onChange} /></div>
      if (config.clauses !== undefined) return <ConditionClauses graph={graph} node={node} config={config} onChange={onChange} />
      return (
        <div className="condition-form">
          <ConditionWaitFields config={config} onChange={next => { onChange(next) }} />
          <label>我想判断<select value={config.mode ?? 'value'} onChange={event => { const mode = event.target.value as typeof config.mode; onChange({ ...config, mode }) }}><option value="value">一个变量的值</option><option value="url">当前页面 URL</option><option value="element">页面元素</option><option value="ai">AI 判断</option></select></label>
          {config.mode === 'ai' ? <ConditionAiFields graph={graph} node={node} config={config} onChange={onChange} /> : null}
          {config.mode === 'url' ? <><label>URL<select value={config.operator ?? 'contains'} onChange={event => { onChange({ ...config, operator: event.target.value as typeof config.operator }) }}><option value="contains">包含</option><option value="equals">等于</option></select></label><input className="condition-main-input" value={config.equals} onChange={event => { onChange({ ...config, equals: event.target.value }) }} placeholder="例如 /home" /></> : null}
          {config.mode === 'element' ? <><label>元素是否<select value={config.operator ?? 'visible'} onChange={event => { onChange({ ...config, operator: event.target.value as typeof config.operator }) }}><option value="visible">可见</option><option value="exists">存在</option></select></label><div className="picker-field"><input className="condition-main-input" value={selectorText(config.selector ?? '')} onChange={event => { onChange({ ...config, selector: event.target.value }) }} placeholder="元素选择器" /><button type="button" onClick={() => { onPick('selector') }}>拾取</button></div></> : null}
          {config.mode !== 'url' && config.mode !== 'element' && config.mode !== 'ai' ? <><BindingField graph={graph} nodeId={node.id} label="变量" binding={config.left} onChange={left => { onChange({ ...config, left }, { ...node.inputBindings, left }) }} /><label>字段路径（可选）<input value={config.path} onChange={event => { onChange({ ...config, path: event.target.value }) }} placeholder="例如 status" /></label><label>等于<input value={config.equals} onChange={event => { onChange({ ...config, equals: event.target.value }) }} /></label></> : null}
          <div className="condition-branches"><span>满足条件 → matched</span><span>不满足 → else</span></div>
        </div>
      )
    case 'switch':
      return (
        <div className="switch-config">
          <label>判断方式<select value={config.mode ?? 'value'} onChange={event => { onChange({ ...config, mode: event.target.value === 'ai' ? 'ai' : 'value', caseTypes: undefined }) }}><option value="value">精确匹配</option><option value="ai">AI 场景判断</option></select></label>
          <BindingField graph={graph} nodeId={node.id} label={config.mode === 'ai' ? '判断内容来源' : '判断值'} binding={config.left} onChange={left => { onChange({ ...config, left }, { ...node.inputBindings, left }) }} />
          <label>字段路径<input value={config.path} onChange={event => { onChange({ ...config, path: event.target.value }) }} placeholder="例如 intent" /></label>
          {config.mode === 'ai' ? <>
            <label>使用的 AI<select value={config.llmId ?? ''} onChange={event => { onChange({ ...config, llmId: event.target.value || undefined }) }}><option value="">默认 AI</option>{(graph.llms ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>判断依据变量名<input value={config.reasonOutputName ?? 'reason'} onChange={event => { onChange({ ...config, reasonOutputName: event.target.value }) }} placeholder="例如 reason 或 routeReason" /></label>
            <p className="properties-hint">AI 会固定输出简短判断依据，并写入该变量；后续节点可使用 <code>{`{{${config.reasonOutputName?.trim() || 'reason'}}}`}</code> 引用。</p>
            <label>补充数据与上下文<textarea rows={5} value={config.aiContext ?? ''} onChange={event => { onChange({ ...config, aiContext: event.target.value }) }} placeholder={'例如：\n客户等级：{{customer.level}}\n店铺：{{shop.name}}\n订单详情：{{order}}\n判断时优先参考客户等级和订单状态。'} /></label>
            <p className="properties-hint">支持 <code>{'{{变量名}}'}</code> 引用流程变量、循环变量和前置节点产出；对象和数组会作为 JSON 提供给 AI。请只填写与本次判断有关的数据。</p>
            <div className="switch-ai-branches">
              <div className="ai-field-editor-title"><strong>判断场景 · {config.cases.length} 路</strong><button type="button" onClick={() => { onChange({ ...config, cases: [...config.cases, ''], caseIds: [...config.cases.map((_, index) => switchCaseId(config, index)), newId('case')], casePrompts: [...config.cases.map((_, index) => config.casePrompts?.[index] ?? ''), ''] }) }}>＋添加场景</button></div>
              {config.cases.map((name, index) => <div className="switch-ai-branch" key={switchCaseId(config, index)}>
                <div className="switch-ai-branch-heading"><strong>优先级 {String(index + 1).padStart(2, '0')}</strong><div className="switch-ai-branch-order"><button type="button" title="上移场景" aria-label={`上移场景 ${index + 1}`} disabled={index === 0} onClick={() => { onChange(reorderSwitchCase(config, index, index - 1)) }}>↑</button><button type="button" title="下移场景" aria-label={`下移场景 ${index + 1}`} disabled={index === config.cases.length - 1} onClick={() => { onChange(reorderSwitchCase(config, index, index + 1)) }}>↓</button></div><button type="button" disabled={config.cases.length <= 1} onClick={() => { onChange({ ...config, cases: config.cases.filter((_, i) => i !== index), caseIds: config.cases.map((_, i) => switchCaseId(config, i)).filter((_, i) => i !== index), casePrompts: config.cases.map((_, i) => config.casePrompts?.[i] ?? '').filter((_, i) => i !== index) }) }}>删除</button></div>
                <label>场景名称<input aria-label={`场景 ${index + 1} 名称`} value={name} onChange={event => { onChange({ ...config, cases: config.cases.map((item, i) => i === index ? event.target.value : item) }) }} placeholder="例如：辱骂投诉" /></label>
                <label>判断要求<textarea aria-label={`${name.trim() || `场景 ${index + 1}`} 的判断要求`} rows={3} value={config.casePrompts?.[index] ?? ''} onChange={event => { onChange({ ...config, casePrompts: config.cases.map((_, i) => i === index ? event.target.value : config.casePrompts?.[i] ?? '') }) }} placeholder="描述什么内容应进入此场景，可引用 {{变量名}}" /></label>
              </div>)}
              <div className="switch-ai-else"><strong>否则出口</strong> · 所有场景均不符合时进入</div>
            </div>
            <p className="properties-hint">AI 按上方优先级选择第一个符合的场景。名称显示在画布出口，判断要求用于模型识别；调整顺序不会丢失原有连线。</p>
          </> : <SwitchExactCasesEditor config={config} onChange={onChange} />}
        </div>
      )
    case 'image-recognition': {
      const comparisonImages = config.comparisonImages?.length
        ? config.comparisonImages
        : config.comparisonImage?.trim() ? [{ dataUrl: config.comparisonImage, name: config.comparisonImageName ?? '' }] : []
      return <div className="switch-config image-recognition-config">
        <BindingField graph={graph} nodeId={node.id} label="图片来源变量" binding={config.image} onChange={image => { onChange({ ...config, image }, { ...node.inputBindings, image }) }} />
        <label>字段路径（可选）<input value={config.path} onChange={event => { onChange({ ...config, path: event.target.value }) }} placeholder="例如 data.imageUrl" /></label>
        <label>最多识别图片数<input type="number" min={1} max={MAX_IMAGE_RECOGNITION_MAX_IMAGES} step={1} value={config.maxImages ?? DEFAULT_IMAGE_RECOGNITION_MAX_IMAGES} onChange={event => { onChange({ ...config, maxImages: normalizeImageRecognitionMaxImages(event.currentTarget.valueAsNumber) }) }} /></label>
        <p className="properties-hint">支持单张图片或图片数组，本节点会按原顺序最多识别 {config.maxImages ?? DEFAULT_IMAGE_RECOGNITION_MAX_IMAGES} 张（系统上限 {MAX_IMAGE_RECOGNITION_MAX_IMAGES} 张）；超出的图片不会传给 AI。每项可为图片 URL、data:image/...;base64、Base64 字符串，或包含 url、imageUrl、base64 字段的对象。全部入选图片会在一次 AI 调用中综合判断，最终只进入一条支路。</p>
        <label>使用的视觉 AI<select value={config.llmId ?? ''} onChange={event => { onChange({ ...config, llmId: event.target.value || undefined }) }}><option value="">默认 AI</option>{(graph.llms ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>统一判断要求（可选）<textarea rows={3} value={config.instruction} onChange={event => { onChange({ ...config, instruction: event.target.value }) }} placeholder="例如只依据图片可见内容判断，不推测图片之外的信息" /></label>
        <section className="image-comparison-panel">
          <label className="image-comparison-toggle"><input type="checkbox" checked={config.comparisonEnabled === true} onChange={event => { onChange({ ...config, comparisonEnabled: event.target.checked }) }} /><span><strong>启用图片对比</strong><small>将待识别图片与一组参考图进行综合比较</small></span></label>
          {config.comparisonEnabled === true ? <div className="image-comparison-fields">
            <div className="image-comparison-source-tabs" role="group" aria-label="对比图片来源"><button type="button" className={(config.comparisonSourceMode ?? 'upload') === 'upload' ? 'active' : ''} onClick={() => { onChange({ ...config, comparisonSourceMode: 'upload' }) }}>上传图片</button><button type="button" className={config.comparisonSourceMode === 'variable' ? 'active' : ''} onClick={() => { onChange({ ...config, comparisonSourceMode: 'variable' }) }}>来源变量</button></div>
            {(config.comparisonSourceMode ?? 'upload') === 'upload' ? <div className="image-comparison-upload-list">
              {comparisonImages.map((item, index) => <div className="image-comparison-preview" key={`${item.name}-${index}`}><img src={item.dataUrl} alt={`对比参考图 ${index + 1}`} /><div><strong>{item.name.trim() || `对比参考图 ${index + 1}`}</strong><span>参考图 {index + 1} · 随流程配置保存</span></div><button type="button" onClick={() => { onChange({ ...config, comparisonImages: comparisonImages.filter((_, itemIndex) => itemIndex !== index), comparisonImage: '', comparisonImageName: '' }) }}>移除</button></div>)}
              {comparisonImages.length < 8 ? <label className="image-comparison-upload">{comparisonImages.length === 0 ? '上传对比图片（可多选）' : `继续添加对比图片（${comparisonImages.length}/8）`}<input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => {
              const files = Array.from(event.currentTarget.files ?? [])
              event.currentTarget.value = ''
              if (files.length === 0) return
              if (comparisonImages.length + files.length > 8) { window.alert('对比图片最多上传 8 张'); return }
              if (files.some(file => !COMPARISON_IMAGE_TYPES.has(file.type))) { window.alert('仅支持 PNG、JPEG、WebP 或 GIF 图片'); return }
              if (files.some(file => file.size > MAX_COMPARISON_IMAGE_BYTES)) { window.alert('每张对比图片不能超过 2 MB'); return }
              void Promise.all(files.map(async file => ({ dataUrl: await readImageFile(file), name: file.name }))).then(items => { onChange({ ...config, comparisonImages: [...comparisonImages, ...items], comparisonImage: '', comparisonImageName: '' }) }).catch(error => { window.alert(error instanceof Error ? error.message : '无法读取图片文件') })
            }} /></label> : null}
            </div> : <div className="image-comparison-variable"><BindingField graph={graph} nodeId={node.id} label="对比图片来源变量" binding={config.comparisonImageSource ?? { kind: 'literal', value: '' }} onChange={comparisonImageSource => { onChange({ ...config, comparisonImageSource }, { ...node.inputBindings, comparisonImageSource }) }} /><label>字段路径（可选）<input value={config.comparisonImagePath ?? ''} onChange={event => { onChange({ ...config, comparisonImagePath: event.target.value }) }} placeholder="例如 data.referenceImages" /></label><p className="properties-hint">变量内容支持单张图片或图片数组，每项可为图片 URL、Base64、data URL 或图片对象，最多读取 8 张。</p></div>}
            <label>图片对比要求（可选）<textarea rows={4} value={config.comparisonPrompt ?? ''} onChange={event => { onChange({ ...config, comparisonPrompt: event.target.value }) }} placeholder={'例如：重点比较版式、文字内容和金额是否与参考图一致；忽略截图尺寸差异。\n支持引用 {{变量名}}。'} /></label>
            <p className="properties-hint">参考图仅用于对比，不计入待识别图片数量；所有参考图和待识别图片会共同参与一次分支判断。</p>
          </div> : null}
        </section>
        <div className="switch-ai-branches"><div className="ai-field-editor-title"><strong>图片场景 · {config.cases.length} 路</strong><button type="button" onClick={() => { onChange({ ...config, cases: [...config.cases, { id: newId('case'), name: '', prompt: '' }] }) }}>＋添加场景</button></div>
          {config.cases.map((item, index) => <div className="switch-ai-branch" key={item.id}>
            <div className="switch-ai-branch-heading"><strong>优先级 {String(index + 1).padStart(2, '0')}</strong><div className="switch-ai-branch-order"><button type="button" title="上移场景" aria-label={`上移图片场景 ${index + 1}`} disabled={index === 0} onClick={() => { onChange(reorderImageRecognitionCase(config, index, index - 1)) }}>↑</button><button type="button" title="下移场景" aria-label={`下移图片场景 ${index + 1}`} disabled={index === config.cases.length - 1} onClick={() => { onChange(reorderImageRecognitionCase(config, index, index + 1)) }}>↓</button></div><button type="button" disabled={config.cases.length <= 1} onClick={() => { onChange({ ...config, cases: config.cases.filter(candidate => candidate.id !== item.id) }) }}>删除</button></div>
            <label>场景名称<input aria-label={`图片场景 ${index + 1} 名称`} value={item.name} onChange={event => { onChange({ ...config, cases: config.cases.map(candidate => candidate.id === item.id ? { ...candidate, name: event.target.value } : candidate) }) }} placeholder="例如：付款截图" /></label>
            <label>判断要求<textarea aria-label={`${item.name.trim() || `图片场景 ${index + 1}`} 的判断要求`} rows={5} value={item.prompt} onChange={event => { onChange({ ...config, cases: config.cases.map(candidate => candidate.id === item.id ? { ...candidate, prompt: event.target.value } : candidate) }) }} placeholder={'命中条件：描述什么情况下属于该场景。\n排除条件：描述容易混淆但不应命中的情况。\n必要证据：说明图片中必须能看到什么。'} /></label>
          </div>)}
          <div className="switch-ai-else"><strong>否则出口</strong> · 所有图片场景均不符合时进入</div>
        </div>
        <p className="properties-hint">AI 会先按图片对比要求提取相关差异，再独立判断上面的每个场景；程序按优先级选择第一个命中的支路。名称显示在画布出口，调整顺序不会丢失原有连线。</p>
        <label>识别结果变量名<input value={config.outputName} onChange={event => { onChange({ ...config, outputName: event.target.value }) }} placeholder="例如 imageResult" /></label>
        <OutputVariableMode graph={graph} mode={config.outputMode} target={config.updateVariable} onChange={(outputMode, updateVariable) => { onChange({ ...config, outputMode, updateVariable }) }} />
      </div>
    }
    case 'call-subflow':
      return <CallSubflowEditor graph={graph} node={node} config={config} onChange={onChange} onBatchSubflowVersion={onBatchSubflowVersion} batchSubflowBusy={batchSubflowBusy} />
    case 'approval':
      return <ApprovalEditor graph={graph} node={node} config={config} onChange={onChange} />
    case 'handoff':
      return <label>人工处理说明<textarea rows={5} value={config.note} onChange={event => { onChange({ ...config, note: event.target.value }) }} placeholder="告诉操作人员需要检查什么" /></label>
    case 'set-variable':
      {
        const valueText = bindingTemplateText(config.value)
        return (
        <>
          <label>变量名<input value={config.name} onChange={event => { onChange({ ...config, name: event.target.value }) }} placeholder="例如 order.currentId" /></label>
          <VariableReferencePicker graph={graph} />
          <label>变量值<textarea rows={6} value={valueText} onChange={event => {
            const value = { kind: 'literal' as const, value: event.target.value }
            onChange({ ...config, value, interpolate: true }, { ...node.inputBindings, value })
          }} placeholder={'支持多行文本，例如：\n订单号：{{orderId}}\n处理结果：{{result}}'} /></label>
          <p className="properties-hint">支持多行内容和变量引用，例如 <code>{'{{变量名}}'}</code>、<code>{'{{inputs.输入名}}'}</code>、<code>{'{{order.id}}'}</code>；运行时会替换为实际值。</p>
          <label>字段路径<input value={config.path} onChange={event => { onChange({ ...config, path: event.target.value }) }} placeholder="可选，例如 data.id" /></label>
        </>
        )
      }
    case 'transform':
      return (
        <>
          <BindingField graph={graph} nodeId={node.id} label="输入值" binding={config.input} onChange={input => { onChange({ ...config, input }, { ...node.inputBindings, input }) }} />
          <label>处理方式<select value={config.operation} onChange={event => { const operation = event.target.value as typeof config.operation; onChange({ ...config, operation }) }}><option value="trim">去除首尾空格</option><option value="uppercase">转大写</option><option value="lowercase">转小写</option><option value="regex">正则提取</option><option value="replace">文本替换</option><option value="json-parse">解析 JSON</option><option value="json-stringify">序列化 JSON</option></select></label>
          <label>正则/查找内容<input value={config.pattern} onChange={event => { onChange({ ...config, pattern: event.target.value }) }} /></label>
          <label>替换内容<input value={config.replacement} onChange={event => { onChange({ ...config, replacement: event.target.value }) }} /></label>
          <label>输出字段<input value={config.outputName} onChange={event => { onChange({ ...config, outputName: event.target.value }) }} /></label>
          <OutputVariableMode graph={graph} mode={config.outputMode} target={config.updateVariable} onChange={(outputMode, updateVariable) => { onChange({ ...config, outputMode, updateVariable }) }} />
        </>
      )
    case 'code':
      return <CodeNodeEditor graph={graph} nodeId={node.id} subflowVariableNames={subflowVariableNames} config={config} onChange={next => { onChange(next) }} />
    case 'start':
      return <><label>初始 URL（可选）<input value={config.url} onChange={event => { onChange({ ...config, url: event.target.value }) }} placeholder="https://example.com" /></label><p className="properties-hint">填写后，流程进入开始节点时会跳转到该地址。留空时不会跳转；若当前已有可用浏览器页面，会继续沿用。没有可用页面且后续需要网页操作时，请填写 URL。</p></>
    case 'end':
      return null
    case 'continue-loop':
      return <p className="properties-hint">执行到这里会结束当前这一轮，自动返回循环节点判断是否进入下一轮。此节点只能放在循环体内，不需要连接出口；全部循环结束后会从循环节点的“完成”出口继续。</p>
    case 'for-each':
      return <div className="loop-config">
        <section className="loop-config-section">
          <div className="loop-section-title"><strong>1. 循环数据源</strong><span>可选</span></div>
          <BindingField graph={graph} nodeId={node.id} label="选择数组或变量" binding={config.collection} onChange={collection => { onChange({ ...config, collection }, { ...node.inputBindings, collection }) }} />
          <p className="properties-hint">选择一个数组变量后，每次循环会处理其中一项；也可以不选，单独使用循环条件。</p>
        </section>
        <section className="loop-config-section loop-condition-section">
          <div className="loop-section-title"><strong>2. 循环条件</strong><span>满足条件才继续</span></div>
          <div className="loop-logic-row"><span>条件关系</span><select value={config.conditionLogic ?? 'and'} onChange={event => { onChange({ ...config, conditionLogic: event.target.value === 'or' ? 'or' : 'and' }) }}><option value="and">全部满足（AND）</option><option value="or">任一满足（OR）</option></select></div>
          {(config.conditionClauses ?? []).map((clause, index) => <div className="loop-condition-row" key={`loop-condition-${index}`}>
            <BindingField graph={graph} nodeId={node.id} includeOwnLoopVariables label={`条件 ${index + 1}`} binding={clause.binding} onChange={binding => { onChange({ ...config, conditionClauses: (config.conditionClauses ?? []).map((item, i) => i === index ? { ...item, binding } : item) }) }} />
            <input value={clause.path ?? ''} onChange={event => { onChange({ ...config, conditionClauses: (config.conditionClauses ?? []).map((item, i) => i === index ? { ...item, path: event.target.value } : item) }) }} placeholder="字段路径（可选，如 status）" />
            <div className="loop-transform-row"><span>处理变量</span><select aria-label="变量处理方式" value={clause.transform?.operation ?? 'none'} onChange={event => { const operation = event.target.value as NonNullable<LoopConditionClause['transform']>['operation'] | 'none'; onChange({ ...config, conditionClauses: (config.conditionClauses ?? []).map((item, i) => i === index ? { ...item, transform: operation === 'none' ? undefined : { operation, value: item.transform?.value ?? '1' } } : item) }) }}><option value="none">不处理</option><option value="add">加</option><option value="subtract">减</option><option value="multiply">乘</option><option value="divide">除</option></select>{clause.transform ? <input value={clause.transform.value} onChange={event => { onChange({ ...config, conditionClauses: (config.conditionClauses ?? []).map((item, i) => i === index && item.transform ? { ...item, transform: { ...item.transform, value: event.target.value } } : item) }) }} placeholder="数值或 {{变量名}}" /> : null}</div>
            <select value={clause.operator} onChange={event => { onChange({ ...config, conditionClauses: (config.conditionClauses ?? []).map((item, i) => i === index ? { ...item, operator: event.target.value as LoopConditionClause['operator'] } : item) }) }}><option value="equals">等于</option><option value="notEquals">不等于</option><option value="contains">包含</option><option value="greaterThan">大于</option><option value="greaterThanOrEqual">大于等于</option><option value="lessThan">小于</option><option value="lessThanOrEqual">小于等于</option><option value="isEmpty">为空</option><option value="isNotEmpty">不为空</option></select>
            {clause.operator !== 'isEmpty' && clause.operator !== 'isNotEmpty' ? <input value={String(clause.value ?? '')} onChange={event => { onChange({ ...config, conditionClauses: (config.conditionClauses ?? []).map((item, i) => i === index ? { ...item, value: event.target.value } : item) }) }} placeholder="比较值，可写 {{变量名}}" /> : null}
            <button type="button" onClick={() => { onChange({ ...config, conditionClauses: (config.conditionClauses ?? []).filter((_, i) => i !== index) }) }}>删除</button>
          </div>)}
          <button type="button" className="loop-add-condition" onClick={() => { onChange({ ...config, conditionClauses: [...(config.conditionClauses ?? []), { binding: { kind: 'variable', name: config.itemVar || 'item' }, path: '', operator: 'equals', value: '' }] }) }}>＋添加条件</button>
          <p className="properties-hint">循环条件可选当前项和索引，因为它们会在每轮判断前赋值；循环体后续节点的产出不能直接作为本轮条件。若要在下一轮使用上一轮结果，请预先声明有初值的流程变量，并在循环体内更新。</p>
          {(config.conditionClauses ?? []).length === 0 && (config.condition?.trim() ?? '') === '' ? <p className="properties-hint">未添加条件时，默认执行到数组遍历结束；添加条件后，最多执行高级设置中的最大处理条数。</p> : null}
          {config.condition !== undefined && config.condition.trim() !== '' ? <details className="loop-legacy-condition"><summary>已存在旧版条件表达式</summary><input value={config.condition} onChange={event => { onChange({ ...config, condition: event.target.value }) }} /><p className="properties-hint">添加结构化条件后，将优先使用上面的条件行。</p></details> : null}
        </section>
        <section className="loop-config-section">
          <div className="loop-section-title"><strong>3. 循环变量</strong><button type="button" onClick={() => { onChange({ ...config, declaredVariables: [...(config.declaredVariables ?? []), ''] }) }}>＋添加变量</button></div>
          <p className="properties-hint">默认可用 <code>{config.itemVar || 'item'}</code>（当前项）和 <code>{config.indexVar || 'index'}</code>（当前序号）。需要额外名称时再添加。</p>
          {(config.declaredVariables ?? []).map((name, index) => <div className="ai-field-row" key={`loop-var-${index}`}><input value={name} placeholder="例如 order" onChange={event => { onChange({ ...config, declaredVariables: (config.declaredVariables ?? []).map((item, i) => i === index ? event.target.value : item) }) }} /><button type="button" onClick={() => { onChange({ ...config, declaredVariables: (config.declaredVariables ?? []).filter((_, i) => i !== index) }) }}>删除</button></div>)}
          {(config.declaredVariables ?? []).length === 0 ? <div className="loop-empty-state">暂未添加额外变量</div> : null}
          <p className="properties-hint">声明字段名后，会把当前项的同名字段作为独立变量。例如声明 <code>id</code> 后，可直接使用 <code>{'{{id}}'}</code>；仍可用 <code>{`{{${config.itemVar || 'item'}.id}}`}</code> 读取原始当前项。</p>
        </section>
        <details className="loop-advanced"><summary>高级设置</summary><div className="loop-advanced-grid">
          <label>最大处理条数<input type="number" min={1} value={config.maxItems} onChange={event => { onChange({ ...config, maxItems: Number(event.target.value) }) }} /></label>
          <label>单项重试次数<input type="number" min={0} value={config.retryCount} onChange={event => { onChange({ ...config, retryCount: Number(event.target.value) }) }} /></label>
          <label>单项失败策略<select value={config.onItemError} onChange={event => { onChange({ ...config, onItemError: event.target.value === 'stop' ? 'stop' : 'skip' }) }}><option value="skip">跳过当前项</option><option value="stop">停止整个流程</option></select></label>
          <label>当前项变量<input value={config.itemVar} onChange={event => { onChange({ ...config, itemVar: event.target.value }) }} placeholder="item" /></label>
          <label>当前索引变量<input value={config.indexVar} onChange={event => { onChange({ ...config, indexVar: event.target.value }) }} placeholder="index" /></label>
        </div></details>
        <p className="properties-hint loop-connection-hint">连接方式：“循环体”出口 → 处理节点 → “本次循环结束”节点；它会自动进入下一轮，无需连回循环入口。“完成”出口连接全部循环结束后的下一步。</p>
      </div>
    case 'page-action':
      return <><p className="properties-hint variable-injection-hint">页面操作中的 URL、选择器和输入内容都支持引用变量，例如 <code>{'{{tableData[0].id}}'}</code>。</p><PageActionEditor graph={graph} steps={config.steps} onChange={steps => { onChange({ ...config, steps }) }} onPick={onPick} /></>
    case 'list-row-action':
      return <ListRowActionEditor graph={graph} node={node} config={config} onChange={(next, source) => { onChange(next, source === undefined ? undefined : { ...node.inputBindings, source }) }} onPick={onPick} />
    case 'api-listen':
      return <div className="api-listen-form"><p className="properties-hint">监听页面已经发出的接口响应。通常将此节点放在触发查询的页面操作之后。</p><label>接口 URL 匹配<input value={config.urlPattern} onChange={event => { onChange({ ...config, urlPattern: event.target.value }) }} placeholder="例如 /api/orders" /></label><div className="api-listen-grid"><label>匹配方式<select value={config.matchMode} onChange={event => { onChange({ ...config, matchMode: event.target.value as typeof config.matchMode }) }}><option value="contains">包含</option><option value="equals">完全匹配</option><option value="regex">正则</option></select></label><label>请求方法<select value={config.method} onChange={event => { onChange({ ...config, method: event.target.value }) }}><option value="ANY">全部方法</option><option value="GET">GET</option><option value="POST">POST</option><option value="PUT">PUT</option><option value="DELETE">DELETE</option></select></label></div><div className="api-fields-editor"><div className="ai-field-editor-title"><strong>请求参数匹配（可选）</strong><button type="button" onClick={() => { onChange({ ...config, requestParams: [...(config.requestParams ?? []), { name: '', value: '' }] }) }}>＋添加参数</button></div>{(config.requestParams ?? []).map((param, index) => <div className="api-field-row" key={`api-param-${index}`}><input value={param.name} placeholder="参数名，例如 page" onChange={event => { onChange({ ...config, requestParams: (config.requestParams ?? []).map((item, i) => i === index ? { ...item, name: event.target.value } : item) }) }} /><input value={param.value} placeholder="参数值，例如 1 或 {{page}}" onChange={event => { onChange({ ...config, requestParams: (config.requestParams ?? []).map((item, i) => i === index ? { ...item, value: event.target.value } : item) }) }} /><button type="button" onClick={() => { onChange({ ...config, requestParams: (config.requestParams ?? []).filter((_, i) => i !== index) }) }}>删除</button></div>)}</div><div className="api-listen-grid"><label>响应类型<select value={config.responseType} onChange={event => { onChange({ ...config, responseType: event.target.value === 'text' ? 'text' : 'json' }) }}><option value="json">JSON</option><option value="text">文本</option></select></label><label>超时（毫秒）<input type="number" min={100} value={config.timeoutMs} onChange={event => { onChange({ ...config, timeoutMs: Number(event.target.value) }) }} /></label></div><label>主变量路径（可选）<input value={config.jsonPath} onChange={event => { onChange({ ...config, jsonPath: event.target.value }) }} placeholder="例如 data.records" /></label><label>主产出变量名<input value={config.outputName} onChange={event => { onChange({ ...config, outputName: event.target.value }) }} placeholder="例如 tableData" /></label><OutputVariableMode graph={graph} mode={config.outputMode} target={config.updateVariable} onChange={(outputMode, updateVariable) => { onChange({ ...config, outputMode, updateVariable }) }} /><label>原始响应变量名<input value={config.rawOutputName ?? 'responseData'} onChange={event => { onChange({ ...config, rawOutputName: event.target.value }) }} placeholder="例如 responseData" /></label><div className="api-fields-editor"><div className="ai-field-editor-title"><strong>额外字段变量</strong><button type="button" onClick={() => { onChange({ ...config, fields: [...(config.fields ?? []), { name: '', path: '' }] }) }}>＋添加字段</button></div>{(config.fields ?? []).map((field, index) => <div className="api-field-row" key={`api-field-${index}`}><input value={field.name} placeholder="变量名，例如 total" onChange={event => { onChange({ ...config, fields: (config.fields ?? []).map((item, i) => i === index ? { ...item, name: event.target.value } : item) }) }} /><input value={field.path} placeholder="路径，例如 data.total" onChange={event => { onChange({ ...config, fields: (config.fields ?? []).map((item, i) => i === index ? { ...item, path: event.target.value } : item) }) }} /><button type="button" onClick={() => { onChange({ ...config, fields: (config.fields ?? []).filter((_, i) => i !== index) }) }}>删除</button></div>)}</div><p className="properties-hint">支持嵌套路径和数组下标，例如 <code>data.records</code>、<code>data.orders[0].id</code>。</p></div>
    case 'api-request':
      return <ApiRequestEditor graph={graph} config={config} onChange={next => { onChange(next) }} />
  }
}

function SwitchExactCasesEditor({ config, onChange }: { config: SwitchConfig; onChange: (config: NodeConfig) => void }): ReactNode {
  const caseTypes = config.cases.map((_, index) => switchCaseType(config, index))
  const caseIds = config.cases.map((_, index) => switchCaseId(config, index))
  const updateCase = (index: number, raw: string, type = caseTypes[index]): void => {
    onChange({ ...config, cases: config.cases.map((item, i) => i === index ? raw : item), caseTypes: caseTypes.map((item, i) => i === index ? type : item), caseIds })
  }
  return (
    <section className="switch-exact-editor" aria-label="精确值匹配分支">
      <div className="switch-exact-heading"><div><strong>精确值匹配</strong><span>按顺序查找第一个相等的值</span></div><button type="button" onClick={() => { onChange({ ...config, cases: [...config.cases, ''], caseTypes: [...caseTypes, 'string'], caseIds: [...caseIds, newId('case')], casePrompts: [...(config.casePrompts ?? []), ''] }) }}>＋ 添加分支</button></div>
      {config.cases.map((raw, index) => {
        const type = caseTypes[index]
        const expected = switchCaseValue(config, index)
        const invalid = expected === undefined
        const duplicate = !invalid && config.cases.slice(0, index).some((_, otherIndex) => switchCaseType(config, otherIndex) === type && switchCaseValue(config, otherIndex) === expected)
        return <div className="switch-exact-case" key={caseIds[index]}>
          <div className="switch-exact-case-top"><strong>出口 {index + 1}</strong><span title={switchCaseLabel(config, index)}>{switchCaseLabel(config, index)}</span><button type="button" disabled={config.cases.length <= 1} aria-label={`删除出口 ${index + 1}`} onClick={() => { onChange({ ...config, cases: config.cases.filter((_, i) => i !== index), caseTypes: caseTypes.filter((_, i) => i !== index), caseIds: caseIds.filter((_, i) => i !== index), casePrompts: config.casePrompts?.filter((_, i) => i !== index) }) }}>删除</button></div>
          <div className="switch-exact-case-fields">
            <label>值类型<select aria-label={`出口 ${index + 1} 值类型`} value={type} onChange={event => {
              const nextType = event.target.value as SwitchCaseType
              const nextRaw = nextType === 'boolean' ? 'true' : nextType === 'null' ? 'null' : nextType === 'number' && (raw.trim() === '' || !Number.isFinite(Number(raw))) ? '' : raw
              updateCase(index, nextRaw, nextType)
            }}><option value="string">文本</option><option value="number">数字</option><option value="boolean">布尔值</option><option value="null">空值 null</option></select></label>
            {type === 'null' ? <div className="switch-exact-null">仅匹配 null</div> : <label>精确值{type === 'boolean' ? <select aria-label={`出口 ${index + 1} 精确值`} value={raw === 'false' ? 'false' : 'true'} onChange={event => { updateCase(index, event.target.value) }}><option value="true">true</option><option value="false">false</option></select> : <input aria-label={`出口 ${index + 1} 精确值`} type="text" inputMode={type === 'number' ? 'decimal' : 'text'} value={raw} onChange={event => { updateCase(index, event.target.value) }} placeholder={type === 'number' ? '例如 90' : '例如 approved'} />}</label>}
          </div>
          {invalid ? <p className="switch-exact-warning">请输入有效的{type === 'number' ? '数字' : '布尔值'}。</p> : null}
          {duplicate ? <p className="switch-exact-warning">与前面的出口重复，这个出口不会被命中。</p> : null}
        </div>
      })}
      <div className="switch-exact-else"><strong>否则</strong><span>所有值都不相等时进入</span></div>
      <p className="properties-hint">文本区分大小写并保留空格；数字 90 与文本“90”、布尔 true 与文本“true”不同。删除分支时，其连线会移除，后续分支的连线保持对应。</p>
    </section>
  )
}

function ApiRequestEditor({ graph, config, onChange }: { graph: WorkflowGraph; config: Extract<NodeConfig, { type: 'api-request' }>; onChange: (config: NodeConfig) => void }): ReactNode {
  const nodeId = useContext(CurrentNodeIdContext)
  const subflowVariableNames = useContext(SubflowVariableContext)
  const patch = (next: Partial<typeof config>): void => { onChange({ ...config, ...next }) }
  const editPairs = (key: 'queryParams' | 'headers', index: number, value: { name: string; value: string }): void => { patch({ [key]: (config[key] ?? []).map((item, i) => i === index ? value : item) } as Partial<typeof config>) }
  const addPair = (key: 'queryParams' | 'headers'): void => { patch({ [key]: [...(config[key] ?? []), { name: '', value: '' }] } as Partial<typeof config>) }
  const removePair = (key: 'queryParams' | 'headers', index: number): void => { patch({ [key]: (config[key] ?? []).filter((_, i) => i !== index) } as Partial<typeof config>) }
  return <div className="api-request-form">
    <VariableReferencePicker graph={graph} />
    <div className="api-form-section"><div className="api-form-heading"><strong>基础请求</strong><span>Node HTTP 直接请求</span></div>
      <label>请求 URL<input value={config.url} onChange={event => { patch({ url: event.target.value }) }} placeholder="https://example.com/api/orders/{{orderId}}" /></label>
      <p className="properties-hint">路径参数可直接引用变量，例如 <code>https://example.com/api/orders/{'{{orderId}}'}</code>；运行时会先替换变量，再发送请求。</p>
      <div className="api-listen-grid"><label>请求方法<select value={config.method} onChange={event => { patch({ method: event.target.value }) }}><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option></select></label><label>超时（毫秒）<input type="number" min={100} value={config.timeoutMs} onChange={event => { patch({ timeoutMs: Number(event.target.value) }) }} /></label></div>
      <p className="properties-hint">请求不会自动继承浏览器登录态；需要认证时，请在请求头中配置 Authorization、Cookie 等信息。</p>
    </div>
    <ApiPairSection title="查询参数" items={config.queryParams ?? []} add={() => { addPair('queryParams') }} edit={(index, value) => { editPairs('queryParams', index, value) }} remove={index => { removePair('queryParams', index) }} />
    <ApiPairSection title="请求头" items={config.headers ?? []} add={() => { addPair('headers') }} edit={(index, value) => { editPairs('headers', index, value) }} remove={index => { removePair('headers', index) }} />
    <div className="api-form-section"><div className="api-form-heading"><strong>请求体</strong><span>支持变量注入</span></div><RequestBodyEditor graph={graph} nodeId={nodeId} subflowVariableNames={subflowVariableNames} value={config.body} method={config.method} onChange={body => { patch({ body }) }} /></div>
    <div className="api-form-section"><div className="api-form-heading"><strong>响应输出</strong><span>主变量 + 多个字段变量</span></div>
      <div className="api-listen-grid"><label>响应类型<select value={config.responseType} onChange={event => { patch({ responseType: event.target.value === 'text' ? 'text' : 'json' }) }}><option value="json">JSON</option><option value="text">文本</option></select></label><label>主变量 JSON 路径<input value={config.jsonPath} onChange={event => { patch({ jsonPath: event.target.value }) }} placeholder="留空保留整个响应，例如 data.records" /></label></div>
      <label>主产出变量名（连线引用）<input value={config.outputName} onChange={event => { patch({ outputName: event.target.value }) }} placeholder="例如 workOrders" /></label>
      <label>原始响应变量名<input value={config.rawOutputName ?? 'rawResponseData'} onChange={event => { patch({ rawOutputName: event.target.value }) }} placeholder="例如 rawResponseData" /></label>
      <div className="api-fields-editor"><div className="ai-field-editor-title"><strong>额外字段变量</strong><button type="button" onClick={() => { patch({ fields: [...(config.fields ?? []), { name: '', path: '' }] }) }}>＋添加字段</button></div>
        {(config.fields ?? []).map((field, index) => <div className="api-field-row" key={`api-request-field-${index}`}><input value={field.name} placeholder="变量名，例如 total" onChange={event => { patch({ fields: (config.fields ?? []).map((item, i) => i === index ? { ...item, name: event.target.value } : item) }) }} /><input value={field.path} placeholder="JSON 路径，例如 data.total" onChange={event => { patch({ fields: (config.fields ?? []).map((item, i) => i === index ? { ...item, path: event.target.value } : item) }) }} /><button type="button" onClick={() => { patch({ fields: (config.fields ?? []).filter((_, i) => i !== index) }) }}>删除</button></div>)}
      </div>
      <OutputVariableMode graph={graph} mode={config.outputMode} target={config.updateVariable} onChange={(outputMode, updateVariable) => { patch({ outputMode, updateVariable }) }} />
    </div>
  </div>
}

function AgentFields({ graph, config, onChange }: { graph: WorkflowGraph; config: Extract<NodeConfig, { type: 'agent' }>; onChange: (config: NodeConfig) => void }): ReactNode {
  const outputs = config.outputs ?? []
  const patchOutput = (index: number, patch: Partial<(typeof config.outputs)[number]>): void => {
    onChange({ ...config, outputs: outputs.map((output, outputIndex) => outputIndex === index ? { ...output, ...patch } : output) })
  }
  return <div className="agent-config code-node-config code-node-dify">
    <label>使用的 AI<select value={config.llmId ?? ''} onChange={event => { onChange({ ...config, llmId: event.target.value || undefined }) }}><option value="">默认 AI</option>{(graph.llms ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <VariableReferencePicker graph={graph} />
    <label>系统提示<textarea rows={5} value={config.systemPrompt ?? ''} onChange={event => { onChange({ ...config, systemPrompt: event.target.value }) }} placeholder="定义 Agent 的角色、业务规则和禁止事项，可引用 {{变量名}}" /></label>
    <label>任务内容<textarea rows={5} value={config.task ?? ''} onChange={event => { onChange({ ...config, task: event.target.value }) }} placeholder="例如：根据订单 {{order}} 和客户描述 {{message}} 生成售后处理建议。" /></label>
    <p className="properties-hint">系统提示和任务内容都支持直接引用流程输入、全局变量、循环变量及前置节点产出，例如 <code>{'{{order.id}}'}</code>。</p>
    <section className="code-dify-section">
      <div className="code-dify-heading"><div><strong>结构化输出</strong><p>每个字段都会成为节点产出变量，模型必须严格按名称和类型返回。</p></div><button type="button" onClick={() => { onChange({ ...config, outputs: [...outputs, { name: '', valueType: 'string', description: '', outputMode: 'produce' }] }) }}>＋添加输出字段</button></div>
      {outputs.map((output, index) => <div className="agent-structured-field" key={`agent-output-${index}`}>
        <div className="agent-output-definition"><label>字段变量名<input aria-label={`Agent 输出字段 ${index + 1} 名称`} value={output.name} placeholder="例如 category" onChange={event => { patchOutput(index, { name: event.target.value.replace(/[^A-Za-z0-9_]/g, '_') }) }} /></label><label>字段类型<select value={output.valueType} onChange={event => { patchOutput(index, { valueType: event.target.value as typeof output.valueType }) }}><option value="string">文本</option><option value="number">数字</option><option value="boolean">布尔值</option><option value="object">对象</option><option value="array">数组</option></select></label></div>
        <label>字段说明<input value={output.description} placeholder="例如：售后场景分类名称" onChange={event => { patchOutput(index, { description: event.target.value }) }} /></label>
        <OutputVariableMode graph={graph} mode={output.outputMode} target={output.updateVariable} onChange={(outputMode, updateVariable) => { patchOutput(index, { outputMode, updateVariable }) }} />
        <button type="button" disabled={outputs.length <= 1} onClick={() => { onChange({ ...config, outputs: outputs.filter((_, outputIndex) => outputIndex !== index) }) }}>删除输出字段</button>
      </div>)}
    </section>
    <p className="properties-hint">执行时优先使用 JSON Mode，失败后自动切换 Function Calling，并由字段 Schema 校验结果；不再对普通文本执行 <code>JSON.parse</code>。</p>
  </div>
}

function OutputVariableMode({ graph, mode, target, onChange }: { graph: WorkflowGraph; mode?: OutputVariableModeType; target?: string; onChange: (mode: OutputVariableModeType, target: string) => void }): ReactNode {
  const names = outputVariableNames(graph, useContext(CurrentNodeIdContext), useContext(SubflowVariableContext))
  const selectedMode = mode ?? 'produce'
  return <div className="output-variable-mode">
    <label>变量处理方式<select value={selectedMode} onChange={event => { const next = event.target.value === 'declare' || event.target.value === 'update' ? event.target.value : 'produce'; onChange(next, target ?? '') }}><option value="produce">直接产出变量</option><option value="declare">声明流程变量（供后续复用）</option><option value="update">更新已有变量（覆盖）</option></select></label>
    {selectedMode === 'declare' ? <><label>流程变量名<input value={target ?? ''} onChange={event => { onChange('declare', event.target.value) }} placeholder="例如 workOrders" /></label><p className="properties-hint">首次运行时创建此变量；之后每次运行（包括循环中）都会更新它，后续请求可用 <code>{`{{${target || '变量名'}}}`}</code> 引用。</p></> : null}
    {selectedMode === 'update' ? <><label>要覆盖的变量<select value={target ?? ''} onChange={event => { onChange('update', event.target.value) }}><option value="">选择已有变量…</option>{names.map(name => <option key={name} value={name}>{name}</option>)}</select></label><p className="properties-hint">更新会覆盖所选流程变量；节点输出仍可通过连线引用。</p></> : null}
  </div>
}

function outputVariableNames(graph: WorkflowGraph, nodeId: string, subflowNames: readonly string[] = []): string[] {
  const before = upstreamNodes(graph, nodeId)
  const names = [
    ...(graph.context?.variables ?? []).map(item => item.name),
    ...before.flatMap(node => node.config.type === 'set-variable' ? [node.config.name] : []),
    ...before.flatMap(node => nodeDataOutputs(node).map(output => output.name)),
    ...before.flatMap(node => node.config.type === 'code' ? (node.config.outputs ?? []).map(output => output.name) : []),
    ...declaredOutputVariableNames(before),
    ...subflowNames,
  ]
  return names.filter((name, index) => name.trim() !== '' && names.indexOf(name) === index)
}

function declaredOutputVariableNames(nodes: readonly WorkflowNode[]): string[] {
  return nodes.flatMap(node => {
    const config = node.config
    if (config.type === 'page-action') return config.steps.flatMap(step => step.type === 'extract' && step.outputMode === 'declare' && step.updateVariable?.trim() ? [step.updateVariable] : [])
    if (config.type === 'agent') return (config.outputs ?? []).flatMap(output => output.outputMode === 'declare' && output.updateVariable?.trim() ? [output.updateVariable] : [])
    if (config.type === 'api-request' || config.type === 'api-listen' || config.type === 'extract' || config.type === 'transform' || config.type === 'code' || config.type === 'image-recognition') {
      return config.outputMode === 'declare' && config.updateVariable?.trim() ? [config.updateVariable] : []
    }
    return []
  })
}

function ApiPairSection({ title, items, add, edit, remove }: { title: string; items: readonly { name: string; value: string }[]; add: () => void; edit: (index: number, value: { name: string; value: string }) => void; remove: (index: number) => void }): ReactNode {
  return <div className="api-form-section"><div className="api-form-heading"><strong>{title}</strong><button type="button" onClick={add}>＋添加</button></div>{items.length === 0 ? <p className="api-empty-hint">暂无配置</p> : items.map((item, index) => <div className="api-pair-row" key={`${title}-${index}`}><input value={item.name} placeholder="名称" onChange={event => { edit(index, { ...item, name: event.target.value }) }} /><input value={item.value} placeholder="值，可写 {{变量名}}" onChange={event => { edit(index, { ...item, value: event.target.value }) }} /><button type="button" onClick={() => { remove(index) }}>删除</button></div>)}</div>
}

function PageActionEditor({ graph, steps, onChange, onPick }: { graph: WorkflowGraph; steps: readonly PageActionStep[]; onChange: (steps: readonly PageActionStep[]) => void; onPick: (field: 'selector' | 'beforeHover' | 'waitForVisible' | 'rowSelector' | 'extractField', stepIndex?: number) => void }): ReactNode {
  const add = (type: PageActionStep['type']): void => {
    const next: PageActionStep = type === 'open' ? { type, url: '' } : type === 'click' ? { type, selector: '' } : type === 'type' ? { type, selector: '', value: { kind: 'literal', value: '' }, inputMode: 'replace' } : type === 'hover' ? { type, selector: '' } : type === 'wait' ? { type, ms: 1000 } : { type, selector: '', outputName: 'text', mode: 'text' }
    onChange([...steps, next])
  }
  const patch = (index: number, value: PageActionStep): void => { onChange(steps.map((step, i) => i === index ? value : step)) }
  return <div className="page-actions"><VariableReferencePicker graph={graph} /><div className="page-actions-list">{steps.map((step, index) => <div className="page-action-step" key={`${step.type}-${index}`}><div className="page-action-heading"><strong>{index + 1}. {step.type}</strong><div className="page-action-heading-actions"><button type="button" className="step-order-button" title="上移步骤" aria-label={`上移步骤 ${index + 1}`} disabled={index === 0} onClick={() => { onChange(reorderPageActionStep(steps, index, index - 1)) }}>↑</button><button type="button" className="step-order-button" title="下移步骤" aria-label={`下移步骤 ${index + 1}`} disabled={index === steps.length - 1} onClick={() => { onChange(reorderPageActionStep(steps, index, index + 1)) }}>↓</button><button type="button" onClick={() => { onChange(steps.filter((_, i) => i !== index)) }}>删除</button></div></div><label className="step-wait-field">操作后等待（毫秒）<input type="number" min={0} value={step.waitAfterMs ?? 0} onChange={event => { patch(index, { ...step, waitAfterMs: Number(event.target.value) }) }} /></label>
    {step.type === 'open' ? <label>URL<input value={step.url} onChange={event => { patch(index, { ...step, url: event.target.value }) }} placeholder="可写 {{变量名}}" /></label> : null}
    {step.type === 'click' ? <label>点击选择器<div className="picker-field"><input value={selectorText(step.selector)} onChange={event => { patch(index, { ...step, selector: event.target.value }) }} placeholder="可写 {{变量名}}" /><button type="button" onClick={() => { onPick('selector', index) }}>拾取</button></div></label> : null}
    {step.type === 'hover' ? <label>Hover 选择器<div className="picker-field"><input value={selectorText(step.selector)} onChange={event => { patch(index, { ...step, selector: event.target.value }) }} placeholder="可写 {{变量名}}" /><button type="button" onClick={() => { onPick('selector', index) }}>拾取</button></div></label> : null}
    {step.type === 'wait' ? <><label>等待毫秒<input type="number" value={step.ms} onChange={event => { patch(index, { ...step, ms: Number(event.target.value) }) }} /></label><label>等待选择器（可选）<div className="picker-field"><input value={selectorText(step.selector ?? '')} onChange={event => { patch(index, { ...step, selector: event.target.value }) }} placeholder="可写 {{变量名}}" /><button type="button" onClick={() => { onPick('selector', index) }}>拾取</button></div></label></> : null}
    {step.type === 'type' ? <><label>输入选择器<div className="picker-field"><input value={selectorText(step.selector)} onChange={event => { patch(index, { ...step, selector: event.target.value }) }} placeholder="可写 {{变量名}}" /><button type="button" onClick={() => { onPick('selector', index) }}>拾取</button></div></label><label>输入方式<select value={step.inputMode ?? 'replace'} onChange={event => { patch(index, { ...step, inputMode: event.target.value === 'append' ? 'append' : 'replace' }) }}><option value="replace">替换原内容</option><option value="append">拼接到原内容后面</option></select></label><p className="properties-hint">替换会清空输入框原内容；拼接会保留原内容，并把新内容追加到末尾。</p><label className="llm-switch"><input type="checkbox" checked={step.ai?.enabled === true} onChange={event => { patch(index, { ...step, ai: { enabled: event.target.checked, prompt: step.ai?.prompt ?? '', llmId: step.ai?.llmId } }) }} />使用 AI 生成输入内容</label>{step.ai?.enabled ? <div className="extract-ai-config"><label>使用的 AI<select value={step.ai.llmId ?? ''} onChange={event => { patch(index, { ...step, ai: { ...step.ai!, llmId: event.target.value || undefined } }) }}><option value="">默认 AI</option>{(graph.llms ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>生成提示词<textarea rows={3} value={step.ai.prompt} onChange={event => { patch(index, { ...step, ai: { ...step.ai!, prompt: event.target.value } }) }} placeholder="例如：根据当前订单信息，生成一段礼貌的售后回复。可引用 {{item.title}} 等变量。" /></label><p className="properties-hint">AI 只会根据提示词及其中明确引用的变量生成文本，不会自动发送其他流程变量。</p></div> : <label>输入内容<input value={step.value.kind === 'literal' ? String(step.value.value ?? '') : step.value.kind === 'variable' ? `{{${step.value.name}}}` : step.value.kind === 'workflow-input' ? `{{inputs.${step.value.name}}}` : ''} onChange={event => { patch(index, { ...step, value: { kind: 'literal', value: event.target.value } }) }} placeholder="可写 {{变量名}}" /></label>}</> : null}
    {step.type === 'extract' ? <><label>抽取选择器<div className="picker-field"><input value={selectorText(step.selector)} onChange={event => { patch(index, { ...step, selector: event.target.value }) }} placeholder="可写 {{变量名}}" /><button type="button" onClick={() => { onPick('selector', index) }}>拾取</button></div></label><label>产出名称（连线引用）<input value={step.outputName} onChange={event => { patch(index, { ...step, outputName: event.target.value }) }} placeholder="例如 detailText" /></label><OutputVariableMode graph={graph} mode={step.outputMode} target={step.updateVariable} onChange={(outputMode, updateVariable) => { patch(index, { ...step, outputMode, updateVariable }) }} /><label className="llm-switch"><input type="checkbox" checked={step.ai?.enabled === true} onChange={event => { patch(index, { ...step, ai: { enabled: event.target.checked, fields: step.ai?.fields ?? [], prompt: step.ai?.prompt ?? '', llmId: step.ai?.llmId } }) }} />使用 AI 抽取</label>{step.ai?.enabled ? <div className="extract-ai-config"><label>使用的 AI<select value={step.ai.llmId ?? graph.llms?.[0]?.id ?? ''} onChange={event => { patch(index, { ...step, ai: { ...step.ai!, llmId: event.target.value } }) }}><option value="">默认 AI</option>{(graph.llms ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>输出字段（每行一个）<textarea rows={3} value={step.ai.fields.join('\n')} onChange={event => { patch(index, { ...step, ai: { ...step.ai!, fields: event.target.value.split('\n').map(item => item.trim()).filter(Boolean) } }) }} placeholder="订单号\n状态\n详情链接" /></label><label>AI 提示词<textarea rows={2} value={step.ai.prompt ?? ''} onChange={event => { patch(index, { ...step, ai: { ...step.ai!, prompt: event.target.value } }) }} placeholder="说明需要如何提取和清洗字段" /></label></div> : null}</> : null}
  </div>)}</div><div className="page-action-add"><select defaultValue="" onChange={event => { if (event.target.value) { add(event.target.value as PageActionStep['type']); event.target.value = '' } }}><option value="">添加页面步骤…</option><option value="open">打开页面</option><option value="hover">Hover</option><option value="click">点击</option><option value="type">输入</option><option value="wait">等待</option><option value="extract">抽取</option></select></div></div>
}

function ListRowActionEditor({ graph, node, config, onChange, onPick }: { graph: WorkflowGraph; node: WorkflowNode; config: Extract<NodeConfig, { type: 'list-row-action' }>; onChange: (config: Extract<NodeConfig, { type: 'list-row-action' }>, source?: ValueBinding) => void; onPick: (field: PickerField, stepIndex?: number) => void }): ReactNode {
  const patchMatch = (index: number, patch: Partial<(typeof config.matchFields)[number]>): void => {
    onChange({ ...config, matchFields: config.matchFields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field) })
  }
  const patchAction = (index: number, action: (typeof config.matchedActions)[number]): void => {
    onChange({ ...config, matchedActions: config.matchedActions.map((item, actionIndex) => actionIndex === index ? action : item) })
  }
  return <div className="page-actions">
    <p className="properties-hint">按业务字段把目标数组与页面行同步。请先拾取列表容器和一条样例行，再拾取行内字段与按钮；行内拾取会自动生成相对于当前行的可复用选择器。</p>
    <BindingField graph={graph} nodeId={node.id} label="目标数组" binding={config.source} onChange={source => { onChange({ ...config, source }, source) }} />
    <label>数组字段路径（可选）<input value={config.sourcePath} onChange={event => { onChange({ ...config, sourcePath: event.target.value }) }} placeholder="例如 data.items；变量本身是数组时留空" /></label>
    <label>列表容器（可选）<div className="picker-field"><input value={config.containerSelector ?? ''} onChange={event => { onChange({ ...config, containerSelector: event.target.value }) }} placeholder="#order-items；不填则使用整个页面" /><button type="button" onClick={() => { onPick('listContainerSelector') }}>拾取容器</button></div></label>
    <label>行识别规则<select value={config.rowSelectorMode ?? 'css'} onChange={event => { onChange({ ...config, rowSelectorMode: event.target.value === 'class-contains' ? 'class-contains' : 'css' }) }}><option value="class-contains">class 包含（适合 CSS Modules）</option><option value="css">CSS 选择器</option></select></label>
    <label>{config.rowSelectorMode === 'class-contains' ? 'class 包含内容' : '行选择器'}<div className="picker-field"><input value={config.rowSelector} onChange={event => { onChange({ ...config, rowSelector: event.target.value }) }} placeholder={config.rowSelectorMode === 'class-contains' ? '例如 ComplaintDetailListItem__listItem' : '.order-item-row 或 tbody > tr'} /><button type="button" onClick={() => { onPick('listRowSelector') }}>拾取样例行</button></div></label>
    {config.rowSelectorMode === 'class-contains' ? <p className="properties-hint">运行时会自动按 <code>--哈希</code> 边界匹配 CSS Modules 类名，避免把 <code>listItemField</code> 一类子元素误识别成行。</p> : null}

    <div className="api-form-section"><div className="api-form-heading"><strong>行匹配字段</strong><button type="button" onClick={() => { onChange({ ...config, matchFields: [...config.matchFields, { selectorMode: 'css', rowSelector: '', dataPath: '', matchMode: 'exact', readMode: 'text', trim: true, ignoreCase: false }] }) }}>＋添加</button></div>
      {config.matchFields.map((field, index) => <div className="page-action-step" key={`match-${index}`}><div className="page-action-heading"><strong>条件 {index + 1}</strong><button type="button" disabled={config.matchFields.length <= 1} onClick={() => { onChange({ ...config, matchFields: config.matchFields.filter((_, itemIndex) => itemIndex !== index) }) }}>删除</button></div><label>字段识别规则<select value={field.selectorMode ?? 'css'} onChange={event => { patchMatch(index, { selectorMode: event.target.value === 'class-contains' ? 'class-contains' : 'css' }) }}><option value="class-contains">class 包含（适合 CSS Modules）</option><option value="css">CSS 选择器</option></select></label><label>{field.selectorMode === 'class-contains' ? 'class 包含内容' : '行内字段选择器'}<div className="picker-field"><input value={field.rowSelector} onChange={event => { patchMatch(index, { rowSelector: event.target.value }) }} placeholder={field.selectorMode === 'class-contains' ? '例如 ComplaintDetailListItem__listingSku' : '.sku-code'} /><button type="button" onClick={() => { onPick('listMatchField', index) }}>拾取字段</button></div></label>{field.selectorMode === 'class-contains' ? <p className="properties-hint">只在当前行内按 <code>--哈希</code> 边界查找该 CSS Modules 元素。</p> : null}<label>目标数据字段路径<input value={field.dataPath} onChange={event => { patchMatch(index, { dataPath: event.target.value }) }} placeholder="sku" /></label><label>匹配方式<select value={field.matchMode ?? 'exact'} onChange={event => { patchMatch(index, { matchMode: event.target.value === 'contains' ? 'contains' : 'exact' }) }}><option value="exact">完全匹配</option><option value="contains">页面字段包含目标值</option></select></label><label>读取方式<select value={field.readMode} onChange={event => { patchMatch(index, { readMode: event.target.value as typeof field.readMode }) }}><option value="text">文本</option><option value="value">输入值</option><option value="attribute">属性</option></select></label>{field.readMode === 'attribute' ? <label>属性名<input value={field.attribute ?? ''} onChange={event => { patchMatch(index, { attribute: event.target.value }) }} placeholder="data-id" /></label> : null}<label className="llm-switch"><input type="checkbox" checked={field.trim !== false} onChange={event => { patchMatch(index, { trim: event.target.checked }) }} />忽略首尾空格</label><label className="llm-switch"><input type="checkbox" checked={field.ignoreCase === true} onChange={event => { patchMatch(index, { ignoreCase: event.target.checked }) }} />忽略大小写</label></div>)}
    </div>

    <div className="api-form-section"><div className="api-form-heading"><strong>匹配行操作</strong><button type="button" onClick={() => { onChange({ ...config, matchedActions: [...config.matchedActions, { type: 'type', selector: '', value: '', dataPath: '', inputMode: 'replace' }] }) }}>＋添加</button></div>
      {config.matchedActions.length === 0 ? <p className="api-empty-hint">不修改匹配行，仅用于清理未匹配行。</p> : config.matchedActions.map((action, index) => <div className="page-action-step" key={`action-${index}`}><div className="page-action-heading"><strong>操作 {index + 1}</strong><button type="button" onClick={() => { onChange({ ...config, matchedActions: config.matchedActions.filter((_, itemIndex) => itemIndex !== index) }) }}>删除</button></div><label>操作类型<select value={action.type} onChange={event => { const type = event.target.value; const value = 'value' in action ? action.value : ''; const dataPath = 'dataPath' in action ? action.dataPath ?? '' : ''; patchAction(index, type === 'click' ? { type: 'click', selector: action.selector } : type === 'select' ? { type: 'select', selector: action.selector, value, dataPath } : { type: 'type', selector: action.selector, value, dataPath, inputMode: 'replace' }) }}><option value="type">输入</option><option value="select">下拉选择</option><option value="click">点击</option></select></label><label>行内目标选择器<div className="picker-field"><input value={action.selector} onChange={event => { patchAction(index, { ...action, selector: event.target.value }) }} placeholder="input.quantity" /><button type="button" onClick={() => { onPick('listMatchedAction', index) }}>拾取目标</button></div></label>{action.type !== 'click' ? <><label>数据字段名<input value={action.dataPath ?? ''} onChange={event => { patchAction(index, { ...action, dataPath: event.target.value }) }} placeholder="qty" /></label><p className="properties-hint">{'从当前行对象读取该属性并回填。例如数据是 [{qty:1}] 时，字段名填 qty 会输入 1。'}</p><label>{action.type === 'select' ? '选项值（可选模板）' : '输入内容（可选模板）'}<textarea rows={2} value={action.value} onChange={event => { patchAction(index, { ...action, value: event.target.value }) }} placeholder="字段名为空时可用 {{item.qty}} 或固定文本" /></label></> : null}{action.type === 'type' ? <label>输入方式<select value={action.inputMode ?? 'replace'} onChange={event => { patchAction(index, { ...action, inputMode: event.target.value === 'append' ? 'append' : 'replace' }) }}><option value="replace">替换原内容</option><option value="append">拼接到末尾</option></select></label> : null}</div>)}
    </div>

    <label>未匹配页面行<select value={config.unmatchedMode} onChange={event => { onChange({ ...config, unmatchedMode: event.target.value === 'delete' ? 'delete' : 'keep' }) }}><option value="keep">保留</option><option value="delete">点击删除</option></select></label>
    {config.unmatchedMode === 'delete' || config.emptySourceAction === 'delete-all' ? <div className="extract-ai-config"><label>行内删除按钮<div className="picker-field"><input value={config.deleteSelector} onChange={event => { onChange({ ...config, deleteSelector: event.target.value }) }} placeholder="button.delete" /><button type="button" onClick={() => { onPick('listDeleteSelector') }}>拾取按钮</button></div></label><label>确认按钮（可选，全局选择器）<div className="picker-field"><input value={config.confirmSelector ?? ''} onChange={event => { onChange({ ...config, confirmSelector: event.target.value }) }} placeholder=".confirm-dialog .confirm" /><button type="button" onClick={() => { onPick('listConfirmSelector') }}>拾取确认按钮</button></div></label><label>删除后等待（毫秒）<input type="number" min={0} value={config.waitAfterDeleteMs} onChange={event => { onChange({ ...config, waitAfterDeleteMs: Math.max(0, Number(event.target.value)) }) }} /></label><label>最大删除数量<input type="number" min={1} value={config.maxDeleteCount} onChange={event => { onChange({ ...config, maxDeleteCount: Math.max(1, Number(event.target.value)) }) }} /></label></div> : null}
    <label>目标数据未匹配页面行<select value={config.missingMatchAction} onChange={event => { onChange({ ...config, missingMatchAction: event.target.value === 'skip' ? 'skip' : 'stop' }) }}><option value="stop">停止运行</option><option value="skip">跳过并记录</option></select></label>
    <label>页面存在重复匹配行<select value={config.duplicateMatchAction === 'first' ? 'first' : 'all'} onChange={event => { onChange({ ...config, duplicateMatchAction: event.target.value === 'first' ? 'first' : 'all' }) }}><option value="all">操作所有匹配行</option><option value="first">只操作第一行</option></select></label>
    <label>目标数据为空时<select value={config.emptySourceAction} onChange={event => { const value = event.target.value; onChange({ ...config, emptySourceAction: value === 'keep' || value === 'delete-all' ? value : 'stop' }) }}><option value="stop">停止运行</option><option value="keep">保留所有行</option><option value="delete-all">删除所有行</option></select></label>
    <label>结果变量名<input value={config.outputName} onChange={event => { onChange({ ...config, outputName: event.target.value }) }} placeholder="listOperationResult" /></label>
  </div>
}

function selectorText(selector: string | { readonly strategy: string; readonly value: string }): string {
  const value = typeof selector === 'string' ? selector : selector.value
  return displayPickedSelector(value)
}

function bindingTemplateText(binding: ValueBinding): string {
  if (binding.kind === 'node-output') return `{{outputs.${binding.nodeId}.${binding.port}}}`
  if (binding.kind === 'workflow-input') return `{{inputs.${binding.name}}}`
  if (binding.kind === 'variable') return `{{${binding.name}}}`
  if (binding.kind === 'runtime') return `{{${binding.path}}}`
  return typeof binding.value === 'string' ? binding.value : JSON.stringify(binding.value, null, 2)
}

function pageActionVariableNames(graph: WorkflowGraph, nodeId: string, subflowNames: readonly string[] = []): string[] {
  const before = upstreamNodes(graph, nodeId)
  const names = [
    ...(graph.context?.variables ?? []).map(item => item.name),
    ...before.flatMap(node => node.config.type === 'set-variable' ? [node.config.name] : []),
    ...before.flatMap(node => nodeDataOutputs(node).map(output => output.name)),
    ...before.flatMap(node => node.config.type === 'code' ? (node.config.outputs ?? []).map(output => output.name) : []),
    ...declaredOutputVariableNames(before),
    ...before.flatMap(node => node.config.type === 'for-each' ? ['currentItem', 'currentIndex', node.config.itemVar, node.config.indexVar, ...(node.config.declaredVariables ?? [])] : []),
    'failureCount', 'successCount',
    ...subflowNames,
  ]
  return names.filter((name, index) => name.trim() !== '' && names.indexOf(name) === index)
}

function VariableReferencePicker({ graph }: { graph: WorkflowGraph }): ReactNode {
  const nodeId = useContext(CurrentNodeIdContext)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const names = [...(graph.context?.inputs ?? []).map(item => `inputs.${item.name}`), ...pageActionVariableNames(graph, nodeId, useContext(SubflowVariableContext))]
    .filter((name, index, all) => name.trim() !== '' && all.indexOf(name) === index)
  const selectedAvailable = selected.filter(name => names.includes(name))
  const filtered = names.filter(name => name.toLowerCase().includes(search.trim().toLowerCase()))
  const toggle = (name: string): void => setSelected(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name])
  return <section className="variable-reference-picker">
    <div className="variable-reference-heading"><div><strong>引用变量</strong><small>多选可用变量；在下方字段中写 <code>{'{{变量名}}'}</code></small></div><button type="button" className={open ? 'is-open' : ''} onClick={() => { setOpen(value => !value) }} aria-expanded={open}>{selectedAvailable.length > 0 ? `已选 ${selectedAvailable.length} 项` : '选择变量'}<span>{open ? '⌃' : '⌄'}</span></button></div>
    {selectedAvailable.length > 0 ? <div className="variable-reference-tags">{selectedAvailable.map(name => <code key={name}>{`{{${name}}}`}</code>)}</div> : null}
    {open ? <div className="variable-reference-options"><input value={search} onChange={event => { setSearch(event.target.value) }} placeholder="搜索变量…" aria-label="搜索变量" />{filtered.length === 0 ? <p>没有可选变量</p> : filtered.map(name => <label key={name}><input type="checkbox" checked={selected.includes(name)} onChange={() => { toggle(name) }} /><code>{name}</code></label>)}</div> : null}
  </section>
}

function ApprovalEditor({ graph, node, config, onChange }: { graph: WorkflowGraph; node: WorkflowNode; config: Extract<NodeConfig, { type: 'approval' }>; onChange: (config: NodeConfig) => void }): ReactNode {
  const [selectedVariable, setSelectedVariable] = useState('')
  const variableNames = [...(graph.context?.inputs ?? []).map(item => `inputs.${item.name}`), ...pageActionVariableNames(graph, node.id, useContext(SubflowVariableContext))]
    .filter((name, index, all) => name.trim() !== '' && all.indexOf(name) === index)
  const insertVariable = (): void => {
    if (selectedVariable === '') return
    const separator = config.description !== '' && !/\s$/.test(config.description) ? ' ' : ''
    onChange({ ...config, description: `${config.description}${separator}{{${selectedVariable}}}` })
  }
  return <div className="approval-config">
    <label>审批标题<input value={config.title} onChange={event => { onChange({ ...config, title: event.target.value }) }} placeholder="例如：确认提交订单" /></label>
    <label>审批说明<textarea rows={4} value={config.description} onChange={event => { onChange({ ...config, description: event.target.value }) }} placeholder="例如：订单 {{orderId}} 已超过 {{overdueDays}} 天，请确认是否继续" /></label>
    <p className="properties-hint">展示时支持安全的 HTML 富文本，如 <code>{'<strong>重点</strong>'}</code>、段落、列表和表格；普通文字仍按原样显示。</p>
    <div className="approval-variable-helper"><div><strong>引用变量辅助说明</strong><small>执行到此节点时会替换为变量的实际值</small></div><div><select value={selectedVariable} onChange={event => { setSelectedVariable(event.target.value) }}><option value="">选择变量…</option>{variableNames.map(name => <option key={name} value={name}>{name}</option>)}</select><button type="button" disabled={selectedVariable === ''} onClick={insertVariable}>插入说明</button></div></div>
    <p className="properties-hint">也可手动输入 <code>{'{{变量名}}'}</code>，支持流程输入、循环变量及前置节点产出。</p>
    <div className="ai-field-editor-title"><strong>审批展示字段</strong><button type="button" onClick={() => { onChange({ ...config, fields: [...config.fields, { label: '', value: { kind: 'literal', value: '' }, path: '' }] }) }}>＋添加字段</button></div>
    {config.fields.map((field, index) => <div className="approval-field-row" key={`approval-field-${index}`}><input value={field.label} onChange={event => { onChange({ ...config, fields: config.fields.map((item, i) => i === index ? { ...item, label: event.target.value } : item) }) }} placeholder="字段名称，例如订单金额" /><BindingField graph={graph} nodeId={node.id} label={`字段值 ${index + 1}`} binding={field.value} onChange={value => { onChange({ ...config, fields: config.fields.map((item, i) => i === index ? { ...item, value } : item) }) }} /><input value={field.path ?? ''} onChange={event => { onChange({ ...config, fields: config.fields.map((item, i) => i === index ? { ...item, path: event.target.value } : item) }) }} placeholder="字段路径（可选）" /><button type="button" onClick={() => { onChange({ ...config, fields: config.fields.filter((_, i) => i !== index) }) }}>删除</button></div>)}
    {config.fields.length === 0 ? <p className="properties-hint">可以添加订单号、金额等需要审批人核对的信息。</p> : null}
    <label className="checkbox-label"><input type="checkbox" checked={config.requireCommentOnReject} onChange={event => { onChange({ ...config, requireCommentOnReject: event.target.checked }) }} />拒绝时必须填写意见</label>
    <label>审批超时（分钟）<input type="number" min={1} value={config.timeoutMinutes} onChange={event => { onChange({ ...config, timeoutMinutes: Math.max(1, Number(event.target.value) || 1) }) }} /></label>
    <p className="properties-hint">当前执行人审批。通过、拒绝和超时分别从对应出口继续。</p>
  </div>
}

function CallSubflowEditor({ graph, node, config, onChange, onBatchSubflowVersion, batchSubflowBusy }: { graph: WorkflowGraph; node: WorkflowNode; config: Extract<NodeConfig, { type: 'call-subflow' }>; onChange: (config: NodeConfig) => void; onBatchSubflowVersion: (workflowId: string, version: number) => Promise<void>; batchSubflowBusy: boolean }): ReactNode {
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([])
  const [revisions, setRevisions] = useState<WorkflowRevisionItem[]>([])
  const [revisionsFor, setRevisionsFor] = useState('')
  const [unpublishedCount, setUnpublishedCount] = useState(0)
  const [childGraph, setChildGraph] = useState<WorkflowGraph>()
  const [workspaceNames, setWorkspaceNames] = useState<Record<string, string>>({ default: '默认空间' })
  const [loadingList, setLoadingList] = useState(false)
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [loadingRevision, setLoadingRevision] = useState(false)
  const [switchingVersion, setSwitchingVersion] = useState(false)
  const [error, setError] = useState('')
  const [versionError, setVersionError] = useState('')
  const [versionNotice, setVersionNotice] = useState('')
  const [pendingVersion, setPendingVersion] = useState<{ workflowId: string; version: number; graph: WorkflowGraph; mappings: MappingReconciliation }>()
  const [batchTargetVersion, setBatchTargetVersion] = useState<number>()
  const revisionCache = useRef(new Map<string, WorkflowGraph>())
  const switchToken = useRef(0)
  const configRef = useRef(config)
  configRef.current = config

  useEffect(() => {
    let active = true
    void listWorkspaces(RPA_SERVICE_URL).then(result => {
      if (active) setWorkspaceNames(Object.fromEntries(result.items.map(item => [item.id, item.name])))
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    setLoadingList(true)
    setError('')
    void (async () => {
      const pageSize = 100
      const first = await listWorkflows(RPA_SERVICE_URL, 1, pageSize)
      const items = [...first.items]
      for (let page = 2; items.length < first.total; page += 1) {
        const next = await listWorkflows(RPA_SERVICE_URL, page, pageSize)
        if (next.items.length === 0) break
        items.push(...next.items)
      }
      if (active) {
        const candidates = items.filter(flow => flow.id !== graph.workflowId && flow.status !== 'archived')
        setWorkflows(candidates.filter(flow => flow.publishedVersion !== null))
        setUnpublishedCount(candidates.filter(flow => flow.publishedVersion === null).length)
      }
    })().catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : '读取子流程列表失败')
    }).finally(() => { if (active) setLoadingList(false) })
    return () => { active = false }
  }, [graph.workflowId])

  useEffect(() => {
    let active = true
    setRevisions([])
    setRevisionsFor('')
    setVersionError('')
    setVersionNotice('')
    setPendingVersion(undefined)
    setBatchTargetVersion(undefined)
    if (!config.workflowId) { setLoadingVersions(false); return () => { active = false; switchToken.current += 1 } }
    setLoadingVersions(true)
    void listWorkflowRevisions(RPA_SERVICE_URL, config.workflowId).then(result => {
      if (active) {
        setRevisions(result.items.filter(item => item.stage === 'published').sort((a, b) => b.version - a.version))
        setRevisionsFor(config.workflowId)
      }
    }).catch(reason => {
      if (active) setVersionError(reason instanceof Error ? reason.message : '读取已发布版本失败')
    }).finally(() => { if (active) setLoadingVersions(false) })
    return () => { active = false; switchToken.current += 1 }
  }, [config.workflowId, node.id])

  useEffect(() => {
    let active = true
    setChildGraph(undefined)
    setError('')
    if (!config.workflowId || config.workflowVersion === undefined) { setLoadingRevision(false); return () => { active = false } }
    const key = `${config.workflowId}@${config.workflowVersion}`
    const cached = revisionCache.current.get(key)
    if (cached !== undefined) { setChildGraph(cached); setLoadingRevision(false); return () => { active = false } }
    setLoadingRevision(true)
    void getWorkflowRevision(RPA_SERVICE_URL, config.workflowId, config.workflowVersion).then(result => {
      if (active) {
        if (result.stage !== 'published') throw new Error(`子流程 v${config.workflowVersion} 不是已发布版本`)
        revisionCache.current.set(key, result.graph)
        setChildGraph(result.graph)
      }
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : '读取子流程版本失败')
    }).finally(() => { if (active) setLoadingRevision(false) })
    return () => { active = false }
  }, [config.workflowId, config.workflowVersion])

  const selected = workflows.find(flow => flow.id === config.workflowId)
  const availableRevisions = revisionsFor === config.workflowId ? revisions : []
  const latestVersion = availableRevisions[0]?.version ?? selected?.publishedVersion ?? undefined
  const sameFlowNodes = graph.nodes.filter(item => item.config.type === 'call-subflow' && item.config.workflowId === config.workflowId)
  const batchTarget = batchTargetVersion ?? latestVersion ?? config.workflowVersion
  const batchChangeCount = sameFlowNodes.filter(item => item.config.type === 'call-subflow' && item.config.workflowVersion !== batchTarget).length
  const versionCounts = [...new Set(sameFlowNodes.map(item => item.config.type === 'call-subflow' ? item.config.workflowVersion : undefined))].map(version => `v${version ?? '未固定'} × ${sameFlowNodes.filter(item => item.config.type === 'call-subflow' && item.config.workflowVersion === version).length}`)
  const mappings = config.inputMappings ?? []
  const activeChildGraph = childGraph?.workflowId === config.workflowId && childGraph.version === config.workflowVersion ? childGraph : undefined
  const missingRequiredInputs = (activeChildGraph?.context?.inputs ?? []).filter(input => {
    if (!input.required || input.defaultValue !== undefined) return false
    const mapping = mappings.find(item => item.inputName === input.name)
    return mapping === undefined || (mapping.source.kind === 'literal' && (mapping.source.value === null || (typeof mapping.source.value === 'string' && mapping.source.value.trim() === '')))
  })
  const variableConflicts = (activeChildGraph?.context?.variables ?? []).filter(childVariable => {
    const parentVariable = graph.context?.variables.find(item => item.name === childVariable.name)
    return parentVariable !== undefined && JSON.stringify(parentVariable.defaultValue) !== JSON.stringify(childVariable.defaultValue)
  })
  const missingSecrets = (activeChildGraph?.context?.variables ?? []).filter(childVariable => childVariable.secret && childVariable.defaultValue === '******' && !graph.context?.variables.some(item => item.name === childVariable.name && item.secret))
  const updatePendingMappings = (nextMappings: readonly CallSubflowInputMapping[]): void => {
    if (activeChildGraph === undefined) return
    setPendingVersion(current => current === undefined ? undefined : { ...current, mappings: reconcileSubflowMappings(activeChildGraph, current.graph, nextMappings) })
  }
  const updateMapping = (inputName: string, source: ValueBinding): void => {
    const next = mappings.some(item => item.inputName === inputName)
      ? mappings.map(item => item.inputName === inputName ? { ...item, source } : item)
      : [...mappings, { inputName, source }]
    onChange({ ...config, inputMappings: next })
    updatePendingMappings(next)
  }
  const removeMapping = (inputName: string): void => {
    const next = mappings.filter(item => item.inputName !== inputName)
    onChange({ ...config, inputMappings: next })
    updatePendingMappings(next)
  }

  const commitVersion = (candidate: NonNullable<typeof pendingVersion>): void => {
    const currentConfig = configRef.current
    if (candidate.workflowId !== currentConfig.workflowId) return
    const currentGraph = revisionCache.current.get(`${currentConfig.workflowId}@${currentConfig.workflowVersion}`) ?? activeChildGraph
    if (currentGraph === undefined) return
    const reconciliation = reconcileSubflowMappings(currentGraph, candidate.graph, currentConfig.inputMappings ?? [])
    revisionCache.current.set(`${candidate.workflowId}@${candidate.version}`, candidate.graph)
    onChange({ ...currentConfig, workflowVersion: candidate.version, inputMappings: reconciliation.retained })
    setPendingVersion(undefined)
    setVersionNotice(`已固定子流程 v${candidate.version}；保留 ${reconciliation.retained.length} 项兼容映射${reconciliation.removed.length ? `，移除 ${reconciliation.removed.length} 项不兼容映射` : ''}。`)
  }

  const requestVersion = async (version: number): Promise<void> => {
    if (!config.workflowId || version === config.workflowVersion || activeChildGraph === undefined || switchingVersion) return
    const token = ++switchToken.current
    setSwitchingVersion(true)
    setVersionError('')
    setVersionNotice('')
    try {
      const key = `${config.workflowId}@${version}`
      const cached = revisionCache.current.get(key)
      const revision = cached === undefined ? await getWorkflowRevision(RPA_SERVICE_URL, config.workflowId, version) : undefined
      if (token !== switchToken.current) return
      if (revision !== undefined && revision.stage !== 'published') throw new Error(`子流程 v${version} 不是已发布版本`)
      const nextGraph = cached ?? revision!.graph
      const candidate = { workflowId: config.workflowId, version, graph: nextGraph, mappings: reconcileSubflowMappings(activeChildGraph, nextGraph, configRef.current.inputMappings ?? []) }
      if (candidate.mappings.removed.length > 0 || candidate.mappings.missingRequired.length > 0) setPendingVersion(candidate)
      else commitVersion(candidate)
    } catch (reason) {
      if (token === switchToken.current) setVersionError(reason instanceof Error ? reason.message : '切换子流程版本失败')
    } finally {
      if (token === switchToken.current) setSwitchingVersion(false)
    }
  }

  return <div className="call-subflow-config">
    <label>子流程<select value={config.workflowId} disabled={loadingList} onChange={event => {
      const flow = workflows.find(item => item.id === event.target.value)
      onChange({ ...config, workflowId: flow?.id ?? '', workflowVersion: flow?.publishedVersion ?? undefined, inputMappings: [] })
      setChildGraph(undefined)
      setRevisions([])
      setRevisionsFor('')
      setVersionNotice('')
      setVersionError('')
      setPendingVersion(undefined)
      setBatchTargetVersion(undefined)
      switchToken.current += 1
    }}><option value="">{loadingList ? '正在读取流程…' : workflows.length === 0 ? '暂无可选的已发布流程' : '选择已发布流程'}</option>{config.workflowId && !selected ? <option value={config.workflowId}>当前引用的子流程（列表不可用）</option> : null}{workflows.map(flow => <option key={flow.id} value={flow.id}>{workspaceNames[flow.workspaceId] ?? flow.workspaceId} / {flow.name} / v{flow.publishedVersion}</option>)}</select></label>
    {!loadingList && !error && workflows.length === 0 ? <p className="properties-hint">{unpublishedCount > 0 ? `找到 ${unpublishedCount} 个其他流程，但它们还没有已发布版本。请先到流程管理中发布要复用的流程。` : '请先在流程管理中创建并发布另一条流程，再将它作为子流程复用。'}</p> : null}
    {config.workflowId ? <div className="call-subflow-version-panel">
      <label>执行版本<select aria-label="子流程执行版本" value={config.workflowVersion ?? ''} disabled={loadingVersions || loadingRevision || switchingVersion || activeChildGraph === undefined} onChange={event => { if (event.target.value) void requestVersion(Number(event.target.value)) }}>
        <option value="">请选择已发布版本</option>
        {config.workflowVersion !== undefined && !availableRevisions.some(item => item.version === config.workflowVersion) ? <option value={config.workflowVersion}>v{config.workflowVersion} · 当前固定版本</option> : null}
        {availableRevisions.map(revision => <option key={revision.id} value={revision.version}>v{revision.version}{revision.version === latestVersion ? ' · 最新发布' : ''}</option>)}
      </select></label>
      <div className="call-subflow-version-status"><span>当前固定：{config.workflowVersion === undefined ? '未选择' : `v${config.workflowVersion}`}</span><span>最新发布：{latestVersion === undefined ? '读取中' : `v${latestVersion}`}</span></div>
      {latestVersion !== undefined && config.workflowVersion !== undefined && latestVersion > config.workflowVersion ? <button type="button" disabled={loadingVersions || loadingRevision || switchingVersion || activeChildGraph === undefined} onClick={() => { void requestVersion(latestVersion) }}>升级到最新 v{latestVersion}</button> : null}
      <p>子流程版本固定在本节点中；子流程发布新版后，父流程不会自动升级。</p>
      {versionError ? <p className="call-subflow-warning">{versionError}</p> : null}
      {pendingVersion?.workflowId === config.workflowId ? <div className="call-subflow-version-confirm"><strong>确认切换到 v{pendingVersion.version}？</strong>{pendingVersion.mappings.removed.length > 0 ? <p>将移除不兼容或已删除输入的映射：{pendingVersion.mappings.removed.join('、')}</p> : null}{pendingVersion.mappings.missingRequired.length > 0 ? <p>切换后需要重新配置必填输入：{pendingVersion.mappings.missingRequired.join('、')}</p> : null}<div><button type="button" onClick={() => { commitVersion(pendingVersion) }}>确认切换</button><button type="button" onClick={() => { setPendingVersion(undefined) }}>取消</button></div></div> : null}
      {versionNotice ? <p className="call-subflow-version-notice">{versionNotice}</p> : null}
    </div> : null}
    {config.workflowId && sameFlowNodes.length > 1 ? <section className="call-subflow-batch-panel">
      <div className="call-subflow-batch-heading"><strong>画布内批量版本</strong><span>同一子流程共 {sameFlowNodes.length} 个调用节点</span></div>
      <p>当前版本：{versionCounts.join('、')}</p>
      <div className="call-subflow-batch-actions"><label>统一到<select aria-label="批量选择子流程版本" value={batchTarget ?? ''} disabled={batchSubflowBusy || loadingVersions} onChange={event => { setBatchTargetVersion(event.target.value ? Number(event.target.value) : undefined) }}>
        <option value="">选择已发布版本</option>
        {batchTarget !== undefined && !availableRevisions.some(item => item.version === batchTarget) ? <option value={batchTarget}>v{batchTarget} · 当前选择</option> : null}
        {availableRevisions.map(revision => <option key={revision.id} value={revision.version}>v{revision.version}{revision.version === latestVersion ? ' · 最新' : ''}</option>)}
      </select></label><button type="button" disabled={batchSubflowBusy || batchTarget === undefined || batchChangeCount === 0} onClick={() => { if (batchTarget !== undefined) void onBatchSubflowVersion(config.workflowId, batchTarget) }}>{batchSubflowBusy ? '正在统一…' : batchChangeCount === 0 ? '版本已统一' : `统一 ${batchChangeCount} 个节点`}</button></div>
      <small>会分别保留兼容的输入映射；若有映射需要移除或必填输入待补全，将先请你确认。</small>
    </section> : null}
    {error ? <p className="properties-error">{error}</p> : null}
    {loadingRevision ? <p className="properties-hint">正在读取子流程输入定义…</p> : null}
    {activeChildGraph ? <>
      {missingRequiredInputs.length > 0 ? <p className="call-subflow-warning">当前版本还有必填输入未映射：{missingRequiredInputs.map(input => input.description || input.name).join('、')}</p> : null}
      {(activeChildGraph.context?.inputs ?? []).length > 0 ? <section className="call-subflow-inputs">
        <div className="call-subflow-inputs-heading"><div><strong>输入变量</strong><span>逐项设置传给子流程的值</span></div><small>已映射 {mappings.filter(mapping => activeChildGraph.context?.inputs.some(input => input.name === mapping.inputName)).length} / {activeChildGraph.context?.inputs.length}</small></div>
        <details className="call-subflow-input-guide"><summary>如何传入多个变量？</summary><p>选择一个父流程变量，可保留原始类型；也可以在内容框中插入多个变量并加入说明文字。完整的 {'{{变量名}}'} 引用保留原始类型，拼接内容则作为文本传入。</p></details>
        <div className="call-subflow-input-list">{activeChildGraph.context?.inputs.map(definition => {
          const mapping = mappings.find(item => item.inputName === definition.name)
          const isMissing = missingRequiredInputs.some(input => input.name === definition.name)
          const typeWarning = mapping === undefined || isMissing ? undefined : subflowInputTypeWarning(graph, definition, mapping.source)
          const hasDefault = definition.defaultValue !== undefined
          const defaultText = definition.secret ? '••••••' : hasDefault ? typeof definition.defaultValue === 'string' ? definition.defaultValue : JSON.stringify(definition.defaultValue) : ''
          return <div className="call-subflow-input" data-missing={isMissing ? 'true' : undefined} data-incompatible={typeWarning ? 'true' : undefined} key={definition.name}>
            <div className="call-subflow-input-heading"><div><strong>{definition.description || definition.name}</strong><code>{definition.name}</code></div><span className={definition.required ? 'is-required' : ''}>{definition.required ? '必填' : '可选'}</span></div>
            <div className="call-subflow-input-meta"><span>类型：{definition.type}</span><span>{mapping ? isMissing ? '待填写传入值' : typeWarning ? '传入类型不兼容' : '已配置传入值' : hasDefault ? '使用子流程默认值' : definition.required ? '尚未配置' : '不传入'}</span></div>
            {typeWarning ? <p className="call-subflow-type-warning" role="status">⚠ {typeWarning} 请更换来源或调整子流程输入类型。</p> : null}
            {mapping ? <div className="call-subflow-input-editor"><BindingField graph={graph} nodeId={node.id} label="传入值" binding={mapping.source} onChange={source => { updateMapping(definition.name, source) }} editableExpression /><div className="call-subflow-input-footer"><span>选择变量或填写固定内容</span><button type="button" className="call-subflow-unmap" onClick={() => { removeMapping(definition.name) }}>{hasDefault ? '恢复默认值' : '清除映射'}</button></div></div> : <div className="call-subflow-input-empty"><p>{hasDefault ? <>默认值：<code>{defaultText || '空文本'}</code></> : definition.required ? '此输入没有默认值，请配置传入值。' : '未映射时保持为空。'}</p><button type="button" className="call-subflow-map" onClick={() => { updateMapping(definition.name, { kind: 'literal', value: definition.defaultValue ?? '' }) }}>{hasDefault ? '改为传入值' : '配置传入值'}</button></div>}
          </div>
        })}</div>
      </section> : <p className="properties-hint">该子流程没有运行时输入，可直接复用其节点流程。</p>}
      <div className="call-subflow-shared"><strong>变量共享</strong><p>子流程与父流程共用全局变量。子流程产生或更新的变量，父流程后续节点可直接引用；父流程已有值优先于子流程固定变量的默认值。</p></div>
      {variableConflicts.length > 0 ? <p className="call-subflow-warning">同名变量默认值不同：{variableConflicts.map(item => item.name).join('、')}。运行时保留父流程变量，不会被子流程默认值覆盖。</p> : null}
      {missingSecrets.length > 0 ? <p className="call-subflow-warning">子流程包含敏感变量：{missingSecrets.map(item => item.name).join('、')}。请在父流程全局变量中添加同名敏感变量，执行前由当前执行人填写。</p> : null}
    </> : null}
  </div>
}

function ConditionValueField({ value, onChange }: { value: import('@graph/types.ts').JsonValue | undefined; onChange: (value: import('@graph/types.ts').JsonValue) => void }): ReactNode {
  const valueType = typeof value === 'boolean' ? 'boolean' : 'text'
  return <div className="condition-value-field"><select aria-label="比较值类型" value={valueType} onChange={event => { onChange(event.target.value === 'boolean' ? true : String(value ?? '')) }}><option value="text">文本</option><option value="boolean">布尔值</option></select>{valueType === 'boolean' ? <select aria-label="布尔比较值" value={value === false ? 'false' : 'true'} onChange={event => { onChange(event.target.value === 'true') }}><option value="true">true（是）</option><option value="false">false（否）</option></select> : <input value={String(value ?? '')} onChange={event => { onChange(event.target.value) }} placeholder="比较值" />}</div>
}

function ConditionClauses({ graph, node, config, onChange }: { graph: WorkflowGraph; node: WorkflowNode; config: Extract<NodeConfig, { type: 'condition' }>; onChange: (config: NodeConfig, inputBindings?: Readonly<Record<string, ValueBinding>>) => void }): ReactNode {
  const clauses = config.clauses ?? []
  const patch = (index: number, clause: typeof clauses[number]): void => onChange({ ...config, clauses: clauses.map((item, i) => i === index ? clause : item) })
  if (config.mode === 'ai') return <div className="condition-form"><label>判断方式<select value="ai" onChange={event => { onChange({ ...config, mode: event.target.value as typeof config.mode }) }}><option value="value">结构化条件</option><option value="ai">AI 判断</option></select></label><ConditionAiFields graph={graph} node={node} config={config} onChange={onChange} /></div>
  return <div className="condition-form"><label>判断方式<select value="value" onChange={event => { onChange({ ...config, mode: event.target.value as typeof config.mode }) }}><option value="value">结构化条件</option><option value="ai">AI 判断</option></select></label><ConditionWaitFields config={config} onChange={next => { onChange(next) }} /><label>条件关系<select value={config.logic ?? 'and'} onChange={event => { onChange({ ...config, logic: event.target.value === 'or' ? 'or' : 'and' }) }}><option value="and">全部满足（AND）</option><option value="or">任一满足（OR）</option></select></label>{clauses.map((clause, index) => <div className="condition-clause" key={index}><BindingField graph={graph} nodeId={node.id} label={`变量 ${index + 1}`} binding={clause.binding} onChange={binding => { patch(index, { ...clause, binding }) }} /><select value={clause.operator} onChange={event => { patch(index, { ...clause, operator: event.target.value as typeof clause.operator }) }}><option value="equals">等于</option><option value="notEquals">不等于</option><option value="contains">包含</option><option value="greaterThan">大于</option><option value="lessThan">小于</option><option value="isEmpty">为空</option><option value="isNotEmpty">不为空</option></select>{clause.operator !== 'isEmpty' && clause.operator !== 'isNotEmpty' ? <ConditionValueField value={clause.value} onChange={value => { patch(index, { ...clause, value }) }} /> : null}<button type="button" onClick={() => { onChange({ ...config, clauses: clauses.filter((_, i) => i !== index) }) }}>删除条件</button></div>)}<button type="button" onClick={() => { onChange({ ...config, clauses: [...clauses, { binding: { kind: 'literal', value: '' }, operator: 'equals', value: '' }] }) }}>＋ 添加条件</button></div>
}

function ConditionAiFields({ graph, node, config, onChange }: { graph: WorkflowGraph; node: WorkflowNode; config: Extract<NodeConfig, { type: 'condition' }>; onChange: (config: NodeConfig, inputBindings?: Readonly<Record<string, ValueBinding>>) => void }): ReactNode {
  return <><BindingField graph={graph} nodeId={node.id} label="AI 判断内容" binding={config.left} onChange={left => { onChange({ ...config, left }, { ...node.inputBindings, left }) }} /><label>字段路径（可选）<input value={config.path} onChange={event => { onChange({ ...config, path: event.target.value }) }} placeholder="例如 content.text" /></label><label>使用的 AI<select value={config.llmId ?? ''} onChange={event => { onChange({ ...config, llmId: event.target.value || undefined }) }}><option value="">默认 AI</option>{(graph.llms ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>判断提示词<textarea rows={4} value={config.aiPrompt ?? ''} onChange={event => { onChange({ ...config, aiPrompt: event.target.value }) }} placeholder="例如：判断内容是否属于需要人工跟进的售后问题。可引用 {{变量名}}。" /></label><p className="properties-hint">AI 会结合上方内容和提示词判断；满足进入 matched，否则进入 else。提示词支持 {'{{变量名}}'} 引用。</p></>
}

function ConditionWaitFields({ config, onChange }: { config: Extract<NodeConfig, { type: 'condition' }>; onChange: (config: NodeConfig) => void }): ReactNode {
  return <div className="condition-wait-fields"><label className="checkbox-label"><input type="checkbox" checked={config.waitForCondition === true} onChange={event => { onChange({ ...config, waitForCondition: event.target.checked }) }} />等待条件满足</label>{config.waitForCondition === true ? <div className="condition-wait-options"><label>最大等待（毫秒）<input type="number" min={0} value={config.waitTimeoutMs ?? 10000} onChange={event => { onChange({ ...config, waitTimeoutMs: Number(event.target.value) }) }} /></label><label>轮询间隔（毫秒）<input type="number" min={50} value={config.pollIntervalMs ?? 500} onChange={event => { onChange({ ...config, pollIntervalMs: Number(event.target.value) }) }} /></label><p className="properties-hint">超时后进入“否则”分支。</p></div> : null}</div>
}

function BindingField({
  graph,
  nodeId,
  label,
  binding,
  onChange,
  editableExpression = false,
  includeOwnLoopVariables = false,
}: {
  graph: WorkflowGraph
  nodeId: string
  label: string
  binding: ValueBinding
  onChange: (binding: ValueBinding) => void
  editableExpression?: boolean
  includeOwnLoopVariables?: boolean
}): ReactNode {
  const expressionRef = useRef<HTMLTextAreaElement>(null)
  const selectionRef = useRef<{ start: number; end: number } | null>(null)
  const subflowVariableNames = useContext(SubflowVariableContext)
  const before = upstreamNodes(graph, nodeId)
  const ownLoop = includeOwnLoopVariables ? graph.nodes.find(item => item.id === nodeId && item.config.type === 'for-each') : undefined
  const options = before.flatMap(item => {
    return nodeDataOutputs(item).map(port => ({
      key: `${item.id}.${port.name}`,
      nodeId: item.id,
      port: port.name,
      label: `${item.name}.${port.name}`,
    }))
  })
  const inputOptions = (graph.context?.inputs ?? []).map(item => ({ key: `inputs.${item.name}`, nodeId: '', port: item.name, label: `开始输入 · ${item.name}`, inputName: item.name }))
  const declaredVariableNames = [...before, ...(ownLoop === undefined ? [] : [ownLoop])].flatMap(item => {
    if (item.config.type !== 'for-each') return []
    return ['currentItem', 'currentIndex', item.config.itemVar || 'item', item.config.indexVar || 'index', ...(item.config.declaredVariables ?? [])]
  })
  const runtimeVariableNames = ['failureCount', 'successCount', ...before.filter(item => item.config.type === 'for-each').flatMap(item => [`failureCount_${item.id}`, `successCount_${item.id}`])]
  const nodeOutputNames = new Set(options.map(option => option.port))
  const variableNames = [...(graph.context?.variables ?? []).map(item => item.name), ...before.flatMap(item => item.config.type === 'set-variable' ? [item.config.name] : []), ...declaredOutputVariableNames(before), ...declaredVariableNames, ...runtimeVariableNames, ...subflowVariableNames]
    .filter(name => name.trim() !== '' && !nodeOutputNames.has(name))
    .filter((name, index, all) => all.indexOf(name) === index)
  const variableOptions = variableNames.map(name => {
    const global = (graph.context?.variables ?? []).some(item => item.name === name)
    const loop = declaredVariableNames.includes(name)
    const special = runtimeVariableNames.includes(name)
    const child = subflowVariableNames.includes(name)
    return { key: `variables.${name}`, nodeId: '', port: name, label: `${special ? '特殊变量' : loop ? '循环变量' : global ? '全局变量' : child ? '子流程变量' : '变量'} · ${name}`, variableName: name }
  })
  const runtimeOptions = [{ key: 'page.url', label: '页面环境 · page.url', path: 'page.url' as const }, { key: 'page.title', label: '页面环境 · page.title', path: 'page.title' as const }]
  const outputAliases = outputReferenceAliases(options.map(option => ({ nodeId: option.nodeId, port: option.port })))
  const expression = binding.kind === 'node-output' ? `{{outputs.${binding.nodeId}.${binding.port}}}`
    : binding.kind === 'workflow-input' ? `{{inputs.${binding.name}}}`
      : binding.kind === 'variable' ? `{{${binding.name}}}`
        : binding.kind === 'runtime' ? `{{${binding.path}}}`
          : typeof binding.value === 'string' ? binding.value : JSON.stringify(binding.value)
  const shownExpression = editableExpression ? displaySubflowReferences(expression, outputAliases) : expression
  const literalValue = binding.kind === 'literal' ? expression : ''
  const selectedExpression = editableExpression && binding.kind === 'literal' ? /^\{\{\s*([^}]+?)\s*\}\}$/.exec(expression.trim())?.[1] : undefined
  const legacyVariableOutput = binding.kind === 'variable' && !variableOptions.some(option => option.variableName === binding.name)
    ? options.filter(option => option.port === binding.name).at(-1)
    : undefined
  const selected = binding.kind === 'node-output' ? `${binding.nodeId}.${binding.port}` : binding.kind === 'workflow-input' ? `inputs.${binding.name}` : binding.kind === 'variable' ? legacyVariableOutput?.key ?? `variables.${binding.name}` : binding.kind === 'runtime' ? binding.path
    : selectedExpression === undefined ? 'literal'
      : [...inputOptions, ...variableOptions, ...runtimeOptions, ...options].find(option => ('key' in option && (option.key === selectedExpression || option.key === `variables.${selectedExpression}` || ('nodeId' in option && option.nodeId && `outputs.${option.key}` === selectedExpression))))?.key ?? 'literal'
  const unavailableSelection = selected !== 'literal' && ![...inputOptions, ...variableOptions, ...runtimeOptions, ...options].some(option => option.key === selected)
  const selectedSource = binding.kind === 'variable'
    ? legacyVariableOutput === undefined
      ? { label: subflowVariableNames.includes(binding.name) && !(graph.context?.variables ?? []).some(item => item.name === binding.name) ? '子流程变量' : '全局变量', field: binding.name }
      : { label: graph.nodes.find(item => item.id === legacyVariableOutput.nodeId)?.name ?? '节点产出', field: legacyVariableOutput.port }
    : binding.kind === 'workflow-input'
      ? { label: '开始输入', field: binding.name }
      : binding.kind === 'runtime'
        ? { label: '页面环境', field: binding.path }
        : binding.kind === 'node-output'
          ? (() => {
            const source = graph.nodes.find(item => item.id === binding.nodeId)
            const port = source === undefined ? undefined : nodeDataOutputs(source).find(item => item.name === binding.port)
            return { label: source?.name ?? '节点产出', field: port?.name ?? binding.port, description: port?.label }
          })()
          : undefined
  const insertExpression = (path: string): void => {
    const reference = displaySubflowReferences(`{{${path}}}`, outputAliases)
    const start = Math.min(selectionRef.current?.start ?? shownExpression.length, shownExpression.length)
    const end = Math.min(selectionRef.current?.end ?? start, shownExpression.length)
    selectionRef.current = { start: start + reference.length, end: start + reference.length }
    const marker = '\uE000\uE001'
    const nextShown = shownExpression.slice(0, start) + marker + shownExpression.slice(end)
    onChange({ kind: 'literal', value: storeSubflowReferences(nextShown, outputAliases, expression).replace(marker, `{{${path}}}`) })
    requestAnimationFrame(() => {
      expressionRef.current?.focus()
      expressionRef.current?.setSelectionRange(start + reference.length, start + reference.length)
    })
  }
  return (
    <>
      <label>
        {label}来源
        <select
          value={selected}
          onChange={event => {
            selectionRef.current = null
            if (event.target.value === 'literal') {
              onChange({ kind: 'literal', value: editableExpression ? expression : literalValue })
              return
            }
            const input = inputOptions.find(item => item.key === event.target.value)
            if (input !== undefined) { onChange({ kind: 'workflow-input', name: input.inputName }); return }
            const variable = variableOptions.find(item => item.key === event.target.value)
            if (variable !== undefined) { onChange({ kind: 'variable', name: variable.variableName }); return }
            const runtime = runtimeOptions.find(item => item.key === event.target.value)
            if (runtime !== undefined) { onChange({ kind: 'runtime', path: runtime.path }); return }
            const option = options.find(item => item.key === event.target.value)
            if (option !== undefined) onChange({ kind: 'node-output', nodeId: option.nodeId, port: option.port })
          }}
        >
          <option value="literal">固定值</option>
          {unavailableSelection ? <option value={selected} disabled>当前引用不在前置节点中</option> : null}
          {inputOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
          {variableOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
          {runtimeOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
          {options.map(option => (
            <option key={option.key} value={option.key}>{option.label}</option>
          ))}
        </select>
      </label>
      {binding.kind === 'literal' || editableExpression ? (
        <label>
          {editableExpression ? `${label}内容（可编辑）` : label}
          {editableExpression
            ? <textarea ref={expressionRef} rows={3} value={shownExpression} onSelect={event => { selectionRef.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd } }} onChange={event => { selectionRef.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }; onChange({ kind: 'literal', value: storeSubflowReferences(event.target.value, outputAliases, expression) }) }} placeholder="可填写文字或多个 {{变量名}}" />
            : <input value={literalValue} onChange={event => { onChange({ kind: 'literal', value: event.target.value }) }} />}
        </label>
      ) : null}
      {editableExpression ? <label>
        插入变量到光标处
        <select className="call-subflow-insert-select" value="" onChange={event => {
          const key = event.target.value
          if (inputOptions.some(option => option.key === key) || runtimeOptions.some(option => option.key === key)) insertExpression(key)
          else if (variableOptions.some(option => option.key === key)) insertExpression(key.slice('variables.'.length))
          else if (key.startsWith('outputs.') && options.some(option => `outputs.${option.key}` === key)) insertExpression(key)
        }}>
          <option value="">＋ 选择一个变量插入</option>
          {inputOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
          {variableOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
          {runtimeOptions.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
          {options.map(option => <option key={option.key} value={`outputs.${option.key}`}>{option.label}</option>)}
        </select>
      </label> : null}
      {selectedSource !== undefined ? <div className="binding-source-summary"><span>{selectedSource.label}</span><code>{selectedSource.field}</code>{'description' in selectedSource && selectedSource.description !== undefined ? <em>{selectedSource.description}</em> : null}</div> : null}
    </>
  )
}

/**
 * 数据绑定应使用节点上实际配置的产出变量名（例如 tableData），而不是
 * 节点目录里的通用端口名（例如 text/json）。这样下拉框和变量面板显示一致。
 */
function nodeDataOutputs(node: WorkflowNode): readonly DataPort[] {
  const fallback = NODE_CATALOG[node.type].dataOutputs
  if (node.config.type === 'extract') {
    return [{ name: node.config.outputName || fallback[0]?.name || 'result', label: node.config.mode === 'list' ? '列表数据' : '抽取结果' }]
  }
  if (node.config.type === 'agent') return (node.config.outputs ?? []).filter(output => output.name.trim()).map(output => ({ name: output.name, label: output.description || 'AI 结果' }))
  if (node.config.type === 'image-recognition') return [{ name: node.config.outputName || 'imageResult', label: '图片识别结果' }]
  if (node.config.type === 'list-row-action') return [{ name: node.config.outputName || 'listOperationResult', label: '列表操作结果' }]
  if (node.config.type === 'switch' && node.config.mode === 'ai') return [{ name: node.config.reasonOutputName?.trim() || 'reason', label: 'AI 判断依据' }]
  if (node.config.type === 'transform' || node.config.type === 'code') {
    return [{ name: node.config.outputName || 'result', label: '处理结果' }]
  }
  if (node.config.type === 'api-listen') {
    return [{ name: node.config.outputName || 'tableData', label: '接口数据' }, ...(node.config.rawOutputName?.trim() ? [{ name: node.config.rawOutputName, label: '原始响应' }] : []), ...(node.config.fields ?? []).filter(field => field.name.trim() !== '').map(field => ({ name: field.name, label: field.path || '字段变量' }))]
  }
  if (node.config.type === 'api-request') return [{ name: node.config.outputName || 'responseData', label: '接口数据' }, ...(node.config.rawOutputName?.trim() ? [{ name: node.config.rawOutputName, label: '原始响应' }] : []), ...(node.config.fields ?? []).filter(field => field.name.trim() !== '').map(field => ({ name: field.name, label: field.path || '字段变量' }))]
  if (node.config.type === 'page-action') {
    const extracts = node.config.steps.filter(step => step.type === 'extract').map(step => ({ name: step.outputName || 'text', label: '抽取结果' }))
    return extracts
  }
  if (node.config.type === 'for-each') {
    return [{ name: 'item', label: '当前项' }, { name: 'index', label: '当前索引' }]
  }
  return fallback
}
