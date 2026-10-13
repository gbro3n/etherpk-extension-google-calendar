/**
 * The Google Calendar API v3 calls the extension makes
 * (https://developers.google.com/workspace/calendar/api/v3/reference), over a `GoogleClient`.
 *
 * Writes always send `conferenceDataVersion=1` and `supportsAttachments=true`. Google's reference
 * warns that a client which leaves them out can strip a Meet link or attachments from an event it
 * writes back, because Google then assumes the client doesn't know those fields.
 */
import { GoogleError, listAllPages, type GoogleClient, type RequestOptions } from './http'
import type { CalendarEvent, CalendarListEntry, CalendarResource, CalendarSettings, ColorPalettes, EventLabel, FreeBusyCalendar } from './types'

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

/**
 * A calendar's path. Ids hold characters a URL path can't carry as they are: an `@` in every
 * address, and a `#` in Google's own calendars, such as `en.uk#holiday@group.v.calendar.google.com`.
 */
function calendarPath(calendarId: string): string {
    return `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}`
}

function eventPath(calendarId: string, eventId: string): string {
    return `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`
}

/** The calendars in the person's list. Deleted entries are left out. */
export async function listCalendars(client: GoogleClient, signal?: AbortSignal): Promise<CalendarListEntry[]> {
    const entries = await listAllPages<CalendarListEntry>(client, `${CALENDAR_API}/users/me/calendarList`, { maxResults: 250 }, signal)
    return entries.filter((entry) => !entry.deleted)
}

/** Google's calendar and event palettes. */
export async function getColors(client: GoogleClient, signal?: AbortSignal): Promise<ColorPalettes> {
    const colors = await client.request<Partial<ColorPalettes>>(`${CALENDAR_API}/colors`, { signal })
    return { calendar: colors.calendar ?? {}, event: colors.event ?? {} }
}

/** The person's Google Calendar settings, by setting id. */
export async function getSettings(client: GoogleClient, signal?: AbortSignal): Promise<CalendarSettings> {
    const items = await listAllPages<{ id: string; value: string }>(client, `${CALENDAR_API}/users/me/settings`, { maxResults: 250 }, signal)
    const settings: Record<string, string> = {}
    for (const item of items) settings[item.id] = item.value
    return settings as CalendarSettings
}

export interface TimeRange {
    timeMin: Date
    timeMax: Date
}

/**
 * Every event that overlaps a range, with each repeating event expanded into its occurrences.
 * Google's `timeMin` bounds an event's end and `timeMax` bounds its start, both exclusive, so an
 * event that started before the range but ends inside it is included, as a visible range needs.
 */
export async function listEvents(client: GoogleClient, calendarId: string, range: TimeRange, signal?: AbortSignal): Promise<CalendarEvent[]> {
    return listAllPages<CalendarEvent>(
        client,
        `${calendarPath(calendarId)}/events`,
        {
            timeMin: range.timeMin.toISOString(),
            timeMax: range.timeMax.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 2500,
        },
        signal,
    )
}

/** One event. Google gives a deleted event too, with status `cancelled`. */
export async function getEvent(client: GoogleClient, calendarId: string, eventId: string, signal?: AbortSignal): Promise<CalendarEvent> {
    return client.request<CalendarEvent>(eventPath(calendarId, eventId), { signal })
}

export interface WriteOptions {
    /** Who Google emails about the change. */
    sendUpdates?: 'all' | 'externalOnly' | 'none'
    /** The event's `etag` as it was read. Google refuses the write (`precondition`) if the event changed since. */
    etag?: string
    signal?: AbortSignal
}

/**
 * The query every event write carries. `eventLabelVersion=1` goes only on a write that sets a label:
 * with it, Google ignores `colorId`, so sending it always would stop colours being set on calendars
 * that don't use labels. Without it, Google ignores `eventLabelId`.
 */
function writeQuery(options: WriteOptions, body?: Partial<CalendarEvent>): RequestOptions['query'] {
    return {
        conferenceDataVersion: 1,
        supportsAttachments: true,
        sendUpdates: options.sendUpdates,
        eventLabelVersion: body !== undefined && 'eventLabelId' in body ? 1 : undefined,
    }
}

function ifMatch(options: WriteOptions): Record<string, string> | undefined {
    return options.etag ? { 'If-Match': options.etag } : undefined
}

export async function insertEvent(client: GoogleClient, calendarId: string, event: Partial<CalendarEvent>, options: WriteOptions = {}): Promise<CalendarEvent> {
    return client.request<CalendarEvent>(`${calendarPath(calendarId)}/events`, {
        method: 'POST',
        query: writeQuery(options, event),
        json: event,
        signal: options.signal,
    })
}

/**
 * Change the fields given and keep the rest. An array given (attendees, attachments, reminder
 * overrides) replaces the event's whole array, so send it complete.
 */
export async function patchEvent(
    client: GoogleClient,
    calendarId: string,
    eventId: string,
    patch: Partial<CalendarEvent>,
    options: WriteOptions = {},
): Promise<CalendarEvent> {
    return client.request<CalendarEvent>(eventPath(calendarId, eventId), {
        method: 'PATCH',
        query: writeQuery(options, patch),
        json: patch,
        headers: ifMatch(options),
        signal: options.signal,
    })
}

/**
 * Delete an event. One that is already gone (`410`) counts as deleted, since that is the outcome
 * wanted, so a repeated delete after a lost answer doesn't show an error.
 */
export async function deleteEvent(client: GoogleClient, calendarId: string, eventId: string, options: WriteOptions = {}): Promise<void> {
    try {
        await client.request<void>(eventPath(calendarId, eventId), {
            method: 'DELETE',
            query: { sendUpdates: options.sendUpdates },
            headers: ifMatch(options),
            signal: options.signal,
        })
    } catch (error) {
        if (error instanceof GoogleError && error.kind === 'gone') return
        throw error
    }
}

/**
 * Bring back a deleted event by setting its status to `confirmed` again.
 *
 * Google's Events reference says a cancelled event on the organiser's calendar keeps its details
 * "so that they can be restored (undeleted)", and that `events.get` always returns cancelled
 * events. It doesn't name the call that restores one. A patch of `status` is the only writable
 * route, and other Calendar clients use it, but it was not tried against Google here.
 */
export async function restoreEvent(client: GoogleClient, calendarId: string, eventId: string, options: WriteOptions = {}): Promise<CalendarEvent> {
    return patchEvent(client, calendarId, eventId, { status: 'confirmed' }, options)
}

/** Move an event to another calendar of the same account. */
export async function moveEvent(
    client: GoogleClient,
    calendarId: string,
    eventId: string,
    destinationCalendarId: string,
    options: WriteOptions = {},
): Promise<CalendarEvent> {
    return client.request<CalendarEvent>(`${eventPath(calendarId, eventId)}/move`, {
        method: 'POST',
        query: { destination: destinationCalendarId, sendUpdates: options.sendUpdates },
        headers: ifMatch(options),
        signal: options.signal,
    })
}

/** The occurrences of a repeating event within a range. */
export async function listInstances(
    client: GoogleClient,
    calendarId: string,
    eventId: string,
    range: TimeRange,
    signal?: AbortSignal,
): Promise<CalendarEvent[]> {
    return listAllPages<CalendarEvent>(
        client,
        `${eventPath(calendarId, eventId)}/instances`,
        { timeMin: range.timeMin.toISOString(), timeMax: range.timeMax.toISOString(), maxResults: 2500 },
        signal,
    )
}

/**
 * Answer an invitation as the person signed in.
 *
 * A patch replaces the whole attendees array, so the array is sent complete with only the person's
 * own answer changed. When Google left guests out of the event as read (`attendeesOmitted`),
 * sending the partial array would remove them, so only the person's own entry goes, with
 * `attendeesOmitted: true`, which Google documents as the way to update only the person's answer.
 */
export async function respondToInvitation(
    client: GoogleClient,
    calendarId: string,
    event: CalendarEvent,
    response: 'accepted' | 'declined' | 'tentative',
    options: WriteOptions = {},
): Promise<CalendarEvent> {
    const attendees = event.attendees ?? []
    const self = attendees.find((attendee) => attendee.self)
    if (!self) {
        throw new GoogleError('You aren’t a guest of this event, so there is no invitation to answer.', { status: 0, kind: 'bad-request', reason: 'notAGuest' })
    }
    const answered = { ...self, responseStatus: response }
    const patch: Partial<CalendarEvent> = event.attendeesOmitted
        ? { attendees: [answered], attendeesOmitted: true }
        : { attendees: attendees.map((attendee) => (attendee === self ? answered : attendee)) }
    return patchEvent(client, calendarId, event.id, patch, options)
}

/** When calendars, or people by address, are busy within a range, by calendar id or address. */
export async function freeBusy(
    client: GoogleClient,
    query: { timeMin: Date; timeMax: Date; items: string[] },
    signal?: AbortSignal,
): Promise<Record<string, FreeBusyCalendar>> {
    const answer = await client.request<{ calendars?: Record<string, FreeBusyCalendar> }>(`${CALENDAR_API}/freeBusy`, {
        method: 'POST',
        json: {
            timeMin: query.timeMin.toISOString(),
            timeMax: query.timeMax.toISOString(),
            items: query.items.map((id) => ({ id })),
        },
        signal,
    })
    return answer.calendars ?? {}
}

/**
 * The event labels a calendar defines (Google, July 2026), empty where it defines none.
 *
 * Labels live on the calendar's own resource, `calendars.get`, as `labelProperties.eventLabels`,
 * each with an `id` (a UUID), a `backgroundColor` and an optional `name`
 * (https://developers.google.com/workspace/calendar/api/guides/labels and the Calendars reference).
 * Reading them needs `calendar.calendars.readonly`. An event names its label in `eventLabelId`,
 * which Google gives on reads without any extra parameter.
 */
export async function listLabels(client: GoogleClient, calendarId: string, signal?: AbortSignal): Promise<EventLabel[]> {
    const calendar = await client.request<CalendarResource>(calendarPath(calendarId), { query: { fields: 'labelProperties' }, signal })
    return (calendar.labelProperties?.eventLabels ?? []).map((label) => ({
        id: label.id,
        name: label.name ?? '',
        ...(label.backgroundColor ? { color: label.backgroundColor } : {}),
    }))
}
