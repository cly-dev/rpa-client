import { describe, expect, it } from 'vitest'
import { BrowserOperationGate } from './browser-operation.ts'

describe('BrowserOperationGate', () => {
  it('prevents one run from closing a browser used by another operation', () => {
    const gate = new BrowserOperationGate()
    const release = gate.begin('执行流程')
    expect(() => gate.begin('拾取元素')).toThrow('浏览器正在执行流程')
    release()
    expect(() => gate.begin('拾取元素')).not.toThrow()
  })
})
