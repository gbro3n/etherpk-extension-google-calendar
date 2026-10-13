/**
 * Dates and times for the calendar, in the device's local time zone.
 *
 * Google writes an all-day event as plain `YYYY-MM-DD` dates and a timed event as an RFC 3339
 * instant with an offset. The extension shows both in the local zone, so an all-day date becomes
 * local midnight and a timed instant is shown at its local wall-clock time. Day arithmetic works in
 * calendar days through the `Date` setters, never by adding 24 hours, because a day that a clock
 * change shortens or lengthens is 23 or 25 hours long.
 */
import type { CalendarEvent, EventDateTime } from '../google/types'

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

/** When an event starts and ends. The end is exclusive: an all-day event ends at the midnight after its last day. */
export interface EventSpan {
    start: Date
    end: Date
    allDay: boolean
}

function pad2(value: number): string {
    return String(value).padStart(2, '0')
}

/**
 * The first moment of a local calendar day. The month and day may overflow, as with the `Date`
 * constructor, so `localDay(2026, 9, 32)` is the first of November. The constructor reads the
 * years 0 to 99 as 1900 to 1999, so those years are set again explicitly.
 */
function localDay(year: number, monthIndex: number, day: number): Date {
    const date = new Date(year, monthIndex, day)
    if (year >= 0 && year < 100) date.setFullYear(year, monthIndex, day)
    return date
}

/** The local day `days` after the one `date` falls on, at its first moment. */
function dayAfter(date: Date, days: number): Date {
    return localDay(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

/** The whole calendar days from the day `from` falls on to the day `to` falls on, in local time. */
function calendarDaysBetween(from: Date, to: Date): number {
    const fromDay = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
    const toDay = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())
    return Math.round((toDay - fromDay) / MS_PER_DAY)
}

/** The local calendar day a moment falls on, as `YYYY-MM-DD`. */
export function isoDay(date: Date): string {
    return `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * Local midnight at the start of a `YYYY-MM-DD` day. Where a clock change skips midnight itself,
 * the result is the first moment the day has. A string that is not a day gives an invalid date
 * rather than an error, so one malformed event cannot stop a whole calendar from showing.
 */
export function parseIsoDay(day: string): Date {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
    if (!match) return new Date(Number.NaN)
    return localDay(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

/** The same local wall-clock time `days` calendar days later (or earlier, for a negative count). */
export function addDays(date: Date, days: number): Date {
    const result = new Date(date.getTime())
    result.setDate(result.getDate() + days)
    return result
}

/** A local day as the half-open range [its midnight, the next midnight). */
export function dayBounds(day: string): { start: Date; end: Date } {
    const start = parseIsoDay(day)
    return { start, end: dayAfter(start, 1) }
}

/**
 * When an event starts and ends, as moments in local time.
 *
 * An all-day event's dates become local midnights, and its end stays exclusive as Google writes it.
 * A timed event's instants carry their own offsets, so they parse to the right moment in any zone.
 * An end missing or before the start is read as one day (all-day) or no time (timed), and an event
 * with no readable start gets invalid dates, which no day overlaps.
 */
export function eventSpan(event: Pick<CalendarEvent, 'start' | 'end'>): EventSpan {
    const { start, end } = event
    if (start?.date) {
        const startDay = parseIsoDay(start.date)
        const endDay = end?.date ? parseIsoDay(end.date) : dayAfter(startDay, 1)
        return { start: startDay, end: endDay > startDay ? endDay : dayAfter(startDay, 1), allDay: true }
    }
    const startAt = new Date(start?.dateTime ?? Number.NaN)
    const endAt = end?.dateTime ? new Date(end.dateTime) : end?.date ? parseIsoDay(end.date) : new Date(startAt.getTime())
    return { start: startAt, end: endAt >= startAt ? endAt : new Date(startAt.getTime()), allDay: false }
}

/** A moment as RFC 3339 in local wall-clock time with the local offset, such as `2026-10-12T09:00:00+01:00`. */
function localDateTime(date: Date): string {
    const offset = -date.getTimezoneOffset()
    const sign = offset >= 0 ? '+' : '-'
    const absolute = Math.abs(offset)
    const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    return `${isoDay(date)}T${time}${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
}

/**
 * A start or end as Google takes it. An all-day value is the local date alone. A timed value is the
 * local time with its offset, plus the IANA zone, which Google needs to repeat an event correctly
 * across clock changes.
 */
export function toEventDateTime(date: Date, allDay: boolean, timeZone: string): EventDateTime {
    if (allDay) return { date: isoDay(date) }
    return { dateTime: localDateTime(date), timeZone }
}

/**
 * Whether an event shows on a day. The end is exclusive, so an event that ends exactly at midnight
 * does not show on the day that midnight begins. A timed event with no length shows on the day its
 * moment falls on.
 */
export function overlapsDay(span: EventSpan, day: string): boolean {
    const { start, end } = dayBounds(day)
    if (span.start.getTime() === span.end.getTime()) return span.start >= start && span.start < end
    return span.start < end && span.end > start
}

/** An event's title, where the event has one, for ordering. */
function titleOf(event: object): string {
    return 'summary' in event && typeof event.summary === 'string' ? event.summary : ''
}

/**
 * The events that show on a day, in the order a day lists them: all-day events first, then by
 * start time, then the longer event first, then by title.
 */
export function eventsOnDay<T extends Pick<CalendarEvent, 'start' | 'end'>>(events: readonly T[], day: string): T[] {
    return events
        .map((event) => ({ event, span: eventSpan(event) }))
        .filter(({ span }) => overlapsDay(span, day))
        .sort((a, b) => {
            if (a.span.allDay !== b.span.allDay) return a.span.allDay ? -1 : 1
            const byStart = a.span.start.getTime() - b.span.start.getTime()
            if (byStart !== 0) return byStart
            const byLength = b.span.end.getTime() - b.span.start.getTime() - (a.span.end.getTime() - a.span.start.getTime())
            if (byLength !== 0) return byLength
            return titleOf(a.event).localeCompare(titleOf(b.event))
        })
        .map(({ event }) => event)
}

/**
 * An event moved to a new start, keeping its length. An all-day event keeps its number of days and a
 * timed event its exact duration. An all-day event dropped onto a time becomes one hour long, and a
 * timed event dropped onto a day becomes one day long. An all-day start is the midnight of the day
 * `to.start` falls on, whatever time it carries.
 */
export function moveSpan(span: EventSpan, to: { start: Date; allDay: boolean }): EventSpan {
    if (to.allDay) {
        const start = dayAfter(to.start, 0)
        const days = span.allDay ? Math.max(1, calendarDaysBetween(span.start, span.end)) : 1
        return { start, end: dayAfter(start, days), allDay: true }
    }
    const start = new Date(to.start.getTime())
    const duration = span.allDay ? MS_PER_HOUR : Math.max(0, span.end.getTime() - span.start.getTime())
    return { start, end: new Date(start.getTime() + duration), allDay: false }
}

export interface TimeRangeOptions {
    /** A 12-hour clock with AM and PM, as Google Calendar's `format24HourTime` setting asks. */
    hour12: boolean
    /** A BCP 47 locale for the clock. Without one, the clock is `09:00` or `9:00 AM`. */
    locale?: string
    /** The `YYYY-MM-DD` day the event is shown on, which decides how an event over several days reads. */
    day?: string
}

/**
 * A clock time. Without a locale it is written by hand, so the text is the same on every machine.
 * With one, `Intl` writes it, with `hourCycle` rather than `hour12: false`, which some engines read
 * as a clock that shows midnight as 24:00.
 */
function formatClock(date: Date, hour12: boolean, locale: string | undefined): string {
    if (locale === undefined) {
        const minutes = pad2(date.getMinutes())
        if (!hour12) return `${pad2(date.getHours())}:${minutes}`
        const hours = date.getHours()
        return `${hours % 12 === 0 ? 12 : hours % 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`
    }
    return new Intl.DateTimeFormat(locale, {
        hour: hour12 ? 'numeric' : '2-digit',
        minute: '2-digit',
        hourCycle: hour12 ? 'h12' : 'h23',
    }).format(date)
}

/** A short date to go with a clock time, such as `Mon 12 Oct`. */
function formatShortDate(date: Date, locale: string | undefined): string {
    return new Intl.DateTimeFormat(locale ?? 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(date)
}

/**
 * When an event happens, in plain words: `All day`, `09:00 to 10:30` or `9:00 AM to 10:30 AM`.
 *
 * A timed event over several days reads by the day it is shown on: `From 22:00` on its first day,
 * `Until 09:00` on its last, and `All day` on a day it runs through. Without a day, such an event
 * names its dates as well as its times.
 */
export function formatTimeRange(span: EventSpan, options: TimeRangeOptions): string {
    if (span.allDay) return 'All day'
    const clock = (date: Date): string => formatClock(date, options.hour12, options.locale)
    if (span.start.getTime() === span.end.getTime()) return clock(span.start)
    if (options.day !== undefined) {
        const bounds = dayBounds(options.day)
        const startsHere = span.start >= bounds.start
        const endsHere = span.end <= bounds.end
        if (startsHere && endsHere) return `${clock(span.start)} to ${clock(span.end)}`
        if (startsHere) return `From ${clock(span.start)}`
        // An event that started earlier and runs to this day's closing midnight fills the day.
        if (endsHere && span.end < bounds.end) return `Until ${clock(span.end)}`
        return 'All day'
    }
    const endsOnStartDay = isoDay(span.start) === isoDay(span.end) || span.end.getTime() === dayAfter(span.start, 1).getTime()
    if (endsOnStartDay) return `${clock(span.start)} to ${clock(span.end)}`
    return `${formatShortDate(span.start, options.locale)}, ${clock(span.start)} to ${formatShortDate(span.end, options.locale)}, ${clock(span.end)}`
}

/** The device's IANA time zone, such as `Europe/London`. */
export function localTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
}
