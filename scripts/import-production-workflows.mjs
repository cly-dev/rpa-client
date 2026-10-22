import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fileOption = process.argv.find(value => value.startsWith('--file='))
const serverOption = process.argv.find(value => value.startsWith('--server-dir='))
const apply = process.argv.includes('--apply')
if (!fileOption) throw new Error('请提供 --file=/path/to/rpa_production_latest_*.json')
const exportFile = fileOption.slice('--file='.length)
const serverDir = serverOption ? serverOption.slice('--server-dir='.length) : '../rpa-serve'
const serverRoot = isAbsolute(serverDir) ? serverDir : resolve(projectRoot, serverDir)
const requireServer = createRequire(join(serverRoot, 'package.json'))
requireServer('dotenv').config({ path: join(serverRoot, '.env'), quiet: true })
const { PrismaClient, Prisma } = requireServer('@prisma/client')
const prisma = new PrismaClient()

function graphCalls(graph) {
  if (!graph || !Array.isArray(graph.nodes)) throw new Error('导出文件中的流程图结构无效')
  return graph.nodes.filter(node => node?.config?.type === 'call-subflow' && typeof node.config.workflowId === 'string' && node.config.workflowId.trim())
}

function validate(data) {
  if (data.format !== 'rpa-production-workflows-v1') throw new Error('不支持的导出格式')
  for (const key of ['workspaces', 'workflows', 'workflowRevisions', 'workflowDependencies', 'llmConfigs']) {
    if (!Array.isArray(data[key])) throw new Error(`导出文件缺少 ${key}`)
  }
  const workflows = new Map(data.workflows.map(item => [item.id, item]))
  const revisions = new Map()
  for (const revision of data.workflowRevisions) {
    if (!workflows.has(revision.workflowId) || revisions.has(revision.workflowId)) throw new Error('导出文件包含重复修订或孤立修订')
    revisions.set(revision.workflowId, revision)
  }
  for (const workflow of data.workflows) {
    const revision = revisions.get(workflow.id)
    if ((workflow.publishedVersion ?? null) !== (revision?.version ?? null)) throw new Error(`${workflow.name} 的发布版本与修订不一致`)
    for (const graph of [workflow.draftGraph, revision?.graph].filter(Boolean)) {
      for (const node of graphCalls(graph)) {
        const child = revisions.get(node.config.workflowId)
        if (!child || child.version !== node.config.workflowVersion) throw new Error(`${workflow.name} 的子流程 ${node.config.workflowId} 版本不存在`)
      }
    }
  }
  for (const dependency of data.workflowDependencies) {
    const parent = workflows.get(dependency.parentWorkflowId)
    const child = revisions.get(dependency.childWorkflowId)
    const call = parent && graphCalls(parent.draftGraph).find(node => node.id === dependency.callNodeId)
    if (!parent || !child || !call || call.config.workflowId !== dependency.childWorkflowId || call.config.workflowVersion !== dependency.childVersion || child.version !== dependency.childVersion) {
      throw new Error(`子流程依赖 ${dependency.id} 与导出流程图不一致`)
    }
  }
}

try {
  const data = JSON.parse(await readFile(exportFile, 'utf8'))
  validate(data)
  const target = new URL(process.env.DATABASE_URL)
  const counts = await Promise.all([
    prisma.workflow.count(), prisma.workflowRevision.count(), prisma.workflowDependency.count(), prisma.llmConfig.count(),
  ])
  const summary = { mode: apply ? 'apply' : 'dry-run', target: `${target.hostname}:${target.port || '5432'}${target.pathname}`, targetCounts: counts, importing: { workspaces: data.workspaces.length, workflows: data.workflows.length, revisions: data.workflowRevisions.length, dependencies: data.workflowDependencies.length, llmConfigs: data.llmConfigs.length } }
  console.log(JSON.stringify(summary, null, 2))
  if (counts.some(Boolean)) throw new Error('目标数据库已有流程或 AI 配置，拒绝导入；请使用空的已迁移数据库')
  if (apply) {
    await prisma.$transaction(async tx => {
      const insideCounts = await Promise.all([tx.workflow.count(), tx.workflowRevision.count(), tx.workflowDependency.count(), tx.llmConfig.count()])
      if (insideCounts.some(Boolean)) throw new Error('导入期间目标数据库已有流程数据')
      for (const workspace of data.workspaces) await tx.workspace.upsert({ where: { id: workspace.id }, create: workspace, update: workspace })
      if (data.llmConfigs.length) await tx.llmConfig.createMany({ data: data.llmConfigs })
      if (data.workflows.length) await tx.workflow.createMany({ data: data.workflows })
      if (data.workflowRevisions.length) await tx.workflowRevision.createMany({ data: data.workflowRevisions })
      if (data.workflowDependencies.length) await tx.workflowDependency.createMany({ data: data.workflowDependencies })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 120_000 })
    const imported = await Promise.all([prisma.workflow.count(), prisma.workflowRevision.count(), prisma.workflowDependency.count(), prisma.llmConfig.count()])
    if (imported[0] !== data.workflows.length || imported[1] !== data.workflowRevisions.length || imported[2] !== data.workflowDependencies.length || imported[3] !== data.llmConfigs.length) throw new Error('导入后数量核验失败')
    console.log('导入完成，记录数核验通过')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
