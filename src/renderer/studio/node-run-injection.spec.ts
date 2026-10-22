import { describe, expect, it } from 'vitest'
import { createNode } from '@graph/mutate.ts'
import { parseInjections, referencedInjections } from './node-run-injection.ts'

describe('node run injections', () => {
  it('collects variable and upstream-output bindings used by the selected node', () => {
    const base = createNode('set-variable', { x: 0, y: 0 })
    const node = { ...base, inputBindings: { source: { kind: 'node-output' as const, nodeId: 'api-1', port: 'data' }, extra: { kind: 'variable' as const, name: 'order.id' } }, config: { ...base.config, value: { kind: 'literal' as const, value: '{{variables.user.name}}' } } }
    const rows = referencedInjections(node)
    expect(rows.map(row => row.key)).toEqual(expect.arrayContaining(['output:api-1:data', 'variable:order.id', 'variable:user.name']))
  })

  it('parses typed values into variable and output maps', () => {
    expect(parseInjections([
      { key: 'a', name: 'order.id', type: 'number', value: '42' },
      { key: 'b', name: 'approved', type: 'boolean', value: 'false' },
      { key: 'c', name: 'api-1.data', type: 'json', value: '{"ok":true}', source: 'output', nodeId: 'api-1', port: 'data' },
    ])).toEqual({ variables: { order: { id: 42 }, approved: false }, outputs: { 'api-1': { data: { ok: true } } } })
  })
})
