import { describe, expect, it } from 'vitest'
import {
    deleteEvent,
    freeBusy,
    getColors,
    getEvent,
    getSettings,
    insertEvent,
    listCalendars,
    listEvents,
    listInstances,
    listLabels,
    moveEvent,
    patchEvent,
    respondToInvitation,
    restoreEvent,
} from './calendar-api'
import { bodyJson, fakeFetch, googleError, json } from './fake-fetch'
import { createGoogleClient, GoogleError } from './http'
import type { CalendarEvent } from './types'

function setup(...replies: Parameters<typeof fakeFetch>) {
    const fetch = fakeFetch(...replies)
    const client = createGoogleClient({ tokens: { token: async () => 'token-1', refresh: async () => 'token-2' }, fetch, sleep: async () => {} })
    return { fetch, client }
}

const query = (request: { url: URL }) => Object.fromEntries(request.url.searchParams)

const event: CalendarEvent = {
    id: 'beans1',
    etag: '"etag-1"',
    summary: 'Water the beans',
    start: { dateTime: '2026-10-12T09:00:00+01:00' },
    end: { dateTime: '2026-10-12T09:30:00+01:00' },
}

describe('listCalendars', () => {
    it('reads every page and leaves out deleted entries', async () => {
        const { fetch, client } = setup(
            json({ items: [{ id: 'gardener@example.com', summary: 'Garden', accessRole: 'owner', primary: true }], nextPageToken: 'next' }),
            json({ items: [{ id: 'kitchen@group.calendar.google.com', summary: 'Kitchen', accessRole: 'reader', deleted: true }, { id: 'shed', summary: 'Shed', accessRole: 'writer' }] }),
        )
        const calendars = await listCalendars(client)
        expect(calendars.map((calendar) => calendar.summary)).toEqual(['Garden', 'Shed'])
        expect(fetch.requests[0].url.pathname).toBe('/calendar/v3/users/me/calendarList')
        expect(query(fetch.requests[1])).toEqual({ maxResults: '250', pageToken: 'next' })
    })
})

describe('getColors', () => {
    it('reads both palettes', async () => {
        const palettes = { calendar: { 1: { background: '#ac725e', foreground: '#1d1d1d' } }, event: { 1: { background: '#a4bdfc', foreground: '#1d1d1d' } } }
        const { fetch, client } = setup(json({ kind: 'calendar#colors', ...palettes }))
        await expect(getColors(client)).resolves.toEqual(palettes)
        expect(fetch.requests[0].url.toString()).toBe('https://www.googleapis.com/calendar/v3/colors')
    })
})

describe('getSettings', () => {
    it('maps every page of settings by id', async () => {
        const { client } = setup(
            json({ items: [{ id: 'weekStart', value: '1' }, { id: 'format24HourTime', value: 'true' }], nextPageToken: 'next' }),
            json({ items: [{ id: 'timezone', value: 'Europe/London' }] }),
        )
        await expect(getSettings(client)).resolves.toEqual({ weekStart: '1', format24HourTime: 'true', timezone: 'Europe/London' })
    })
})

describe('listEvents', () => {
    it('asks for single events in start order over the range, and reads every page', async () => {
        const { fetch, client } = setup(json({ items: [event], nextPageToken: 'page-2' }), json({ items: [{ ...event, id: 'beans2' }] }))
        const range = { timeMin: new Date('2026-10-01T00:00:00Z'), timeMax: new Date('2026-11-01T00:00:00Z') }
        const events = await listEvents(client, 'en.uk#holiday@group.v.calendar.google.com', range)
        expect(events.map((found) => found.id)).toEqual(['beans1', 'beans2'])
        const [first, second] = fetch.requests
        // `#` and `@` are encoded, or the `#` would end the path.
        expect(first.url.pathname).toBe('/calendar/v3/calendars/en.uk%23holiday%40group.v.calendar.google.com/events')
        expect(query(first)).toEqual({
            timeMin: '2026-10-01T00:00:00.000Z',
            timeMax: '2026-11-01T00:00:00.000Z',
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults: '2500',
        })
        expect(query(second).pageToken).toBe('page-2')
    })
})

describe('getEvent', () => {
    it('reads one event', async () => {
        const { fetch, client } = setup(json(event))
        await expect(getEvent(client, 'garden', 'beans1')).resolves.toEqual(event)
        expect(fetch.requests[0].url.pathname).toBe('/calendar/v3/calendars/garden/events/beans1')
    })
})

describe('insertEvent', () => {
    it('always sends conferenceDataVersion and supportsAttachments', async () => {
        const { fetch, client } = setup(json(event))
        await insertEvent(client, 'garden', { summary: 'Water the beans', start: event.start, end: event.end }, { sendUpdates: 'all' })
        const [request] = fetch.requests
        expect(request.method).toBe('POST')
        expect(request.url.pathname).toBe('/calendar/v3/calendars/garden/events')
        expect(query(request)).toEqual({ conferenceDataVersion: '1', supportsAttachments: 'true', sendUpdates: 'all' })
        expect(await bodyJson(request)).toEqual({ summary: 'Water the beans', start: event.start, end: event.end })
    })

    it('sends eventLabelVersion only when the event carries a label', async () => {
        const { fetch, client } = setup(json(event))
        await insertEvent(client, 'garden', { summary: 'Water the beans', eventLabelId: '22222222-3333-4444-5555-666666666666' })
        expect(query(fetch.requests[0]).eventLabelVersion).toBe('1')
    })
})

describe('patchEvent', () => {
    it('sends If-Match with the etag, and the patch alone', async () => {
        const { fetch, client } = setup(json(event))
        await patchEvent(client, 'garden', 'beans1', { summary: 'Water the peas' }, { etag: '"etag-1"', sendUpdates: 'none' })
        const [request] = fetch.requests
        expect(request.method).toBe('PATCH')
        expect(request.url.pathname).toBe('/calendar/v3/calendars/garden/events/beans1')
        expect(request.headers['if-match']).toBe('"etag-1"')
        expect(query(request)).toEqual({ conferenceDataVersion: '1', supportsAttachments: 'true', sendUpdates: 'none' })
        expect(await bodyJson(request)).toEqual({ summary: 'Water the peas' })
    })

    it('sends no If-Match without an etag', async () => {
        const { fetch, client } = setup(json(event))
        await patchEvent(client, 'garden', 'beans1', { colorId: '5' })
        expect(fetch.requests[0].headers).not.toHaveProperty('if-match')
        expect(query(fetch.requests[0])).not.toHaveProperty('eventLabelVersion')
    })

    it('sends eventLabelVersion when it removes a label', async () => {
        const { fetch, client } = setup(json(event))
        await patchEvent(client, 'garden', 'beans1', { eventLabelId: '' })
        expect(query(fetch.requests[0]).eventLabelVersion).toBe('1')
    })

    it('reports an event changed elsewhere as a precondition failure', async () => {
        const { client } = setup(googleError(412, 'conditionNotMet', 'Precondition Failed'))
        await expect(patchEvent(client, 'garden', 'beans1', { summary: 'Water the peas' }, { etag: '"etag-0"' })).rejects.toMatchObject({ kind: 'precondition' })
    })
})

describe('deleteEvent', () => {
    it('deletes with If-Match and sendUpdates', async () => {
        const { fetch, client } = setup(new Response(null, { status: 204 }))
        await expect(deleteEvent(client, 'garden', 'beans1', { etag: '"etag-1"', sendUpdates: 'all' })).resolves.toBeUndefined()
        const [request] = fetch.requests
        expect(request.method).toBe('DELETE')
        expect(request.headers['if-match']).toBe('"etag-1"')
        expect(query(request)).toEqual({ sendUpdates: 'all' })
    })

    it('counts an event already deleted as deleted', async () => {
        const { client } = setup(googleError(410, 'deleted', 'Resource has been deleted'))
        await expect(deleteEvent(client, 'garden', 'beans1')).resolves.toBeUndefined()
    })

    it('reports other failures', async () => {
        const { client } = setup(googleError(403, 'forbiddenForNonOrganizer'))
        await expect(deleteEvent(client, 'garden', 'beans1')).rejects.toMatchObject({ kind: 'forbidden', message: 'Only the event’s organiser can change that.' })
    })
})

describe('restoreEvent', () => {
    it('patches the status back to confirmed', async () => {
        const { fetch, client } = setup(json({ ...event, status: 'confirmed' }))
        await expect(restoreEvent(client, 'garden', 'beans1', { etag: '"etag-2"' })).resolves.toMatchObject({ status: 'confirmed' })
        const [request] = fetch.requests
        expect(request.method).toBe('PATCH')
        expect(request.headers['if-match']).toBe('"etag-2"')
        expect(query(request)).toMatchObject({ conferenceDataVersion: '1', supportsAttachments: 'true' })
        expect(await bodyJson(request)).toEqual({ status: 'confirmed' })
    })
})

describe('moveEvent', () => {
    it('posts to move with the destination', async () => {
        const { fetch, client } = setup(json(event))
        await moveEvent(client, 'garden', 'beans1', 'kitchen@group.calendar.google.com', { sendUpdates: 'externalOnly' })
        const [request] = fetch.requests
        expect(request.method).toBe('POST')
        expect(request.url.pathname).toBe('/calendar/v3/calendars/garden/events/beans1/move')
        expect(query(request)).toEqual({ destination: 'kitchen@group.calendar.google.com', sendUpdates: 'externalOnly' })
    })
})

describe('listInstances', () => {
    it('reads every page of a series’ occurrences in the range', async () => {
        const { fetch, client } = setup(json({ items: [{ ...event, id: 'beans1_20261012T080000Z' }], nextPageToken: 'next' }), json({ items: [] }))
        const range = { timeMin: new Date('2026-10-01T00:00:00Z'), timeMax: new Date('2026-11-01T00:00:00Z') }
        const instances = await listInstances(client, 'garden', 'beans1', range)
        expect(instances.map((instance) => instance.id)).toEqual(['beans1_20261012T080000Z'])
        expect(fetch.requests[0].url.pathname).toBe('/calendar/v3/calendars/garden/events/beans1/instances')
        expect(query(fetch.requests[0])).toEqual({ timeMin: '2026-10-01T00:00:00.000Z', timeMax: '2026-11-01T00:00:00.000Z', maxResults: '2500' })
        expect(query(fetch.requests[1]).pageToken).toBe('next')
    })
})

describe('respondToInvitation', () => {
    const invitation: CalendarEvent = {
        ...event,
        attendees: [
            { email: 'organiser@example.com', organizer: true, responseStatus: 'accepted' },
            { email: 'gardener@example.com', self: true, responseStatus: 'needsAction' },
            { email: 'cook@example.com', responseStatus: 'tentative' },
        ],
    }

    it('sends every guest, with only the person’s own answer changed', async () => {
        const { fetch, client } = setup(json(invitation))
        await respondToInvitation(client, 'gardener@example.com', invitation, 'accepted', { etag: '"etag-1"' })
        const [request] = fetch.requests
        expect(request.method).toBe('PATCH')
        expect(request.headers['if-match']).toBe('"etag-1"')
        expect(await bodyJson(request)).toEqual({
            attendees: [
                { email: 'organiser@example.com', organizer: true, responseStatus: 'accepted' },
                { email: 'gardener@example.com', self: true, responseStatus: 'accepted' },
                { email: 'cook@example.com', responseStatus: 'tentative' },
            ],
        })
    })

    it('sends only the person’s own entry when Google left other guests out', async () => {
        const { fetch, client } = setup(json(invitation))
        const partial: CalendarEvent = { ...event, attendeesOmitted: true, attendees: [{ email: 'gardener@example.com', self: true, responseStatus: 'needsAction' }] }
        await respondToInvitation(client, 'gardener@example.com', partial, 'declined')
        expect(await bodyJson(fetch.requests[0])).toEqual({
            attendees: [{ email: 'gardener@example.com', self: true, responseStatus: 'declined' }],
            attendeesOmitted: true,
        })
    })

    it('refuses an event the person is not a guest of, without a request', async () => {
        const { fetch, client } = setup()
        const error = await respondToInvitation(client, 'garden', event, 'tentative').catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(GoogleError)
        expect(fetch.requests).toHaveLength(0)
    })
})

describe('freeBusy', () => {
    it('posts the range and items, and gives the busy times by calendar', async () => {
        const busy = { 'gardener@example.com': { busy: [{ start: '2026-10-12T08:00:00Z', end: '2026-10-12T09:00:00Z' }] }, 'cook@example.com': { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] } }
        const { fetch, client } = setup(json({ kind: 'calendar#freeBusy', calendars: busy }))
        const result = await freeBusy(client, { timeMin: new Date('2026-10-12T00:00:00Z'), timeMax: new Date('2026-10-13T00:00:00Z'), items: ['gardener@example.com', 'cook@example.com'] })
        expect(result).toEqual(busy)
        const [request] = fetch.requests
        expect(request.method).toBe('POST')
        expect(request.url.toString()).toBe('https://www.googleapis.com/calendar/v3/freeBusy')
        expect(await bodyJson(request)).toEqual({
            timeMin: '2026-10-12T00:00:00.000Z',
            timeMax: '2026-10-13T00:00:00.000Z',
            items: [{ id: 'gardener@example.com' }, { id: 'cook@example.com' }],
        })
    })
})

describe('listLabels', () => {
    it('reads the calendar’s labelProperties', async () => {
        const { fetch, client } = setup(
            json({
                labelProperties: {
                    eventLabels: [
                        { id: '42617328-8756-4291-8273-192837465647', backgroundColor: '#039be5', name: 'Garden jobs' },
                        { id: '22222222-3333-4444-5555-666666666666', backgroundColor: '#33b679' },
                    ],
                },
            }),
        )
        await expect(listLabels(client, 'gardener@example.com')).resolves.toEqual([
            { id: '42617328-8756-4291-8273-192837465647', name: 'Garden jobs', color: '#039be5' },
            { id: '22222222-3333-4444-5555-666666666666', name: '', color: '#33b679' },
        ])
        const [request] = fetch.requests
        expect(request.url.pathname).toBe('/calendar/v3/calendars/gardener%40example.com')
        expect(query(request)).toEqual({ fields: 'labelProperties' })
    })

    it('gives none for a calendar without labels', async () => {
        const { client } = setup(json({}))
        await expect(listLabels(client, 'garden')).resolves.toEqual([])
    })
})
