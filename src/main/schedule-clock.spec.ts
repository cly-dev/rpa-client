import { describe, expect, it, vi } from 'vitest'
import { ClientScheduleClock, scheduleMatches, type ClientScheduleRule } from './schedule-clock.ts'

const interval: ClientScheduleRule = {
  id: 'schedule-1', kind: 'interval', intervalMinutes: 5,
  hour: null, minute: null, weekday: null, timezone: 'Asia/Shanghai',
  createdAt: '2026-10-19T01:00:20.000Z', enabled: true,
}

describe('client schedule clock', () => {
  it('matches fixed intervals from the first complete minute after creation', () => {
    expect(scheduleMatches(interval, Date.parse('2026-10-19T01:01:00.000Z'))).toBe(true)
    expect(scheduleMatches(interval, Date.parse('2026-10-19T01:06:00.000Z'))).toBe(true)
    expect(scheduleMatches(interval, Date.parse('2026-10-19T01:05:00.000Z'))).toBe(false)
  })

  it('emits only once per occurrence and catches up only within five minutes', () => {
    const due = vi.fn()
    const clock = new ClientScheduleClock(due)
    clock.sync([interval], Date.parse('2026-10-19T01:06:30.000Z'))
    clock.tick(Date.parse('2026-10-19T01:06:45.000Z'))
    expect(due).toHaveBeenCalledTimes(1)
    expect(due).toHaveBeenCalledWith('schedule-1', '2026-10-19T01:06:00.000Z')
    clock.tick(Date.parse('2026-10-19T01:07:01.000Z'))
    expect(due).toHaveBeenCalledTimes(2)
    clock.acknowledge('schedule-1', '2026-10-19T01:06:00.000Z')
    clock.tick(Date.parse('2026-10-19T01:07:20.000Z'))
    expect(due).toHaveBeenCalledTimes(2)
    clock.tick(Date.parse('2026-10-19T01:11:20.000Z'))
    expect(due).toHaveBeenCalledTimes(3)
  })

  it('matches daily and weekly times in the configured time zone', () => {
    const daily: ClientScheduleRule = { ...interval, kind: 'daily', intervalMinutes: null, hour: 9, minute: 10 }
    expect(scheduleMatches(daily, Date.parse('2026-10-19T01:10:00.000Z'))).toBe(true)
    const weekly: ClientScheduleRule = { ...daily, kind: 'weekly', weekday: 1 }
    expect(scheduleMatches(weekly, Date.parse('2026-10-19T01:10:00.000Z'))).toBe(true)
    expect(scheduleMatches(weekly, Date.parse('2026-10-20T01:10:00.000Z'))).toBe(false)
  })
})
