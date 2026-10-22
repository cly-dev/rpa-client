import { useState, type ReactNode } from 'react'
import { notificationContentError, validDingTalkRobotUrl } from '@graph/webhook-body-template.ts'
import { RPA_SERVICE_URL, testDingTalkWebhook } from '../workflow-api.ts'

export function WebhookTestButton({ url, messageTemplate, workflowName, nodeName }: {
  url: string
  messageTemplate: string
  workflowName: string
  nodeName?: string
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const error = notificationContentError(messageTemplate)
  const addressValid = validDingTalkRobotUrl(url)
  const test = async (): Promise<void> => {
    setBusy(true)
    setResult('')
    try {
      const response = await testDingTalkWebhook(RPA_SERVICE_URL, { url, messageTemplate, workflowName, nodeName })
      setResult(response.message)
    } catch (cause) { setResult(cause instanceof Error ? cause.message : '测试发送失败') }
    finally { setBusy(false) }
  }
  return <div className="webhook-test-action"><button type="button" disabled={busy || !addressValid || error !== undefined} onClick={() => { void test() }}>{busy ? '发送中…' : '发送测试通知'}</button>{!addressValid ? <span>请先填写有效的钉钉机器人地址</span> : error ? <span>{error}</span> : null}{result ? <span role="status">{result}</span> : null}</div>
}
