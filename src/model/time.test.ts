/**
 * The time helpers, in whatever zone the machine runs in. Every date is built from local
 * components, so each expectation holds in any zone. `time.dst.test.ts` pins Europe/London to show
 * the same code across a real clock change.
 */
import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../google/types'
import {
    addDays,
    dayBounds,
    eventSpan,
    eventsOnDay,
    formatTimeRange,
    isoDay,
    localTimeZone,
    moveSpan,
    overlapsDay,
    parseIsoDay,
    toEventDateTime,
    type EventSpan,
} from './time'

const HOUR = 60 * 60 * 1000

function timed(start: Date, end: Date): EventSpan {
    return { start, end, allDay: false }
}

function allDay(first: string, endExclusive: string): EventSpan {
    return { start: parseIsoDay(first), end: parseIsoDay(endExclusive), allDay: true }
}

type DayEvent = Pick<CalendarEvent, 'start' | 'end' | 'summary'>

function timedEvent(summary: string, start: Date, end: Date): DayEvent {
    return { summary, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }
}

function allDayEvent(summary: string, first: string, endExclusive: string): DayEvent {
    return { summary, start: { date: first }, end: { date: endExclusive } }
}

describe('isoDay and parseIsoDay', () => {
    it('writes the local calendar day, padded', () => {
        expect(isoDay(new Date(2026, 9, 12, 23, 59))).toBe('2026-10-12')
        expect(isoDay(new Date(2026, 0, 5, 0, 0))).toBe('2026-01-05')
    })

    it('reads a day as its local midnight', () => {
        const day = parseIsoDay('2026-10-12')
        expect(day.getTime()).toBe(new Date(2026, 9, 12).getTime())
        expect(isoDay(day)).toBe('2026-10-12')
    })

    it('round-trips every day of a year', () => {
        for (let date = new Date(2026, 0, 1); date.getFullYear() === 2026; date = addDays(date, 1)) {
            expect(isoDay(parseIsoDay(isoDay(date)))).toBe(isoDay(date))
        }
    })

    it('gives an invalid date for a string that is not a day', () => {
        expect(Number.isNaN(parseIsoDay('12/10/2026').getTime())).toBe(true)
        expect(Number.isNaN(parseIsoDay('').getTime())).toBe(true)
    })
})

describe('addDays', () => {
    it('keeps the wall-clock time across the end of October', () => {
        const moved = addDays(new Date(2026, 9, 24, 9, 30), 2)
        expect(isoDay(moved)).toBe('2026-10-26')
        expect([moved.getHours(), moved.getMinutes()]).toEqual([9, 30])
    })

    it('crosses months and years, both ways', () => {
        expect(isoDay(addDays(new Date(2026, 11, 31, 8), 1))).toBe('2027-01-01')
        expect(isoDay(addDays(new Date(2026, 2, 1, 8), -1))).toBe('2026-02-28')
        expect(isoDay(addDays(new Date(2028, 1, 28, 8), 1))).toBe('2028-02-29')
    })

    it('does not change the date it is given', () => {
        const date = new Date(2026, 9, 12, 9)
        addDays(date, 3)
        expect(isoDay(date)).toBe('2026-10-12')
    })
})

describe('dayBounds', () => {
    it('runs from local midnight to the next local midnight', () => {
        const { start, end } = dayBounds('2026-10-25')
        expect(start.getTime()).toBe(new Date(2026, 9, 25).getTime())
        expect(end.getTime()).toBe(new Date(2026, 9, 26).getTime())
    })
})

describe('eventSpan', () => {
    it('reads all-day dates as local midnights with an exclusive end', () => {
        const span = eventSpan({ start: { date: '2026-10-12' }, end: { date: '2026-10-15' } })
        expect(span).toEqual({ start: new Date(2026, 9, 12), end: new Date(2026, 9, 15), allDay: true })
    })

    it('reads timed values by their own offsets', () => {
        const span = eventSpan({
            start: { dateTime: '2026-10-12T09:00:00+01:00', timeZone: 'Europe/London' },
            end: { dateTime: '2026-10-12T10:30:00-04:00' },
        })
        expect(span.start.getTime()).toBe(Date.UTC(2026, 9, 12, 8, 0))
        expect(span.end.getTime()).toBe(Date.UTC(2026, 9, 12, 14, 30))
        expect(span.allDay).toBe(false)
    })

    it('reads an all-day end that is missing or not after the start as one day', () => {
        expect(eventSpan({ start: { date: '2026-10-12' }, end: {} }).end).toEqual(new Date(2026, 9, 13))
        expect(eventSpan({ start: { date: '2026-10-12' }, end: { date: '2026-10-12' } }).end).toEqual(new Date(2026, 9, 13))
    })

    it('reads a timed end before the start as no time', () => {
        const span = eventSpan({ start: { dateTime: '2026-10-12T09:00:00Z' }, end: { dateTime: '2026-10-12T08:00:00Z' } })
        expect(span.end.getTime()).toBe(span.start.getTime())
    })

    it('gives an event with no readable start a span that no day shows', () => {
        const span = eventSpan({ start: {}, end: {} })
        expect(Number.isNaN(span.start.getTime())).toBe(true)
        expect(overlapsDay(span, '2026-10-12')).toBe(false)
    })
})

describe('toEventDateTime', () => {
    it('writes an all-day value as the local date alone', () => {
        expect(toEventDateTime(new Date(2026, 9, 12, 15, 45), true, 'Europe/London')).toEqual({ date: '2026-10-12' })
    })

    it('writes a timed value as local time with the local offset and the zone', () => {
        const date = new Date(2026, 9, 12, 9, 0, 0)
        const value = toEventDateTime(date, false, 'Europe/London')
        expect(value.timeZone).toBe('Europe/London')
        expect(value.date).toBeUndefined()
        expect(value.dateTime).toMatch(/^2026-10-12T09:00:00[+-]\d{2}:\d{2}$/)
        expect(new Date(value.dateTime as string).getTime()).toBe(date.getTime())
    })

    it('round-trips through eventSpan', () => {
        const start = new Date(2026, 9, 12, 9, 15)
        const end = new Date(2026, 9, 12, 10, 45)
        const span = eventSpan({ start: toEventDateTime(start, false, 'UTC'), end: toEventDateTime(end, false, 'UTC') })
        expect(span).toEqual({ start, end, allDay: false })
        const days = eventSpan({ start: toEventDateTime(new Date(2026, 9, 12), true, 'UTC'), end: toEventDateTime(new Date(2026, 9, 14), true, 'UTC') })
        expect(days).toEqual(allDay('2026-10-12', '2026-10-14'))
    })
})

describe('overlapsDay', () => {
    it('shows an all-day event over several days on each of its days and no other', () => {
        const span = allDay('2026-10-12', '2026-10-15')
        expect(overlapsDay(span, '2026-10-11')).toBe(false)
        expect(overlapsDay(span, '2026-10-12')).toBe(true)
        expect(overlapsDay(span, '2026-10-13')).toBe(true)
        expect(overlapsDay(span, '2026-10-14')).toBe(true)
        expect(overlapsDay(span, '2026-10-15')).toBe(false)
    })

    it('does not show an event that ends exactly at midnight on the next day', () => {
        const span = timed(new Date(2026, 9, 12, 22), new Date(2026, 9, 13, 0))
        expect(overlapsDay(span, '2026-10-12')).toBe(true)
        expect(overlapsDay(span, '2026-10-13')).toBe(false)
    })

    it('shows an event that runs past midnight on both days', () => {
        const span = timed(new Date(2026, 9, 12, 22), new Date(2026, 9, 13, 2))
        expect(overlapsDay(span, '2026-10-12')).toBe(true)
        expect(overlapsDay(span, '2026-10-13')).toBe(true)
    })

    it('shows an event with no length on the day of its moment', () => {
        const atMidnight = timed(new Date(2026, 9, 13, 0), new Date(2026, 9, 13, 0))
        expect(overlapsDay(atMidnight, '2026-10-12')).toBe(false)
        expect(overlapsDay(atMidnight, '2026-10-13')).toBe(true)
        const atNine = timed(new Date(2026, 9, 12, 9), new Date(2026, 9, 12, 9))
        expect(overlapsDay(atNine, '2026-10-12')).toBe(true)
    })

    it('does not show an event that starts at the next midnight', () => {
        expect(overlapsDay(timed(new Date(2026, 9, 13, 0), new Date(2026, 9, 13, 1)), '2026-10-12')).toBe(false)
    })
})

describe('eventsOnDay', () => {
    const day = '2026-10-12'
    const garden = timedEvent('Garden', new Date(2026, 9, 12, 9), new Date(2026, 9, 12, 10))
    const kitchenLong = timedEvent('Kitchen', new Date(2026, 9, 12, 9), new Date(2026, 9, 12, 12))
    const beans = timedEvent('Beans', new Date(2026, 9, 12, 9), new Date(2026, 9, 12, 10))
    const early = timedEvent('Water the beans', new Date(2026, 9, 12, 7), new Date(2026, 9, 12, 7, 30))
    const holiday = allDayEvent('Holiday', '2026-10-11', '2026-10-14')
    const shed = allDayEvent('Shed', '2026-10-12', '2026-10-13')
    const yesterday = timedEvent('Yesterday', new Date(2026, 9, 11, 22), new Date(2026, 9, 12, 0))
    const tomorrow = allDayEvent('Tomorrow', '2026-10-13', '2026-10-14')

    it('lists all-day events first, then by start, then longer first, then by title', () => {
        const listed = eventsOnDay([garden, tomorrow, kitchenLong, shed, beans, yesterday, early, holiday], day)
        expect(listed.map((event) => event.summary)).toEqual(['Holiday', 'Shed', 'Water the beans', 'Kitchen', 'Beans', 'Garden'])
    })

    it('gives back the same event objects', () => {
        expect(eventsOnDay([garden], day)[0]).toBe(garden)
    })

    it('orders events without a title before titled ones that start with them', () => {
        const untitled = { start: garden.start, end: garden.end }
        expect(eventsOnDay([garden, untitled], day)).toEqual([untitled, garden])
    })
})

describe('moveSpan', () => {
    it('keeps an all-day event the same number of days', () => {
        const moved = moveSpan(allDay('2026-10-12', '2026-10-15'), { start: new Date(2026, 9, 23, 14, 30), allDay: true })
        expect(moved).toEqual(allDay('2026-10-23', '2026-10-26'))
    })

    it('keeps a timed event the same length', () => {
        const span = timed(new Date(2026, 9, 12, 9), new Date(2026, 9, 12, 10, 30))
        const moved = moveSpan(span, { start: new Date(2026, 9, 24, 23, 0), allDay: false })
        expect(moved.start).toEqual(new Date(2026, 9, 24, 23, 0))
        expect(moved.end.getTime() - moved.start.getTime()).toBe(1.5 * HOUR)
        expect(moved.allDay).toBe(false)
    })

    it('makes an all-day event dropped onto a time one hour long', () => {
        const moved = moveSpan(allDay('2026-10-12', '2026-10-15'), { start: new Date(2026, 9, 13, 9), allDay: false })
        expect(moved).toEqual(timed(new Date(2026, 9, 13, 9), new Date(2026, 9, 13, 10)))
    })

    it('makes a timed event dropped onto a day one day long', () => {
        const span = timed(new Date(2026, 9, 12, 9), new Date(2026, 9, 14, 17))
        expect(moveSpan(span, { start: new Date(2026, 9, 20, 9), allDay: true })).toEqual(allDay('2026-10-20', '2026-10-21'))
    })

    it('does not change the span it is given', () => {
        const span = allDay('2026-10-12', '2026-10-13')
        moveSpan(span, { start: new Date(2026, 9, 20), allDay: true })
        expect(span).toEqual(allDay('2026-10-12', '2026-10-13'))
    })
})

describe('formatTimeRange', () => {
    const morning = timed(new Date(2026, 9, 12, 9), new Date(2026, 9, 12, 10, 30))

    it('says All day for an all-day event', () => {
        expect(formatTimeRange(allDay('2026-10-12', '2026-10-15'), { hour12: false, day: '2026-10-13' })).toBe('All day')
        expect(formatTimeRange(allDay('2026-10-12', '2026-10-13'), { hour12: true })).toBe('All day')
    })

    it('writes a 24-hour range', () => {
        expect(formatTimeRange(morning, { hour12: false })).toBe('09:00 to 10:30')
        expect(formatTimeRange(morning, { hour12: false, day: '2026-10-12' })).toBe('09:00 to 10:30')
    })

    it('writes a 12-hour range', () => {
        expect(formatTimeRange(morning, { hour12: true })).toBe('9:00 AM to 10:30 AM')
        const afternoon = timed(new Date(2026, 9, 12, 12, 0), new Date(2026, 9, 12, 23, 59))
        expect(formatTimeRange(afternoon, { hour12: true })).toBe('12:00 PM to 11:59 PM')
        const night = timed(new Date(2026, 9, 12, 0, 15), new Date(2026, 9, 12, 1, 0))
        expect(formatTimeRange(night, { hour12: true })).toBe('12:15 AM to 1:00 AM')
    })

    it('writes a moment alone for an event with no length', () => {
        expect(formatTimeRange(timed(new Date(2026, 9, 12, 9), new Date(2026, 9, 12, 9)), { hour12: false })).toBe('09:00')
    })

    it('reads a timed event over several days by the day it is shown on', () => {
        const span = timed(new Date(2026, 9, 12, 22), new Date(2026, 9, 14, 9))
        expect(formatTimeRange(span, { hour12: false, day: '2026-10-12' })).toBe('From 22:00')
        expect(formatTimeRange(span, { hour12: false, day: '2026-10-13' })).toBe('All day')
        expect(formatTimeRange(span, { hour12: false, day: '2026-10-14' })).toBe('Until 09:00')
        expect(formatTimeRange(span, { hour12: true, day: '2026-10-12' })).toBe('From 10:00 PM')
        expect(formatTimeRange(span, { hour12: true, day: '2026-10-14' })).toBe('Until 9:00 AM')
    })

    it('reads a day that an event runs through to its closing midnight as All day', () => {
        const span = timed(new Date(2026, 9, 12, 22), new Date(2026, 9, 14, 0))
        expect(formatTimeRange(span, { hour12: false, day: '2026-10-13' })).toBe('All day')
    })

    it('writes an event that ends at midnight as a range on its own day', () => {
        const span = timed(new Date(2026, 9, 12, 22), new Date(2026, 9, 13, 0))
        expect(formatTimeRange(span, { hour12: false, day: '2026-10-12' })).toBe('22:00 to 00:00')
        expect(formatTimeRange(span, { hour12: false })).toBe('22:00 to 00:00')
    })

    it('names the dates of an event over several days when no day is given', () => {
        const span = timed(new Date(2026, 9, 12, 22), new Date(2026, 9, 14, 9))
        expect(formatTimeRange(span, { hour12: false })).toBe('Mon 12 Oct, 22:00 to Wed 14 Oct, 09:00')
    })

    it('uses the locale clock when a locale is given', () => {
        // ICU may put a narrow no-break space before the AM marker, so spaces are normalised here.
        const spaced = (text: string): string => text.replace(/\s/g, ' ')
        expect(spaced(formatTimeRange(morning, { hour12: true, locale: 'en-US' }))).toBe('9:00 AM to 10:30 AM')
        expect(formatTimeRange(morning, { hour12: false, locale: 'en-GB' })).toBe('09:00 to 10:30')
        const midnight = timed(new Date(2026, 9, 12, 0, 0), new Date(2026, 9, 12, 0, 30))
        expect(formatTimeRange(midnight, { hour12: false, locale: 'en-US' })).toBe('00:00 to 00:30')
    })

    it('uses no dashes', () => {
        const span = timed(new Date(2026, 9, 12, 22), new Date(2026, 9, 14, 9))
        expect(formatTimeRange(span, { hour12: false })).not.toMatch(/[-\u2013\u2014]/)
    })
})

describe('localTimeZone', () => {
    it('is the zone Intl resolves', () => {
        expect(localTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
        expect(localTimeZone().length).toBeGreaterThan(0)
    })
})
