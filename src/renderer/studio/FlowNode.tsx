import { useEffect, type ReactNode } from 'react'
import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from '@xyflow/react'
import { NODE_CATALOG } from '@graph/catalog.ts'
import type { NodeConfig, NodeRunStatus, NodeType } from '@graph/types.ts'
import { switchCaseLabel } from '@graph/switch-cases.ts'

export interface FlowNodeData extends Record<string, unknown> {
  readonly type: NodeType
  readonly name: string
  readonly status: NodeRunStatus
  readonly config?: NodeConfig
  readonly bindings?: readonly string[]
  readonly connectedPorts?: readonly string[]
  readonly issues?: readonly string[]
  readonly onDelete?: (id: string) => void
}

export type StudioFlowNode = Node<FlowNodeData, 'studio'>

export function FlowNode({ id, data, selected }: NodeProps<StudioFlowNode>): ReactNode {
  const updateNodeInternals = useUpdateNodeInternals()
  const definition = NODE_CATALOG[data.type]
  const switchConfig = data.config?.type === 'switch' ? data.config : undefined
  const imageConfig = data.config?.type === 'image-recognition' ? data.config : undefined
  const switchOutputs = switchConfig === undefined ? [] : [
    ...switchConfig.cases.map((name, index) => ({
      name: `case-${index}`,
      label: switchConfig.mode === 'ai' ? name.trim() || `场景 ${index + 1}` : switchCaseLabel(switchConfig, index),
      detail: switchConfig.mode === 'ai' ? switchConfig.casePrompts?.[index]?.trim() || '尚未填写判断要求' : '精确值匹配',
      otherwise: false,
    })),
    { name: 'else', label: '否则', detail: switchConfig.mode === 'ai' ? '所有场景均不符合时进入' : '没有匹配值时进入', otherwise: true },
  ]
  const imageOutputs = imageConfig === undefined ? [] : [
    ...imageConfig.cases.map((item, index) => ({
      name: `case-${item.id}`,
      label: item.name.trim() || `场景 ${index + 1}`,
      detail: item.prompt.trim() || '尚未填写判断要求',
      otherwise: false,
    })),
    { name: 'else', label: '否则', detail: '所有图片场景均不符合时进入', otherwise: true },
  ]
  const decisionOutputs = switchConfig !== undefined ? switchOutputs : imageOutputs
  const outputs = decisionOutputs.length > 0 ? decisionOutputs : definition.flowOutputs
  const outputSignature = outputs.map(port => port.name).join('|')
  useEffect(() => {
    // A dynamic branch can add, remove or reorder handles without changing the
    // node's measured size. React Flow otherwise keeps stale handle bounds and
    // temporarily stops rendering edges that refer to those handles.
    updateNodeInternals(id)
  }, [id, outputSignature, updateNodeInternals])
  const canDelete = data.type !== 'start' && data.onDelete !== undefined
  return (
    <div className={`flow-node${decisionOutputs.length === 0 ? '' : ' flow-node--switch'}`} data-kind={definition.kind} data-selected={selected ? 'true' : undefined} data-status={data.status} data-invalid={data.issues?.length ? 'true' : undefined}>
      {definition.acceptsIncoming ? <Handle type="target" position={Position.Left} /> : null}
      {canDelete ? (
        <button
          type="button"
          className="flow-node-delete nodrag nopan"
          aria-label={`删除 ${data.name}`}
          onMouseDown={event => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={event => {
            event.preventDefault()
            event.stopPropagation()
            data.onDelete?.(id)
          }}
        >
          删除
        </button>
      ) : null}
      <span className="flow-node-type">{definition.title}</span>
      <strong>{data.name}</strong>
      {data.issues?.length ? <span className="flow-node-issues" title={data.issues.join('\n')} aria-label={`${data.issues.length} 项待处理：${data.issues.join('；')}`}>⚠ {data.issues[0]}{data.issues.length > 1 ? ` 等 ${data.issues.length} 项` : ''}</span> : null}
      {data.type === 'start' ? <span className="flow-node-start-hint">{data.connectedPorts?.includes('default') ? '拖动右侧圆点可改接下一节点' : '拖动或点击右侧圆点连接下一节点'}</span> : null}
      {data.bindings?.map(binding => <span className="flow-node-binding" key={binding}>{binding}</span>)}
      {decisionOutputs.length > 0 ? <>
        <div className="flow-node-switch-summary"><span>{imageConfig !== undefined ? '✦ AI 图片识别' : switchConfig?.mode === 'ai' ? '✦ AI 场景判断' : '＝ 精确值匹配'}</span><small>{decisionOutputs.length - 1} 个场景</small></div>
        <ol className="flow-node-switch-branches">
          {decisionOutputs.map((port, index) => <li className="flow-node-switch-branch" data-otherwise={port.otherwise ? 'true' : undefined} data-connected={data.connectedPorts?.includes(port.name) ? 'true' : undefined} key={port.name}>
            <span className="flow-node-switch-index">{port.otherwise ? '↳' : String(index + 1).padStart(2, '0')}</span>
            <span className="flow-node-switch-copy"><strong title={port.label}>{port.label}</strong><small title={port.detail}>{port.detail}</small></span>
            <span className="flow-node-switch-connection">{data.connectedPorts?.includes(port.name) ? '已连接' : '待连接'}</span>
            <Handle type="source" position={Position.Right} id={port.name} />
          </li>)}
        </ol>
      </> : outputs.map((port, index) => (
        <Handle
          key={port.name}
          type="source"
          position={Position.Right}
          id={port.name}
          style={outputs.length > 1 ? { top: 28 + index * 18 } : undefined}
        />
      ))}
      {decisionOutputs.length === 0 && outputs.length > 1 ? (
        <ol className="flow-node-ports">
          {outputs.map(port => (
            <li key={port.name}>{port.label}</li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
