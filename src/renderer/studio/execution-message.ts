import type { DryRunState } from '@runner/dry-run.ts'

/** Remove Electron's transport wrapper so the user sees the actionable cause. */
export function readableRunError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method ['"]workflow:run['"]: (?:Error: )?/, '').trim() || '本机执行失败，请查看执行记录'
}

export function failedRunReason(state: DryRunState): string {
  return state.logs.at(-1)?.message.trim() || '流程执行失败，请查看执行记录中的节点日志'
}

export function executionEventTone(message: string): 'error' | 'warning' | 'normal' {
  if (/执行失败|运行失败|尝试失败|失败，已停下来等人|状态：(failed|waiting-user)|错误：|异常：/.test(message)) return 'error'
  if (/等待|重试|超时|跳过/.test(message)) return 'warning'
  return 'normal'
}
