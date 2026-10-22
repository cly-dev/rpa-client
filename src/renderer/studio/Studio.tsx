import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  MiniMap,
  MarkerType,
  ReactFlow,
  getBezierPath,
  type Connection,
  type Edge,
  type EdgeProps,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  addNode,
  connectOrRewire,
  autoLayoutGraph,
  createDefaultTemplate,
  createEdge,
  createNode,
  duplicateNode,
  firstIssue,
  firstPublishIssue,
  missingStartUrl,
  patchNode,
  removeEdges,
  removeNodes,
  renameWorkflow,
  validateGraph,
  validatePublishConnections,
} from '@graph/index.ts'
import type { ApprovalPrompt, JsonValue, NodeConfig, NodeType, ValueBinding, WorkflowContextVariable, WorkflowGraph, WorkflowLlmConfig, WorkflowNode } from '@graph/types.ts'
import { NODE_CATALOG, PALETTE_TYPES } from '@graph/catalog.ts'
import { runDry, type DryRunState } from '@runner/dry-run.ts'
import { workflowNeedsBrowser } from '@runner/page-requirement.ts'
import { FlowNode } from './FlowNode.tsx'
import { toFlowNodes, type NodeSize } from './flow-nodes.ts'
import { Palette, readPaletteType } from './Palette.tsx'
import { Properties } from './Properties.tsx'
import { RunPanel } from './RunPanel.tsx'
import { VariablesPanel } from './VariablesPanel.tsx'
import { ContextPanel } from './ContextPanel.tsx'
import { WorkbenchHome, type WorkflowListViewState } from './WorkbenchHome.tsx'
import { flowNodeRunGraph, initialNodeRunMode, isolatedNodeRunGraph, prefixToNode } from './node-run-graph.ts'
import { parseInjections, referencedInjections, type InjectionRow, type InjectionType } from './node-run-injection.ts'
import { createWorkflow, getWorkflow, getWorkflowRevision, loadServiceLlmConfigs, loadSubflowBundle, publishWorkflow, RPA_SERVICE_URL, updateWorkflow, type WorkflowListItem } from '../workflow-api.ts'
import { downloadJson, importWorkflowJson, safeJsonFilename } from './json-transfer.ts'
import { planBulkSubflowVersionUpdate } from './subflow-version.ts'
import { WebhookSettings } from './WebhookSettings.tsx'
import { WorkflowRunningBubble } from './WorkflowRunningBubble.tsx'
import type { AuthUser } from '../auth.ts'

const nodeTypes = { studio: FlowNode }
const edgeTypes = { insertable: InsertableEdge }

function hasRedactedSecrets(graph: WorkflowGraph): boolean {
  return [graph.llm, ...(graph.llms ?? [])].some(llm => llm?.apiKey === '******')
    || [...(graph.context?.inputs ?? []), ...(graph.context?.variables ?? [])].some(variable => variable.secret && variable.defaultValue === '******')
}

function formatRuntimeInput(value: JsonValue | undefined): string {
  if (value === undefined || value === '******') return ''
  return typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : String(value)
}

function parseRuntimeInputs(definitions: readonly WorkflowContextVariable[], values: Readonly<Record<string, string>>, requireAll = true): Readonly<Record<string, JsonValue>> {
  const result: Record<string, JsonValue> = {}
  for (const definition of definitions) {
    const text = values[definition.name] ?? ''
    if (text.trim() === '') {
      if (definition.defaultValue !== undefined && definition.defaultValue !== '******') result[definition.name] = definition.defaultValue
      else if (definition.required && requireAll) throw new Error(`请填写必填变量「${definition.description || definition.name}」`)
      continue
    }
    if (definition.type === 'string') result[definition.name] = text
    else if (definition.type === 'number') {
      const number = Number(text)
      if (!Number.isFinite(number)) throw new Error(`变量「${definition.name}」需要填写有效数字`)
      result[definition.name] = number
    } else if (definition.type === 'boolean') {
      if (text !== 'true' && text !== 'false') throw new Error(`请选择变量「${definition.name}」的值`)
      result[definition.name] = text === 'true'
    } else {
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { throw new Error(`变量「${definition.name}」需要填写有效的 JSON`) }
      if (definition.type === 'array' ? !Array.isArray(parsed) : parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`变量「${definition.name}」需要填写${definition.type === 'array' ? '数组' : '对象'}`)
      }
      result[definition.name] = parsed as JsonValue
    }
  }
  return result
}

function hasConfiguredStartUrl(graphs: readonly WorkflowGraph[]): boolean {
  return graphs.some(item => item.nodes.some(node => node.config.type === 'start' && node.config.url.trim() !== ''))
}

function subflowCallsSignature(graph: WorkflowGraph, workflowId: string): string {
  return JSON.stringify(graph.nodes.filter(node => node.config.type === 'call-subflow' && node.config.workflowId === workflowId).map(node => [node.id, node.config]))
}

function toEdges(graph: WorkflowGraph, onInsert: (edgeId: string, type: NodeType) => void): Edge[] {
  return graph.edges.map(edge => ({
    id: edge.id,
    source: edge.sourceNodeId,
    sourceHandle: edge.sourcePort,
    target: edge.targetNodeId,
    type: 'insertable',
    // Edges are removed only through the explicit context-menu action below.
    deletable: false,
    markerEnd: { type: MarkerType.ArrowClosed, color: '#8792a2', width: 16, height: 16 },
    data: { onInsert },
  }))
}

function InsertableEdge(props: EdgeProps): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)
  const [search, setSearch] = useState('')
  const data = props.data as { onInsert?: (edgeId: string, type: NodeType) => void } | undefined
  const [path, labelX, labelY] = getBezierPath(props)
  const unavailableReason = (type: NodeType): string | undefined => {
    if (type === 'for-each') return '循环需要分别连接「循环体」和「完成」出口'
    if (type === 'end') return '结束节点不能插在流程中间'
    if (type === 'continue-loop') return '请在循环体末尾连接此节点；无需连回循环入口'
    return undefined
  }
  const insertableTypes = PALETTE_TYPES.filter(type => NODE_CATALOG[type].acceptsIncoming)
  const groupedTypes = [
    { title: '动作', types: insertableTypes.filter(type => NODE_CATALOG[type].kind === 'action') },
    { title: '处理', types: insertableTypes.filter(type => NODE_CATALOG[type].kind === 'decision') },
    { title: '流程', types: insertableTypes.filter(type => NODE_CATALOG[type].kind === 'terminal') },
  ].map(group => ({ ...group, types: group.types.filter(type => `${NODE_CATALOG[type].title} ${NODE_CATALOG[type].description}`.toLowerCase().includes(search.trim().toLowerCase())) })).filter(group => group.types.length > 0)
  return <>
    <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} />
    <EdgeLabelRenderer>
      <div className="edge-insert-anchor nodrag nopan" style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}>
        <button
          type="button"
          className="edge-insert-trigger"
          aria-label="在连线中间插入节点"
          aria-expanded={menuOpen}
          title="插入节点"
          onMouseDown={event => { event.stopPropagation() }}
          onClick={event => { event.stopPropagation(); setMenuOpen(open => !open) }}
        >＋</button>
        {menuOpen ? <div className="edge-insert-menu" role="menu" onMouseDown={event => { event.stopPropagation() }} onClick={event => { event.stopPropagation() }} onWheelCapture={event => { event.stopPropagation() }} onTouchMove={event => { event.stopPropagation() }}>
          <div className="edge-insert-menu-heading"><strong>插入节点</strong><button type="button" aria-label="关闭" onClick={() => { setMenuOpen(false) }}>×</button></div>
          <input className="edge-insert-search" autoFocus value={search} onChange={event => { setSearch(event.target.value) }} onWheelCapture={event => { event.stopPropagation() }} placeholder="搜索节点…" aria-label="搜索可插入节点" />
          {groupedTypes.length === 0 ? <p className="edge-insert-empty">没有匹配的节点</p> : groupedTypes.map(group => <section key={group.title} className="edge-insert-group"><span>{group.title}</span>{group.types.map(type => {
            const reason = unavailableReason(type)
            return <button key={type} type="button" role="menuitem" disabled={reason !== undefined} title={reason} onClick={() => { data?.onInsert?.(props.id, type); setMenuOpen(false); setSearch('') }}><i data-kind={NODE_CATALOG[type].kind} /><span><strong>{NODE_CATALOG[type].title}</strong><small>{reason ?? NODE_CATALOG[type].description}</small></span></button>
          })}</section>)}
        </div> : null}
      </div>
    </EdgeLabelRenderer>
  </>
}

export function Studio({ currentUser, onLogout }: { currentUser: AuthUser; onLogout: () => void }): ReactNode {
  const [graph, setGraph] = useState<WorkflowGraph>(() => ({ ...createDefaultTemplate(), context: { inputs: [], variables: [] } }))
  const [view, setView] = useState<'home' | 'editor'>('home')
  const [workflowListView, setWorkflowListView] = useState<WorkflowListViewState>({ page: 1, query: '' })
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(() => localStorage.getItem('rpa.workspaceId') || 'default')
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [serviceWorkflowId, setServiceWorkflowId] = useState<string>()
  const [workflowMeta, setWorkflowMeta] = useState<Pick<WorkflowListItem, 'publishedVersion' | 'status'>>()
  const [notice, setNotice] = useState<string>()
  const [run, setRun] = useState<DryRunState>()
  const [editorSubflows, setEditorSubflows] = useState<WorkflowGraph[]>([])
  const [serviceLlms, setServiceLlms] = useState<WorkflowLlmConfig[]>([])
  const [serviceLlmError, setServiceLlmError] = useState<string>()
  const [subflowVariableError, setSubflowVariableError] = useState<string>()
  const [pageEnvironment, setPageEnvironment] = useState<{ url: string; title: string }>()
  const [running, setRunning] = useState(false)
  const [bulkUpdatingSubflow, setBulkUpdatingSubflow] = useState(false)
  const [runtimeInputDialog, setRuntimeInputDialog] = useState(false)
  const [runtimeRunRequest, setRuntimeRunRequest] = useState<{ type: 'workflow' } | { type: 'picker'; nodeId: string; field: 'selector' | 'beforeHover' | 'waitForVisible' | 'rowSelector' | 'extractField'; stepIndex?: number }>()
  const [runtimeInputValues, setRuntimeInputValues] = useState<Record<string, string>>({})
  const [runtimeInputError, setRuntimeInputError] = useState<string>()
  const [nodeRunDialog, setNodeRunDialog] = useState<{ nodeId: string; mode: 'flow' | 'direct' }>()
  const [nodeRunRows, setNodeRunRows] = useState<InjectionRow[]>([])
  const [nodeRunError, setNodeRunError] = useState<string>()
  const [editorApproval, setEditorApproval] = useState<ApprovalPrompt>()
  const [editorApprovalComment, setEditorApprovalComment] = useState('')
  const [editorApprovalSubmitting, setEditorApprovalSubmitting] = useState(false)
  const [runPanelExpandRequest, setRunPanelExpandRequest] = useState(0)
  const [globalRunActivity, setGlobalRunActivity] = useState<{ readonly runId: string; readonly workflowName: string; readonly state?: DryRunState }>()
  const [stoppingRunId, setStoppingRunId] = useState<string>()
  const runtimeInputsByWorkflow = useRef<Record<string, Record<string, string>>>({})
  const pickerInputsByWorkflow = useRef<Record<string, boolean>>({})
  const [contextOpen, setContextOpen] = useState(false)
  const [webhookOpen, setWebhookOpen] = useState(false)
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false)
  const [edgeMenu, setEdgeMenu] = useState<{ edgeId: string; x: number; y: number }>()
  const [nodeMenu, setNodeMenu] = useState<{ nodeId: string; x: number; y: number }>()
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved')
  const savedGraphSnapshot = useRef<string | null>(null)
  const graphRef = useRef(graph)
  graphRef.current = graph
  const bulkSubflowInProgress = useRef(false)
  const saveInProgress = useRef(false)
  const flowRef = useRef<ReactFlowInstance | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const workflowJsonInputRef = useRef<HTMLInputElement | null>(null)
  const toolbarMenuRef = useRef<HTMLDivElement | null>(null)
  const toolbarMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const nodeSizes = useRef(new Map<string, NodeSize>())
  const runToken = useRef(0)
  const activeEditorRunId = useRef<string>()
  const editorDryRunAbort = useRef<AbortController>()
  const subflowSignature = graph.nodes
    .filter(node => node.config.type === 'call-subflow' && node.config.workflowId.trim() !== '' && node.config.workflowVersion !== undefined)
    .map(node => node.config.type === 'call-subflow' ? `${node.config.workflowId}@${node.config.workflowVersion}` : '')
    .sort().join('|')

  useEffect(() => {
    if (view !== 'editor') return
    let active = true
    void loadServiceLlmConfigs().then(items => {
      if (!active) return
      setServiceLlms(items)
      setServiceLlmError(undefined)
    }).catch(error => {
      if (!active) return
      setServiceLlms([])
      setServiceLlmError(error instanceof Error ? error.message : '读取 AI 配置失败')
    })
    return () => { active = false }
  }, [view])

  const propertiesGraph = useMemo<WorkflowGraph>(() => ({ ...graph, llms: serviceLlms, llm: serviceLlms.find(item => item.enabled) }), [graph, serviceLlms])

  useEffect(() => {
    let active = true
    setEditorSubflows([])
    setSubflowVariableError(undefined)
    if (view !== 'editor' || subflowSignature === '') return () => { active = false }
    const configuredNodes = graph.nodes.filter(node => node.config.type === 'call-subflow' && node.config.workflowId.trim() !== '' && node.config.workflowVersion !== undefined)
    void loadSubflowBundle(RPA_SERVICE_URL, { ...graph, nodes: configuredNodes }).then(subflows => {
      if (active) setEditorSubflows(subflows)
    }).catch(error => {
      if (active) setSubflowVariableError(error instanceof Error ? error.message : '读取子流程变量失败')
    })
    return () => { active = false }
  }, [graph.workflowId, subflowSignature, view])

  const prepareRuntimeInputs = (definitions: readonly WorkflowContextVariable[]): void => {
    const previous = runtimeInputsByWorkflow.current[graph.workflowId] ?? {}
    const values = Object.fromEntries(definitions.map(input => [input.name, previous[input.name] ?? formatRuntimeInput(input.defaultValue)]))
    runtimeInputsByWorkflow.current[graph.workflowId] = values
    setRuntimeInputValues(values)
  }

  const updateRuntimeInput = (name: string, value: string): void => {
    setRuntimeInputValues(current => {
      const next = { ...current, [name]: value }
      runtimeInputsByWorkflow.current[graph.workflowId] = next
      return next
    })
  }

  const deleteNode = useCallback((id: string) => {
    const target = graph.nodes.find(node => node.id === id)
    if (target === undefined) return
    if (target.type === 'start') {
      setNotice('开始节点不能删除')
      return
    }
    if (!window.confirm(`确定要删除节点「${target.name}」吗？\n节点与它相关的连线也会被删除。`)) return
    setGraph(current => removeNodes(current, [id]))
    setSelectedId(current => (current === id ? undefined : current))
    setNotice(`已删除「${target.name}」`)
  }, [graph.nodes])

  const statuses = run?.nodes ?? {}
  const workflowBusy = running || globalRunActivity !== undefined
  const runStatusValues = Object.values(statuses)
  const runCompletedCount = runStatusValues.filter(status => status === 'succeeded' || status === 'failed').length
  const runTotalCount = runStatusValues.length
  const currentRunningNodeName = run?.currentNodeId === undefined
    ? undefined
    : [...run.logs].reverse().find(line => line.nodeId === run.currentNodeId)?.nodeName
      ?? graph.nodes.find(node => node.id === run.currentNodeId)?.name
  const issues = useMemo(() => [...validateGraph(graph, editorSubflows), ...validatePublishConnections(graph)], [graph, editorSubflows])
  const nodes = useMemo(() => toFlowNodes(graph, statuses, selectedId, deleteNode, nodeSizes.current, issues), [graph, statuses, selectedId, deleteNode, issues])
  const insertNodeOnEdge = useCallback((edgeId: string, type: NodeType) => {
    const edge = graph.edges.find(item => item.id === edgeId)
    const source = edge === undefined ? undefined : graph.nodes.find(item => item.id === edge.sourceNodeId)
    const target = edge === undefined ? undefined : graph.nodes.find(item => item.id === edge.targetNodeId)
    if (edge === undefined || source === undefined || target === undefined) return
    const inserted = createNode(type, {
      x: (source.position.x + target.position.x) / 2 - 100,
      y: (source.position.y + target.position.y) / 2 - 36,
    })
    const outputPorts = inserted.config.type === 'image-recognition'
      ? [...inserted.config.cases.map(item => `case-${item.id}`), 'else']
      : inserted.config.type === 'switch'
      ? [...inserted.config.cases.map((_, index) => `case-${index}`), 'else']
      : NODE_CATALOG[type].flowOutputs.map(port => port.name)
    const next = {
      ...graph,
      nodes: [...graph.nodes, inserted],
      edges: [
        ...graph.edges.filter(item => item.id !== edgeId),
        createEdge(edge.sourceNodeId, edge.sourcePort, inserted.id),
        ...(outputPorts[0] === undefined ? [] : [createEdge(inserted.id, outputPorts[0], edge.targetNodeId)]),
      ],
    }
    setGraph(next)
    void autoLayoutGraph(next, nodeSizes.current).then(setGraph).catch(error => {
      setNotice(`节点已插入，但自动排布失败：${error instanceof Error ? error.message : String(error)}`)
    })
    setSelectedId(inserted.id)
    setNotice(`已在连线中插入「${NODE_CATALOG[type].title}」`)
  }, [graph])
  const edges = useMemo(() => toEdges(graph, insertNodeOnEdge), [graph, insertNodeOnEdge])
  const selected = graph.nodes.find(node => node.id === selectedId)

  const keepCanvasVisible = (_event: MouseEvent | TouchEvent | null, viewport: { x: number; y: number; zoom: number }): void => {
    const canvas = canvasRef.current
    if (canvas === null || graph.nodes.length === 0 || viewport.zoom <= 0) return
    const { width, height } = canvas.getBoundingClientRect()
    if (width <= 0 || height <= 0) return
    const left = Math.min(...graph.nodes.map(node => node.position.x))
    const top = Math.min(...graph.nodes.map(node => node.position.y))
    const right = Math.max(...graph.nodes.map(node => node.position.x + 220))
    const bottom = Math.max(...graph.nodes.map(node => node.position.y + 140))
    const margin = Math.min(100, width * 0.15, height * 0.15)
    const minX = margin - right * viewport.zoom
    const maxX = width - margin - left * viewport.zoom
    const minY = margin - bottom * viewport.zoom
    const maxY = height - margin - top * viewport.zoom
    const x = Math.max(minX, Math.min(maxX, viewport.x))
    const y = Math.max(minY, Math.min(maxY, viewport.y))
    if (Math.abs(x - viewport.x) > 0.5 || Math.abs(y - viewport.y) > 0.5) {
      void flowRef.current?.setViewport({ ...viewport, x, y })
    }
  }

  const onNodesChange = (changes: NodeChange[]): void => {
    for (const change of changes) {
      if (change.type === 'dimensions' && change.dimensions !== undefined) nodeSizes.current.set(change.id, change.dimensions)
      if (change.type === 'remove') nodeSizes.current.delete(change.id)
    }
    const positions = new Map(changes.flatMap(change => change.type === 'position' && change.position !== undefined
      ? [[change.id, change.position] as const]
      : []))
    if (positions.size > 0) {
      setGraph(current => ({
        ...current,
        nodes: current.nodes.map(node => {
          const position = positions.get(node.id)
          return position === undefined ? node : { ...node, position }
        }),
      }))
    }
    for (const change of changes) {
      if (change.type === 'select') {
        if (change.selected) setSelectedId(change.id)
        else if (selectedId === change.id) setSelectedId(undefined)
      }
      if (change.type === 'remove') deleteNode(change.id)
    }
  }

  const onConnect = (connection: Connection): void => {
    if (connection.source === null || connection.target === null) return
    const port = connection.sourceHandle ?? 'default'
    const previous = graph.edges.find(edge => edge.sourceNodeId === connection.source && edge.sourcePort === port)
    if (previous?.targetNodeId === connection.target) return
    if (connection.source === connection.target || graph.nodes.find(node => node.id === connection.target)?.type === 'start') {
      setNotice('连线无效：不能连接到自身或开始节点')
      return
    }
    setGraph(current => connectOrRewire(current, createEdge(connection.source!, port, connection.target!)))
    if (previous !== undefined) setNotice('已改接该出口，原连线已移动到新节点')
  }

  const onReconnect = (previous: Edge, connection: Connection): void => {
    if (connection.source === null || connection.target === null) return
    const source = graph.nodes.find(node => node.id === connection.source)
    const target = graph.nodes.find(node => node.id === connection.target)
    if (source === undefined || target === undefined || NODE_CATALOG[source.type].flowOutputs.length === 0 || target.type === 'start') {
      setNotice('连线无效：无出口节点不能作为起点，开始节点不能作为目标')
      return
    }
    const sourcePort = connection.sourceHandle ?? 'default'
    const occupiedOutput = graph.edges.some(edge => edge.id !== previous.id && edge.sourceNodeId === connection.source && edge.sourcePort === sourcePort)
    if (occupiedOutput) {
      setNotice('该出口已有连线；一个出口只能连接一个入口')
      return
    }
    setGraph(current => {
      return {
        ...current,
        edges: current.edges.map(edge => edge.id === previous.id
          ? { ...edge, sourceNodeId: connection.source!, sourcePort, targetNodeId: connection.target! }
          : edge),
      }
    })
  }

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const type = readPaletteType(event)
    const instance = flowRef.current
    if (type === undefined || instance === null) return
    const position = instance.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const node = createNode(type, position)
    setGraph(current => addNode(current, node))
    setSelectedId(node.id)
  }, [])

  const formatCanvas = async (): Promise<void> => {
    try {
      const arranged = await autoLayoutGraph(graph, nodeSizes.current)
      setGraph(arranged)
    } catch (error) {
      setNotice(`自动排布失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => { void flowRef.current?.fitView({ duration: 260, padding: 0.16, maxZoom: 1.1 }) })
    })
    setNotice('已使用 ELK 自动整理节点布局')
  }

  const changeNode = (id: string, patch: {
    name?: string
    config?: NodeConfig
    execution?: WorkflowNode['execution']
    inputBindings?: Readonly<Record<string, ValueBinding>>
    notifications?: WorkflowNode['notifications']
  }): void => {
    setGraph(current => {
      const next = patchNode(current, id, patch)
      if (patch.config?.type !== 'image-recognition') return next
      const ports = new Set([...patch.config.cases.map(item => `case-${item.id}`), 'else'])
      return { ...next, edges: next.edges.filter(edge => edge.sourceNodeId !== id || ports.has(edge.sourcePort)) }
    })
  }

  const updateCanvasSubflowVersion = async (workflowId: string, version: number): Promise<void> => {
    if (bulkSubflowInProgress.current) return
    const initialGraph = graphRef.current
    const targets = initialGraph.nodes.filter(node => node.config.type === 'call-subflow' && node.config.workflowId === workflowId && node.config.workflowVersion !== version)
    if (targets.length === 0) { setNotice(`当前画布中该子流程的调用节点已统一为 v${version}`); return }
    bulkSubflowInProgress.current = true
    setBulkUpdatingSubflow(true)
    try {
      const signature = subflowCallsSignature(initialGraph, workflowId)
      const known = new Map(editorSubflows.filter(item => item.workflowId === workflowId).map(item => [item.version, item]))
      const needed = new Set([version, ...targets.flatMap(node => node.config.type === 'call-subflow' && node.config.workflowVersion !== undefined ? [node.config.workflowVersion] : [])])
      await Promise.all([...needed].filter(item => !known.has(item)).map(async item => {
        const revision = await getWorkflowRevision(RPA_SERVICE_URL, workflowId, item)
        if (revision.stage !== 'published' || revision.graph.version !== item) throw new Error(`子流程 v${item} 不是可用的已发布版本`)
        known.set(item, revision.graph)
      }))
      const target = known.get(version)
      if (target === undefined) throw new Error(`未读取到子流程 v${version}`)
      if (subflowCallsSignature(graphRef.current, workflowId) !== signature) throw new Error('子流程配置已变化，请重新执行批量版本操作')
      const plan = planBulkSubflowVersionUpdate(graphRef.current, workflowId, target, [...known.values()])
      if (plan.removedMappings > 0 || plan.nodesMissingRequired > 0) {
        const details = [plan.removedMappings > 0 ? `将移除 ${plan.removedMappings} 项与目标版本不兼容的输入映射。` : '', plan.nodesMissingRequired > 0 ? `${plan.nodesMissingRequired} 个调用节点会缺少必填输入：${plan.missingRequiredNames.join('、')}。` : ''].filter(Boolean).join('\n')
        if (!window.confirm(`将当前画布中 ${plan.updates.size} 个同子流程调用节点统一到 v${version}。\n\n${details}\n\n确认继续？`)) return
      }
      if (subflowCallsSignature(graphRef.current, workflowId) !== signature) throw new Error('子流程配置已变化，请重新执行批量版本操作')
      setGraph(current => ({ ...current, nodes: current.nodes.map(node => {
        const next = plan.updates.get(node.id)
        return next === undefined ? node : { ...node, config: next }
      }) }))
      setNotice(`已将 ${plan.updates.size} 个调用节点统一到子流程 v${version}${plan.removedMappings > 0 ? `，移除 ${plan.removedMappings} 项不兼容映射` : ''}${plan.nodesMissingRequired > 0 ? `；${plan.nodesMissingRequired} 个节点仍需补全必填输入` : ''}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '批量切换子流程版本失败')
    } finally {
      bulkSubflowInProgress.current = false
      setBulkUpdatingSubflow(false)
    }
  }

  const importWorkflowFile = async (file: File): Promise<void> => {
    try {
      const next = importWorkflowJson(await file.text(), graph)
      setGraph(next)
      setSelectedId(undefined)
      setRun(undefined)
      setNotice(`已导入流程 JSON「${file.name}」，当前流程身份保持不变`)
      window.requestAnimationFrame(() => { void flowRef.current?.fitView({ duration: 220, padding: 0.16, maxZoom: 1.1 }) })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '流程 JSON 导入失败')
    }
  }

  const persistGraph = useCallback(async (graphToSave: WorkflowGraph, automatic: boolean): Promise<boolean> => {
    const snapshot = JSON.stringify(graphToSave)
    if (saveInProgress.current) return false
    saveInProgress.current = true
    setSaveState('saving')
    try {
      if (serviceWorkflowId !== undefined && hasRedactedSecrets(graphToSave)) {
        const message = '后端返回的密钥已脱敏（******）。为避免覆盖原密钥，请先重新填写密钥后再保存。'
        setNotice(message)
        setSaveState('error')
        return false
      }
      const saved = serviceWorkflowId === undefined
        ? await createWorkflow(RPA_SERVICE_URL, graphToSave, selectedWorkspaceId)
        : await updateWorkflow(RPA_SERVICE_URL, graphToSave)
      setServiceWorkflowId(saved.id ?? saved.graph.workflowId)
      setWorkflowMeta({ publishedVersion: saved.publishedVersion, status: saved.status })
      savedGraphSnapshot.current = snapshot
      setSaveState('saved')
      if (!automatic) setNotice(serviceWorkflowId === undefined ? '草稿已保存到 RPA 服务' : '草稿已保存')
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存到 RPA 服务失败'
      if (!automatic) setNotice(message)
      setSaveState('error')
      return false
    } finally {
      saveInProgress.current = false
    }
  }, [serviceWorkflowId, selectedWorkspaceId])

  const save = async (): Promise<void> => {
    await persistGraph(graph, false)
  }

  const publishCurrent = async (): Promise<void> => {
    const problem = firstPublishIssue(graph, editorSubflows)
    if (problem !== undefined) {
      if (problem.nodeId !== undefined) setSelectedId(problem.nodeId)
      setNotice(`发布失败：${problem.message}`)
      return
    }
    const needsSave = serviceWorkflowId === undefined || JSON.stringify(graph) !== savedGraphSnapshot.current
    if (needsSave && !await persistGraph(graph, false)) return
    try {
      const workflowId = serviceWorkflowId ?? graph.workflowId
      const published = await publishWorkflow(RPA_SERVICE_URL, workflowId)
      setWorkflowMeta({ publishedVersion: published.publishedVersion, status: 'published' })
      setNotice(`已发布正式版本 v${published.publishedVersion}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '发布流程失败')
    }
  }

  useEffect(() => {
    if (view !== 'editor' || savedGraphSnapshot.current === null) return
    const snapshot = JSON.stringify(graph)
    if (snapshot === savedGraphSnapshot.current) return
    setSaveState('pending')
    let timer = 0
    const saveWhenReady = (): void => {
      if (saveInProgress.current) {
        timer = window.setTimeout(saveWhenReady, 250)
        return
      }
      if (JSON.stringify(graph) !== savedGraphSnapshot.current) void persistGraph(graph, true)
    }
    timer = window.setTimeout(saveWhenReady, 900)
    return () => { window.clearTimeout(timer) }
  }, [graph, persistGraph, view])

  useEffect(() => {
    if (view !== 'editor' || window.studio === undefined) return
    return window.studio.onApprovalRequest(prompt => {
      setEditorApproval(prompt)
      setEditorApprovalComment('')
      setNotice('流程正在等待审批，请选择通过或拒绝')
    })
  }, [view])

  useEffect(() => window.studio?.onPageEnvironment(environment => { setPageEnvironment(environment) }), [])

  useEffect(() => () => {
    editorDryRunAbort.current?.abort()
    const runId = activeEditorRunId.current
    if (runId !== undefined) void window.studio?.cancelWorkflow(runId, 'editor-exit').catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!toolbarMenuOpen) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && toolbarMenuRef.current?.contains(event.target)) return
      setToolbarMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setToolbarMenuOpen(false)
      toolbarMenuButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [toolbarMenuOpen])

  useEffect(() => {
    if (edgeMenu === undefined && nodeMenu === undefined) return
    const close = (): void => { setEdgeMenu(undefined); setNodeMenu(undefined) }
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('blur', close)
    }
  }, [edgeMenu, nodeMenu])

  const copyNode = (id: string): void => {
    const copy = duplicateNode(graph, id)
    setNodeMenu(undefined)
    if (copy === undefined) return
    setGraph(current => addNode(current, copy))
    setSelectedId(copy.id)
    setNotice(`已复制「${copy.name}」，可拖动并连接到流程`)
  }

  const openServiceWorkflow = async (id: string): Promise<void> => {
    try {
      const result = await getWorkflow(RPA_SERVICE_URL, id)
      const nextGraph = result.graph
      savedGraphSnapshot.current = JSON.stringify(nextGraph)
      setSaveState('saved')
      setGraph(nextGraph)
      setSelectedWorkspaceId(result.workspaceId)
      localStorage.setItem('rpa.workspaceId', result.workspaceId)
      setServiceWorkflowId(id)
      setWorkflowMeta({ publishedVersion: result.publishedVersion, status: result.status })
      setSelectedId(undefined)
      nodeSizes.current.clear()
      setNodeMenu(undefined)
      setEdgeMenu(undefined)
      setRun(undefined)
      setView('editor')
      setNotice(`已打开「${result.graph.name}」`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '打开 RPA 流程失败')
    }
  }

  const createServiceWorkflow = (): void => {
    const next = { ...createDefaultTemplate(), context: { inputs: [], variables: [] } }
    savedGraphSnapshot.current = JSON.stringify(next)
    setSaveState('saved')
    setGraph(next)
    setServiceWorkflowId(undefined)
    setWorkflowMeta(undefined)
    setSelectedId(next.entryNodeId)
    nodeSizes.current.clear()
    setRun(undefined)
    setView('editor')
    setNotice('正在创建草稿…')
    void persistGraph(next, true)
  }

  const startDryRun = async (): Promise<void> => {
    const problem = firstIssue(graph, editorSubflows)
    if (problem !== undefined) {
      setNotice(problem.message)
      return
    }
    const token = ++runToken.current
    const controller = new AbortController()
    editorDryRunAbort.current = controller
    setRunning(true)
    setNotice('试运行中')
    try {
      const subflows = await loadSubflowBundle(RPA_SERVICE_URL, graph)
      if (token !== runToken.current) return
      if (workflowNeedsBrowser([graph, ...subflows]) && missingStartUrl(graph) && !hasConfiguredStartUrl(subflows)) throw new Error('流程和子流程都没有配置开始 URL；请在开始节点填写一个初始地址')
      await runDry(graph, {
        onUpdate: state => {
          if (token === runToken.current) setRun(state)
        },
        wait: ms => new Promise((resolve, reject) => {
          if (controller.signal.aborted) { reject(new Error('试运行已终止')); return }
          const timer = window.setTimeout(() => {
            controller.signal.removeEventListener('abort', cancel)
            resolve()
          }, ms)
          const cancel = (): void => {
            window.clearTimeout(timer)
            reject(new Error('试运行已终止'))
          }
          controller.signal.addEventListener('abort', cancel, { once: true })
        }),
      }, subflows)
      if (token === runToken.current) setNotice('试运行结束')
    } catch (error) {
      if (token === runToken.current) setNotice(error instanceof Error ? error.message : '试运行失败')
    } finally {
      if (editorDryRunAbort.current === controller) editorDryRunAbort.current = undefined
      if (token === runToken.current) setRunning(false)
    }
  }

  async function runNode(id: string): Promise<void> {
    const node = graph.nodes.find(item => item.id === id)
    if (node === undefined || workflowBusy) return
    if (window.studio?.runWorkflow === undefined) { setNotice('当前窗口不支持节点运行'); return }
    prepareRuntimeInputs(graph.context?.inputs ?? [])
    const referenced = referencedInjections(node).map(row => {
      const declaredType = row.source === 'variable' ? graph.context?.variables.find(variable => variable.name === row.name)?.type : undefined
      return declaredType === undefined ? row : { ...row, type: declaredType === 'object' || declaredType === 'array' ? 'json' as const : declaredType }
    })
    const listed = new Set(referenced.map(row => row.key))
    const declared = (graph.context?.variables ?? []).filter(variable => !listed.has(`variable:${variable.name}`)).map(variable => ({
      key: `variable:${variable.name}`, name: variable.name,
      type: variable.type === 'object' || variable.type === 'array' ? 'json' as const : variable.type,
      value: '', source: 'variable' as const,
    }))
    setNodeRunRows([...referenced, ...declared])
    setNodeRunError(undefined)
    setNodeRunDialog({ nodeId: id, mode: initialNodeRunMode(node.type) })
  }

  async function executeNodeRun(id: string, mode: 'flow' | 'direct', inputs: Readonly<Record<string, JsonValue>>, variables: Readonly<Record<string, JsonValue>>, outputs: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>): Promise<void> {
    const node = graph.nodes.find(item => item.id === id)
    const studio = window.studio
    if (node === undefined || workflowBusy || studio?.runWorkflow === undefined) return
    const token = ++runToken.current
    const runId = crypto.randomUUID()
    activeEditorRunId.current = runId
    setRun(undefined)
    setRunning(true)
    setNotice(mode === 'flow' ? `正在按流程运行至「${node.name}」` : `正在单独运行「${node.name}」`)
    let stop: (() => void) | undefined
    try {
      const runnable = mode === 'flow' ? flowNodeRunGraph(graph, id) : isolatedNodeRunGraph(graph, id)
      const subflows = await loadSubflowBundle(RPA_SERVICE_URL, runnable)
      if (token !== runToken.current) return
      stop = studio.onRunUpdate(({ runId: updateRunId, state }) => { if (token === runToken.current && updateRunId === runId) setRun(state) })
      const state = await studio.runWorkflow(runnable, { runId, inputs, variables, outputs, subflows, reuseCurrentPage: true, stopAfterNodeId: node.type === 'call-subflow' ? undefined : id })
      if (token === runToken.current) {
        setRun(state)
        setNotice(state.status !== 'succeeded' ? `「${node.name}」运行失败` : state.nodes[id] === 'succeeded' ? `「${node.name}」运行完成` : `流程已结束，但条件分支未进入「${node.name}」`)
      }
    } catch (error) {
      if (token === runToken.current) setNotice(error instanceof Error ? error.message : `「${node.name}」运行失败`)
    } finally {
      stop?.()
      if (activeEditorRunId.current === runId) activeEditorRunId.current = undefined
      if (token === runToken.current) setRunning(false)
    }
  }

  const confirmNodeRun = async (): Promise<void> => {
    if (nodeRunDialog === undefined) return
    try {
      const inputs = parseRuntimeInputs(graph.context?.inputs ?? [], runtimeInputValues, nodeRunDialog.mode === 'flow')
      const { variables, outputs } = nodeRunDialog.mode === 'direct' ? parseInjections(nodeRunRows) : { variables: {}, outputs: {} }
      const { nodeId, mode } = nodeRunDialog
      setNodeRunError(undefined)
      setNodeRunDialog(undefined)
      await executeNodeRun(nodeId, mode, inputs, variables, outputs)
    } catch (error) {
      setNodeRunError(error instanceof Error ? error.message : '请检查运行参数')
    }
  }

  const startLiveRun = async (): Promise<void> => {
    const problem = firstIssue(graph, editorSubflows)
    if (problem !== undefined) {
      setNotice(problem.message)
      return
    }
    // A blank start URL can use the browser page left open by an earlier run.
    // The main process checks whether that page is actually available.
    const inputs = graph.context?.inputs ?? []
    if (inputs.length > 0) {
      prepareRuntimeInputs(inputs)
      setRuntimeInputError(undefined)
      setRuntimeRunRequest({ type: 'workflow' })
      setRuntimeInputDialog(true)
      return
    }
    await executeLiveRun({})
  }

  const confirmRuntimeRun = async (): Promise<void> => {
    try {
      const inputs = parseRuntimeInputs(graph.context?.inputs ?? [], runtimeInputValues)
      setRuntimeInputError(undefined)
      setRuntimeInputDialog(false)
      const request = runtimeRunRequest
      setRuntimeRunRequest(undefined)
      if (request?.type === 'picker') {
        pickerInputsByWorkflow.current[graph.workflowId] = true
        await performElementPick(request.nodeId, request.field, request.stepIndex, inputs)
      } else await executeLiveRun(inputs)
    } catch (error) {
      setRuntimeInputError(error instanceof Error ? error.message : '请检查运行时变量')
    }
  }

  const executeLiveRun = async (inputs: Readonly<Record<string, JsonValue>>): Promise<void> => {
    const studio = window.studio
    if (studio === undefined || studio.runWorkflow === undefined) {
      setNotice('当前窗口没有工作室接口，无法打开浏览器。请用 Electron 窗口点「运行」。')
      return
    }
    const token = ++runToken.current
    const runId = crypto.randomUUID()
    activeEditorRunId.current = runId
    setRun(undefined)
    setRunning(true)
    setNotice('正在启动流程…')
    const stop = studio.onRunUpdate(({ runId: updateRunId, state }) => {
      if (token === runToken.current && updateRunId === runId) setRun(state)
    })
    try {
      const subflows = await loadSubflowBundle(RPA_SERVICE_URL, graph)
      if (token !== runToken.current) return
      const state = await studio.runWorkflow(graph, { runId, inputs, subflows, reuseCurrentPage: true })
      if (token === runToken.current) {
        setRun(state)
        setNotice(state.status === 'succeeded' ? '运行结束' : '运行失败')
      }
    } catch (error) {
      if (token === runToken.current) {
        setNotice(error instanceof Error ? error.message : '运行失败')
      }
    } finally {
      stop()
      if (activeEditorRunId.current === runId) activeEditorRunId.current = undefined
      if (token === runToken.current) setRunning(false)
    }
  }

  const leaveEditor = (): void => {
    runToken.current += 1
    editorDryRunAbort.current?.abort()
    editorDryRunAbort.current = undefined
    const runId = activeEditorRunId.current
    activeEditorRunId.current = undefined
    if (runId !== undefined) void window.studio?.cancelWorkflow(runId, 'editor-exit').catch(() => undefined)
    setRunning(false)
    setEditorApproval(undefined)
    setEditorApprovalComment('')
    setView('home')
  }

  const stopRunningWorkflow = async (): Promise<void> => {
    if (running) {
      runToken.current += 1
      editorDryRunAbort.current?.abort()
      editorDryRunAbort.current = undefined
      const runId = activeEditorRunId.current
      activeEditorRunId.current = undefined
      if (runId !== undefined) {
        setStoppingRunId(runId)
        try { await window.studio?.cancelWorkflow(runId, 'user') } catch { /* The run may already have ended. */ }
      }
      setEditorApproval(undefined)
      setEditorApprovalComment('')
      setRunning(false)
      setStoppingRunId(undefined)
      setNotice('流程已停止')
      return
    }
    const activity = globalRunActivity
    if (activity === undefined || stoppingRunId !== undefined) return
    setStoppingRunId(activity.runId)
    try {
      await window.studio?.cancelWorkflow(activity.runId, 'user')
    } catch (error) {
      setStoppingRunId(undefined)
      setNotice(error instanceof Error ? error.message : '停止流程失败')
    }
  }

  const pickElement = async (nodeId: string, field: 'selector' | 'beforeHover' | 'waitForVisible' | 'rowSelector' | 'extractField', stepIndex?: number): Promise<void> => {
    const needsRuntimeInputs = (graph.context?.inputs ?? []).length > 0 && !pickerInputsByWorkflow.current[graph.workflowId]
    if (needsRuntimeInputs) {
      prepareRuntimeInputs(graph.context?.inputs ?? [])
      setRuntimeInputError(undefined)
      setRuntimeRunRequest({ type: 'picker', nodeId, field, stepIndex })
      setRuntimeInputDialog(true)
      setNotice('首次准备拾取需要填写流程输入；后续拾取会复用已打开的浏览器')
      return
    }
    const inputs = parseRuntimeInputs(graph.context?.inputs ?? [], runtimeInputsByWorkflow.current[graph.workflowId] ?? {})
    await performElementPick(nodeId, field, stepIndex, inputs)
  }

  const performElementPick = async (nodeId: string, field: 'selector' | 'beforeHover' | 'waitForVisible' | 'rowSelector' | 'extractField', stepIndex: number | undefined, inputs: Readonly<Record<string, JsonValue>>): Promise<void> => {
    if (window.studio?.pickElement === undefined) { setNotice('当前窗口不支持元素拾取'); return }
    setNotice('已打开元素拾取器，请在 Chromium 页面中点击元素')
    try {
      const prefix = prefixToNode(graph, nodeId)
      const targetNode = graph.nodes.find(item => item.id === nodeId)
      const shouldPrepareInsideAction = stepIndex !== undefined && targetNode?.config.type === 'page-action'
      const prepNodes = shouldPrepareInsideAction
        ? prefix.nodes.map(item => item.id === nodeId && item.config.type === 'page-action'
          ? { ...item, config: { ...item.config, steps: item.config.steps.slice(0, stepIndex) } }
          : item)
        : (prefix.nodes.length > 1 ? prefix.nodes.slice(0, -1) : [])
      const prepIds = new Set(prepNodes.map(item => item.id))
      // 保留前置节点的所有分支，未进入目标链的分支会在主进程收束到临时结束节点。
      const prepEdges = graph.edges.filter(edge => prepIds.has(edge.sourceNodeId))
      const prep: WorkflowGraph | undefined = prepNodes.length > 0
        ? { ...graph, entryNodeId: prepNodes[0].id, nodes: prepNodes, edges: prepEdges }
        : undefined
      const start = graph.nodes.find(item => item.type === 'start')
      const startUrl = start?.config.type === 'start' ? start.config.url : undefined
      const actionNode = graph.nodes.find(item => item.id === nodeId)
      const stepUrl = actionNode?.config.type === 'page-action' && stepIndex !== undefined
        ? actionNode.config.steps.slice(0, stepIndex + 1).find(step => step.type === 'open')?.url
        : undefined
      const subflows = prep === undefined ? [] : await loadSubflowBundle(RPA_SERVICE_URL, prep)
      const picked = window.studio.prepareAndPickElement !== undefined
        ? await window.studio.prepareAndPickElement(prep, prep === undefined ? (stepUrl || startUrl) : undefined, field === 'rowSelector' ? 'list' : 'element', subflows, inputs, shouldPrepareInsideAction ? { workflowId: graph.workflowId, nodeId, stepIndex } : undefined)
        : await window.studio.pickElement(prep === undefined ? (stepUrl || startUrl) : undefined, field === 'rowSelector' ? 'list' : 'element')
      if (picked.selector === '') { setNotice('已取消元素拾取'); return }
      const node = graph.nodes.find(item => item.id === nodeId)
      if (node === undefined) return
      const value = picked.selector
      const config = node.config
      if (config.type === 'extract' && field === 'rowSelector') setGraph(current => patchNode(current, nodeId, { config: { ...config, rowSelector: value } }))
      else if (config.type === 'extract' && field === 'extractField' && stepIndex !== undefined) setGraph(current => patchNode(current, nodeId, { config: { ...config, fields: (config.fields ?? []).map((item, index) => index === stepIndex ? { ...item, selector: value } : item) } }))
      else if (config.type === 'click') setGraph(current => patchNode(current, nodeId, { config: { ...config, [field]: value } }))
      else if (field === 'selector' && (config.type === 'type' || config.type === 'extract' || config.type === 'wait')) setGraph(current => patchNode(current, nodeId, { config: { ...config, selector: value } }))
      else if (config.type === 'page-action' && stepIndex !== undefined) {
        setGraph(current => patchNode(current, nodeId, { config: { ...config, steps: config.steps.flatMap((step, index) => {
          if (index !== stepIndex || !('selector' in step)) return [step]
          if (step.type === 'click' && picked.triggerSelector !== undefined && picked.optionSelector !== undefined) return [
            { type: 'click' as const, selector: picked.triggerSelector, waitAfterMs: 350 },
            { type: 'click' as const, selector: picked.optionSelector, waitAfterMs: step.waitAfterMs ?? 0 },
          ]
          return [{ ...step, selector: value, ...(step.type === 'click' && picked.optionValue !== undefined ? { optionValue: picked.optionValue } : {}) }]
        }) } }))
      }
      setNotice(`已选中 ${picked.tagName}${picked.text ? `「${picked.text}」` : ''}，已回填选择器`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '元素拾取失败')
    }
  }

  const submitEditorApproval = async (decision: 'approved' | 'rejected'): Promise<void> => {
    const approval = editorApproval
    const studio = window.studio
    if (approval === undefined || studio === undefined || editorApprovalSubmitting) return
    const comment = editorApprovalComment.trim()
    if (decision === 'rejected' && approval.requireCommentOnReject && comment === '') {
      setNotice('拒绝审批时必须填写审批意见')
      return
    }
    setEditorApprovalSubmitting(true)
    try {
      await studio.respondApproval(approval.id, decision, comment)
      setEditorApproval(undefined)
      setEditorApprovalComment('')
      setNotice(decision === 'approved' ? '审批已通过，流程继续执行' : '审批已拒绝，流程进入拒绝分支')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '提交审批结果失败')
    } finally {
      setEditorApprovalSubmitting(false)
    }
  }

  const bubbleRun = running ? run : globalRunActivity?.state
  const bubbleStatuses = Object.values(bubbleRun?.nodes ?? {})
  const bubbleCurrentNodeName = running
    ? currentRunningNodeName
    : bubbleRun?.currentNodeId === undefined
      ? globalRunActivity?.workflowName
      : [...bubbleRun.logs].reverse().find(line => line.nodeId === bubbleRun.currentNodeId)?.nodeName ?? globalRunActivity?.workflowName
  const runningBubble = running || globalRunActivity !== undefined ? <WorkflowRunningBubble
    waitingApproval={bubbleRun?.status === 'waiting-approval'}
    currentNodeName={bubbleCurrentNodeName}
    completed={running ? runCompletedCount : bubbleStatuses.filter(status => status === 'succeeded' || status === 'failed').length}
    total={running ? runTotalCount : bubbleStatuses.length}
    stopping={stoppingRunId !== undefined}
    onStop={() => { void stopRunningWorkflow() }}
    onOpen={running && view === 'editor' ? () => {
      setRunPanelExpandRequest(value => value + 1)
      document.getElementById('workflow-run-panel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    } : undefined}
  /> : null

  if (view === 'home') return <><WorkbenchHome currentUser={currentUser} onLogout={onLogout} onOpenWorkflow={id => { void openServiceWorkflow(id) }} onCreateWorkflow={createServiceWorkflow} selectedWorkspaceId={selectedWorkspaceId} onWorkspaceChange={id => { setSelectedWorkspaceId(id); localStorage.setItem('rpa.workspaceId', id); setWorkflowListView({ page: 1, query: '' }) }} workflowListView={workflowListView} onWorkflowListViewChange={setWorkflowListView} onRunActivityChange={activity => { setGlobalRunActivity(activity); if (activity === undefined) setStoppingRunId(undefined) }} />{runningBubble}</>

  return (
    <div className="studio">
      <header className="toolbar">
        <div className="toolbar-identity">
          <button type="button" className="toolbar-back" title="返回工作台" aria-label="返回工作台" onClick={() => { setToolbarMenuOpen(false); leaveEditor() }}>←</button>
          <div className="toolbar-flow-info">
            <input
              className="workflow-name"
              aria-label="流程名称"
              value={graph.name}
              onChange={event => { setGraph(current => renameWorkflow(current, event.target.value)) }}
            />
            <div className="toolbar-flow-status">
              <span className="workflow-version-summary" title="当前编辑的是草稿；执行中心使用已发布版本，编辑器运行使用当前草稿"><span>编辑草稿</span><span>已发布 {workflowMeta?.publishedVersion == null ? '无' : `v${workflowMeta.publishedVersion}`}</span></span>
              <span className={`autosave-status is-${saveState}`} role="status">{saveState === 'saving' ? '保存中…' : saveState === 'pending' ? '有未保存更改' : saveState === 'error' ? '自动保存失败' : '已自动保存'}</span>
              {saveState === 'error' ? <button type="button" className="toolbar-save-retry" onClick={() => { void save() }}>重试保存</button> : null}
            </div>
          </div>
        </div>
        <div className="toolbar-actions">
          <span className="toolbar-account" title={`PMS 账号 ${currentUser.username}`}>{currentUser.name}</span>
          <button type="button" className={contextOpen ? 'is-active' : ''} onClick={() => { setContextOpen(value => !value) }}>全局变量{((graph.context?.inputs.length ?? 0) + (graph.context?.variables.length ?? 0)) > 0 ? ` · ${(graph.context?.inputs.length ?? 0) + (graph.context?.variables.length ?? 0)}` : ''}</button>
          <input ref={workflowJsonInputRef} className="workflow-json-file-input" type="file" accept="application/json,.json" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file !== undefined) void importWorkflowFile(file) }} />
          <button type="button" disabled={workflowBusy} title="模拟执行流程，不操作网页" onClick={() => { void startDryRun() }}>
            {running ? '进行中…' : globalRunActivity !== undefined ? '已有流程运行' : '试运行'}
          </button>
          <button type="button" className="primary" disabled={workflowBusy} title="运行当前草稿" onClick={() => { void startLiveRun() }}>
            {running ? '进行中…' : globalRunActivity !== undefined ? '已有流程运行' : '运行草稿'}
          </button>
          <button type="button" className="toolbar-publish" disabled={running || saveState === 'saving'} title="发布后执行中心可使用此版本" onClick={() => { void publishCurrent() }}>发布</button>
          <div className="toolbar-more" ref={toolbarMenuRef}>
            <button ref={toolbarMenuButtonRef} type="button" className="toolbar-more-trigger" aria-label="更多操作" aria-haspopup="true" aria-expanded={toolbarMenuOpen} aria-controls={toolbarMenuOpen ? 'toolbar-more-menu' : undefined} title="更多操作" onClick={() => { setToolbarMenuOpen(open => !open) }}>···</button>
            {toolbarMenuOpen ? <div className="toolbar-more-menu" id="toolbar-more-menu">
              <button type="button" onClick={() => { setToolbarMenuOpen(false); void save() }}>保存草稿</button>
              <button type="button" onClick={() => { setToolbarMenuOpen(false); void formatCanvas() }}>自动排布</button>
              <button type="button" onClick={() => { setToolbarMenuOpen(false); setWebhookOpen(true) }}>Webhook 通知设置</button>
              <hr />
              <button type="button" onClick={() => { setToolbarMenuOpen(false); workflowJsonInputRef.current?.click() }}>导入流程 JSON</button>
              <button type="button" onClick={() => { setToolbarMenuOpen(false); downloadJson(graph, `${safeJsonFilename(graph.name)}.json`); setNotice('流程 JSON 已导出') }}>导出流程 JSON</button>
              <hr />
              <button type="button" onClick={() => { setToolbarMenuOpen(false); leaveEditor(); onLogout() }}>退出登录</button>
            </div> : null}
          </div>
        </div>
      </header>
      {notice === undefined ? null : <p className="notice" role="status">{notice}</p>}
      <div className="workspace">
        {contextOpen ? <div className="context-overlay" role="presentation" onClick={() => { setContextOpen(false) }}><ContextPanel context={graph.context ?? { inputs: [], variables: [] }} onChange={context => { setGraph(current => ({ ...current, context })) }} onClose={() => { setContextOpen(false) }} /></div> : null}
        {webhookOpen ? <WebhookSettings value={graph.webhook} workflowName={graph.name} onChange={webhook => { setGraph(current => ({ ...current, webhook })) }} onClose={() => { setWebhookOpen(false) }} /> : null}
        <Palette />
        <VariablesPanel graph={graph} subflows={editorSubflows} outputs={run?.outputs} inputs={run?.inputs} variables={run?.variables} page={pageEnvironment ?? run?.page} />
        <div className="canvas-shell" ref={canvasRef} onDragOver={event => { event.preventDefault() }} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={instance => { flowRef.current = instance }}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            connectOnClick
            onReconnect={onReconnect}
            onEdgeContextMenu={(event, edge) => {
              event.preventDefault()
              setNodeMenu(undefined)
              setEdgeMenu({ edgeId: edge.id, x: event.clientX, y: event.clientY })
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault()
              setEdgeMenu(undefined)
              setNodeMenu({ nodeId: node.id, x: Math.min(event.clientX, window.innerWidth - 150), y: Math.min(event.clientY, window.innerHeight - 52) })
            }}
            onMoveEnd={keepCanvasVisible}
            edgesReconnectable
            onPaneClick={() => { setSelectedId(undefined); setEdgeMenu(undefined); setNodeMenu(undefined) }}
            panOnDrag
            panActivationKeyCode="Space"
            autoPanOnNodeDrag={false}
            fitView
            deleteKeyCode={null}
          >
            <Background gap={18} size={1} />
            <Controls />
            <MiniMap pannable zoomable width={64} height={44} />
          </ReactFlow>
        </div>
        {edgeMenu ? <div className="edge-context-menu" role="menu" style={{ left: edgeMenu.x, top: edgeMenu.y }} onPointerDown={event => { event.stopPropagation() }}><button type="button" role="menuitem" onClick={() => { setGraph(current => removeEdges(current, [edgeMenu.edgeId])); setEdgeMenu(undefined); setNotice('已删除连线') }}>删除连线</button></div> : null}
        {nodeMenu ? <div className="node-context-menu" role="menu" style={{ left: nodeMenu.x, top: nodeMenu.y }} onPointerDown={event => { event.stopPropagation() }}><button type="button" role="menuitem" disabled={graph.nodes.find(node => node.id === nodeMenu.nodeId)?.type === 'start'} title={graph.nodes.find(node => node.id === nodeMenu.nodeId)?.type === 'start' ? '流程只能有一个开始节点' : undefined} onClick={() => { copyNode(nodeMenu.nodeId) }}>复制节点</button></div> : null}
        <Properties graph={propertiesGraph} node={selected} subflows={editorSubflows} subflowError={subflowVariableError} llmError={serviceLlmError} onChange={changeNode} onBatchSubflowVersion={(workflowId, version) => updateCanvasSubflowVersion(workflowId, version)} batchSubflowBusy={bulkUpdatingSubflow} onImport={node => { changeNode(node.id, { name: node.name, config: node.config, execution: node.execution, inputBindings: node.inputBindings, notifications: node.notifications }); setNotice(`已导入节点「${node.name}」的 JSON 配置`) }} onDelete={deleteNode} onRun={id => { void runNode(id) }} onPick={(id, field, stepIndex) => { void pickElement(id, field, stepIndex) }} />
      </div>
      <RunPanel issues={issues} run={run} expandRequest={runPanelExpandRequest} />
      {runningBubble}
      {editorApproval ? <div className="execution-dialog-backdrop" role="presentation">
        <section className="execution-dialog approval-dialog" role="dialog" aria-modal="true" aria-label="审批任务" onClick={event => { event.stopPropagation() }}>
          <header><div><h2>{editorApproval.title}</h2><p>{editorApproval.nodeName} · 编辑器试运行审批</p></div></header>
          <div className="execution-dialog-body">
            <p className="approval-description">{editorApproval.description || '请确认是否允许流程继续执行。'}</p>
            {editorApproval.fields.length > 0 ? <dl className="approval-detail-list">{editorApproval.fields.map((field, index) => <div key={`${field.label}-${index}`}><dt>{field.label || `字段 ${index + 1}`}</dt><dd>{typeof field.value === 'object' && field.value !== null ? JSON.stringify(field.value, null, 2) : String(field.value ?? '')}</dd></div>)}</dl> : null}
            <label className="execution-input-field"><span>审批意见{editorApproval.requireCommentOnReject ? <em>拒绝时必填</em> : null}</span><textarea rows={4} value={editorApprovalComment} onChange={event => { setEditorApprovalComment(event.target.value) }} placeholder="填写审批意见（可选）" /></label>
            {editorApproval.timeoutAt ? <p className="properties-hint">审批截止时间：{new Date(editorApproval.timeoutAt).toLocaleString()}</p> : null}
            <p className="properties-hint">选择通过或拒绝后，流程会从对应出口继续执行。</p>
          </div>
          <footer><button type="button" className="approval-reject" disabled={editorApprovalSubmitting} onClick={() => { void submitEditorApproval('rejected') }}>{editorApprovalSubmitting ? '正在提交…' : '拒绝并继续'}</button><button type="button" className="workbench-primary" disabled={editorApprovalSubmitting} onClick={() => { void submitEditorApproval('approved') }}>{editorApprovalSubmitting ? '正在提交…' : '通过并继续'}</button></footer>
        </section>
      </div> : null}
      {nodeRunDialog ? <div className="execution-dialog-backdrop" role="presentation" onClick={() => { setNodeRunDialog(undefined); setNodeRunError(undefined) }}>
        <section className="execution-dialog node-run-dialog" role="dialog" aria-modal="true" aria-label="运行节点" onClick={event => { event.stopPropagation() }}>
          <header><div><h2>运行节点「{graph.nodes.find(node => node.id === nodeRunDialog.nodeId)?.name}」</h2><p>选择执行方式，再填写本次运行需要的数据。</p></div><button type="button" aria-label="关闭" onClick={() => { setNodeRunDialog(undefined); setNodeRunError(undefined) }}>×</button></header>
          <div className="execution-dialog-body">
            <div className="node-run-modes" role="radiogroup" aria-label="节点运行方式">
              <label className={nodeRunDialog.mode === 'flow' ? 'is-selected' : ''}><input type="radio" name="node-run-mode" checked={nodeRunDialog.mode === 'flow'} onChange={() => { setNodeRunDialog({ ...nodeRunDialog, mode: 'flow' }); setNodeRunError(undefined) }} /><span><strong>按照流程运行</strong><small>{graph.nodes.find(node => node.id === nodeRunDialog.nodeId)?.type === 'call-subflow' ? '从父流程开始节点执行；若父流程配置了 URL，会先跳转到该页面。' : '从开始节点出发，按实际条件分支运行，到该节点后停止。'}</small></span></label>
              <label className={nodeRunDialog.mode === 'direct' ? 'is-selected' : ''}><input type="radio" name="node-run-mode" checked={nodeRunDialog.mode === 'direct'} onChange={() => { setNodeRunDialog({ ...nodeRunDialog, mode: 'direct' }); setNodeRunError(undefined) }} /><span><strong>注入变量，只执行该节点</strong><small>{graph.nodes.find(node => node.id === nodeRunDialog.nodeId)?.type === 'call-subflow' ? '只执行子流程；子流程开始 URL 留空时沿用当前浏览器页面。' : '跳过前置节点；可填写流程输入、变量和上游节点输出。'}</small></span></label>
            </div>
            {(graph.context?.inputs ?? []).length > 0 ? <div className="node-run-section"><h3>流程输入</h3>{(graph.context?.inputs ?? []).map(input => <label className="execution-input-field" key={input.name}><span>{input.description || input.name}{input.required && nodeRunDialog.mode === 'flow' ? <em>必填</em> : null}</span>{input.type === 'boolean' ? <select value={runtimeInputValues[input.name] ?? ''} onChange={event => { updateRuntimeInput(input.name, event.target.value) }}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select> : input.type === 'object' || input.type === 'array' ? <textarea rows={3} value={runtimeInputValues[input.name] ?? ''} onChange={event => { updateRuntimeInput(input.name, event.target.value) }} placeholder={input.type === 'object' ? '{"key":"value"}' : '["value"]'} /> : <input type={input.secret ? 'password' : input.type === 'number' ? 'number' : 'text'} value={runtimeInputValues[input.name] ?? ''} onChange={event => { updateRuntimeInput(input.name, event.target.value) }} placeholder={`请输入${input.type === 'number' ? '数字' : '内容'}`} />}</label>)}</div> : null}
            {nodeRunDialog.mode === 'direct' ? <div className="node-run-section"><div className="node-run-section-title"><h3>注入数据</h3><button type="button" onClick={() => { setNodeRunRows(rows => [...rows, { key: `custom:${crypto.randomUUID()}`, name: '', type: 'string', value: '' }]) }}>＋ 添加变量</button></div><p>自动列出当前节点引用的变量和上游输出；留空则不注入。</p>{nodeRunRows.map(row => <div className="node-run-row" key={row.key}><label className="execution-input-field"><span>{row.source === 'output' ? '上游输出' : '变量名'}</span><input aria-label={row.source === 'output' ? '上游输出' : '变量名'} value={row.source === 'output' ? `${graph.nodes.find(node => node.id === row.nodeId)?.name ?? row.nodeId}.${row.port}` : row.name} readOnly={row.source === 'output'} onChange={event => { setNodeRunRows(rows => rows.map(item => item.key === row.key ? { ...item, name: event.target.value } : item)) }} placeholder="例如 orderId" /></label><label className="execution-input-field"><span>类型</span><select value={row.type} onChange={event => { setNodeRunRows(rows => rows.map(item => item.key === row.key ? { ...item, type: event.target.value as InjectionType } : item)) }}><option value="string">文本</option><option value="number">数字</option><option value="boolean">布尔值</option><option value="json">JSON</option></select></label><label className="execution-input-field"><span>值</span>{row.type === 'boolean' ? <select value={row.value} onChange={event => { setNodeRunRows(rows => rows.map(item => item.key === row.key ? { ...item, value: event.target.value } : item)) }}><option value="">不注入</option><option value="true">true</option><option value="false">false</option></select> : <input value={row.value} onChange={event => { setNodeRunRows(rows => rows.map(item => item.key === row.key ? { ...item, value: event.target.value } : item)) }} placeholder={row.type === 'json' ? '{"key":"value"}' : '填写值'} />}</label><button type="button" className="node-run-remove" aria-label={`移除 ${row.name}`} onClick={() => { setNodeRunRows(rows => rows.filter(item => item.key !== row.key)) }}>×</button></div>)}{nodeRunRows.length === 0 ? <p className="execution-no-inputs">当前节点未直接引用变量；仍可手动添加。</p> : null}</div> : null}
            {nodeRunError ? <p className="execution-error" role="alert">{nodeRunError}</p> : null}
          </div>
          <footer><button type="button" onClick={() => { setNodeRunDialog(undefined); setNodeRunError(undefined) }}>取消</button><button type="button" className="workbench-primary" onClick={() => { void confirmNodeRun() }}>▶ 开始运行</button></footer>
        </section>
      </div> : null}
      {runtimeInputDialog ? <div className="execution-dialog-backdrop" role="presentation" onClick={() => { setRuntimeInputDialog(false); setRuntimeInputError(undefined) }}><section className="execution-dialog" role="dialog" aria-modal="true" aria-label="填写运行时变量" onClick={event => { event.stopPropagation() }}><header><div><h2>填写运行时变量</h2><p>开始运行前，请填写本次流程需要的输入。</p></div><button type="button" aria-label="关闭" onClick={() => { setRuntimeInputDialog(false); setRuntimeInputError(undefined) }}>×</button></header><div className="execution-dialog-body">{(graph.context?.inputs ?? []).map(input => <label className="execution-input-field" key={input.name}><span>{input.description || input.name}{input.required ? <em>必填</em> : null}</span>{input.type === 'boolean' ? <select value={runtimeInputValues[input.name] ?? ''} onChange={event => { updateRuntimeInput(input.name, event.target.value) }}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select> : input.type === 'object' || input.type === 'array' ? <textarea rows={4} value={runtimeInputValues[input.name] ?? ''} onChange={event => { updateRuntimeInput(input.name, event.target.value) }} placeholder={input.type === 'object' ? '{"key":"value"}' : '["value"]'} /> : <input type={input.secret ? 'password' : input.type === 'number' ? 'number' : 'text'} value={runtimeInputValues[input.name] ?? ''} onChange={event => { updateRuntimeInput(input.name, event.target.value) }} placeholder={input.defaultValue === undefined ? `请输入${input.type === 'number' ? '数字' : '内容'}` : formatRuntimeInput(input.defaultValue)} />}</label>)}{runtimeInputError ? <p className="execution-error" role="alert">{runtimeInputError}</p> : null}</div><footer><button type="button" onClick={() => { setRuntimeInputDialog(false); setRuntimeInputError(undefined) }}>取消</button><button type="button" className="workbench-primary" onClick={() => { void confirmRuntimeRun() }}>▶ 开始运行</button></footer></section></div> : null}
    </div>
  )
}
