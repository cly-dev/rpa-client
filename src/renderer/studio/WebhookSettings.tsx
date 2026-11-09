import type { ReactNode } from 'react'
import type { WorkflowWebhookConfig } from '@graph/types.ts'
import { notificationContentError } from '@graph/webhook-body-template.ts'
import { WebhookTestButton } from './WebhookTestButton.tsx'
import { selectedWebhookDestinations, webhookDestinations } from '@graph/webhook-destinations.ts'

export function WebhookSettings({ value, workflowName, onChange, onClose }: {
  value?: WorkflowWebhookConfig
  workflowName: string
  onChange: (next: WorkflowWebhookConfig) => void
  onClose: () => void
}): ReactNode {
  const message = value?.messageTemplate ?? ''
  const error = notificationContentError(message)
  const destinations = value?.destinations ?? (webhookDestinations(value).length ? webhookDestinations(value) : [{ id: 'default', name: '默认 Webhook', url: '' }])
  const patch = (next: Partial<WorkflowWebhookConfig>): void => {
    onChange({ ...value, url: value?.url ?? '', messageTemplate: message, provider: 'dingtalk', ...next })
  }
  const updateDestinations = (next: typeof destinations): void => { patch({ destinations: next, url: next[0]?.url ?? '' }) }
  const selectedFinished = selectedWebhookDestinations(value, value?.onFinishedDestinationIds).map(item => item.id)
  return <div className="context-overlay" role="presentation" onClick={onClose}>
    <section className="context-panel workflow-webhook-panel" role="dialog" aria-label="Webhook 通知设置" onClick={event => { event.stopPropagation() }}>
      <div className="context-panel-header webhook-panel-heading"><div><span className="webhook-eyebrow">流程通知设置</span><h2>钉钉机器人</h2><p>先添加通知目标，再到节点中选择发送给谁。</p></div><button type="button" aria-label="关闭" onClick={onClose}>×</button></div>
      {value?.provider === 'generic' && value.bodyTemplate?.trim() ? <p className="webhook-panel-warning">此流程原有通用 Webhook 配置；修改设置后会切换为钉钉机器人通知。</p> : null}
      <section className="webhook-settings-section" aria-label="Webhook 目标">
        <div className="webhook-section-heading"><div><h3>通知目标 <span>{destinations.length}</span></h3><p>一次通知可勾选多个目标，系统会分别投递与重试。</p></div><button type="button" className="webhook-add-button" onClick={() => { updateDestinations([...destinations, { id: crypto.randomUUID(), name: `Webhook ${destinations.length + 1}`, url: '' }]) }}>＋ 添加目标</button></div>
        {destinations.length === 0 ? <p className="webhook-empty-state">暂无通知目标，点击“添加目标”开始配置。</p> : destinations.map((destination, index) => <div className="webhook-destination-card" key={destination.id}>
          <div className="webhook-destination-heading"><span className="webhook-destination-index">{index + 1}</span><strong>{destination.name.trim() || `Webhook ${index + 1}`}</strong><span className={destination.url.trim() ? 'webhook-destination-state is-ready' : 'webhook-destination-state'}>{destination.url.trim() ? '已填写地址' : '待填写地址'}</span><button type="button" className="webhook-remove-button" onClick={() => { updateDestinations(destinations.filter(item => item.id !== destination.id)) }} aria-label={`删除 ${destination.name || `Webhook ${index + 1}`}`}>删除</button></div>
          <div className="webhook-destination-fields"><label>目标名称<input value={destination.name} placeholder="例如：客服群" onChange={event => { updateDestinations(destinations.map(item => item.id === destination.id ? { ...item, name: event.target.value } : item)) }} /></label><label>Webhook 地址<input type="url" value={destination.url} placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." onChange={event => { updateDestinations(destinations.map(item => item.id === destination.id ? { ...item, url: event.target.value } : item)) }} /></label></div>
          <div className="webhook-destination-footer"><span>保存前可单独测试此目标</span><WebhookTestButton url={destination.url} prefixTemplate={message} messageTemplate="" workflowName={workflowName} /></div>
        </div>)}
        <p className="webhook-section-footnote">支持钉钉机器人的关键词或 IP 白名单安全方式；加签密钥暂未接入。</p>
      </section>
      <section className="webhook-settings-section" aria-label="流程结束通知"><div className="webhook-section-heading"><div><h3>流程结束通知</h3><p>成功、失败、取消或中断时发送。</p></div><label className="webhook-switch"><input type="checkbox" checked={value?.onFinished === true} onChange={event => { patch({ onFinished: event.target.checked }) }} /><span>{value?.onFinished ? '已开启' : '未开启'}</span></label></div>
        {value?.onFinished ? <div className="webhook-target-choices"><span>发送到（可多选）</span>{destinations.map(destination => <label className={selectedFinished.includes(destination.id) ? 'webhook-target-chip is-selected' : 'webhook-target-chip'} key={destination.id}><input type="checkbox" checked={selectedFinished.includes(destination.id)} onChange={event => { patch({ onFinishedDestinationIds: event.target.checked ? [...selectedFinished, destination.id] : selectedFinished.filter(id => id !== destination.id) }) }} />{destination.name || destination.url || '未命名 Webhook'}</label>)}</div> : null}
      </section>
      <section className="webhook-settings-section" aria-label="默认通知前缀"><div className="webhook-section-heading"><div><h3>默认通知前缀</h3><p>自动拼接到每条通知正文前；留空则不添加。</p></div></div><label className="webhook-prefix-field"><textarea aria-label="默认钉钉通知前缀" spellCheck={false} value={message} placeholder={'例如：客服告警 · {{event.workflowName}}'} onChange={event => { patch({ messageTemplate: event.target.value }) }} /></label><p className="webhook-section-footnote">支持 {'{{event.workflowName}}'}、{'{{event.node.name}}'}、{'{{inputs.字段名}}'} 和 {'{{变量名}}'} 等变量。</p>{error ? <p className="webhook-body-error" role="alert">{error}</p> : null}</section>
      <p className="webhook-panel-footnote">节点通知请在对应节点配置。服务端默认仅发送到公网地址；内网地址需管理员启用 RPA_WEBHOOK_ALLOW_PRIVATE。</p>
    </section>
  </div>
}
