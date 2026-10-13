import { describe, expect, it } from 'vitest'

import type { CalendarEvent } from '../google/types'
import { applyChanges, diffEvent } from './actions'

const event: CalendarEvent = {
    id: 'beans',
    etag: '"1"',
    summary: 'Water the beans',
    start: { dateTime: '2026-10-12T10:00:00+01:00', timeZone: 'Europe/London' },
    end: { dateTime: '2026-10-12T11:00:00+01:00', timeZone: 'Europe/London' },
    attendees: [{ email: 'orchard@example.com', responseStatus: 'accepted' }],
    reminders: { useDefault: true },
}

describe('an edit as a patch', () => {
    it('holds only the fields that changed', () => {
        expect(diffEvent(event, applyChanges(event, { summary: 'Water the beans well' }))).toEqual({ summary: 'Water the beans well' })
    })

    it('leaves out a guest list given again unchanged, in another key order, so nobody is emailed', () => {
        const again = applyChanges(event, { attendees: [{ responseStatus: 'accepted', email: 'orchard@example.com' }], reminders: { useDefault: true } })
        expect(diffEvent(event, again)).toEqual({})
    })

    it('clears a field Google holds with null', () => {
        expect(diffEvent({ ...event, location: 'North bed' }, applyChanges({ ...event, location: 'North bed' }, { location: undefined }))).toEqual({ location: null })
    })

    it('writes new times in the event’s own time zone, as all-day dates or times with an offset', () => {
        const moved = applyChanges(event, { span: { start: new Date(2026, 9, 13, 9, 0), end: new Date(2026, 9, 13, 10, 0), allDay: false } })
        expect(moved.start.timeZone).toBe('Europe/London')
        expect(moved.start.dateTime).toMatch(/^2026-10-13T09:00:00[+-]\d\d:\d\d$/)
        const whole = applyChanges(event, { span: { start: new Date(2026, 9, 13), end: new Date(2026, 9, 14), allDay: true } })
        expect([whole.start, whole.end]).toEqual([{ date: '2026-10-13' }, { date: '2026-10-14' }])
    })

    it('clears the time a timed event made all-day no longer has, and the date the other way', () => {
        const whole = diffEvent(event, applyChanges(event, { span: { start: new Date(2026, 9, 13), end: new Date(2026, 9, 14), allDay: true } }))
        expect(whole.start).toEqual({ date: '2026-10-13', dateTime: null })
        const day: CalendarEvent = { ...event, start: { date: '2026-10-13' }, end: { date: '2026-10-14' } }
        const timed = diffEvent(day, applyChanges(day, { span: { start: new Date(2026, 9, 13, 9), end: new Date(2026, 9, 13, 10), allDay: false }, timeZone: 'Europe/London' }))
        expect(timed.start).toMatchObject({ date: null, timeZone: 'Europe/London' })
        expect((timed.start as { dateTime: string }).dateTime).toMatch(/^2026-10-13T09:00:00/)
    })
})
