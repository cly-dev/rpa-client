import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { parseWorkflow } from '@graph/parse.ts'
import { RPA_SERVICE_URL, ServiceAuthExpiredError, loadServiceLlmConfigs, withServiceLlms } from '@graph/service-llms.ts'
import type { ApprovalDecision, ApprovalPrompt, JsonValue, WorkflowGraph, WorkflowNode } from '@graph/types.ts'
import { runBrowser } from '@runner/browser-run.ts'
import { usablePageUrl, workflowNeedsExistingPage } from '@runner/page-requirement.ts'
import type { RunState } from '@runner/walk.ts'
import { createHttpOnlyDriver, openPlaywrightSession, type PlaywrightSession } from '@runner/playwright-driver.ts'
import { runWorkflowCode } from '@runner/code-runtime.ts'
import { BrowserOperationGate } from './browser-operation.ts'
import { createLazyBrowserDriver } from './lazy-browser-driver.ts'
import { failedAtPageAction } from './page-action-debug.ts'
import { checkBrowserReadiness } from '@runner/browser-readiness.ts'
import { ClientScheduleClock, type ClientScheduleRule } from './schedule-clock.ts'

function resolveLlmEndpoint(baseUrl?: string, chatPath?: string): string {
  const path = (chatPath?.trim() || '/v1/chat/completions')
  if (/^https?:\/\//i.test(path)) return path
  const base = (baseUrl?.trim() || 'http://localhost:3000').replace(/\/$/, '')
  return `${base}/${path.replace(/^\/+/, '')}`
}

function admit(raw: unknown): WorkflowGraph {
  const parsed = parseWorkflow(raw)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.graph
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: 'RPA 工作室',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
    },
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`窗口加载失败 ${code} ${description} ${url}`)
  })
  window.on('ready-to-show', () => {
    window.show()
    if (!app.isPackaged) window.webContents.openDevTools({ mode: 'detach' })
  })
  if (process.env['ELECTRON_RENDERER_URL'] !== undefined) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const serviceTokens = new WeakMap<object, string>()
  ipcMain.handle('auth:set-token', (event, raw: unknown) => {
    if (raw === undefined) { serviceTokens.delete(event.sender); return { ok: true } }
    if (typeof raw !== 'string' || !/^[^.]+\.[^.]+\.[^.]+$/.test(raw)) throw new Error('登录会话无效')
    serviceTokens.set(event.sender, raw)
    return { ok: true }
  })
  const loadMainServiceLlms = async (event: IpcMainInvokeEvent) => {
    const token = serviceTokens.get(event.sender)
    if (!token) throw new Error('请先登录')
    try { return { configs: await loadServiceLlmConfigs(RPA_SERVICE_URL, token), token } }
    catch (error) {
      if (error instanceof ServiceAuthExpiredError) {
        if (serviceTokens.get(event.sender) === token) serviceTokens.delete(event.sender)
        if (!event.sender.isDestroyed()) event.sender.send('auth:expired', token)
      }
      throw error
    }
  }
  let session: PlaywrightSession | undefined
  const browserGate = new BrowserOperationGate()
  let pickerProgress: { session: PlaywrightSession; workflowId: string; nodeId: string; stepIndex: number; fingerprint: string; pageUrl: string; state: RunState } | undefined
  let stopPageEnvironment: (() => void) | undefined
  const clearPageEnvironmentListener = (): void => {
    stopPageEnvironment?.()
    stopPageEnvironment = undefined
  }
  const closeCurrentSession = async (): Promise<void> => {
    const previous = session
    if (previous === undefined) return
    clearPageEnvironmentListener()
    session = undefined
    pickerProgress = undefined
    try {
      await previous.close()
    } catch (error) {
      if (!previous.isUsable()) return
      session = previous
      throw new Error(`清理上次浏览器会话失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const discardClosedSession = async (): Promise<void> => {
    if (session === undefined || session.isUsable()) return
    clearPageEnvironmentListener()
    await session.close().catch(() => undefined)
    session = undefined
    pickerProgress = undefined
  }
  const deviceName = hostname() || '本机'
  const deviceId = createHash('sha256').update(deviceName).digest('hex').slice(0, 20)
  const scheduleClock = new ClientScheduleClock((id, scheduledAt) => {
    const window = BrowserWindow.getAllWindows().find(item => !item.isDestroyed())
    if (window && !window.webContents.isDestroyed()) window.webContents.send('scheduler:due', { id, scheduledAt })
  })
  const scheduleTimer = setInterval(() => scheduleClock.tick(), 15_000)
  app.on('before-quit', () => clearInterval(scheduleTimer))
  ipcMain.handle('scheduler:sync', (_event, raw: unknown) => {
    if (!Array.isArray(raw) || raw.length > 500) throw new Error('定时任务列表无效')
    const rules = raw as ClientScheduleRule[]
    if (rules.some(rule => !rule || typeof rule.id !== 'string' || !['interval', 'daily', 'weekly'].includes(rule.kind) || typeof rule.timezone !== 'string' || typeof rule.createdAt !== 'string')) throw new Error('定时任务配置无效')
    scheduleClock.sync(rules)
    return { count: rules.length }
  })
  ipcMain.handle('scheduler:clear', () => { scheduleClock.sync([]); return { ok: true } })
  ipcMain.handle('scheduler:ack', (_event, raw: unknown) => {
    const value = raw as { id?: unknown; scheduledAt?: unknown } | undefined
    if (typeof value?.id !== 'string' || typeof value.scheduledAt !== 'string') throw new Error('定时任务确认参数无效')
    scheduleClock.acknowledge(value.id, value.scheduledAt)
    return { ok: true }
  })
  const activeRuns = new Map<string, { readonly controller: AbortController; readonly senderId: number }>()
  const pendingApprovals = new Map<string, { readonly resolve: (decision: ApprovalDecision) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout>; readonly senderId: number; readonly runId?: string }>()
  ipcMain.handle('workflow:approval-respond', (_event, raw: unknown) => {
    const value = typeof raw === 'object' && raw !== null ? raw as { id?: unknown; decision?: unknown; comment?: unknown } : {}
    if (typeof value.id !== 'string' || (value.decision !== 'approved' && value.decision !== 'rejected')) throw new Error('审批结果无效')
    const pending = pendingApprovals.get(value.id)
    if (pending === undefined) throw new Error('审批已处理、已超时或执行已结束')
    clearTimeout(pending.timer)
    pendingApprovals.delete(value.id)
    pending.resolve({ decision: value.decision, comment: typeof value.comment === 'string' ? value.comment : '', approverId: deviceId, approverName: deviceName, decidedAt: new Date().toISOString() })
    return { ok: true }
  })
  ipcMain.handle('device:info', () => ({ deviceId, deviceName, clientVersion: app.getVersion() }))
  ipcMain.handle('system:browser-readiness', () => checkBrowserReadiness(app.isPackaged))
  ipcMain.handle('workflow:cancel-run', async (event, raw: unknown) => {
    const value = typeof raw === 'object' && raw !== null ? raw as { runId?: unknown; reason?: unknown } : {}
    const runId = typeof value.runId === 'string'
      ? value.runId
      : ''
    const active = activeRuns.get(runId)
    if (active === undefined || active.senderId !== event.sender.id) return { cancelled: false }
    const reason = new Error(value.reason === 'editor-exit' ? '流程已因退出编辑页而终止' : '流程已由用户停止')
    active.controller.abort(reason)
    for (const [approvalId, approval] of pendingApprovals) {
      if (approval.runId !== runId) continue
      clearTimeout(approval.timer)
      pendingApprovals.delete(approvalId)
      approval.reject(reason)
    }
    await closeCurrentSession().catch(() => undefined)
    return { cancelled: true }
  })
  ipcMain.handle('workflow:test-code', (_event, raw: unknown) => {
    const payload = typeof raw === 'object' && raw !== null ? raw as { code?: unknown; input?: unknown; variables?: unknown } : {}
    if (typeof payload.code !== 'string' || payload.code.trim() === '') return { ok: false, message: '请先编写代码' }
    const input = payload.input === undefined ? {} : payload.input as JsonValue
    const variables = typeof payload.variables === 'object' && payload.variables !== null && !Array.isArray(payload.variables) ? payload.variables as Record<string, JsonValue> : {}
    try { return { ok: true, result: runWorkflowCode(payload.code, input, variables, 1500) } }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('workflow:run', async (event, raw: unknown) => {
    const release = browserGate.begin('执行流程')
    let registeredRunId: string | undefined
    let runController: AbortController | undefined
    try {
    pickerProgress = undefined
    const payload = typeof raw === 'object' && raw !== null && 'graph' in raw
      ? raw as { graph: unknown; runId?: unknown; executionId?: unknown; inputs?: unknown; variables?: unknown; outputs?: unknown; headless?: unknown; subflows?: unknown; reuseCurrentPage?: unknown; stopAfterNodeId?: unknown; openDebugBrowserOnPageActionFailure?: unknown }
      : { graph: raw }
    const runId = typeof payload.runId === 'string' && payload.runId.trim() !== '' ? payload.runId : undefined
    if (runId !== undefined) {
      if (activeRuns.has(runId)) throw new Error('该流程运行标识已在使用')
      runController = new AbortController()
      registeredRunId = runId
      activeRuns.set(runId, { controller: runController, senderId: event.sender.id })
    }
    const throwIfCancelled = (): void => {
      if (runController?.signal.aborted !== true) return
      throw runController.signal.reason instanceof Error ? runController.signal.reason : new Error('流程已终止')
    }
    const wait = (ms: number): Promise<void> => new Promise((resolve, reject) => {
      try { throwIfCancelled() } catch (error) { reject(error); return }
      const timer = setTimeout(() => {
        runController?.signal.removeEventListener('abort', cancel)
        resolve()
      }, ms)
      const cancel = (): void => {
        clearTimeout(timer)
        reject(runController?.signal.reason instanceof Error ? runController.signal.reason : new Error('流程已终止'))
      }
      runController?.signal.addEventListener('abort', cancel, { once: true })
    })
    const headless = payload.headless === true
    // Execution Center runs must never inherit a browser or picker session,
    // even when validation fails before the workflow reaches a page node.
    if (headless) await closeCurrentSession()
    const { configs: serviceLlms, token: serviceToken } = await loadMainServiceLlms(event)
    const graph = withServiceLlms(admit(payload.graph), serviceLlms, serviceToken)
    const executionId = typeof payload.executionId === 'string' ? payload.executionId : undefined
    const inputs = typeof payload.inputs === 'object' && payload.inputs !== null && !Array.isArray(payload.inputs)
      ? payload.inputs as Readonly<Record<string, JsonValue>>
      : undefined
    const variables = typeof payload.variables === 'object' && payload.variables !== null && !Array.isArray(payload.variables)
      ? payload.variables as Readonly<Record<string, JsonValue>>
      : undefined
    const outputs = typeof payload.outputs === 'object' && payload.outputs !== null && !Array.isArray(payload.outputs)
      ? payload.outputs as Readonly<Record<string, Readonly<Record<string, JsonValue>>>>
      : undefined
    const subflows = Array.isArray(payload.subflows) ? payload.subflows.map(flow => withServiceLlms(admit(flow), serviceLlms, serviceToken)) : []
    const graphs = [graph, ...subflows]
    const needsExistingPage = workflowNeedsExistingPage(graphs)
    await discardClosedSession()
    let currentUrl: string | undefined
    try { currentUrl = session?.driver.currentUrl?.() } catch { currentUrl = undefined }
    const entry = graph.nodes.find(node => node.id === graph.entryNodeId)
    const entryHasUrl = entry?.config.type === 'start' && entry.config.url.trim() !== ''
    const stopAtEmptyStart = !entryHasUrl && entry?.config.type === 'start' && payload.stopAfterNodeId === entry.id
    const reuseCurrentPage = !entryHasUrl && !headless && payload.reuseCurrentPage === true && session !== undefined && usablePageUrl(currentUrl)
    if (needsExistingPage && !reuseCurrentPage && !stopAtEmptyStart) {
      throw new Error('当前节点没有可用页面。请先运行父流程打开目标页面，或在子流程开始节点填写初始 URL。')
    }
    if (!reuseCurrentPage && !stopAtEmptyStart && session !== undefined) {
      await closeCurrentSession()
    }
    const lazy = createLazyBrowserDriver(createHttpOnlyDriver(), async () => {
      const opened = await openPlaywrightSession({ headless, packaged: app.isPackaged })
      session = opened
      return opened
    }, reuseCurrentPage ? session : undefined)
    const driver = lazy.driver
    if (!headless) {
      clearPageEnvironmentListener()
      const sender = event.sender
      stopPageEnvironment = driver.onUrlChange?.(url => {
        void driver.currentTitle?.().then(title => {
          if (!sender.isDestroyed()) sender.send('browser:page-environment', { url, title })
        }).catch(() => {
          if (!sender.isDestroyed()) sender.send('browser:page-environment', { url, title: '' })
        })
      })
    }
    const sender = event.sender
    try {
      const result = await runBrowser(graph, driver, {
        onUpdate: state => {
          throwIfCancelled()
          if (!sender.isDestroyed()) sender.send('workflow:run-update', { runId, state })
        },
        wait,
        requestApproval: (prompt: ApprovalPrompt) => new Promise<ApprovalDecision>((resolve, reject) => {
          try { throwIfCancelled() } catch (error) { reject(error); return }
          if (sender.isDestroyed()) { reject(new Error('审批窗口已关闭')); return }
          const timeoutMs = prompt.timeoutAt === undefined ? 30 * 60_000 : Math.max(1, new Date(prompt.timeoutAt).getTime() - Date.now())
          const timer = setTimeout(() => {
            pendingApprovals.delete(prompt.id)
            resolve({ decision: 'timeout', comment: '', approverId: deviceId, approverName: deviceName, decidedAt: new Date().toISOString() })
          }, timeoutMs)
          pendingApprovals.set(prompt.id, { resolve, reject, timer, senderId: sender.id, runId })
          sender.send('workflow:approval-request', prompt)
        }),
      }, { executionId, inputs, variables, outputs, subflows, allowExistingPage: reuseCurrentPage, stopAfterNodeId: typeof payload.stopAfterNodeId === 'string' ? payload.stopAfterNodeId : undefined })
      const runSession = lazy.getSession()
      if (headless && payload.openDebugBrowserOnPageActionFailure === true && failedAtPageAction(result)) {
        if (runSession === undefined || !runSession.isUsable()) {
          return { ...result, debugBrowser: { opened: false, message: '失败时浏览器页面已关闭，无法恢复调试窗口' } }
        }
        try {
          const debugSession = await runSession.openDebugCopy()
          session = debugSession
          return { ...result, debugBrowser: { opened: true } }
        } catch (error) {
          return { ...result, debugBrowser: { opened: false, message: error instanceof Error ? error.message : String(error) } }
        }
      }
      return result
    } finally {
      const runSession = lazy.getSession()
      if (headless && runSession !== undefined) {
        clearPageEnvironmentListener()
        await runSession.close().catch(() => undefined)
        if (session === runSession) session = undefined
      }
    }
    } finally {
      if (registeredRunId !== undefined && activeRuns.get(registeredRunId)?.controller === runController) activeRuns.delete(registeredRunId)
      release()
    }
  })
  ipcMain.handle('llm:test', async (_event, raw: unknown) => {
    const config = raw as { enabled?: boolean; baseUrl?: string; chatPath?: string; model?: string; apiKey?: string } | undefined
    if (config?.model?.trim() === '') return { ok: false, message: '请先填写模型' }
    const endpoint = resolveLlmEndpoint(config?.baseUrl, (config as { chatPath?: string } | undefined)?.chatPath)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (config.apiKey?.trim() !== '') headers.Authorization = `Bearer ${config.apiKey}`
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config?.model, max_tokens: 8, messages: [{ role: 'system', content: 'Reply with OK only.' }] }),
      })
      if (!response.ok) return { ok: false, message: `服务返回 HTTP ${response.status}` }
      return { ok: true, message: 'AI 服务联通成功' }
    } catch (error) {
      return { ok: false, message: `无法连接 AI 服务：${error instanceof Error ? error.message : String(error)}` }
    }
  })
  ipcMain.handle('browser:pick-element', async (_event, url?: unknown) => {
    const release = browserGate.begin('拾取元素')
    try {
    pickerProgress = undefined
    const payload = typeof url === 'object' && url !== null ? url as { url?: unknown; mode?: unknown } : { url }
    const targetUrl = typeof payload.url === 'string' ? payload.url : undefined
    const mode = payload.mode === 'list' ? 'list' : 'element'
    await discardClosedSession()
    if (session === undefined) session = await openPlaywrightSession({ packaged: app.isPackaged })
    const picker = session
    try {
      const picked = await picker.pickElement(targetUrl, mode)
      return picked
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (!/closed|Target page|browser has been closed/i.test(detail)) throw error
      clearPageEnvironmentListener()
      await picker.close().catch(() => undefined)
      session = await openPlaywrightSession({ packaged: app.isPackaged })
      const recovered = session
      const picked = await recovered.pickElement(targetUrl, mode)
      return picked
    }
    } finally { release() }
  })
  ipcMain.handle('browser:prepare-and-pick', async (event, raw: unknown) => {
    const release = browserGate.begin('准备并拾取元素')
    try {
    const payload = typeof raw === 'object' && raw !== null ? raw as { preparedGraph?: unknown; subflows?: unknown; url?: unknown; mode?: unknown; inputs?: unknown; pickerContext?: unknown } : {}
    const serviceLlms = payload.preparedGraph === undefined ? undefined : await loadMainServiceLlms(event)
    const preparedGraph = payload.preparedGraph === undefined || serviceLlms === undefined
      ? undefined : withServiceLlms(admit(payload.preparedGraph), serviceLlms.configs, serviceLlms.token)
    const subflows = Array.isArray(payload.subflows) && serviceLlms !== undefined
      ? payload.subflows.map(flow => withServiceLlms(admit(flow), serviceLlms.configs, serviceLlms.token)) : []
    const targetUrl = typeof payload.url === 'string' ? payload.url : undefined
    const mode = payload.mode === 'list' ? 'list' : 'element'
    const inputs = typeof payload.inputs === 'object' && payload.inputs !== null && !Array.isArray(payload.inputs)
      ? payload.inputs as Readonly<Record<string, JsonValue>>
      : undefined
    const rawPickerContext = typeof payload.pickerContext === 'object' && payload.pickerContext !== null
      ? payload.pickerContext as { workflowId?: unknown; nodeId?: unknown; stepIndex?: unknown }
      : undefined
    const pickerContext = typeof rawPickerContext?.workflowId === 'string' && typeof rawPickerContext.nodeId === 'string' && Number.isInteger(rawPickerContext.stepIndex) && Number(rawPickerContext.stepIndex) >= 0
      ? { workflowId: rawPickerContext.workflowId, nodeId: rawPickerContext.nodeId, stepIndex: Number(rawPickerContext.stepIndex) }
      : undefined
    // Keep the browser alive across picks. Preparation below decides whether
    // to run the full prefix or just the steps added since the last pick.
    await discardClosedSession()
    if (session === undefined) session = await openPlaywrightSession({ packaged: app.isPackaged })
    const picker = session
    try {
      if (preparedGraph !== undefined && preparedGraph.nodes.length > 0) {
        const sender = event.sender
        const targetAction = pickerContext === undefined ? undefined : preparedGraph.nodes.find(node => node.id === pickerContext.nodeId && node.config.type === 'page-action')
        const fingerprintAt = (stepIndex: number): string => JSON.stringify({
          graph: { ...preparedGraph, nodes: preparedGraph.nodes.map(node => node.id === pickerContext?.nodeId && node.config.type === 'page-action' ? { ...node, config: { ...node.config, steps: node.config.steps.slice(0, stepIndex) } } : node) },
          inputs,
          subflows: subflows.map(flow => [flow.workflowId, flow.version]),
        })
        const previous = pickerProgress
        const canContinue = pickerContext !== undefined && targetAction?.config.type === 'page-action' && previous !== undefined
          && previous.session === picker && previous.workflowId === pickerContext.workflowId && previous.nodeId === pickerContext.nodeId
          && pickerContext.stepIndex >= previous.stepIndex && previous.fingerprint === fingerprintAt(previous.stepIndex)
          && previous.pageUrl === (picker.driver.currentUrl?.() ?? previous.pageUrl)
        // The prefix intentionally stops before the target node. Add a terminal
        // node so the runner can complete without trying to continue into it.
        const terminalId = '__rpa_picker_terminal__'
        const lastNode = preparedGraph.nodes[preparedGraph.nodes.length - 1]
        const nodeIds = new Set(preparedGraph.nodes.map(item => item.id))
        const terminal: WorkflowNode = {
          id: terminalId,
          type: 'end',
          name: '拾取准备完成',
          position: { x: (lastNode?.position.x ?? 0) + 260, y: lastNode?.position.y ?? 0 },
          inputBindings: {},
          config: { type: 'end' },
          execution: { timeoutMs: 30_000, maxAttempts: 1, onError: 'fail-run' },
        }
        const fullRunnable: WorkflowGraph = {
          ...preparedGraph,
          nodes: [...preparedGraph.nodes, terminal],
          edges: [
            ...preparedGraph.edges.map(edge => nodeIds.has(edge.targetNodeId) ? edge : { ...edge, targetNodeId: terminalId }),
            ...(lastNode !== undefined && !preparedGraph.edges.some(edge => edge.sourceNodeId === lastNode.id)
              ? [{ id: '__rpa_picker_terminal_edge__', sourceNodeId: lastNode.id, sourcePort: 'default', targetNodeId: terminalId }]
              : []),
          ],
        }
        let state: RunState
        if (canContinue && pickerContext.stepIndex === previous.stepIndex) {
          state = previous.state
        } else {
          let runnable = fullRunnable
          if (canContinue && targetAction.config.type === 'page-action') {
            const resumeStart: WorkflowNode = {
              ...terminal, id: '__rpa_picker_resume_start__', type: 'start', name: '沿用当前页面',
              config: { type: 'start', url: '' },
            }
            const remainingAction: WorkflowNode = {
              ...targetAction,
              config: { ...targetAction.config, steps: targetAction.config.steps.slice(previous.stepIndex, pickerContext.stepIndex) },
            }
            runnable = {
              ...preparedGraph,
              entryNodeId: resumeStart.id,
              nodes: [resumeStart, remainingAction, terminal],
              edges: [
                { id: '__rpa_picker_resume_in__', sourceNodeId: resumeStart.id, sourcePort: 'default', targetNodeId: remainingAction.id },
                { id: '__rpa_picker_resume_out__', sourceNodeId: remainingAction.id, sourcePort: 'default', targetNodeId: terminal.id },
              ],
            }
          }
          const next = await runBrowser(runnable, picker.driver, {
            onUpdate: next => {
              if (!sender.isDestroyed()) sender.send('workflow:run-update', { state: next })
            },
            wait: ms => new Promise(resolve => { setTimeout(resolve, ms) }),
          }, canContinue ? { inputs, variables: previous.state.variables, outputs: previous.state.outputs, allowExistingPage: true } : { subflows, inputs })
          state = canContinue ? {
            ...next,
            outputs: {
              ...previous.state.outputs,
              ...next.outputs,
              [pickerContext.nodeId]: { ...previous.state.outputs[pickerContext.nodeId], ...next.outputs[pickerContext.nodeId] },
            },
          } : next
        }
        if (state.status === 'failed') {
          pickerProgress = undefined
          const detail = state.logs.at(-1)?.message ?? '未知错误'
          throw new Error(`执行前置流程失败，无法拾取元素：${detail}`)
        }
        pickerProgress = pickerContext !== undefined && targetAction?.config.type === 'page-action'
          ? { session: picker, workflowId: pickerContext.workflowId, nodeId: pickerContext.nodeId, stepIndex: pickerContext.stepIndex, fingerprint: fingerprintAt(pickerContext.stepIndex), pageUrl: picker.driver.currentUrl?.() ?? '', state }
          : undefined
      } else {
        pickerProgress = undefined
      }
      const picked = await picker.pickElement(targetUrl, mode)
      return picked
    } catch (error) {
      pickerProgress = undefined
      const detail = error instanceof Error ? error.message : String(error)
      if (/closed|Target page|browser has been closed/i.test(detail)) {
        clearPageEnvironmentListener()
        await picker.close().catch(() => undefined)
        if (session === picker) session = undefined
      }
      throw error
    }
    } finally { release() }
  })
  app.on('before-quit', () => {
    clearPageEnvironmentListener()
    void session?.close()
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch(error => {
  console.error(error)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
