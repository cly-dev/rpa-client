import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'

const STORAGE_KEY = 'rpa.workflow-running-bubble-position'
const EDGE_GAP = 16

interface Position {
  readonly x: number
  readonly y: number
}

interface Props {
  readonly waitingApproval: boolean
  readonly currentNodeName?: string
  readonly completed: number
  readonly total: number
  readonly onOpen?: () => void
  readonly onStop: () => void
  readonly stopping?: boolean
}

function initialPosition(): Position {
  const fallback = { x: Math.max(EDGE_GAP, window.innerWidth - 390), y: 80 }
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '') as Partial<Position>
    if (typeof saved.x === 'number' && typeof saved.y === 'number') return { x: saved.x, y: saved.y }
  } catch { /* Ignore stale or invalid saved positions. */ }
  return fallback
}

export function WorkflowRunningBubble({ waitingApproval, currentNodeName, completed, total, onOpen, onStop, stopping = false }: Props): ReactNode {
  const bubbleRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean }>()
  const suppressClick = useRef(false)
  const [position, setPosition] = useState<Position>(initialPosition)
  const [dragging, setDragging] = useState(false)

  const clamp = (next: Position): Position => {
    const rect = bubbleRef.current?.getBoundingClientRect()
    const width = rect?.width ?? 360
    const height = rect?.height ?? 48
    return {
      x: Math.max(EDGE_GAP, Math.min(next.x, window.innerWidth - width - EDGE_GAP)),
      y: Math.max(EDGE_GAP, Math.min(next.y, window.innerHeight - height - EDGE_GAP)),
    }
  }

  useEffect(() => {
    const keepVisible = (): void => { setPosition(current => clamp(current)) }
    window.addEventListener('resize', keepVisible)
    keepVisible()
    return () => { window.removeEventListener('resize', keepVisible) }
  }, [])

  const startDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button') !== null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: position.x, originY: position.y, moved: false }
    setDragging(true)
  }

  const moveDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === undefined || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
    setPosition(clamp({ x: drag.originX + dx, y: drag.originY + dy }))
  }

  const finishDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === undefined || drag.pointerId !== event.pointerId) return
    const finalPosition = clamp({ x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY })
    suppressClick.current = drag.moved
    dragRef.current = undefined
    setDragging(false)
    setPosition(finalPosition)
    event.currentTarget.releasePointerCapture(event.pointerId)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(finalPosition))
  }

  return <div
    ref={bubbleRef}
    className={`workflow-running-bubble${waitingApproval ? ' is-waiting' : ''}${dragging ? ' is-dragging' : ''}`}
    style={{ left: position.x, top: position.y }}
    role="group"
    aria-label="流程正在运行，可拖动位置"
    onPointerDown={startDrag}
    onPointerMove={moveDrag}
    onPointerUp={finishDrag}
    onPointerCancel={finishDrag}
  >
    <span className="workflow-running-bubble-icon" aria-hidden="true"><i /></span>
    <span className="workflow-running-bubble-copy">
      <strong>{stopping ? '正在停止流程' : waitingApproval ? '流程等待审批' : '流程正在运行'}</strong>
      <small>{currentNodeName ?? '正在准备流程…'}{total > 0 ? ` · ${completed}/${total}` : ''}</small>
    </span>
    <span className="workflow-running-bubble-actions">
      {onOpen === undefined ? null : <button type="button" onClick={() => {
        if (suppressClick.current) { suppressClick.current = false; return }
        onOpen()
      }}>查看日志</button>}
      <button type="button" className="is-stop" disabled={stopping} onClick={onStop}>{stopping ? '停止中…' : '停止'}</button>
    </span>
  </div>
}
