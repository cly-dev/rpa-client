import type { ApprovalPrompt, WorkflowGraph } from '@graph/types.ts'
import type { DryRunState } from '@runner/dry-run.ts'
import type { ClientScheduleRule } from '../main/schedule-clock.ts'

interface StudioApi {
  setServiceToken(token?: string): Promise<{ ok: true }>
  onAuthExpired(callback: (token: string) => void): () => void
  getDeviceInfo(): Promise<{ deviceId: string; deviceName: string; clientVersion: string }>
  checkBrowserReadiness(): Promise<{ available: boolean; message: string }>
  runWorkflow(graph: WorkflowGraph, options?: { runId?: string; executionId?: string; inputs?: Readonly<Record<string, import('@graph/types.ts').JsonValue>>; variables?: Readonly<Record<string, import('@graph/types.ts').JsonValue>>; outputs?: Readonly<Record<string, Readonly<Record<string, import('@graph/types.ts').JsonValue>>>>; headless?: boolean; subflows?: readonly WorkflowGraph[]; reuseCurrentPage?: boolean; stopAfterNodeId?: string; openDebugBrowserOnPageActionFailure?: boolean }): Promise<DryRunState>
  syncSchedules(rules: readonly ClientScheduleRule[]): Promise<{ count: number }>
  clearSchedules(): Promise<{ ok: true }>
  acknowledgeScheduleDue(id: string, scheduledAt: string): Promise<{ ok: true }>
  onScheduleDue(callback: (value: { id: string; scheduledAt: string }) => void): () => void
  cancelWorkflow(runId: string, reason?: 'user' | 'editor-exit'): Promise<{ cancelled: boolean }>
  onRunUpdate(callback: (value: { readonly runId?: string; readonly state: DryRunState }) => void): () => void
  onApprovalRequest(callback: (prompt: ApprovalPrompt) => void): () => void
  respondApproval(id: string, decision: 'approved' | 'rejected', comment?: string): Promise<{ ok: true }>
  onPageEnvironment(callback: (environment: { url: string; title: string }) => void): () => void
  testLlm(config: WorkflowGraph['llm']): Promise<{ ok: boolean; message: string }>
  testCode(code: string, input: import('@graph/types.ts').JsonValue, variables?: Readonly<Record<string, import('@graph/types.ts').JsonValue>>): Promise<{ ok: boolean; result?: import('@graph/types.ts').JsonValue; message?: string }>
  pickElement(url?: string, mode?: 'element' | 'list' | 'list-container' | 'list-row' | 'row-element', pickOptions?: { scopeSelector?: string; rowSelectorMode?: 'css' | 'class-contains'; rowSelector?: string }): Promise<{ tagName: string; text: string; id: string; className: string; ariaLabel: string; role: string; placeholder: string; selector: string; url: string; title: string; optionValue?: string; triggerSelector?: string; optionSelector?: string; rowSelectorMode?: 'css' | 'class-contains'; rowSelectorValue?: string; relativeSelectorMode?: 'css' | 'class-contains'; relativeSelectorValue?: string }>
  prepareAndPickElement(preparedGraph: WorkflowGraph | undefined, url?: string, mode?: 'element' | 'list' | 'list-container' | 'list-row' | 'row-element', subflows?: readonly WorkflowGraph[], inputs?: Readonly<Record<string, import('@graph/types.ts').JsonValue>>, pickerContext?: { workflowId: string; nodeId: string; stepIndex: number }, runId?: string, pickOptions?: { scopeSelector?: string; rowSelectorMode?: 'css' | 'class-contains'; rowSelector?: string }): Promise<{ tagName: string; text: string; id: string; className: string; ariaLabel: string; role: string; placeholder: string; selector: string; url: string; title: string; optionValue?: string; triggerSelector?: string; optionSelector?: string; rowSelectorMode?: 'css' | 'class-contains'; rowSelectorValue?: string; relativeSelectorMode?: 'css' | 'class-contains'; relativeSelectorValue?: string }>
}

declare global {
  interface Window {
    readonly studio?: StudioApi
  }
}

export {}
