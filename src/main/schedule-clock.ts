export interface ClientScheduleRule {
  readonly id: string
  readonly kind: 'interval' | 'daily' | 'weekly'
  readonly intervalMinutes: number | null
  readonly hour: number | null
  readonly minute: number | null
  readonly weekday: number | null
  readonly timezone: string
  readonly createdAt: string
  readonly enabled: boolean
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function scheduleMatches(rule: ClientScheduleRule, timestamp: number): boolean {
  if (!Number.isFinite(timestamp) || timestamp % 60_000 !== 0) return false
  const created = Date.parse(rule.createdAt)
  if (!Number.isFinite(created)) return false
  const anchor = Math.ceil(created / 60_000) * 60_000
  if (timestamp < anchor) return false
  if (rule.kind === 'interval') return typeof rule.intervalMinutes === 'number' && rule.intervalMinutes > 0 && (timestamp - anchor) % (rule.intervalMinutes * 60_000) === 0
  if (rule.hour === null || rule.minute === null) return false
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: rule.timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(new Date(timestamp))
    const part = (type: string): string => parts.find(item => item.type === type)?.value ?? ''
    return Number(part('hour')) === rule.hour && Number(part('minute')) === rule.minute && (rule.kind === 'daily' || WEEKDAYS.indexOf(part('weekday')) === rule.weekday)
  } catch { return false }
}

export class ClientScheduleClock {
  private rules: readonly ClientScheduleRule[] = []
  private readonly lastSent = new Map<string, number>()
  private readonly acknowledged = new Set<string>()

  constructor(private readonly onDue: (id: string, scheduledAt: string) => void) {}

  sync(rules: readonly ClientScheduleRule[], now = Date.now()): void {
    this.rules = rules.filter(rule => rule.enabled)
    this.tick(now)
  }

  acknowledge(id: string, scheduledAt: string): void {
    const timestamp = Date.parse(scheduledAt)
    if (Number.isFinite(timestamp)) this.acknowledged.add(`${id}@${timestamp}`)
  }

  tick(now = Date.now()): void {
    const currentMinute = Math.floor(now / 60_000) * 60_000
    for (const rule of this.rules) {
      for (let minutesAgo = 0; minutesAgo <= 4; minutesAgo += 1) {
        const candidate = currentMinute - minutesAgo * 60_000
        if (!scheduleMatches(rule, candidate)) continue
        const key = `${rule.id}@${candidate}`
        if (!this.acknowledged.has(key) && (this.lastSent.get(key) === undefined || now - this.lastSent.get(key)! >= 30_000)) {
          this.lastSent.set(key, now)
          this.onDue(rule.id, new Date(candidate).toISOString())
        }
        break
      }
    }
    const oldest = currentMinute - 6 * 60_000
    for (const key of this.lastSent.keys()) if (Number(key.slice(key.lastIndexOf('@') + 1)) < oldest) this.lastSent.delete(key)
    for (const key of this.acknowledged) if (Number(key.slice(key.lastIndexOf('@') + 1)) < oldest) this.acknowledged.delete(key)
  }
}
