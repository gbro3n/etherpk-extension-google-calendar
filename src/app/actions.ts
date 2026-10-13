/**
 * Changing events in Google: creating, saving an edit, moving or resizing by dragging, deleting,
 * and answering an invitation.
 *
 * - **Only what changed is sent.** An edit becomes a `patch` of the fields that differ from the event
 *   as it was read (`diffEvent`), with the event's `etag` as `If-Match`, so a change made in Google
 *   meanwhile is reported (412) rather than overwritten, and an unchanged guest list never emails
 *   anyone.
 * - **Repeating events** change in one of three ways. "This event" changes the occurrence.
 *   "All events" changes the series, moving its times by as much as this occurrence moved.
 *   "This and following events" ends the series just before this occurrence and starts a new series
 *   from it with the change, because the API has no single call for it.
 * - **Shown at once, or after Google.** A change to an event without guests shows at once and goes
 *   back if Google refuses it. A change that can email guests waits for Google, because the emails
 *   can't be taken back (the UI asks first whether to send them).
 */
import { deleteEvent, getEvent, insertEvent, listInstances, moveEvent, patchEvent, respondToInvitation, restoreEvent } from '../google/calendar-api'
import { GoogleError, type GoogleClient } from '../google/http'
import type { CalendarEvent } from '../google/types'
import { continueSeriesFrom, endSeriesBefore, formatRecurrence, parseRecurrence, splitExceptions } from '../model/recurrence'
import { eventSpan, toEventDateTime, type EventSpan } from '../model/time'
import type { CalendarStore, ShownEvent } from './calendar-store.svelte'
import type { CalendarRef } from './records'

export type EditScope = 'this' | 'following' | 'all'
export type SendUpdates = 'all' | 'none'

/** What an edit sets, as the editor holds it. Fields left out are not changed. */
export type EventChanges = Partial<Omit<CalendarEvent, 'id' | 'etag' | 'start' | 'end'>> & {
    /** New times, given as a span: the editor and a drag both produce one. */
    span?: EventSpan
    /** The time zone timed times are written in. */
    timeZone?: string
}

export interface ActionOptions {
    scope?: EditScope
    sendUpdates?: SendUpdates
}

/** The fields an edit may change, compared one by one. */
const COMPARED: (keyof CalendarEvent)[] = [
    'summary',
    'description',
    'location',
    'colorId',
    'eventLabelId',
    'start',
    'end',
    'recurrence',
    'transparency',
    'visibility',
    'attendees',
    'guestsCanModify',
    'guestsCanInviteOthers',
    'guestsCanSeeOtherGuests',
    'reminders',
    'attachments',
    'conferenceData',
    'eventType',
    'outOfOfficeProperties',
    'focusTimeProperties',
    'workingLocationProperties',
]

/** Equal as JSON, with object keys in any order. */
function same(a: unknown, b: unknown): boolean {
    return stableJson(a) === stableJson(b)
}

function stableJson(value: unknown): string {
    if (value === undefined) return 'undefined'
    return JSON.stringify(value, (_key, inner: unknown) => {
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
            return Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
        }
        return inner
    })
}

/** The event as the changes would leave it: times written in the event's own form. */
export function applyChanges(event: CalendarEvent, changes: EventChanges): CalendarEvent {
    const { span, timeZone, ...fields } = changes
    const next: CalendarEvent = { ...event, ...fields }
    if (span) {
        const zone = timeZone ?? event.start.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
        next.start = toEventDateTime(span.start, span.allDay, zone)
        next.end = toEventDateTime(span.end, span.allDay, zone)
    }
    return next
}

/**
 * The fields of `next` that differ from `event`, for a patch. Null clears a field Google holds.
 * Google merges a patched start or end into the one it holds, so a timed event made all-day (or the
 * other way) clears the form it no longer has, or it would carry both and be refused.
 */
export function diffEvent(event: CalendarEvent, next: CalendarEvent): Partial<CalendarEvent> {
    const patch: Record<string, unknown> = {}
    for (const field of COMPARED) {
        if (same(event[field], next[field])) continue
        if ((field === 'start' || field === 'end') && next[field]) {
            const time = next[field]
            patch[field] = time.date !== undefined ? { date: time.date, dateTime: null } : { ...time, date: null }
            continue
        }
        patch[field] = next[field] === undefined ? null : next[field]
    }
    return patch as Partial<CalendarEvent>
}

export interface Actions {
    create(ref: CalendarRef, event: Partial<CalendarEvent>, options?: ActionOptions): Promise<CalendarEvent>
    save(shown: ShownEvent, changes: EventChanges, options?: ActionOptions): Promise<void>
    /** Put the event in another calendar, then make the rest of an edit there. */
    moveToCalendar(shown: ShownEvent, to: CalendarRef, options?: ActionOptions): Promise<ShownEvent | null>
    /**
     * Delete an event, or occurrences of a series, and resolve with how to put it back: Google keeps
     * a deleted event on the organiser's calendar for about 30 days, and a change of its status
     * restores it. Null where it can't be put back from here (the person is not the organiser).
     */
    remove(shown: ShownEvent, options?: ActionOptions): Promise<(() => Promise<void>) | null>
    respond(shown: ShownEvent, response: 'accepted' | 'declined' | 'tentative'): Promise<void>
}

export function createActions(store: CalendarStore): Actions {
    const clientFor = (email: string): GoogleClient => {
        const client = store.client(email)
        if (!client) throw new Error('This account is not connected on this device. Connect it again, then try again.')
        return client
    }
    const refOf = (shown: ShownEvent): CalendarRef => ({ account: shown.account, calendarId: shown.calendar.id })

    /**
     * Run a change: shown at once when it can email nobody, else after Google answers. Either way the
     * calendar's months are read again afterwards, so Google's own version replaces any guess.
     */
    async function change(shown: ShownEvent, guess: CalendarEvent | null, write: () => Promise<void>, options: ActionOptions): Promise<void> {
        const ref = refOf(shown)
        const optimistic = guess !== null && (!shown.hasGuests || options.sendUpdates === 'none')
        if (optimistic) store.putEvent(ref, guess)
        try {
            await write()
        } catch (error) {
            // Refused: what is shown goes back to what Google holds.
            if (optimistic) store.putEvent(ref, shown.event)
            throw readable(error)
        } finally {
            void store.reload(ref)
        }
    }

    async function seriesOf(client: GoogleClient, shown: ShownEvent): Promise<CalendarEvent> {
        return getEvent(client, shown.calendar.id, shown.event.recurringEventId!)
    }

    /** End a series just before an occurrence, and start a new series there with the changes. */
    async function splitSeries(client: GoogleClient, shown: ShownEvent, changes: EventChanges, sendUpdates: SendUpdates): Promise<void> {
        const series = await seriesOf(client, shown)
        const original = shown.event.originalStartTime ? eventSpan({ start: shown.event.originalStartTime, end: shown.event.originalStartTime }) : shown.span
        const { rule, others } = parseRecurrence(series.recurrence)
        const seriesSpan = eventSpan(series)
        // The first occurrence: "this and following" is the whole series.
        if (!rule || original.start.getTime() <= seriesSpan.start.getTime()) {
            await patchSeries(client, shown, series, changes, sendUpdates)
            return
        }
        let before = 0
        if (rule.count !== undefined) {
            const earlier = await listInstances(client, shown.calendar.id, series.id, { timeMin: seriesSpan.start, timeMax: original.start })
            before = earlier.length
        }
        const exceptions = splitExceptions(others, original.start)
        await patchEvent(client, shown.calendar.id, series.id, { recurrence: formatRecurrence(endSeriesBefore(rule, original.start, original.allDay), exceptions.before) }, { etag: series.etag, sendUpdates })
        const continued = continueSeriesFrom(rule, before)
        const base = applyChanges({ ...series, start: shown.event.start, end: shown.event.end }, changes)
        const { id: _id, etag: _etag, recurringEventId: _series, originalStartTime: _original, htmlLink: _link, ...fields } = base
        await insertEvent(client, shown.calendar.id, { ...fields, recurrence: changes.recurrence ?? formatRecurrence(continued, exceptions.after) }, { sendUpdates })
    }

    /** Change a whole series, moving its times by as much as this occurrence's times moved. */
    async function patchSeries(client: GoogleClient, shown: ShownEvent, series: CalendarEvent, changes: EventChanges, sendUpdates: SendUpdates): Promise<void> {
        const { span, ...rest } = changes
        let seriesChanges: EventChanges = rest
        if (span) {
            const seriesSpan = eventSpan(series)
            const moved = span.start.getTime() - shown.span.start.getTime()
            const length = span.end.getTime() - span.start.getTime()
            const start = new Date(seriesSpan.start.getTime() + moved)
            seriesChanges = { ...rest, span: { start, end: new Date(start.getTime() + length), allDay: span.allDay } }
        }
        const patch = diffEvent(series, applyChanges(series, seriesChanges))
        if (Object.keys(patch).length === 0) return
        await patchEvent(client, shown.calendar.id, series.id, patch, { etag: series.etag, sendUpdates })
    }

    return {
        async create(ref, event, options = {}) {
            const client = clientFor(ref.account)
            try {
                const created = await insertEvent(client, ref.calendarId, event, { sendUpdates: options.sendUpdates ?? 'all' })
                store.putEvent(ref, created)
                void store.reload(ref)
                return created
            } catch (error) {
                throw readable(error)
            }
        },

        async save(shown, changes, options = {}) {
            const client = clientFor(shown.account)
            const scope = shown.event.recurringEventId ? (options.scope ?? 'this') : 'this'
            const sendUpdates = options.sendUpdates ?? 'all'
            const next = applyChanges(shown.event, changes)
            if (scope === 'this') {
                // One occurrence has no repeat rule of its own: a new rule is for the series.
                if (shown.event.recurringEventId) delete next.recurrence
                const patch = diffEvent(shown.event, next)
                if (Object.keys(patch).length === 0) return
                await change(shown, next, async () => void (await patchEvent(client, shown.calendar.id, shown.event.id, patch, { etag: shown.event.etag, sendUpdates })), options)
                return
            }
            await change(
                shown,
                null,
                async () => {
                    if (scope === 'all') await patchSeries(client, shown, await seriesOf(client, shown), changes, sendUpdates)
                    else await splitSeries(client, shown, changes, sendUpdates)
                    store.dropSeries(refOf(shown), shown.event.recurringEventId!)
                },
                options,
            )
        },

        async moveToCalendar(shown, to, options = {}) {
            if (to.account !== shown.account) throw new Error('An event can only move to another calendar of the same Google account.')
            if (to.calendarId === shown.calendar.id) return shown
            const client = clientFor(shown.account)
            const target = shown.event.recurringEventId && options.scope === 'all' ? shown.event.recurringEventId : shown.event.id
            try {
                const moved = await moveEvent(client, shown.calendar.id, target, to.calendarId, { sendUpdates: options.sendUpdates ?? 'all' })
                store.dropEvent(refOf(shown), shown.event.id)
                store.putEvent(to, moved)
                void store.reload(refOf(shown))
                void store.reload(to)
                return store.find(`${to.account}|${to.calendarId}|${moved.id}`) ?? null
            } catch (error) {
                throw readable(error)
            }
        },

        async remove(shown, options = {}) {
            const client = clientFor(shown.account)
            const ref = refOf(shown)
            const scope = shown.event.recurringEventId ? (options.scope ?? 'this') : 'this'
            const sendUpdates = options.sendUpdates ?? 'all'
            const optimistic = !shown.hasGuests || sendUpdates === 'none'
            if (optimistic && scope === 'this') store.dropEvent(ref, shown.event.id)
            // Only the organiser's calendar keeps a deleted event to restore.
            const restorable = !shown.event.organizer || shown.event.organizer.self === true
            const restoreBy = (eventId: string) => async () => {
                try {
                    await restoreEvent(client, shown.calendar.id, eventId, { sendUpdates })
                } catch (error) {
                    throw readable(error)
                } finally {
                    void store.reload(ref)
                }
            }
            try {
                if (scope === 'this') {
                    await deleteEvent(client, shown.calendar.id, shown.event.id, { sendUpdates })
                    return restorable ? restoreBy(shown.event.id) : null
                }
                if (scope === 'all') {
                    await deleteEvent(client, shown.calendar.id, shown.event.recurringEventId!, { sendUpdates })
                    store.dropSeries(ref, shown.event.recurringEventId!)
                    return restorable ? restoreBy(shown.event.recurringEventId!) : null
                }
                {
                    const series = await seriesOf(client, shown)
                    const { rule, others } = parseRecurrence(series.recurrence)
                    const original = shown.event.originalStartTime ? eventSpan({ start: shown.event.originalStartTime, end: shown.event.originalStartTime }) : shown.span
                    if (!rule || original.start.getTime() <= eventSpan(series).start.getTime()) {
                        await deleteEvent(client, shown.calendar.id, series.id, { sendUpdates })
                        store.dropSeries(ref, series.id)
                        return restorable ? restoreBy(series.id) : null
                    }
                    const kept = splitExceptions(others, original.start).before
                    const ended = await patchEvent(client, shown.calendar.id, series.id, { recurrence: formatRecurrence(endSeriesBefore(rule, original.start, original.allDay), kept) }, { etag: series.etag, sendUpdates })
                    store.dropSeries(ref, series.id)
                    // Putting it back is giving the series its rule as it was.
                    return async () => {
                        try {
                            await patchEvent(client, shown.calendar.id, series.id, { recurrence: series.recurrence }, { etag: ended.etag, sendUpdates })
                        } catch (error) {
                            throw readable(error)
                        } finally {
                            void store.reload(ref)
                        }
                    }
                }
            } catch (error) {
                if (optimistic && scope === 'this') store.putEvent(ref, shown.event)
                throw readable(error)
            } finally {
                void store.reload(ref)
            }
        },

        async respond(shown, response) {
            const client = clientFor(shown.account)
            const guess: CalendarEvent = {
                ...shown.event,
                attendees: shown.event.attendees?.map((attendee) => (attendee.self ? { ...attendee, responseStatus: response } : attendee)),
            }
            // An answer emails the organiser only, which the person means by answering: shown at once.
            store.putEvent(refOf(shown), guess)
            try {
                await respondToInvitation(client, shown.calendar.id, shown.event, response, { etag: shown.event.etag })
            } catch (error) {
                store.putEvent(refOf(shown), shown.event)
                throw readable(error)
            } finally {
                void store.reload(refOf(shown))
            }
        },
    }
}

/** An error as the person reads it: Google's own wording where it is readable, else ours. */
export function readable(error: unknown): Error {
    if (error instanceof GoogleError) {
        if (error.kind === 'precondition') return new Error('This event changed in Google Calendar meanwhile. It now shows as it is there. Make your change again.')
        // A refusal with a reason Google named keeps its own words (an API turned off, a change only
        // the organiser may make, a wrong Client ID); a bare one says what it means here.
        if (error.kind === 'forbidden' && !error.reason) return new Error('Google does not let this account change this event.')
        return error
    }
    return error instanceof Error ? error : new Error('Something went wrong talking to Google. Try again.')
}
