import { describe, expect, it, vi } from 'vitest'
import { bodyJson, bodyText, fakeFetch, googleError, json } from './fake-fetch'
import { backoff, createGoogleClient, GoogleError, listAllPages, type AccessTokenSource } from './http'

const API = 'https://www.googleapis.com/calendar/v3'

/** Tokens that hand out `token-1`, then `token-2`, `token-3` on each refresh. */
function tokens(): AccessTokenSource & { refreshes: number } {
    let current = 'token-1'
    const source = {
        refreshes: 0,
        token: async () => current,
        refresh: async () => {
            source.refreshes++
            current = `token-${source.refreshes + 1}`
            return current
        },
    }
    return source
}

function setup(...replies: Parameters<typeof fakeFetch>) {
    const fetch = fakeFetch(...replies)
    const source = tokens()
    const waits: number[] = []
    const client = createGoogleClient({
        tokens: source,
        fetch,
        sleep: async (ms) => {
            waits.push(ms)
        },
        random: () => 0.5,
    })
    return { fetch, source, waits, client }
}

describe('a request', () => {
    it('carries the access token, the query and a JSON body', async () => {
        const { fetch, client } = setup(json({ id: 'beans' }))
        const result = await client.request<{ id: string }>(`${API}/calendars/garden/events`, {
            method: 'POST',
            query: { conferenceDataVersion: 1, supportsAttachments: true, sendUpdates: undefined, eventTypes: ['default', 'focusTime'] },
            json: { summary: 'Water the beans' },
            headers: { 'If-Match': '"etag-1"' },
        })
        expect(result).toEqual({ id: 'beans' })
        const [request] = fetch.requests
        expect(request.method).toBe('POST')
        expect(request.url.pathname).toBe('/calendar/v3/calendars/garden/events')
        expect(request.url.searchParams.toString()).toBe('conferenceDataVersion=1&supportsAttachments=true&eventTypes=default&eventTypes=focusTime')
        expect(request.headers).toMatchObject({ authorization: 'Bearer token-1', 'content-type': 'application/json', 'if-match': '"etag-1"' })
        expect(await bodyJson(request)).toEqual({ summary: 'Water the beans' })
    })

    it('adds the query to one the URL already has', async () => {
        const { fetch, client } = setup(json({}))
        await client.request('https://www.googleapis.com/upload/drive/v3/files?upload_id=garden', { query: { fields: 'id' } })
        expect(fetch.requests[0].url.search).toBe('?upload_id=garden&fields=id')
    })

    it('sends a raw body with its content type', async () => {
        const { fetch, client } = setup(json({}))
        await client.request(`${API}/x`, { method: 'PUT', body: 'kitchen', contentType: 'text/plain' })
        expect(fetch.requests[0].headers['content-type']).toBe('text/plain')
        expect(await bodyText(fetch.requests[0])).toBe('kitchen')
    })

    it('gives undefined for 204 and for an empty body', async () => {
        const { client } = setup(new Response(null, { status: 204 }), new Response('', { status: 200 }))
        await expect(client.request(`${API}/x`, { method: 'DELETE' })).resolves.toBeUndefined()
        await expect(client.request(`${API}/x`)).resolves.toBeUndefined()
    })

    it('hands back the response itself when asked', async () => {
        const { client } = setup(new Response(null, { status: 200, headers: { Location: 'https://example.com/session' } }))
        const response = await client.request<Response>(`${API}/x`, { responseType: 'response' })
        expect(response.headers.get('Location')).toBe('https://example.com/session')
    })

    it('calls fetch as a plain function, as a browser’s fetch needs', async () => {
        const seen: unknown[] = []
        const fetch = function (this: unknown) {
            seen.push(this)
            return Promise.resolve(json({}))
        } as unknown as typeof globalThis.fetch
        await createGoogleClient({ tokens: tokens(), fetch }).request(`${API}/x`)
        expect(seen).toEqual([undefined])
    })
})

describe('an expired token', () => {
    it('is refreshed once, and the request tried again with the new token', async () => {
        const { fetch, source, client } = setup(googleError(401, 'authError', 'Invalid Credentials'), json({ id: 'garden' }))
        await expect(client.request(`${API}/calendars/garden`)).resolves.toEqual({ id: 'garden' })
        expect(source.refreshes).toBe(1)
        expect(fetch.requests.map((request) => request.headers.authorization)).toEqual(['Bearer token-1', 'Bearer token-2'])
    })

    it('is an auth error when the new token is refused too', async () => {
        const { fetch, source, client } = setup(googleError(401, 'authError'), googleError(401, 'authError'))
        const error = await client.request(`${API}/x`).catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(GoogleError)
        expect(error).toMatchObject({ kind: 'auth', status: 401, reason: 'authError', message: 'Google no longer accepts this account’s sign-in. Connect it again.' })
        expect(source.refreshes).toBe(1)
        expect(fetch.requests).toHaveLength(2)
    })

    it('passes on a failed refresh as it is', async () => {
        const fetch = fakeFetch(googleError(401, 'authError'))
        const revoked = new GoogleError('Google no longer accepts this account’s sign-in. Connect it again.', { status: 400, kind: 'auth', reason: 'revoked' })
        const client = createGoogleClient({ tokens: { token: async () => 'token-1', refresh: () => Promise.reject(revoked) }, fetch })
        await expect(client.request(`${API}/x`)).rejects.toBe(revoked)
        expect(fetch.requests).toHaveLength(1)
    })
})

describe('retries', () => {
    it('back off on 429 and on a rate-limit 403, then succeed', async () => {
        const { fetch, waits, client } = setup(
            googleError(429, 'rateLimitExceeded'),
            googleError(403, 'userRateLimitExceeded'),
            googleError(403, 'rateLimitExceeded'),
            json({ ok: true }),
        )
        await expect(client.request(`${API}/x`)).resolves.toEqual({ ok: true })
        expect(fetch.requests).toHaveLength(4)
        // 500 ms doubled each time, plus half of the 500 ms of jitter (random gives 0.5).
        expect(waits).toEqual([750, 1250, 2250])
    })

    it('retry a server error the same way', async () => {
        const { waits, client } = setup(new Response('Bad Gateway', { status: 502 }), json({ ok: true }))
        await expect(client.request(`${API}/x`)).resolves.toEqual({ ok: true })
        expect(waits).toEqual([750])
    })

    it('stop after four retries, with a rate-limit error', async () => {
        const replies = Array.from({ length: 5 }, () => googleError(429, 'rateLimitExceeded'))
        const { fetch, waits, client } = setup(...replies)
        await expect(client.request(`${API}/x`)).rejects.toMatchObject({ kind: 'rate-limit', status: 429, message: expect.stringContaining('too many requests') })
        expect(fetch.requests).toHaveLength(5)
        expect(waits).toHaveLength(4)
    })

    it('stop after the retries given, with a server error', async () => {
        const fetch = fakeFetch(...Array.from({ length: 2 }, () => new Response('', { status: 500 })))
        const client = createGoogleClient({ tokens: tokens(), fetch, sleep: async () => {}, maxRetries: 1 })
        await expect(client.request(`${API}/x`)).rejects.toMatchObject({ kind: 'server', status: 500 })
        expect(fetch.requests).toHaveLength(2)
    })

    it('stop when the caller aborts during a wait', async () => {
        const controller = new AbortController()
        const fetch = fakeFetch(googleError(429, 'rateLimitExceeded'))
        const client = createGoogleClient({
            tokens: tokens(),
            fetch,
            sleep: async () => controller.abort(),
        })
        const error = await client.request(`${API}/x`, { signal: controller.signal }).catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(DOMException)
        expect((error as DOMException).name).toBe('AbortError')
        expect(fetch.requests).toHaveLength(1)
    })

    it('grow exponentially with jitter', () => {
        expect([0, 1, 2, 3].map((retry) => backoff(retry, () => 0))).toEqual([500, 1000, 2000, 4000])
        expect(backoff(0, () => 0.999)).toBe(999)
    })
})

describe('errors', () => {
    it('reports a network failure as offline, without retrying', async () => {
        const { fetch, waits, client } = setup(new TypeError('Failed to fetch'))
        const error = await client.request(`${API}/x`).catch((caught: unknown) => caught)
        expect(error).toMatchObject({ kind: 'offline', status: 0, message: 'Google can’t be reached. Check your connection, then try again.' })
        expect(fetch.requests).toHaveLength(1)
        expect(waits).toEqual([])
    })

    it('passes on an abort as it is', async () => {
        const controller = new AbortController()
        controller.abort()
        const { client } = setup()
        const error = await client.request(`${API}/x`, { signal: controller.signal }).catch((caught: unknown) => caught)
        expect(error).toBe(controller.signal.reason)
        expect((error as DOMException).name).toBe('AbortError')
    })

    it.each([
        [403, 'forbidden', 'forbidden'],
        [403, 'insufficientPermissions', 'forbidden'],
        [404, 'notFound', 'not-found'],
        [410, 'deleted', 'gone'],
        [412, 'conditionNotMet', 'precondition'],
        [400, 'invalid', 'bad-request'],
        [409, 'duplicate', 'bad-request'],
    ] as const)('maps %i %s to kind %s', async (status, reason, kind) => {
        const { fetch, client } = setup(googleError(status, reason))
        await expect(client.request(`${API}/x`)).rejects.toMatchObject({ status, reason, kind })
        expect(fetch.requests).toHaveLength(1)
    })

    it('keeps Google’s error body', async () => {
        const { client } = setup(googleError(412, 'conditionNotMet', 'Precondition Failed'))
        const error = (await client.request(`${API}/x`).catch((caught: unknown) => caught)) as GoogleError
        expect(error.body).toEqual({ code: 412, message: 'Precondition Failed', errors: [{ reason: 'conditionNotMet', message: 'Precondition Failed', domain: 'global' }] })
        expect(error.message).toBe('This changed in Google after it was loaded here. Reload it, then make your change again.')
    })

    it('says which API to turn on when the person’s Cloud project has it off', async () => {
        const { client } = setup(googleError(403, 'accessNotConfigured'), googleError(403, 'accessNotConfigured'))
        await expect(client.request(`${API}/x`)).rejects.toMatchObject({ message: expect.stringContaining('Google Calendar API is turned off') })
        await expect(client.request('https://tasks.googleapis.com/tasks/v1/users/@me/lists')).rejects.toMatchObject({ message: expect.stringContaining('Google Tasks API') })
    })

    it('gives Google’s own words for a refused value', async () => {
        const { client } = setup(googleError(400, 'timeRangeEmpty', 'The specified time range is empty.'))
        await expect(client.request(`${API}/x`)).rejects.toMatchObject({ message: 'Google didn’t accept that request. It said: The specified time range is empty.' })
    })

    it('copes with an error answer that is not JSON', async () => {
        const { client } = setup(new Response('<html>Not Found</html>', { status: 404 }))
        await expect(client.request(`${API}/x`)).rejects.toMatchObject({ kind: 'not-found', body: undefined, reason: undefined })
    })
})

describe('listAllPages', () => {
    it('follows nextPageToken to the last page', async () => {
        const { fetch, client } = setup(
            json({ items: [{ id: 'garden' }, { id: 'kitchen' }], nextPageToken: 'page-2' }),
            json({ items: [{ id: 'shed' }], nextPageToken: 'page-3' }),
            json({}),
        )
        const items = await listAllPages<{ id: string }>(client, `${API}/users/me/calendarList`, { maxResults: 250 })
        expect(items.map((item) => item.id)).toEqual(['garden', 'kitchen', 'shed'])
        expect(fetch.requests.map((request) => request.url.search)).toEqual(['?maxResults=250', '?maxResults=250&pageToken=page-2', '?maxResults=250&pageToken=page-3'])
    })

    it('passes the signal to every page', async () => {
        const controller = new AbortController()
        const { fetch, client } = setup(json({ items: [], nextPageToken: 'page-2' }), json({ items: [] }))
        await listAllPages(client, `${API}/x`, undefined, controller.signal)
        expect(fetch.requests.map((request) => request.signal)).toEqual([controller.signal, controller.signal])
    })
})

describe('the default sleep', () => {
    it('waits with a timer', async () => {
        vi.useFakeTimers()
        try {
            const fetch = fakeFetch(googleError(429, 'rateLimitExceeded'), json({ ok: true }))
            const client = createGoogleClient({ tokens: tokens(), fetch, random: () => 0 })
            const pending = client.request(`${API}/x`)
            await vi.advanceTimersByTimeAsync(499)
            expect(fetch.requests).toHaveLength(1)
            await vi.advanceTimersByTimeAsync(1)
            await expect(pending).resolves.toEqual({ ok: true })
            expect(fetch.requests).toHaveLength(2)
        } finally {
            vi.useRealTimers()
        }
    })
})
