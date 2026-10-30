import { contextBridge, ipcRenderer } from 'electron'
import type { DryRunState } from '../runner/dry-run.ts'
import type { ApprovalPrompt, JsonValue, WorkflowGraph } from '../graph/types.ts'
import type { ClientScheduleRule } from '../main/schedule-clock.ts'

const studio = {
  setServiceToken: (token?: string) => ipcRenderer.invoke('auth:set-token', token) as Promise<{ ok: true }>,
  onAuthExpired: (callback: (token: string) => void) => {
    const listen = (_event: unknown, token: string): void => { callback(token) }
    ipcRenderer.on('auth:expired', listen)
    return () => { ipcRenderer.removeListener('auth:expired', listen) }
  },
  getDeviceInfo: () => ipcRenderer.invoke('device:info') as Promise<{ deviceId: string; deviceName: string; clientVersion: string }>,
  syncSchedules: (rules: readonly ClientScheduleRule[]) => ipcRenderer.invoke('scheduler:sync', rules) as Promise<{ count: number }>,
  clearSchedules: () => ipcRenderer.invoke('scheduler:clear') as Promise<{ ok: true }>,
  acknowledgeScheduleDue: (id: string, scheduledAt: string) => ipcRenderer.invoke('scheduler:ack', { id, scheduledAt }) as Promise<{ ok: true }>,
  onScheduleDue: (callback: (value: { id: string; scheduledAt: string }) => void) => {
    const listen = (_event: unknown, value: { id: string; scheduledAt: string }): void => { callback(value) }
    ipcRenderer.on('scheduler:due', listen)
    return () => { ipcRenderer.removeListener('scheduler:due', listen) }
  },
  checkBrowserReadiness: () => ipcRenderer.invoke('system:browser-readiness') as Promise<{ available: boolean; message: string }>,
  runWorkflow: (graph: import('../graph/types.ts').WorkflowGraph, options?: { runId?: string; executionId?: string; inputs?: Readonly<Record<string, import('../graph/types.ts').JsonValue>>; variables?: Readonly<Record<string, import('../graph/types.ts').JsonValue>>; outputs?: Readonly<Record<string, Readonly<Record<string, import('../graph/types.ts').JsonValue>>>>; headless?: boolean; subflows?: readonly import('../graph/types.ts').WorkflowGraph[]; reuseCurrentPage?: boolean; stopAfterNodeId?: string; openDebugBrowserOnPageActionFailure?: boolean }) => ipcRenderer.invoke('workflow:run', { graph, ...options }) as Promise<DryRunState>,
  cancelWorkflow: (runId: string, reason: 'user' | 'editor-exit' = 'user') => ipcRenderer.invoke('workflow:cancel-run', { runId, reason }) as Promise<{ cancelled: boolean }>,
  onRunUpdate: (callback: (value: { runId?: string; state: DryRunState }) => void) => {
    const listen = (_event: unknown, value: { runId?: string; state: DryRunState }): void => { callback(value) }
    ipcRenderer.on('workflow:run-update', listen)
    return () => { ipcRenderer.removeListener('workflow:run-update', listen) }
  },
  onApprovalRequest: (callback: (prompt: ApprovalPrompt) => void) => {
    const listen = (_event: unknown, prompt: ApprovalPrompt): void => { callback(prompt) }
    ipcRenderer.on('workflow:approval-request', listen)
    return () => { ipcRenderer.removeListener('workflow:approval-request', listen) }
  },
  respondApproval: (id: string, decision: 'approved' | 'rejected', comment = '') => ipcRenderer.invoke('workflow:approval-respond', { id, decision, comment }) as Promise<{ ok: true }>,
  onPageEnvironment: (callback: (environment: { url: string; title: string }) => void) => {
    const listen = (_event: unknown, environment: { url: string; title: string }): void => { callback(environment) }
    ipcRenderer.on('browser:page-environment', listen)
    return () => { ipcRenderer.removeListener('browser:page-environment', listen) }
  },
  testLlm: (config: WorkflowGraph['llm']) => ipcRenderer.invoke('llm:test', config) as Promise<{ ok: boolean; message: string }>,
  testCode: (code: string, input: JsonValue, variables?: Readonly<Record<string, JsonValue>>) => ipcRenderer.invoke('workflow:test-code', { code, input, variables }) as Promise<{ ok: boolean; result?: JsonValue; message?: string }>,
  pickElement: (url?: string, mode: 'element' | 'list' | 'list-container' | 'list-row' | 'row-element' = 'element', pickOptions?: { scopeSelector?: string; rowSelectorMode?: 'css' | 'class-contains'; rowSelector?: string }) => ipcRenderer.invoke('browser:pick-element', { url, mode, ...pickOptions }) as Promise<{ tagName: string; text: string; id: string; className: string; ariaLabel: string; role: string; placeholder: string; selector: string; url: string; title: string; optionValue?: string; triggerSelector?: string; optionSelector?: string; rowSelectorMode?: 'css' | 'class-contains'; rowSelectorValue?: string; relativeSelectorMode?: 'css' | 'class-contains'; relativeSelectorValue?: string }>,
  prepareAndPickElement: (preparedGraph: WorkflowGraph | undefined, url?: string, mode: 'element' | 'list' | 'list-container' | 'list-row' | 'row-element' = 'element', subflows: readonly WorkflowGraph[] = [], inputs?: Readonly<Record<string, JsonValue>>, pickerContext?: { workflowId: string; nodeId: string; stepIndex: number }, runId?: string, pickOptions?: { scopeSelector?: string; rowSelectorMode?: 'css' | 'class-contains'; rowSelector?: string }) => ipcRenderer.invoke('browser:prepare-and-pick', { preparedGraph, url, mode, subflows, inputs, pickerContext, runId, ...pickOptions }) as Promise<{ tagName: string; text: string; id: string; className: string; ariaLabel: string; role: string; placeholder: string; selector: string; url: string; title: string; optionValue?: string; triggerSelector?: string; optionSelector?: string; rowSelectorMode?: 'css' | 'class-contains'; rowSelectorValue?: string; relativeSelectorMode?: 'css' | 'class-contains'; relativeSelectorValue?: string }>,
}

contextBridge.exposeInMainWorld('studio', studio)

export type StudioApi = typeof studio
