import type { ReactNode } from 'react'
import type { WorkflowWebhookConfig } from '@graph/types.ts'
import { notificationContentError } from '@graph/webhook-body-template.ts'
import { WebhookTestButton } from './WebhookTestButton.tsx'

export function WebhookSettings({ value, workflowName, onChange, onClose }: {
  value?: WorkflowWebhookConfig
  workflowName: string
  onChange: (next: WorkflowWebhookConfig) => void
  onClose: () => void
}): ReactNode {
  const message = value?.messageTemplate ?? ''
  const error = notificationContentError(message)
  const patch = (next: Partial<WorkflowWebhookConfig>): void => {
    onChange({ url: value?.url ?? '', onFinished: value?.onFinished, messageTemplate: message, provider: 'dingtalk', ...next })
  }
  return <div className="context-overlay" role="presentation" onClick={onClose}>
    <section className="context-panel workflow-webhook-panel" role="dialog" aria-label="Webhook 通知设置" onClick={event => { event.stopPropagation() }}>
      <div className="context-panel-header"><h2>钉钉通知</h2><button type="button" aria-label="关闭" onClick={onClose}>×</button></div>
      <p>整个流程共用一个钉钉机器人地址。只需填写通知文字，系统会自动组装发送格式。</p>
      {value?.provider === 'generic' && value.bodyTemplate?.trim() ? <p className="properties-hint">此流程原有通用 Webhook 配置；修改下方设置后会切换为钉钉机器人通知。</p> : null}
      <label>钉钉机器人 Webhook 地址<input type="url" value={value?.url ?? ''} placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." onChange={event => { patch({ url: event.target.value }) }} /></label>
      <p className="properties-hint">请粘贴完整地址。当前支持关键词或 IP 白名单安全方式；加签机器人需要密钥，暂未接入。</p>
      <label className="node-notification-option"><input type="checkbox" checked={value?.onFinished === true} onChange={event => { patch({ onFinished: event.target.checked }) }} />流程结束时通知（成功、失败、取消或中断）</label>
      <label>默认通知内容<textarea aria-label="默认钉钉通知内容" spellCheck={false} value={message} placeholder={'RPA 通知：{{event.workflowName}} / {{event.eventType}}\n{{event.message}}'} onChange={event => { patch({ messageTemplate: event.target.value }) }} /></label>
      <p className="properties-hint">留空时使用系统默认文案；每个节点都可单独覆盖。支持 {'{{event.workflowName}}'}、{'{{event.node.name}}'}、{'{{inputs.字段名}}'}、{'{{变量名}}'} 等变量。</p>
      {error ? <p className="webhook-body-error" role="alert">{error}</p> : null}
      <WebhookTestButton url={value?.url ?? ''} messageTemplate={message} workflowName={workflowName} />
      <p>节点的成功、失败及审批通知，请在对应节点的配置面板勾选。服务端默认仅发送到公网地址；内网地址需管理员启用 RPA_WEBHOOK_ALLOW_PRIVATE。</p>
    </section>
  </div>
}
