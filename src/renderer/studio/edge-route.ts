import type { NodePosition } from '@graph/types.ts'

/** Use saved ELK routes only while they still belong to the current handles. */
export function routedEdgePath(
  points: readonly NodePosition[] | undefined,
  source: NodePosition,
  target: NodePosition,
): readonly [string, number, number] | undefined {
  if (!points || points.length < 2 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return undefined
  const close = (a: NodePosition, b: NodePosition): boolean => Math.abs(a.x - b.x) <= 12 && Math.abs(a.y - b.y) <= 2
  if (!close(points[0]!, source) || !close(points.at(-1)!, target)) return undefined
  const route = [source, ...points.slice(1, -1), target].filter((point, index, all) => index === 0 || point.x !== all[index - 1]!.x || point.y !== all[index - 1]!.y)
  // Legacy saved routes contained only bend points. Fall back rather than
  // drawing them diagonally or stretching stale routes after a card is moved.
  if (route.some((point, index) => index > 0 && Math.abs(point.x - route[index - 1]!.x) > 0.1 && Math.abs(point.y - route[index - 1]!.y) > 0.1)) return undefined
  let path = `M ${source.x},${source.y}`
  const lengths = route.slice(1).map((point, index) => Math.hypot(point.x - route[index]!.x, point.y - route[index]!.y))
  for (let index = 1; index < route.length - 1; index += 1) {
    const previous = route[index - 1]!
    const point = route[index]!
    const next = route[index + 1]!
    const radius = Math.min(8, lengths[index - 1]! / 2, lengths[index]! / 2)
    const before = { x: point.x + (previous.x - point.x) * radius / lengths[index - 1]!, y: point.y + (previous.y - point.y) * radius / lengths[index - 1]! }
    const after = { x: point.x + (next.x - point.x) * radius / lengths[index]!, y: point.y + (next.y - point.y) * radius / lengths[index]! }
    path += ` L ${before.x},${before.y} Q ${point.x},${point.y} ${after.x},${after.y}`
  }
  path += ` L ${target.x},${target.y}`
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!
    if (remaining <= length && length > 0) {
      const a = route[index]!
      const b = route[index + 1]!
      return [path, a.x + (b.x - a.x) * remaining / length, a.y + (b.y - a.y) * remaining / length]
    }
    remaining -= length
  }
  return [path, source.x, source.y]
}
