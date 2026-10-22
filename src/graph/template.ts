import { defaultBindings, defaultConfig, defaultExecution, defaultName, newId } from './catalog.ts'
import type { NodeConfig, NodeType, ValueBinding, WorkflowEdge, WorkflowGraph, WorkflowNode } from './types.ts'

function node(
  id: string,
  type: NodeType,
  x: number,
  y: number,
  extras: { name?: string; config?: NodeConfig; inputBindings?: Readonly<Record<string, ValueBinding>> } = {},
): WorkflowNode {
  return {
    id,
    type,
    name: extras.name ?? defaultName(type),
    position: { x, y },
    inputBindings: extras.inputBindings ?? defaultBindings(type),
    config: extras.config ?? defaultConfig(type),
    execution: defaultExecution(),
  }
}

function edge(sourceNodeId: string, sourcePort: string, targetNodeId: string): WorkflowEdge {
  return {
    id: newId('edge'),
    sourceNodeId,
    sourcePort,
    targetNodeId,
  }
}

/** Example line built from generic RPA bricks: open → extract → click → decide → type or wait. */
export function createDefaultTemplate(): WorkflowGraph {
  const start = newId('start')
  const pageAction = newId('page-action')
  const end = newId('end')

  return {
    workflowId: newId('wf'),
    name: '示例：页面操作',
    version: 1,
    entryNodeId: start,
    nodes: [
      node(start, 'start', 80, 240, { config: { type: 'start', url: 'https://example.com' } }),
      node(pageAction, 'page-action', 360, 240, {
        name: '页面操作',
        config: { type: 'page-action', steps: [
          { type: 'extract', selector: 'h1', outputName: 'title', mode: 'text' },
        ] },
      }),
      node(end, 'end', 720, 240, { name: '结束' }),
    ],
    edges: [
      edge(start, 'default', pageAction),
      edge(pageAction, 'default', end),
    ],
  }
}
