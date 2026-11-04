import { describe, expect, it, vi } from 'vitest'
import { ClientScheduleClock, nextScheduleOccurrence, scheduleMatches, type ClientScheduleRule } from './schedule-clock.ts'

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

  it('uses a past custom start as the interval phase without replaying before creation', () => {
    const rule = { ...interval, createdAt: '2026-10-19T04:20:00.000Z', startAt: '2026-10-18T01:00:00.000Z', intervalMinutes: 60 }
    expect(scheduleMatches(rule, Date.parse('2026-10-19T04:00:00.000Z'))).toBe(false)
    expect(nextScheduleOccurrence(rule, Date.parse('2026-10-19T04:20:00.000Z'))).toBe(Date.parse('2026-10-19T05:00:00.000Z'))
  })

  it('starts a future rule on time and stops after an optional end', () => {
    const rule = { ...interval, startAt: '2026-10-19T02:00:00.000Z', endAt: '2026-10-19T02:10:00.000Z' }
    expect(nextScheduleOccurrence(rule, Date.parse('2026-10-19T01:30:00.000Z'))).toBe(Date.parse('2026-10-19T02:00:00.000Z'))
    expect(scheduleMatches(rule, Date.parse('2026-10-19T02:10:00.000Z'))).toBe(true)
    expect(scheduleMatches(rule, Date.parse('2026-10-19T02:15:00.000Z'))).toBe(false)
    expect(nextScheduleOccurrence(rule, Date.parse('2026-10-19T02:11:00.000Z'))).toBeNull()
  })

  it('keeps running without an end time', () => {
    const rule = { ...interval, startAt: '2026-10-19T01:00:00.000Z', endAt: null }
    expect(nextScheduleOccurrence(rule, Date.parse('2026-10-21T01:02:00.000Z'))).toBe(Date.parse('2026-10-21T01:05:00.000Z'))
  })

  it('previews the first daily run after a future start time', () => {
    const daily: ClientScheduleRule = { ...interval, kind: 'daily', intervalMinutes: null, hour: 9, minute: 10, startAt: '2026-10-19T02:00:00.000Z' }
    expect(nextScheduleOccurrence(daily, Date.parse('2026-10-19T01:00:00.000Z'))).toBe(Date.parse('2026-10-20T01:10:00.000Z'))
  })
})
