/**
 * The time helpers across a real clock change. This file pins the zone to Europe/London, where
 * clocks go back an hour at 02:00 on Sunday 25 October 2026 and forward at 01:00 on Sunday
 * 29 March 2026. Node applies a change to `process.env.TZ` at once, and the first test proves the
 * zone is in force, so the rest cannot pass by accident in a zone without clock changes.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { addDays, dayBounds, eventSpan, formatTimeRange, isoDay, moveSpan, overlapsDay, parseIsoDay, toEventDateTime } from './time'

const HOUR = 60 * 60 * 1000

beforeAll(() => {
    process.env.TZ = 'Europe/London'
})

describe('in Europe/London', () => {
    it('is in a zone whose clocks go back on 25 October 2026', () => {
        expect(new Date(2026, 9, 24, 12).getTimezoneOffset()).toBe(-60)
        expect(new Date(2026, 9, 26, 12).getTimezoneOffset()).toBe(0)
    })

    it('adds calendar days, not 24-hour blocks, across the autumn change', () => {
        const start = new Date(2026, 9, 24, 9)
        const moved = addDays(start, 2)
        expect(isoDay(moved)).toBe('2026-10-26')
        expect(moved.getHours()).toBe(9)
        expect(moved.getTime() - start.getTime()).toBe(49 * HOUR)
    })

    it('adds calendar days across the spring change', () => {
        const start = new Date(2026, 2, 28, 9)
        const moved = addDays(start, 1)
        expect(moved.getHours()).toBe(9)
        expect(moved.getTime() - start.getTime()).toBe(23 * HOUR)
    })

    it('makes the day of the change 25 hours long', () => {
        const { start, end } = dayBounds('2026-10-25')
        expect(end.getTime() - start.getTime()).toBe(25 * HOUR)
        expect(isoDay(end)).toBe('2026-10-26')
    })

    it('writes the summer and winter offsets', () => {
        expect(toEventDateTime(new Date(2026, 9, 24, 9), false, 'Europe/London').dateTime).toBe('2026-10-24T09:00:00+01:00')
        expect(toEventDateTime(new Date(2026, 9, 26, 9), false, 'Europe/London').dateTime).toBe('2026-10-26T09:00:00+00:00')
    })

    it('keeps the wall-clock times of a timed event moved over the change', () => {
        const span = { start: new Date(2026, 9, 24, 9), end: new Date(2026, 9, 24, 10), allDay: false }
        const moved = moveSpan(span, { start: new Date(2026, 9, 26, 9), allDay: false })
        expect(moved.end.getHours()).toBe(10)
    })

    it('keeps an all-day event that spans the change ending at midnight', () => {
        const span = { start: parseIsoDay('2026-10-23'), end: parseIsoDay('2026-10-25'), allDay: true }
        const moved = moveSpan(span, { start: new Date(2026, 9, 24, 15), allDay: true })
        expect(isoDay(moved.start)).toBe('2026-10-24')
        expect(isoDay(moved.end)).toBe('2026-10-26')
        expect(moved.end.getHours()).toBe(0)
        expect(moved.end.getTime() - moved.start.getTime()).toBe(49 * HOUR)
    })

    it('reads an all-day event over the change by its dates', () => {
        const span = eventSpan({ start: { date: '2026-10-24' }, end: { date: '2026-10-26' } })
        expect(overlapsDay(span, '2026-10-25')).toBe(true)
        expect(overlapsDay(span, '2026-10-26')).toBe(false)
    })

    it('writes the wall-clock times of an event during the repeated hour', () => {
        // 00:30 BST is 23:30 UTC and 02:30 GMT is 02:30 UTC: three hours that read as two.
        const span = eventSpan({ start: { dateTime: '2026-10-24T23:30:00Z' }, end: { dateTime: '2026-10-25T02:30:00Z' } })
        expect(span.end.getTime() - span.start.getTime()).toBe(3 * HOUR)
        expect(formatTimeRange(span, { hour12: false, day: '2026-10-25' })).toBe('00:30 to 02:30')
    })
})
