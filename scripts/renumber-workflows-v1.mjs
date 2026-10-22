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
const backupPath = join(projectRoot, '.migration-backups', 'rpa_serve_before_v1_2026-10-19.dump')

function callNodes(graph) {
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes)) throw new Error('流程图结构无效')
  return graph.nodes.filter(node => node?.config?.type === 'call-subflow' && typeof node.config.workflowId === 'string' && node.config.workflowId.trim())
}

function rewriteGraph(graph, version, publishedById, name) {
  const nodes = graph.nodes.map(node => {
    if (node?.config?.type !== 'call-subflow' || !node.config.workflowId?.trim()) return node
    const child = publishedById.get(node.config.workflowId)
    if (child === undefined) throw new Error(`${name} 引用了没有发布版本的子流程 ${node.config.workflowId}`)
    if (node.config.workflowVersion !== child) throw new Error(`${name} 的子流程引用与清理后的发布版本不一致`)
    return { ...node, config: { ...node.config, workflowVersion: 1 } }
  })
  return { ...graph, version, nodes }
}

async function snapshot(client) {
  const [workflows, revisions, dependencies] = await Promise.all([
    client.workflow.findMany(), client.workflowRevision.findMany(), client.workflowDependency.findMany(),
  ])
  return { workflows, revisions, dependencies }
}

function plan(data) {
  const revisionById = new Map()
  for (const revision of data.revisions) {
    if (revisionById.has(revision.workflowId) || revision.stage !== 'published') throw new Error('每个流程必须只保留一个已发布修订')
    revisionById.set(revision.workflowId, revision)
  }
  const publishedById = new Map([...revisionById].map(([id, revision]) => [id, revision.version]))
  const workflowsById = new Map(data.workflows.map(item => [item.id, item]))
  for (const workflow of data.workflows) {
    const current = publishedById.get(workflow.id)
    if ((workflow.publishedVersion ?? null) !== (current ?? null)) throw new Error(`${workflow.name} 的发布版本与修订记录不一致`)
  }
  for (const dependency of data.dependencies) {
    const parent = workflowsById.get(dependency.parentWorkflowId)
    const node = parent && callNodes(parent.draftGraph).find(item => item.id === dependency.callNodeId)
    if (!node || node.config.workflowId !== dependency.childWorkflowId || node.config.workflowVersion !== dependency.childVersion || dependency.childVersion !== publishedById.get(dependency.childWorkflowId)) {
      throw new Error(`子流程依赖 ${dependency.id} 与草稿图或修订不一致`)
    }
  }

  const workflows = data.workflows.map(workflow => {
    const hasRevision = revisionById.has(workflow.id)
    return { id: workflow.id, data: {
      draftVersion: hasRevision ? 1 : 0,
      publishedVersion: hasRevision ? 1 : null,
      draftGraph: rewriteGraph(workflow.draftGraph, hasRevision ? 1 : 0, publishedById, workflow.name),
    } }
  })
  const revisions = data.revisions.map(revision => ({ id: revision.id, data: {
    version: 1,
    graph: rewriteGraph(revision.graph, 1, publishedById, workflowsById.get(revision.workflowId)?.name ?? revision.workflowId),
  } }))
  const dependencies = data.dependencies.map(dependency => ({ id: dependency.id, childVersion: 1 }))
  return { workflows, revisions, dependencies }
}

function validateV1(data) {
  const revisions = new Map(data.revisions.map(item => [item.workflowId, item]))
  if (revisions.size !== data.revisions.length) throw new Error('存在重复流程修订')
  for (const workflow of data.workflows) {
    const revision = revisions.get(workflow.id)
    const expected = revision ? 1 : 0
    if (workflow.draftVersion !== expected || workflow.draftGraph?.version !== expected || (workflow.publishedVersion ?? null) !== (revision ? 1 : null)) throw new Error(`${workflow.name} 的版本未统一到 v1`)
    for (const graph of [workflow.draftGraph, revision?.graph].filter(Boolean)) {
      for (const node of callNodes(graph)) {
        if (node.config.workflowVersion !== 1 || !revisions.has(node.config.workflowId)) throw new Error(`${workflow.name} 仍引用非 v1 子流程`)
      }
    }
  }
  for (const revision of data.revisions) if (revision.version !== 1 || revision.graph?.version !== 1) throw new Error('发布修订仍存在非 v1 版本')
  for (const dependency of data.dependencies) if (dependency.childVersion !== 1 || !revisions.has(dependency.childWorkflowId)) throw new Error('子流程依赖仍存在非 v1 版本')
}

async function exportProduction() {
  const [workspaces, workflows, workflowRevisions, workflowDependencies, llmConfigs] = await Promise.all([
    prisma.workspace.findMany({ orderBy: { id: 'asc' } }),
    prisma.workflow.findMany({ orderBy: { id: 'asc' } }),
    prisma.workflowRevision.findMany({ orderBy: { workflowId: 'asc' } }),
    prisma.workflowDependency.findMany({ orderBy: [{ parentWorkflowId: 'asc' }, { callNodeId: 'asc' }] }),
    prisma.llmConfig.findMany({ orderBy: { id: 'asc' } }),
  ])
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const exportPath = join(projectRoot, '.migration-backups', `rpa_production_v1_${stamp}.json`)
  await writeFile(exportPath, JSON.stringify({
    format: 'rpa-production-workflows-v1',
    createdAt: new Date().toISOString(),
    notice: 'Contains workflow graphs, webhook URLs and LLM API keys. Keep private. Import only into an empty migrated database.',
    workspaces, workflows, workflowRevisions, workflowDependencies, llmConfigs,
  }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { exportPath, workflows: workflows.length, revisions: workflowRevisions.length, dependencies: workflowDependencies.length }
}

try {
  const before = await snapshot(prisma)
  if (before.workflows.length !== 49 || before.revisions.length !== 47) throw new Error('数据库记录数与清理后的预期不同，停止重编号')
  const changes = plan(before)
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', workflows: changes.workflows.length, publishedRevisions: changes.revisions.length, dependencies: changes.dependencies.length, unpublishedWorkflows: before.workflows.filter(item => item.publishedVersion === null).map(item => item.name) }, null, 2))
  if (apply) {
    const backup = await stat(backupPath)
    const header = await readFile(backupPath).then(buffer => buffer.subarray(0, 5).toString('ascii'))
    if (backup.size < 1024 || header !== 'PGDMP') throw new Error('重编号前的完整备份无效')
    await prisma.$transaction(async tx => {
      const current = await snapshot(tx)
      if (current.workflows.length !== before.workflows.length || current.revisions.length !== before.revisions.length || current.dependencies.length !== before.dependencies.length) throw new Error('重编号期间数据发生变化')
      const originals = new Map(before.workflows.map(item => [item.id, item]))
      for (const workflow of current.workflows) {
        if (workflow.updatedAt.getTime() !== originals.get(workflow.id)?.updatedAt.getTime()) throw new Error('重编号期间流程发生变化')
      }
      const currentPlan = plan(current)
      for (const update of currentPlan.workflows) await tx.workflow.update({ where: { id: update.id }, data: update.data })
      for (const update of currentPlan.revisions) await tx.workflowRevision.update({ where: { id: update.id }, data: update.data })
      for (const update of currentPlan.dependencies) await tx.workflowDependency.update({ where: { id: update.id }, data: { childVersion: update.childVersion } })
      await tx.workflowAuditLog.createMany({ data: current.revisions.map(revision => ({ workflowId: revision.workflowId, action: 'renumber_v1', actorId: 'system:version-cleanup', actorName: '版本清理迁移', version: 1 })) })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 120_000 })
    validateV1(await snapshot(prisma))
    console.log('本地流程版本与父子流程引用均已统一为 v1')
    console.log(JSON.stringify(await exportProduction(), null, 2))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
