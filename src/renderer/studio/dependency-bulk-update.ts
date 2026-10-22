import type { WorkflowGraph } from '@graph/types.ts'
import { planBulkSubflowVersionUpdate, type BulkSubflowVersionPlan } from './subflow-version.ts'

export interface ParentDraftForUpdate {
  readonly id: string
  readonly name: string
  readonly updatedAt: string
  readonly graph: WorkflowGraph
  /** null means the parent has never been published; undefined keeps older callers compatible. */
  readonly publishedGraph?: WorkflowGraph | null
}

export interface ParentVersionUpdate {
  readonly parent: ParentDraftForUpdate
  readonly plan: BulkSubflowVersionPlan
  readonly mode: 'update-and-publish' | 'publish-only'
}

function publishedGraphUsesTarget(graph: WorkflowGraph, childWorkflowId: string, targetVersion: number): boolean {
  const calls = graph.nodes.filter(node => node.config.type === 'call-subflow' && node.config.workflowId === childWorkflowId)
  return calls.length > 0 && calls.every(node => node.config.type === 'call-subflow' && node.config.workflowVersion === targetVersion)
}

/** The service masks these values on GET, so a full-graph PUT would overwrite the originals. */
export function hasRedactedSecrets(graph: WorkflowGraph): boolean {
  const masked = '******'
  return graph.llm?.apiKey === masked
    || (graph.llms ?? []).some(llm => llm.apiKey === masked)
    || [...(graph.context?.inputs ?? []), ...(graph.context?.variables ?? [])]
      .some(variable => variable.secret && variable.defaultValue === masked)
}

export function planParentVersionUpdates(
  parents: readonly ParentDraftForUpdate[],
  childWorkflowId: string,
  target: WorkflowGraph,
  previousRevisions: readonly WorkflowGraph[],
): ParentVersionUpdate[] {
  return parents.flatMap(parent => {
    const plan = planBulkSubflowVersionUpdate(parent.graph, childWorkflowId, target, previousRevisions)
    if (plan.updates.size > 0) return [{ parent, plan, mode: 'update-and-publish' as const }]
    if (parent.publishedGraph !== undefined && (parent.publishedGraph === null || !publishedGraphUsesTarget(parent.publishedGraph, childWorkflowId, target.version))) {
      return [{ parent, plan, mode: 'publish-only' as const }]
    }
    return []
  })
}

export function applyParentVersionUpdate(update: ParentVersionUpdate): WorkflowGraph {
  return {
    ...update.parent.graph,
    nodes: update.parent.graph.nodes.map(node => {
      const config = update.plan.updates.get(node.id)
      return config === undefined ? node : { ...node, config }
    }),
  }
}

export interface ParentPublishOutcome {
  readonly id: string
  readonly name: string
  readonly status: 'published' | 'draft-only' | 'not-updated'
  readonly version?: number
  readonly error?: string
}

export interface PublishedWorkflowSeed {
  readonly workflowId: string
  readonly version: number
  readonly graph: WorkflowGraph
  readonly depth?: number
}

export interface CascadedParentPublishOutcome extends ParentPublishOutcome {
  readonly depth: number
  readonly childWorkflowId: string
  readonly childVersion: number
}

export async function executeParentVersionUpdates(
  updates: readonly ParentVersionUpdate[],
  api: {
    getParent(id: string): Promise<ParentDraftForUpdate>
    saveDraft(graph: WorkflowGraph): Promise<unknown>
    publish(id: string): Promise<{ publishedVersion: number }>
  },
  onProgress?: (index: number, total: number, name: string) => void,
): Promise<ParentPublishOutcome[]> {
  const outcomes: ParentPublishOutcome[] = []
  for (const [index, update] of updates.entries()) {
    const { parent } = update
    onProgress?.(index + 1, updates.length, parent.name)
    try {
      const current = await api.getParent(parent.id)
      if (current.updatedAt !== parent.updatedAt || JSON.stringify(current.graph) !== JSON.stringify(parent.graph)) {
        throw new Error('父流程草稿已变化，请重新预览后再操作')
      }
      if (update.mode === 'update-and-publish' && hasRedactedSecrets(current.graph)) {
        throw new Error('父流程包含服务端遮蔽的密钥，无法安全地整体保存草稿')
      }
      if (update.mode === 'update-and-publish') await api.saveDraft(applyParentVersionUpdate(update))
      try {
        const published = await api.publish(parent.id)
        outcomes.push({ id: parent.id, name: parent.name, status: 'published', version: published.publishedVersion })
      } catch (error) {
        outcomes.push({ id: parent.id, name: parent.name, status: 'draft-only', error: error instanceof Error ? error.message : String(error) })
      }
    } catch (error) {
      outcomes.push({ id: parent.id, name: parent.name, status: 'not-updated', error: error instanceof Error ? error.message : String(error) })
    }
  }
  return outcomes
}

/**
 * Propagates newly published workflow versions through every ancestor.
 * Each successful parent publish becomes the target version for its own parents.
 */
export async function executeCascadingParentVersionUpdates(
  seeds: readonly PublishedWorkflowSeed[],
  api: {
    listParentIds(childWorkflowId: string): Promise<readonly string[]>
    getParent(id: string): Promise<ParentDraftForUpdate & { readonly publishedVersion?: number | null }>
    getRevision(id: string, version: number): Promise<WorkflowGraph>
    saveDraft(graph: WorkflowGraph): Promise<unknown>
    publish(id: string): Promise<{ publishedVersion: number }>
    validate(graph: WorkflowGraph): Promise<string | undefined>
  },
  onProgress?: (message: string) => void,
): Promise<CascadedParentPublishOutcome[]> {
  const queue = seeds.map(seed => ({ ...seed, depth: seed.depth ?? 1 }))
  const processed = new Set<string>()
  const outcomes: CascadedParentPublishOutcome[] = []

  while (queue.length > 0) {
    const target = queue.shift() as PublishedWorkflowSeed & { depth: number }
    const targetKey = `${target.workflowId}@${target.version}`
    if (processed.has(targetKey)) continue
    processed.add(targetKey)
    const parentIds = [...new Set(await api.listParentIds(target.workflowId))]
    if (parentIds.length === 0) continue
    onProgress?.(`正在向上更新第 ${target.depth} 层：${parentIds.length} 个父流程引用 ${target.workflowId} v${target.version}`)

    const parents = await Promise.all(parentIds.map(async id => {
      const parent = await api.getParent(id)
      const publishedGraph = parent.publishedVersion == null ? null : await api.getRevision(id, parent.publishedVersion)
      return { ...parent, publishedGraph }
    }))
    const previousVersions = [...new Set(parents.flatMap(parent => parent.graph.nodes.flatMap(node =>
      node.config.type === 'call-subflow'
        && node.config.workflowId === target.workflowId
        && node.config.workflowVersion !== undefined
        && node.config.workflowVersion !== target.version
        ? [node.config.workflowVersion] : []
    )))]
    const previousRevisions = await Promise.all(previousVersions.map(version => api.getRevision(target.workflowId, version)))
    const updates = planParentVersionUpdates(parents, target.workflowId, target.graph, previousRevisions)

    for (const update of updates) {
      const nextGraph = applyParentVersionUpdate(update)
      const validationError = await api.validate(nextGraph)
      if (validationError !== undefined) {
        outcomes.push({ id: update.parent.id, name: update.parent.name, status: 'not-updated', error: validationError, depth: target.depth, childWorkflowId: target.workflowId, childVersion: target.version })
        continue
      }
      const [outcome] = await executeParentVersionUpdates([update], api)
      const cascaded = { ...outcome, depth: target.depth, childWorkflowId: target.workflowId, childVersion: target.version }
      outcomes.push(cascaded)
      if (outcome.status === 'published' && outcome.version !== undefined) {
        const graph = await api.getRevision(update.parent.id, outcome.version)
        queue.push({ workflowId: update.parent.id, version: outcome.version, graph, depth: target.depth + 1 })
      }
    }
  }
  return outcomes
}
