import { useState, type ReactNode } from 'react'
import type { WorkflowGraph, WorkflowLlmConfig } from '@graph/types.ts'

const DEFAULT_LLM: WorkflowLlmConfig = { id: 'default-llm', name: '默认 AI', enabled: false, model: '', baseUrl: '', chatPath: '/v1/chat/completions', apiKey: '', maxTokens: 2048 }

export function LlmPanel({ graph, onChange }: { graph: WorkflowGraph; onChange: (configs: readonly WorkflowLlmConfig[]) => void }): ReactNode {
  const [collapsed, setCollapsed] = useState(true)
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState<string>()
  const configs = graph.llms ?? (graph.llm === undefined ? [DEFAULT_LLM] : [{ ...DEFAULT_LLM, ...graph.llm }])
  const [selectedId, setSelectedId] = useState(configs[0]?.id ?? DEFAULT_LLM.id)
  const config = configs.find(item => item.id === selectedId) ?? configs[0] ?? DEFAULT_LLM
  const patch = (value: Partial<WorkflowLlmConfig>): void => { onChange(configs.map(item => item.id === config.id ? { ...item, ...value } : item)) }
  const addConfig = (): void => { const next = { ...DEFAULT_LLM, id: `llm-${Date.now()}`, name: `AI 配置 ${configs.length + 1}` }; onChange([...configs, next]); setSelectedId(next.id) }
  const removeConfig = (): void => { if (configs.length <= 1) return; const next = configs.filter(item => item.id !== config.id); onChange(next); setSelectedId(next[0].id) }
  return <aside className={`llm-panel${collapsed ? ' is-collapsed' : ''}`}>
    <button type="button" className="llm-toggle" onClick={() => { setCollapsed(value => !value) }} aria-label={collapsed ? '展开 AI 配置' : '收起 AI 配置'}>{collapsed ? '›' : '‹'}</button>
    {collapsed ? <button type="button" className="llm-icon" onClick={() => { setCollapsed(false) }} aria-label="展开 AI 配置">✦</button> : <>
      <div className="llm-title"><span className="ai-badge">✦</span><div><h2>AI 配置</h2><p>全局模型与调用参数</p></div></div>
      <div className="llm-config-list"><select value={config.id} onChange={event => { setSelectedId(event.target.value) }}>{configs.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button type="button" onClick={addConfig}>＋新增</button><button type="button" onClick={removeConfig} disabled={configs.length <= 1}>删除</button></div>
      <label>配置名称<input value={config.name} onChange={event => { patch({ name: event.target.value }) }} /></label>
      <label className="llm-switch"><input type="checkbox" checked={config.enabled} onChange={event => { patch({ enabled: event.target.checked }) }} />启用全局 AI</label>
      <label>模型<input value={config.model} onChange={event => { patch({ model: event.target.value }) }} placeholder="例如 gpt-4o-mini" /></label>
      <label>API 地址<input value={config.baseUrl} onChange={event => { patch({ baseUrl: event.target.value }) }} placeholder="https://api.example.com" /></label>
      <label>对话接口路径<input value={config.chatPath} onChange={event => { patch({ chatPath: event.target.value }) }} placeholder="/v1/chat/completions 或完整 URL" /></label>
      <label>API Key（可选）<input type="password" value={config.apiKey} onChange={event => { patch({ apiKey: event.target.value }) }} placeholder="本地模型或内网服务可留空" /></label>
      <label>最大 Token<input type="number" min={1} value={config.maxTokens} onChange={event => { patch({ maxTokens: Number(event.target.value) }) }} /></label>
      <button type="button" className="llm-test-button" disabled={testing} onClick={() => { setTesting(true); setTestMessage(undefined); void window.studio?.testLlm(config).then(result => { setTestMessage(result.message) }).catch(error => { setTestMessage(error instanceof Error ? error.message : '测试失败') }).finally(() => { setTesting(false) }) }}>{testing ? '测试中…' : '测试联通性'}</button>
      {testMessage !== undefined ? <p className="llm-test-message">{testMessage}</p> : null}
      <p className="llm-note">节点只需选择使用全局 AI，提示词在节点中单独配置。</p>
    </>}
  </aside>
}
