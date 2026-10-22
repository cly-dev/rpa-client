import { describe, expect, it } from 'vitest'
import { assignVariable, initialContextValues, resolveBindingInContext, resolveExpression, resolveRequestBody, type WorkflowContext } from './context.ts'

const context = (): WorkflowContext => ({
  inputs: { orderId: 'A-1001' }, variables: { retry: 2 }, failures: {}, successes: {}, outputs: { extract: { data: { items: [{ name: 'Alpha' }] } } },
  page: { url: 'https://example.com', title: 'Example' }, runtime: { executionId: 'e1', workflowId: 'w1' },
})

describe('workflow context', () => {
  it('resolves exact and interpolated expressions', () => {
    const value = context()
    expect(resolveExpression('{{inputs.orderId}}', value)).toBe('A-1001')
    expect(resolveExpression('订单 {{inputs.orderId}} / {{page.title}}', value)).toBe('订单 A-1001 / Example')
    expect(resolveExpression('{{outputs.extract.data.items[0].name}}', value)).toBe('Alpha')
  })

  it('resolves bindings and assigns nested variables', () => {
    const value = context()
    expect(resolveBindingInContext({ kind: 'workflow-input', name: 'orderId' }, value)).toBe('A-1001')
    assignVariable(value, 'order.currentId', 'A-1001')
    expect(value.variables).toEqual({ retry: 2, order: { currentId: 'A-1001' } })
  })

  it('reads nested variable fields and escapes them inside JSON request bodies', () => {
    const value = context()
    assignVariable(value, 'order.customer', { name: 'A "VIP"', age: 12, items: [{ sku: 'SKU-1' }] })
    expect(resolveExpression('{{order.customer.name}}', value)).toBe('A "VIP"')
    expect(resolveExpression('{{order.customer.items[0].sku}}', value)).toBe('SKU-1')
    expect(JSON.parse(resolveRequestBody('{"name":"{{order.customer.name}}","age":{{order.customer.age}},"sku":"{{order.customer.items[0].sku}}"}', value))).toEqual({ name: 'A "VIP"', age: 12, sku: 'SKU-1' })
    expect(JSON.parse(resolveRequestBody('{{order.customer}}', value))).toEqual({ name: 'A "VIP"', age: 12, items: [{ sku: 'SKU-1' }] })
  })

  it('serializes nested input objects, arrays and numbers in a mixed request body', () => {
    const value = { ...context(), inputs: {
      wordOrderId: 'WO-1',
      workOrderDetail: { shopId: 42, title: 'A "VIP"', addressEditInfo: { city: '上海' }, imageUrl: ['https://example.com/a.png'], items: [{ sku: 'SKU-1' }] },
    } }
    const template = '{"id":"{{inputs.wordOrderId}}","shopId":{{inputs.workOrderDetail.shopId}},"title":"{{inputs.workOrderDetail.title}}","addressEditInfo":{{inputs.workOrderDetail.addressEditInfo}},"imageUrl":{{inputs.workOrderDetail.imageUrl}},"items":{{inputs.workOrderDetail.items}}}'
    expect(JSON.parse(resolveRequestBody(template, value))).toEqual({
      id: 'WO-1', shopId: 42, title: 'A "VIP"', addressEditInfo: { city: '上海' }, imageUrl: ['https://example.com/a.png'], items: [{ sku: 'SKU-1' }],
    })
  })

  it('reports an extra brace instead of sending malformed JSON', () => {
    expect(() => resolveRequestBody('{"id":"{{inputs.orderId}}"}}', context())).toThrow('请求体 JSON 格式错误')
  })

  it('loads declared default values into the runtime context', () => {
    expect(initialContextValues([
      { name: 'username', type: 'string', defaultValue: 'demo' },
      { name: 'optional', type: 'string' },
    ])).toEqual({ username: 'demo', optional: null })
  })
})
