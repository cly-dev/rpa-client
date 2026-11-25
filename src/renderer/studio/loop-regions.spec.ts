import { expect, it } from 'vitest'
import { createDefaultTemplate } from '@graph/template.ts'
import { createEdge, createNode } from '@graph/mutate.ts'
import { loopRegions } from './loop-regions.ts'

it('bounds the measured loop body while excluding completion nodes and feedback to the loop', () => {
  const base = createDefaultTemplate()
  const loop = createNode('for-each', { x: 100, y: 100 })
  const body = createNode('page-action', { x: 400, y: 400 })
  const done = createNode('end', { x: 800, y: 100 })
  const graph = { ...base, nodes: [loop, body, done], edges: [
    createEdge(loop.id, 'body', body.id), createEdge(loop.id, 'done', done.id),
    createEdge(body.id, 'default', loop.id), createEdge(body.id, 'default', done.id),
  ] }
  expect(loopRegions(graph, new Map([[body.id, { width: 250, height: 150 }]]))).toEqual([
    { id: loop.id, name: loop.name, x: 376, y: 368, width: 298, height: 202 },
  ])
})

it('does not render an empty loop body region', () => {
  const base = createDefaultTemplate()
  const loop = createNode('for-each', { x: 100, y: 100 })
  expect(loopRegions({ ...base, nodes: [loop], edges: [] }, new Map())).toEqual([])
})
