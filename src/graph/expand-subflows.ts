import type { CallSubflowConfig, NodeConfig, ValueBinding, WorkflowGraph, WorkflowNode } from './types.ts'

const MAX_DEPTH = 10

function identity(workflowId: string, version: number): string {
  return `${workflowId}@${version}`
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_')
}

function inputAlias(callNodeId: string, name: string): string {
  return `subflow_${safeName(callNodeId)}_${safeName(name)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function aliasedInputPath(path: string, aliases: ReadonlyMap<string, string>): string | undefined {
  const direct = aliases.get(path)
  if (direct !== undefined) return direct
  let matchedName = ''
  let matchedAlias: string | undefined
  for (const [name, alias] of aliases) {
    if (name.length > matchedName.length && (path.startsWith(`${name}.`) || path.startsWith(`${name}[`))) {
      matchedName = name
      matchedAlias = alias
    }
  }
  return matchedAlias === undefined ? undefined : `${matchedAlias}${path.slice(matchedName.length)}`
}

function rewriteValue(
  value: unknown,
  idMap: ReadonlyMap<string, string>,
  aliases: ReadonlyMap<string, string>,
  llmIds: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*inputs\.([^}\s]+)\s*\}\}/g, (match, name: string) => {
      const alias = aliasedInputPath(name, aliases)
      return alias === undefined ? match : `{{${alias}}}`
    })
  }
  if (Array.isArray(value)) return value.map(item => rewriteValue(item, idMap, aliases, llmIds))
  if (!isRecord(value)) return value
  if (value.kind === 'workflow-input' && typeof value.name === 'string') {
    const alias = aliasedInputPath(value.name, aliases)
    return alias === undefined ? value : { kind: 'variable', name: alias }
  }
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'nodeId' && typeof item === 'string') result[key] = idMap.get(item) ?? item
    else if (key === 'llmId' && typeof item === 'string') result[key] = llmIds.get(item) ?? item
    else result[key] = rewriteValue(item, idMap, aliases, llmIds)
  }
  return result
}

function applyDefaultLlm(node: WorkflowNode, llmId: string | undefined): WorkflowNode {
  if (llmId === undefined || !isRecord(node.config)) return node
  const fill = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fill)
    if (!isRecord(value)) return value
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) result[key] = fill(item)
    if (('systemPrompt' in value || 'task' in value || 'casePrompts' in value || 'aiPrompt' in value || value.type === 'image-recognition') && result['llmId'] === undefined) result['llmId'] = llmId
    if (('enabled' in value && 'prompt' in value) && result['llmId'] === undefined) result['llmId'] = llmId
    return result
  }
  const config = fill(node.config) as NodeConfig
  return { ...node, config }
}

function mappedInput(config: CallSubflowConfig, inputName: string): ValueBinding | undefined {
  return config.inputMappings?.find(item => item.inputName === inputName)?.source
}

function mergeDefinitions(parent: WorkflowGraph, child: WorkflowGraph): WorkflowGraph {
  const variables = [...(parent.context?.variables ?? [])]
  const names = new Set(variables.map(item => item.name))
  for (const definition of child.context?.variables ?? []) {
    const existing = variables.find(item => item.name === definition.name)
    if (definition.secret && definition.defaultValue === '******' && (existing === undefined || !existing.secret)) {
      throw new Error(`子流程「${child.name}」的敏感变量「${definition.description || definition.name}」尚未在父流程中声明；请在父流程全局变量中添加同名敏感变量`)
    }
  }
  for (const definition of child.context?.variables ?? []) {
    if (names.has(definition.name)) continue
    names.add(definition.name)
    variables.push(definition)
  }

  return {
    ...parent,
    context: { inputs: parent.context?.inputs ?? [], variables },
  }
}

function replaceCall(graph: WorkflowGraph, callNode: WorkflowNode, child: WorkflowGraph): WorkflowGraph {
  if (callNode.config.type !== 'call-subflow') return graph
  const config = callNode.config
  const childId = child.workflowId
  const prefix = `${callNode.id}::${safeName(childId)}_v${child.version}`
  const idMap = new Map(child.nodes.map(node => [node.id, `${prefix}::${node.id}`]))
  const aliases = new Map((child.context?.inputs ?? []).map(input => [input.name, inputAlias(callNode.id, input.name)]))
  const childLlmConfigs = child.llms ?? (child.llm === undefined ? [] : [child.llm])
  const llmIds = new Map(childLlmConfigs.map(llm => [llm.id, `${prefix}::llm::${llm.id}`]))
  const defaultChildLlm = child.llm?.id ?? childLlmConfigs[0]?.id
  const remappedDefaultLlm = defaultChildLlm === undefined ? undefined : llmIds.get(defaultChildLlm)

  const mappings = config.inputMappings ?? []
  const childInputNames = new Set((child.context?.inputs ?? []).map(input => input.name))
  if (mappings.some(mapping => !childInputNames.has(mapping.inputName))) {
    throw new Error(`调用子流程「${child.name}」的输入映射包含不存在的输入`)
  }
  const injectionNodes: WorkflowNode[] = []
  for (const [index, input] of (child.context?.inputs ?? []).entries()) {
    const source = mappedInput(config, input.name)
    if (source === undefined && input.required && input.defaultValue === undefined) {
      throw new Error(`调用子流程「${child.name}」时，必填输入「${input.description || input.name}」尚未映射`)
    }
    const value: ValueBinding = source ?? { kind: 'literal', value: input.defaultValue ?? null }
    const id = `${callNode.id}::inject::${index}`
    injectionNodes.push({
      id,
      type: 'set-variable',
      name: `注入 ${input.description || input.name}`,
      position: { x: callNode.position.x + 230 + index * 210, y: callNode.position.y },
      inputBindings: { value },
      config: { type: 'set-variable', name: aliases.get(input.name) ?? inputAlias(callNode.id, input.name), value, path: '', interpolate: source?.kind === 'literal', ...(input.required ? { requiredInput: { name: input.description || input.name, type: input.type } } : {}) },
      execution: callNode.execution,
    })
  }

  const clonedNodes = child.nodes.map(node => {
    const rewritten = rewriteValue(node, idMap, aliases, llmIds) as WorkflowNode
    const mapped = { ...rewritten, id: idMap.get(node.id) ?? `${prefix}::${node.id}`, name: `${child.name} · ${node.name}` }
    if (mapped.config.type === 'end') {
      return { ...mapped, type: 'page-action' as const, config: { type: 'page-action' as const, steps: [] }, name: `${child.name} · 返回父流程` }
    }
    return applyDefaultLlm(mapped, remappedDefaultLlm)
  })
  const childEdges = child.edges.map(edge => ({
    ...edge,
    id: `${prefix}::${edge.id}`,
    sourceNodeId: idMap.get(edge.sourceNodeId) ?? edge.sourceNodeId,
    targetNodeId: idMap.get(edge.targetNodeId) ?? edge.targetNodeId,
  }))
  const childEntryId = idMap.get(child.entryNodeId)
  if (childEntryId === undefined) throw new Error(`子流程「${child.name}」找不到开始节点`)

  const outgoing = graph.edges.filter(edge => edge.sourceNodeId === callNode.id)
  if (outgoing.length === 0) throw new Error(`调用子流程节点「${callNode.name}」没有后续连线`)
  const continuationIds = outgoing.map(edge => edge.targetNodeId)
  const terminalIds = child.nodes.filter(node => node.type === 'end').map(node => idMap.get(node.id)).filter((id): id is string => id !== undefined)
  if (terminalIds.length === 0) throw new Error(`子流程「${child.name}」没有结束节点，无法返回父流程`)

  const call = { ...callNode, name: `调用 ${child.name} v${child.version}` }
  const sequentialNodes = [...injectionNodes]
  const edgesToCallTarget = graph.edges.filter(edge => edge.sourceNodeId !== callNode.id)
  const chain = [call.id, ...injectionNodes.map(node => node.id), childEntryId]
  const injectionEdges = chain.slice(0, -1).map((sourceNodeId, index) => ({
    id: `${callNode.id}::chain::${index}`,
    sourceNodeId,
    sourcePort: 'default',
    targetNodeId: chain[index + 1] as string,
  }))
  const returnEdges = terminalIds.flatMap(sourceNodeId => continuationIds.map((targetNodeId, index) => ({
    id: `${sourceNodeId}::return::${index}`,
    sourceNodeId,
    sourcePort: 'default',
    targetNodeId,
  })))

  const childVariableLlmMap = new Map(childLlmConfigs.map(llm => [llm.id, { ...llm, id: llmIds.get(llm.id) ?? llm.id }]))
  const parentLlms = graph.llms ?? (graph.llm === undefined ? [] : [graph.llm])
  const mergedLlms = new Map(parentLlms.map(llm => [llm.id, llm]))
  for (const [id, llm] of childVariableLlmMap) mergedLlms.set(id, llm)

  const merged = mergeDefinitions(graph, child)
  return {
    ...merged,
    nodes: [...merged.nodes.map(node => node.id === callNode.id ? call : node), ...sequentialNodes, ...clonedNodes],
    edges: [...edgesToCallTarget, ...injectionEdges, ...childEdges, ...returnEdges],
    llms: [...mergedLlms.values()],
  }
}

/** Expand selected child revisions into their call locations for local execution. */
export function expandSubflows(root: WorkflowGraph, subflows: readonly WorkflowGraph[]): WorkflowGraph {
  const bundle = new Map(subflows.map(graph => [identity(graph.workflowId, graph.version), graph]))
  let graph = root
  const ancestry = new Map<string, readonly string[]>()
  const processed = new Set<string>()
  ancestry.set('', [root.workflowId])

  while (true) {
    const call = graph.nodes.find(node => node.config.type === 'call-subflow' && !processed.has(node.id))
    if (call === undefined) return graph
    processed.add(call.id)
    if (call.config.type !== 'call-subflow' || call.config.workflowId.trim() === '' || call.config.workflowVersion === undefined) {
      throw new Error(`调用子流程节点「${call.name}」尚未选择已发布版本`)
    }
    const parentPath = ancestry.get(call.id) ?? [root.workflowId]
    if (parentPath.includes(call.config.workflowId)) throw new Error(`检测到子流程循环调用：${[...parentPath, call.config.workflowId].join(' → ')}`)
    if (parentPath.length >= MAX_DEPTH) throw new Error(`子流程嵌套超过最大层级 ${MAX_DEPTH}`)
    const child = bundle.get(identity(call.config.workflowId, call.config.workflowVersion))
    if (child === undefined) throw new Error(`缺少子流程「${call.config.workflowId}」v${call.config.workflowVersion}，请重新读取已发布版本`)
    graph = replaceCall(graph, call, child)
    const prefix = `${call.id}::${safeName(child.workflowId)}_v${child.version}::`
    for (const nested of child.nodes.filter(node => node.config.type === 'call-subflow')) {
      const clonedId = `${prefix}${nested.id}`
      ancestry.set(clonedId, [...parentPath, child.workflowId])
    }
  }
}
