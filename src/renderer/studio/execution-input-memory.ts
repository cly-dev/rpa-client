import type { JsonValue, WorkflowContextVariable } from '@graph/types.ts'

interface RememberedInputs {
  readonly inputs: Readonly<Record<string, string>>
  readonly secrets: Readonly<Record<string, string>>
}

type ExecutionInputMode = 'run' | 'schedule'

const rememberedByWorkflow = new Map<string, RememberedInputs>()
const MAX_REMEMBERED_WORKFLOWS = 30

function memoryKey(workflowId: string, mode: ExecutionInputMode): string {
  return `${mode}:${workflowId}`
}

function defaultText(value: JsonValue | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
}

export function initialExecutionInputText(
  workflowId: string,
  inputs: readonly WorkflowContextVariable[],
  variables: readonly WorkflowContextVariable[],
  reuseRemembered: boolean,
  mode: ExecutionInputMode = 'run',
): RememberedInputs {
  const remembered = reuseRemembered ? rememberedByWorkflow.get(memoryKey(workflowId, mode)) : undefined
  return {
    inputs: Object.fromEntries(inputs.map(item => [item.name, remembered?.inputs[item.name] ?? (item.secret && item.defaultValue === '******' ? '' : defaultText(item.defaultValue))])),
    secrets: Object.fromEntries(variables.filter(item => item.secret).map(item => [item.name, remembered?.secrets[item.name] ?? ''])),
  }
}

export function rememberExecutionInputText(workflowId: string, inputs: Readonly<Record<string, string>>, secrets: Readonly<Record<string, string>>, mode: ExecutionInputMode = 'run'): void {
  const key = memoryKey(workflowId, mode)
  rememberedByWorkflow.delete(key)
  rememberedByWorkflow.set(key, { inputs: { ...inputs }, secrets: { ...secrets } })
  if (rememberedByWorkflow.size > MAX_REMEMBERED_WORKFLOWS) {
    const oldest = rememberedByWorkflow.keys().next().value
    if (oldest !== undefined) rememberedByWorkflow.delete(oldest)
  }
}

export function clearRememberedExecutionInputs(): void {
  rememberedByWorkflow.clear()
}
