import type { JsonValue, WorkflowContextVariable } from '@graph/types.ts'

interface RememberedInputs {
  readonly inputs: Readonly<Record<string, string>>
  readonly secrets: Readonly<Record<string, string>>
}

const rememberedByWorkflow = new Map<string, RememberedInputs>()
const MAX_REMEMBERED_WORKFLOWS = 30

function defaultText(value: JsonValue | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
}

export function initialExecutionInputText(
  workflowId: string,
  inputs: readonly WorkflowContextVariable[],
  variables: readonly WorkflowContextVariable[],
  reuseLastRun: boolean,
): RememberedInputs {
  const remembered = reuseLastRun ? rememberedByWorkflow.get(workflowId) : undefined
  return {
    inputs: Object.fromEntries(inputs.map(item => [item.name, remembered?.inputs[item.name] ?? (item.secret && item.defaultValue === '******' ? '' : defaultText(item.defaultValue))])),
    secrets: Object.fromEntries(variables.filter(item => item.secret).map(item => [item.name, remembered?.secrets[item.name] ?? ''])),
  }
}

export function rememberExecutionInputText(workflowId: string, inputs: Readonly<Record<string, string>>, secrets: Readonly<Record<string, string>>): void {
  rememberedByWorkflow.delete(workflowId)
  rememberedByWorkflow.set(workflowId, { inputs: { ...inputs }, secrets: { ...secrets } })
  if (rememberedByWorkflow.size > MAX_REMEMBERED_WORKFLOWS) {
    const oldest = rememberedByWorkflow.keys().next().value
    if (oldest !== undefined) rememberedByWorkflow.delete(oldest)
  }
}

export function clearRememberedExecutionInputs(): void {
  rememberedByWorkflow.clear()
}
