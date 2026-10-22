import type { DryRunState } from '@runner/dry-run.ts'

/** Remove Electron's transport wrapper so the user sees the actionable cause. */
export function readableRunError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method ['"]workflow:run['"]: (?:Error: )?/, '').trim() || '本机执行失败，请查看执行记录'
}

export function failedRunReason(state: DryRunState): string {
  return state.logs.at(-1)?.message.trim() || '流程执行失败，请查看执行记录中的节点日志'
}
