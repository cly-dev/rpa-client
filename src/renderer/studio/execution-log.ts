/** Keep execution-center and scheduled-run logs consistent and bounded. */
export function safeEventMessage(message: string, secrets: readonly string[] = []): string {
  if (message.startsWith('变量已更新：')) return '变量已更新（具体值不写入执行日志）'
  const produced = /^产出变量 (.+?) = /.exec(message)
  const safe = produced !== null ? `产出变量 ${produced[1]}（具体值不写入执行日志）` : message
  const redacted = secrets.reduce((result, secret) => secret.length > 0 ? result.split(secret).join('••••••') : result, safe)
  return redacted.length > 4_800 ? `${redacted.slice(0, 4_780)}…（日志已截断）` : redacted
}
