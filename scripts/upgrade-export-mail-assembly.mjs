import { readFileSync, writeFileSync } from 'node:fs'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  throw new Error('用法：node upgrade-export-mail-assembly.mjs <原始 JSON> <输出 JSON>')
}

const pack = JSON.parse(readFileSync(inputPath, 'utf8'))
if (pack.format !== 'rpa-workflow-package' || pack.formatVersion !== 1) {
  throw new Error('不是支持的流程导出包')
}

const pmsMailId = 'wf_a1af6910'
const assemblyId = 'wf_4b5ad15d'
const assemblyVersion = 3
const assembly = pack.workflows.find(item => item.sourceId === assemblyId && item.sourceVersion === assemblyVersion)
if (!assembly) throw new Error('找不到发送邮件前数据组装 v3')
const itemTitleCode = assembly.graph.nodes.find(node => node.type === 'code' && node.config.outputs?.some(output => output.name === 'refundContent'))
if (!itemTitleCode) throw new Error('找不到数据组装流程中的商品标题代码节点')
itemTitleCode.config.code = [
  'const items = Array.isArray(input.refundItems) ? input.refundItems : [];',
  'const titles = items.map(item => typeof item?.title === "string" ? item.title.trim() : "").filter(Boolean);',
  'const refundContent = titles.length',
  '  ? "Thank you for reaching out — we have received your return request for " + titles.join(" & ") + "."',
  '  : "Thank you for reaching out — we have received your return request.";',
  'return { refundContent };',
].join('\n')

const workflowInput = name => ({ kind: 'workflow-input', name })
const literal = value => ({ kind: 'literal', value })
const mapping = (inputName, source) => ({ source, inputName })
const ensureInput = (workflow, name, type, description) => {
  if (workflow.graph.context.inputs.some(item => item.name === name)) return
  workflow.graph.context.inputs.push({ name, type, required: true, description })
}
const ensureMapping = (node, inputName, source) => {
  const current = node.config.inputMappings.find(item => item.inputName === inputName)
  if (current) return
  node.config.inputMappings.push(mapping(inputName, source))
}

// The shared assembly supplies the salutation, item summary, and signature.
// Keep the distinct content of every T template, removing only duplicated wrappers.
const unwrapMailContent = html => {
  if (typeof html !== 'string') throw new Error('邮件正文不是文本')
  return html
    .replace(/^\s*<p>Dear \{\{(?:inputs\.)?(?:customName|email|custom_name)\}\},<\/p>\s*/i, '')
    .replace(/^<p>Thank you for reaching out — we have received your return request\.<\/p>\s*/i, '')
    .replace(/\s*<p>Best regards,<br>\s*A-Premium Customer Service Team<\/p>\s*$/i, '')
    .trim()
}

const mailTemplateIds = new Set(pack.workflows
  .filter(item => /^发送邮件-T\d+$/.test(item.name))
  .map(item => item.sourceId))
const categoryWorkflows = pack.workflows.filter(item =>
  item.graph.nodes.some(node => node.type === 'call-subflow' && mailTemplateIds.has(node.config.workflowId)))
const categoryIds = new Set(categoryWorkflows.map(item => item.sourceId))
const changed = { templates: [], directMailNodes: [], parentMappings: 0, categoryMappings: 0 }

const changeMailCall = (workflow, node, sources) => {
  const oldMappings = node.config.inputMappings
  const content = oldMappings.find(item => item.inputName === 'email_content')?.source?.value
  if (typeof content !== 'string') throw new Error(`${workflow.name} 的 ${node.name} 缺少原邮件正文`)
  node.config.workflowId = assemblyId
  node.config.workflowVersion = assemblyVersion
  node.config.inputMappings = [
    mapping('customName', sources.customName),
    mapping('refundItems', sources.refundItems),
    mapping('content', literal(unwrapMailContent(content))),
    mapping('token', sources.token),
    mapping('email', sources.email),
    mapping('orderId', sources.orderId),
    mapping('workId', sources.workId),
  ]
  changed.directMailNodes.push(`${workflow.name} v${workflow.sourceVersion}: ${node.name}`)
}

for (const workflow of pack.workflows) {
  if (!/^发送邮件-T\d+$/.test(workflow.name)) continue
  const direct = workflow.graph.nodes.filter(node => node.type === 'call-subflow' && node.config.workflowId === pmsMailId)
  if (!direct.length) continue // T6 v4 already calls the assembly.
  ensureInput(workflow, 'refundItems', 'array', '退货商品列表')
  ensureInput(workflow, 'workId', 'string', '工单 ID')
  for (const node of direct) changeMailCall(workflow, node, {
    customName: workflowInput('customName'),
    refundItems: workflowInput('refundItems'),
    token: workflowInput('token'),
    email: workflowInput('email'),
    orderId: workflowInput('orderId'),
    workId: workflowInput('workId'),
  })
  changed.templates.push(`${workflow.name} v${workflow.sourceVersion}`)
}

for (const workflow of categoryWorkflows) {
  const itemInput = workflow.graph.context.inputs.some(item => item.name === 'orderItems') ? 'orderItems' : 'refundItems'
  if (itemInput === 'refundItems') ensureInput(workflow, 'refundItems', 'array', '退货商品列表')
  if (!workflow.graph.context.inputs.some(item => item.name === 'workOrderId')) {
    throw new Error(`${workflow.name} 缺少工单 ID 输入`)
  }
  for (const node of workflow.graph.nodes) {
    if (node.type !== 'call-subflow') continue
    if (mailTemplateIds.has(node.config.workflowId)) {
      const before = node.config.inputMappings.length
      ensureMapping(node, 'refundItems', workflowInput(itemInput))
      ensureMapping(node, 'workId', workflowInput('workOrderId'))
      changed.categoryMappings += node.config.inputMappings.length - before
    } else if (node.config.workflowId === pmsMailId) {
      changeMailCall(workflow, node, {
        customName: workflowInput('customName'),
        refundItems: workflowInput(itemInput),
        token: workflowInput('token'),
        email: workflowInput('email'),
        orderId: workflowInput('orderId'),
        workId: workflowInput('workOrderId'),
      })
    }
  }
}

for (const workflow of pack.workflows) {
  if (workflow.name === '无理由退货RPA-测试') {
    for (const node of workflow.graph.nodes) {
      if (node.type !== 'call-subflow' || node.config.workflowId !== pmsMailId) continue
      const old = new Map(node.config.inputMappings.map(item => [item.inputName, item.source]))
      changeMailCall(workflow, node, {
        customName: { kind: 'variable', name: 'custom_name' },
        // T1/T2 branch before the return-detail API, so its item output is unavailable here.
        refundItems: literal([]),
        token: { kind: 'variable', name: 'token' },
        email: old.get('email'),
        orderId: old.get('orderId'),
        workId: workflowInput('workId'),
      })
    }
  }
  for (const node of workflow.graph.nodes) {
    if (node.type !== 'call-subflow' || !categoryIds.has(node.config.workflowId)) continue
    const target = pack.workflows.find(item => item.sourceId === node.config.workflowId && item.sourceVersion === node.config.workflowVersion)
    if (!target) throw new Error(`${workflow.name} 引用的分类子流程版本不存在：${node.config.workflowId} v${node.config.workflowVersion}`)
    const itemInput = target.graph.context.inputs.some(item => item.name === 'orderItems') ? 'orderItems' : 'refundItems'
    const before = node.config.inputMappings.length
    ensureMapping(node, itemInput, workflowInput('refundItems'))
    changed.parentMappings += node.config.inputMappings.length - before
  }
}

// Repair two malformed mappings on the same mail path; otherwise the newly
// forwarded values would still be missing for those branches.
for (const workflow of pack.workflows.filter(item =>
  item.name === '客户诉求分析-子流程' || item.name === '无原因客诉流程处理-子流程')) {
  for (const node of workflow.graph.nodes.filter(item => item.type === 'call-subflow')) {
    for (const item of node.config.inputMappings) {
      if (item.source.kind === 'workflow-input' && item.source.name === 'workOrderDetail ') item.source.name = 'workOrderDetail'
      if (item.inputName === 'email' && item.source.kind === 'literal' && item.source.value === '{{inputs.email}') item.source = workflowInput('email')
    }
  }
}

// Check the complete changed call chain; do not silently leave any direct PMS calls.
const remainingDirect = pack.workflows.flatMap(workflow => workflow.graph.nodes
  .filter(node => node.type === 'call-subflow' && node.config.workflowId === pmsMailId && workflow.sourceId !== assemblyId)
  .map(node => `${workflow.name} v${workflow.sourceVersion}: ${node.name}`))
if (remainingDirect.length) throw new Error(`仍有直连 PMS 邮件节点：${remainingDirect.join('、')}`)
for (const workflow of pack.workflows) {
  for (const node of workflow.graph.nodes) {
    if (node.type !== 'call-subflow' || node.config.workflowId !== assemblyId) continue
    const mapped = new Set(node.config.inputMappings.map(item => item.inputName))
    const missing = assembly.graph.context.inputs.filter(item => item.required && !mapped.has(item.name))
    if (missing.length) throw new Error(`${workflow.name} 的 ${node.name} 缺少组装变量：${missing.map(item => item.name).join(', ')}`)
  }
}
// The previous PMS v1 revision becomes orphaned after all direct calls move to assembly.
// The server rejects packages with orphaned revisions, so omit only that now-unused entry.
const pmsV1 = pack.workflows.find(item => item.sourceId === pmsMailId && item.sourceVersion === 1)
if (!pmsV1) throw new Error('找不到预期的 PMS 发送邮件 v1')
const stillReferencesPmsV1 = pack.workflows.some(workflow => workflow.graph.nodes.some(node =>
  node.type === 'call-subflow' && node.config.workflowId === pmsMailId && node.config.workflowVersion === 1))
if (stillReferencesPmsV1) throw new Error('PMS 发送邮件 v1 仍被引用，不能从导出包移除')
pack.workflows = pack.workflows.filter(item => item !== pmsV1)
changed.removedOrphan = 'PMS发送邮件 v1'

writeFileSync(outputPath, `${JSON.stringify(pack, null, 2)}\n`)
console.log(JSON.stringify(changed, null, 2))
