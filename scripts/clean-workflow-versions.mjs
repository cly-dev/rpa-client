import { readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverRoot = resolve(projectRoot, '../rpa-serve')
const requireServer = createRequire(join(serverRoot, 'package.json'))
requireServer('dotenv').config({ path: join(serverRoot, '.env'), quiet: true })
const { PrismaClient, Prisma } = requireServer('@prisma/client')
const prisma = new PrismaClient()
const apply = process.argv.includes('--apply')
const exportOnly = process.argv.includes('--export-only')
const backupPath = join(projectRoot, '.migration-backups', 'rpa_serve_before_version_cleanup_2026-10-19.dump')

function calls(graph) {
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes)) throw new Error('流程图结构无效')
  return graph.nodes.filter(node => node?.config?.type === 'call-subflow')
}

function upgradeGraph(graph, latestById, parentName, changes) {
  let changed = false
  const nodes = graph.nodes.map(node => {
    if (node?.config?.type !== 'call-subflow') return node
    const childId = node.config.workflowId
    if (typeof childId !== 'string' || !childId.trim()) return node
    const targetVersion = latestById.get(childId)
    if (typeof targetVersion !== 'number') throw new Error(`${parentName} 引用未发布或不存在的子流程 ${childId}`)
    if (node.config.workflowVersion === targetVersion) return node
    changes.push({ parent: parentName, nodeId: node.id, childId, from: node.config.workflowVersion, to: targetVersion })
    changed = true
    return { ...node, config: { ...node.config, workflowVersion: targetVersion } }
  })
  return changed ? { ...graph, nodes } : graph
}

async function snapshot(client) {
  const [workflows, dependencies, revisionRows] = await Promise.all([
    client.workflow.findMany({ include: { revisions: { orderBy: { version: 'desc' }, take: 1 } } }),
    client.workflowDependency.findMany(),
    client.workflowRevision.findMany({ select: { id: true, workflowId: true, version: true } }),
  ])
  return { workflows, dependencies, revisionRows }
}

function plan(data) {
  const { workflows, dependencies, revisionRows } = data
  const latestById = new Map()
  const latestRevisionById = new Map()
  for (const workflow of workflows) {
    const latest = workflow.revisions[0]
    if (latest && (latest.stage !== 'published' || workflow.publishedVersion !== latest.version)) {
      throw new Error(`${workflow.name} 的最新修订与已发布版本不一致，停止清理`)
    }
    if (latest) {
      latestById.set(workflow.id, latest.version)
      latestRevisionById.set(workflow.id, latest)
    }
  }

  const workflowUpdates = []
  const revisionUpdates = []
  const changedReferences = []
  for (const workflow of workflows) {
    const draftChanges = []
    const draftGraph = upgradeGraph(workflow.draftGraph, latestById, workflow.name, draftChanges)
    if (draftGraph !== workflow.draftGraph) workflowUpdates.push({ id: workflow.id, graph: draftGraph })
    changedReferences.push(...draftChanges.map(change => ({ ...change, location: 'draft' })))

    const latest = latestRevisionById.get(workflow.id)
    if (latest) {
      const publishedChanges = []
      const graph = upgradeGraph(latest.graph, latestById, workflow.name, publishedChanges)
      if (graph !== latest.graph) revisionUpdates.push({ id: latest.id, workflowId: workflow.id, version: latest.version, graph })
      changedReferences.push(...publishedChanges.map(change => ({ ...change, location: 'published' })))
    }
  }

  const dependencyUpdates = []
  for (const dependency of dependencies) {
    const parent = workflows.find(item => item.id === dependency.parentWorkflowId)
    const node = parent && calls(parent.draftGraph).find(item => item.id === dependency.callNodeId)
    if (!node || node.config.workflowId !== dependency.childWorkflowId) {
      throw new Error(`父流程 ${dependency.parentWorkflowId} 的子流程依赖 ${dependency.callNodeId} 与草稿图不一致`)
    }
    const targetVersion = latestById.get(dependency.childWorkflowId)
    if (typeof targetVersion !== 'number') throw new Error(`依赖的子流程没有发布版本：${dependency.childWorkflowId}`)
    if (dependency.childVersion !== targetVersion) dependencyUpdates.push({ id: dependency.id, version: targetVersion })
  }

  const oldRevisionIds = revisionRows.filter(row => row.id !== latestRevisionById.get(row.workflowId)?.id).map(row => row.id)
  return { workflowUpdates, revisionUpdates, dependencyUpdates, changedReferences, oldRevisionIds }
}

async function verifyBackup() {
  const info = await stat(backupPath)
  const header = await readFile(backupPath).then(buffer => buffer.subarray(0, 5).toString('ascii'))
  if (info.size < 1024 || header !== 'PGDMP') throw new Error('数据库备份不存在或格式无效，停止清理')
}

async function validateCleanState(client) {
  const data = await snapshot(client)
  const result = plan(data)
  if (result.oldRevisionIds.length || result.changedReferences.length || result.dependencyUpdates.length) {
    throw new Error('清理后的版本或子流程引用仍不一致')
  }
  return data
}

async function writeExport() {
  const [workspaces, workflows, workflowRevisions, workflowDependencies, llmConfigs] = await Promise.all([
    prisma.workspace.findMany({ orderBy: { id: 'asc' } }),
    prisma.workflow.findMany({ orderBy: { id: 'asc' } }),
    prisma.workflowRevision.findMany({ orderBy: [{ workflowId: 'asc' }, { version: 'asc' }] }),
    prisma.workflowDependency.findMany({ orderBy: [{ parentWorkflowId: 'asc' }, { callNodeId: 'asc' }] }),
    prisma.llmConfig.findMany({ orderBy: { id: 'asc' } }),
  ])
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const exportPath = join(projectRoot, '.migration-backups', `rpa_production_latest_${stamp}.json`)
  await writeFile(exportPath, JSON.stringify({
    format: 'rpa-production-workflows-v1',
    createdAt: new Date().toISOString(),
    notice: 'Contains workflow graphs, webhook URLs and LLM API keys. Keep private. Import only into an empty migrated database.',
    workspaces, workflows, workflowRevisions, workflowDependencies, llmConfigs,
  }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { exportPath, workspaces: workspaces.length, workflows: workflows.length, revisions: workflowRevisions.length, dependencies: workflowDependencies.length, llmConfigs: llmConfigs.length }
}

try {
  if (apply && exportOnly) throw new Error('--apply 与 --export-only 不能同时使用')
  const before = await snapshot(prisma)
  const proposed = plan(before)
  console.log(JSON.stringify({ mode: apply ? 'apply' : exportOnly ? 'export-only' : 'dry-run', workflowCount: before.workflows.length, revisionCount: before.revisionRows.length, revisionsToDelete: proposed.oldRevisionIds.length, publishedReferencesToUpgrade: proposed.changedReferences.filter(item => item.location === 'published'), draftReferenceChanges: proposed.changedReferences.filter(item => item.location === 'draft').length, dependencyRowsToUpgrade: proposed.dependencyUpdates.length }, null, 2))

  if (apply) {
    await verifyBackup()
    if (before.workflows.length !== 49 || before.revisionRows.length !== 835) throw new Error('数据库记录数与预检结果不同，停止清理')
    await prisma.$transaction(async tx => {
      const current = await snapshot(tx)
      if (current.workflows.length !== before.workflows.length || current.revisionRows.length !== before.revisionRows.length) throw new Error('清理期间数据发生变化')
      const previousById = new Map(before.workflows.map(item => [item.id, item]))
      for (const workflow of current.workflows) {
        const original = previousById.get(workflow.id)
        if (!original || workflow.updatedAt.getTime() !== original.updatedAt.getTime() || workflow.revisions[0]?.id !== original.revisions[0]?.id) throw new Error('清理期间流程发生变化')
      }
      const changes = plan(current)
      for (const update of changes.workflowUpdates) await tx.workflow.update({ where: { id: update.id }, data: { draftGraph: update.graph } })
      for (const update of changes.revisionUpdates) await tx.workflowRevision.update({ where: { id: update.id }, data: { graph: update.graph } })
      for (const update of changes.dependencyUpdates) await tx.workflowDependency.update({ where: { id: update.id }, data: { childVersion: update.version } })
      const changedWorkflowIds = new Set([...changes.workflowUpdates.map(item => item.id), ...changes.revisionUpdates.map(item => item.workflowId)])
      if (changedWorkflowIds.size) await tx.workflowAuditLog.createMany({ data: [...changedWorkflowIds].map(workflowId => ({ workflowId, action: 'version_cleanup', actorId: 'system:version-cleanup', actorName: '版本清理迁移', version: current.workflows.find(item => item.id === workflowId)?.publishedVersion ?? null })) })
      const deleted = await tx.workflowRevision.deleteMany({ where: { id: { in: changes.oldRevisionIds } } })
      if (deleted.count !== changes.oldRevisionIds.length) throw new Error('删除旧版本的数量不符合预期')
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 120_000 })
    await validateCleanState(prisma)
    console.log('本地数据库清理和引用校验通过')
  }

  if (apply || exportOnly) {
    await validateCleanState(prisma)
    console.log(JSON.stringify(await writeExport(), null, 2))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
