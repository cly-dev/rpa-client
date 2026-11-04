import { afterEach, expect, it } from 'vitest'
import type { WorkflowContextVariable } from '@graph/types.ts'
import { clearRememberedExecutionInputs, initialExecutionInputText, rememberExecutionInputText } from './execution-input-memory.ts'

afterEach(clearRememberedExecutionInputs)

it('reuses the last manual run inputs for the same workflow, including temporary secrets', () => {
  const inputs: WorkflowContextVariable[] = [
    { name: 'orderId', type: 'string', defaultValue: 'DEFAULT' },
    { name: 'body', type: 'object' },
    { name: 'password', type: 'string', secret: true, defaultValue: '******' },
  ]
  const variables: WorkflowContextVariable[] = [{ name: 'token', type: 'string', secret: true }]
  expect(initialExecutionInputText('flow-a', inputs, variables, true)).toEqual({
    inputs: { orderId: 'DEFAULT', body: '', password: '' }, secrets: { token: '' },
  })

  const filledInputs = { orderId: 'A-123', body: '{"status":"PENDING"}', password: 'secret-1' }
  const filledSecrets = { token: 'temporary-token' }
  rememberExecutionInputText('flow-a', filledInputs, filledSecrets)
  filledInputs.orderId = 'changed-after-save'
  expect(initialExecutionInputText('flow-a', inputs, variables, true)).toEqual({
    inputs: { orderId: 'A-123', body: '{"status":"PENDING"}', password: 'secret-1' },
    secrets: { token: 'temporary-token' },
  })
  expect(initialExecutionInputText('flow-b', inputs, variables, true).inputs.orderId).toBe('DEFAULT')
  expect(initialExecutionInputText('flow-a', inputs, variables, false).inputs.orderId).toBe('DEFAULT')
  expect(initialExecutionInputText('flow-a', inputs, variables, false).secrets.token).toBe('')
})

it('only restores fields still declared in the current published version and clears on logout', () => {
  rememberExecutionInputText('flow-a', { oldField: 'old', orderId: 'A-123' }, { oldSecret: 'old' })
  const current = initialExecutionInputText('flow-a', [
    { name: 'orderId', type: 'string' }, { name: 'newField', type: 'number', defaultValue: 1 },
  ], [{ name: 'newSecret', type: 'string', secret: true }], true)
  expect(current).toEqual({ inputs: { orderId: 'A-123', newField: '1' }, secrets: { newSecret: '' } })
  clearRememberedExecutionInputs()
  expect(initialExecutionInputText('flow-a', [{ name: 'orderId', type: 'string' }], [], true).inputs.orderId).toBe('')
})
