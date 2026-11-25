import { describe, expect, it } from 'vitest'
import { routedEdgePath } from './edge-route.ts'

describe('routedEdgePath', () => {
  const points = [{ x: 100, y: 40 }, { x: 180, y: 40 }, { x: 180, y: 140 }, { x: 300, y: 140 }]
  it('renders the ELK route with rounded corners and places insertion at its midpoint', () => {
    const route = routedEdgePath(points, points[0]!, points.at(-1)!)!
    expect(route[0]).toContain('L 172,40 Q 180,40 180,48')
    expect(route[0]).toContain('L 300,140')
    expect(route.slice(1)).toEqual([180, 110])
  })
  it('falls back after dragging a node or changing its handles', () => {
    expect(routedEdgePath(points, { x: 140, y: 40 }, points.at(-1)!)).toBeUndefined()
    expect(routedEdgePath(points, points[0]!, { x: 300, y: 180 })).toBeUndefined()
  })
  it('ignores old bend-only routes, diagonals and invalid coordinates', () => {
    expect(routedEdgePath(points.slice(1, -1), points[0]!, points.at(-1)!)).toBeUndefined()
    expect(routedEdgePath([points[0]!, points.at(-1)!], points[0]!, points.at(-1)!)).toBeUndefined()
    expect(routedEdgePath([{ x: NaN, y: 0 }, points.at(-1)!], points[0]!, points.at(-1)!)).toBeUndefined()
  })
  it('handles straight routes and repeated points without invalid path commands', () => {
    const end = { x: 300, y: 40 }
    expect(routedEdgePath([points[0]!, points[0]!, end], points[0]!, end)).toEqual(['M 100,40 L 300,40', 200, 40])
  })
})
