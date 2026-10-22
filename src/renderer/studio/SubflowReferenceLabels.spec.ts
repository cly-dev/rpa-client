import { describe, expect, it } from 'vitest'
import { displaySubflowReferences, outputReferenceAliases, storeSubflowReferences } from './SubflowReferenceLabels.ts'

describe('subflow output reference labels', () => {
  it('shows readable labels while retaining stable node IDs in saved expressions', () => {
    const aliases = outputReferenceAliases([
      { nodeId: 'api-request_0c8d625f', port: 'paymentTime' },
      { nodeId: 'api-request_62a', port: 'orderId' },
    ])
    const saved = '支付时间：{{outputs.api-request_0c8d625f.paymentTime}}，订单：{{outputs.api-request_62a.orderId}}'
    const shown = '支付时间：{{paymentTime}}，订单：{{orderId}}'
    expect(displaySubflowReferences(saved, aliases)).toBe(shown)
    expect(storeSubflowReferences(shown, aliases, saved)).toBe(saved)
  })

  it('shows duplicate field names without suffixes and retains their original sources', () => {
    const sources = [
      { nodeId: 'api-1', port: 'paymentTime' },
      { nodeId: 'api-2', port: 'paymentTime' },
    ]
    const aliases = outputReferenceAliases(sources)
    expect(aliases.map(alias => alias.label)).toEqual(['paymentTime', 'paymentTime'])
    const saved = '{{outputs.api-1.paymentTime}} + {{outputs.api-2.paymentTime}}'
    const shown = '{{paymentTime}} + {{paymentTime}}'
    expect(displaySubflowReferences(saved, aliases)).toBe(shown)
    expect(storeSubflowReferences(`时间：${shown}`, aliases, saved)).toBe(`时间：${saved}`)
    expect(storeSubflowReferences('{{paymentTime}}', aliases, '{{paymentTime}}')).toBe('{{paymentTime}}')
  })
})
