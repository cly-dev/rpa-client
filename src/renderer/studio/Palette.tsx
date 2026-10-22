import type { DragEvent, ReactNode } from 'react'
import { NODE_CATALOG, PALETTE_TYPES } from '@graph/catalog.ts'
import type { NodeType } from '@graph/types.ts'

const MIME = 'application/x-cs-rpa-node'

export function Palette(): ReactNode {
  const startDrag = (type: NodeType, event: DragEvent<HTMLButtonElement>): void => {
    event.dataTransfer.setData(MIME, type)
    event.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <aside className="palette">
      <h2>节点</h2>
      <p>通用积木，拖到画布。浏览器动作和 Agent 都只是节点。</p>
      {PALETTE_TYPES.map(type => {
        const definition = NODE_CATALOG[type]
        return (
          <button
            key={type}
            type="button"
            className="palette-item"
            data-kind={definition.kind}
            draggable
            onDragStart={event => { startDrag(type, event) }}
          >
            <strong>{definition.title}</strong>
            <span>{definition.description}</span>
          </button>
        )
      })}
    </aside>
  )
}

export function readPaletteType(event: DragEvent): NodeType | undefined {
  const type = event.dataTransfer.getData(MIME)
  return PALETTE_TYPES.find(item => item === type)
}
