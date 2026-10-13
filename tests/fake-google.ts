/**
 * A stand-in for Google's sign-in and Calendar, Drive and Tasks APIs, answered inside the browser
 * test (`context.route`), so no test reaches Google. It keeps calendars and events in memory, answers
 * the requests the extension makes the way Google does, and records each write so a test can read
 * what the extension sent.
 *
 * Every name and address is a generic stand-in.
 */
import type { BrowserContext, Request, Route } from '@playwright/test'

export interface FakeEvent {
    id: string
    etag: string
    status?: string
    summary?: string
    description?: string
    location?: string
    colorId?: string
    start: { date?: string; dateTime?: string; timeZone?: string }
    end: { date?: string; dateTime?: string; timeZone?: string }
    recurrence?: string[]
    recurringEventId?: string
    originalStartTime?: { date?: string; dateTime?: string }
    attendees?: { email: string; self?: boolean; organizer?: boolean; responseStatus?: string; displayName?: string }[]
    organizer?: { email?: string; self?: boolean }
    reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] }
    conferenceData?: unknown
    [field: string]: unknown
}

export interface FakeCalendar {
    id: string
    summary: string
    backgroundColor: string
    selected?: boolean
    primary?: boolean
    accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader'
}

export interface FakeTask {
    id: string
    title: string
    status: 'needsAction' | 'completed'
    due?: string
    notes?: string
    [field: string]: unknown
}

export interface FakeAccount {
    email: string
    calendars: FakeCalendar[]
    /** Events by calendar id. */
    events: Record<string, FakeEvent[]>
    /** Google Tasks by list, each list's title and tasks. */
    tasks?: Record<string, { title: string; items: FakeTask[] }>
}

export interface Write {
    method: string
    url: URL
    body: unknown
    headers: Record<string, string>
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } })

/** An unsigned ID token carrying an email address, as Google's token endpoint returns one. */
export function idToken(email: string): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${part({ alg: 'none' })}.${part({ email, sub: email })}.`
}

export class FakeGoogle {
    readonly accounts = new Map<string, FakeAccount>()
    /** Which account signs in next, by its address. */
    nextSignIn = ''
    /** Refresh tokens Google no longer accepts. */
    readonly revoked = new Set<string>()
    /** Answer every Calendar request as if offline. */
    offline = false
    /** Refuse Tasks requests, as Google does when the Tasks API is not turned on in the project. */
    tasksRefused = false
    readonly writes: Write[] = []
    /** The scopes the last sign-in asked for, which the code exchange grants. */
    #scopes = ''
    #counter = 0

    addAccount(account: FakeAccount): void {
        this.accounts.set(account.email, account)
        this.nextSignIn ||= account.email
    }

    /** The account a request's access token belongs to: tokens are `access-<email>`. */
    #accountOf(request: Request): FakeAccount | undefined {
        const token = request.headers().authorization?.replace(/^Bearer access-/, '')
        return token ? this.accounts.get(token) : undefined
    }

    async install(context: BrowserContext, origin: string): Promise<void> {
        // Sign-in: straight back to the Client's return page with a code naming the account.
        await context.route('https://accounts.google.com/**', async (route) => {
            const asked = new URL(route.request().url())
            this.#scopes = asked.searchParams.get('scope') ?? ''
            const back = new URL('/extension-sign-in', origin)
            back.searchParams.set('code', `code-${asked.searchParams.get('login_hint') || this.nextSignIn}`)
            back.searchParams.set('state', asked.searchParams.get('state') ?? '')
            await route.fulfill({ status: 302, headers: { location: back.href } })
        })
        await context.route('https://oauth2.googleapis.com/**', async (route) => {
            const request = route.request()
            if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
            const url = new URL(request.url())
            const form = new URLSearchParams(request.postData() ?? '')
            if (url.pathname === '/revoke') {
                this.revoked.add(form.get('token') ?? '')
                return json(route, 200, {})
            }
            if (form.get('grant_type') === 'authorization_code') {
                const email = (form.get('code') ?? '').replace(/^code-/, '')
                return json(route, 200, {
                    access_token: `access-${email}`,
                    expires_in: 3600,
                    refresh_token: `refresh-${email}`,
                    scope: this.#scopes || 'openid email https://www.googleapis.com/auth/calendar.events',
                    id_token: idToken(email),
                    token_type: 'Bearer',
                })
            }
            const refresh = form.get('refresh_token') ?? ''
            if (this.revoked.has(refresh)) return json(route, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
            return json(route, 200, { access_token: `access-${refresh.replace(/^refresh-/, '')}`, expires_in: 3600, scope: 'openid email', token_type: 'Bearer' })
        })
        // One route for the host: Playwright tries the last route registered first, so a second,
        // narrower one for uploads would need registering after this.
        await context.route('https://tasks.googleapis.com/**', (route) => this.#tasks(route))
        await context.route('https://www.googleapis.com/**', (route) => (new URL(route.request().url()).pathname.startsWith('/upload/') ? this.#upload(route) : this.#calendar(route)))
    }

    async #calendar(route: Route): Promise<void> {
        const request = route.request()
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
        if (this.offline) return route.abort('internetdisconnected')
        const account = this.#accountOf(request)
        if (!account) return json(route, 401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } })
        const url = new URL(request.url())
        const path = decodeURIComponent(url.pathname).replace(/^\/calendar\/v3/, '')
        const method = request.method()
        if (method !== 'GET') {
            const body = request.postData() ? JSON.parse(request.postData()!) : undefined
            this.writes.push({ method, url, body, headers: request.headers() })
        }

        if (path === '/users/me/calendarList') return json(route, 200, { items: account.calendars.map((calendar) => ({ ...calendar, defaultReminders: [{ method: 'popup', minutes: 10 }] })) })
        if (path === '/colors') return json(route, 200, { calendar: {}, event: { '11': { background: '#dc2127', foreground: '#1d1d1d' } } })
        if (path === '/users/me/settings') return json(route, 200, { items: [{ id: 'format24HourTime', value: 'true' }, { id: 'weekStart', value: '1' }] })
        if (path === '/freeBusy') {
            const body = JSON.parse(request.postData() ?? '{}') as { items: { id: string }[] }
            const calendars: Record<string, unknown> = {}
            for (const { id } of body.items) calendars[id] = this.busy.get(id) ? { busy: this.busy.get(id) } : { busy: [], errors: id.endsWith('@unseen.example') ? [{ reason: 'notFound' }] : undefined }
            return json(route, 200, { calendars })
        }

        const calendarMatch = /^\/calendars\/([^/]+)(\/events(?:\/([^/]+))?(\/instances|\/move)?)?$/.exec(path)
        if (!calendarMatch) return json(route, 404, { error: { code: 404, message: 'Not Found' } })
        const [, calendarId, eventsPart, eventId, action] = calendarMatch
        if (!eventsPart) return json(route, 200, { id: calendarId })
        const events = (account.events[calendarId] ??= [])

        if (!eventId && method === 'GET') {
            const timeMin = url.searchParams.get('timeMin')
            const timeMax = url.searchParams.get('timeMax')
            // singleEvents: a series itself is never listed, only its occurrences.
            const shown = events.filter((event) => !event.recurrence && event.status !== 'cancelled').filter((event) => {
                const start = Date.parse(event.start.dateTime ?? `${event.start.date}T00:00:00`)
                const end = Date.parse(event.end.dateTime ?? `${event.end.date}T00:00:00`)
                return (!timeMin || end > Date.parse(timeMin)) && (!timeMax || start < Date.parse(timeMax))
            })
            return json(route, 200, { items: shown })
        }
        if (!eventId && method === 'POST') {
            const body = JSON.parse(request.postData() ?? '{}') as FakeEvent
            const created: FakeEvent = { ...body, id: `made${++this.#counter}`, etag: `"e${this.#counter}"`, status: 'confirmed', organizer: { email: account.email, self: true } }
            if (body.conferenceData) created.conferenceData = { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] }
            events.push(created)
            return json(route, 200, created)
        }
        const index = events.findIndex((event) => event.id === eventId)
        if (index === -1) return json(route, 404, { error: { code: 404, message: 'Not Found' } })
        const event = events[index]
        if (action === '/instances') {
            const timeMax = url.searchParams.get('timeMax')
            return json(route, 200, { items: events.filter((candidate) => candidate.recurringEventId === eventId && (!timeMax || Date.parse(candidate.start.dateTime ?? candidate.start.date!) < Date.parse(timeMax))) })
        }
        if (action === '/move') {
            const destination = url.searchParams.get('destination') ?? ''
            events.splice(index, 1)
            const moved = { ...event, etag: `"e${++this.#counter}"` }
            ;(account.events[destination] ??= []).push(moved)
            return json(route, 200, moved)
        }
        if (method === 'GET') return json(route, 200, event)
        const ifMatch = request.headers()['if-match']
        if (ifMatch && ifMatch !== event.etag) return json(route, 412, { error: { code: 412, message: 'Precondition Failed', errors: [{ reason: 'conditionNotMet' }] } })
        if (method === 'DELETE') {
            events[index] = { ...event, status: 'cancelled', etag: `"e${++this.#counter}"` }
            return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } })
        }
        if (method === 'PATCH' || method === 'PUT') {
            const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>
            const next: FakeEvent = { ...event, etag: `"e${++this.#counter}"` }
            for (const [key, value] of Object.entries(body)) {
                if (value === null) delete next[key]
                else next[key] = value
            }
            events[index] = next
            return json(route, 200, next)
        }
        return json(route, 405, { error: { code: 405, message: 'Method not allowed' } })
    }

    async #tasks(route: Route): Promise<void> {
        const request = route.request()
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
        const account = this.#accountOf(request)
        if (!account) return json(route, 401, { error: { code: 401, message: 'Invalid Credentials' } })
        if (this.tasksRefused) {
            return json(route, 403, { error: { code: 403, message: 'Google Tasks API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } })
        }
        const url = new URL(request.url())
        const path = decodeURIComponent(url.pathname).replace(/^\/tasks\/v1/, '')
        const method = request.method()
        const body = request.postData() ? JSON.parse(request.postData()!) : undefined
        if (method !== 'GET') this.writes.push({ method: `TASK ${method}`, url, body, headers: request.headers() })
        const lists = (account.tasks ??= {})
        if (path === '/users/@me/lists') return json(route, 200, { items: Object.entries(lists).map(([id, list]) => ({ id, title: list.title })) })
        const match = /^\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(path)
        if (!match || !lists[match[1]]) return json(route, 404, { error: { code: 404, message: 'Not Found' } })
        const items = lists[match[1]].items
        if (!match[2] && method === 'GET') {
            // As Google filters: a due range leaves out tasks with no due date, and completed tasks
            // are listed unless showCompleted is false.
            const showCompleted = url.searchParams.get('showCompleted') !== 'false'
            const dueMin = url.searchParams.get('dueMin')
            const dueMax = url.searchParams.get('dueMax')
            const listed = items.filter(
                (task) => (showCompleted || task.status !== 'completed') && (!dueMin || (task.due !== undefined && task.due >= dueMin)) && (!dueMax || (task.due !== undefined && task.due <= dueMax)),
            )
            return json(route, 200, { items: listed })
        }
        if (!match[2] && method === 'POST') {
            const parent = url.searchParams.get('parent')
            const made = { ...body, id: `task${++this.#counter}`, status: body.status ?? 'needsAction', ...(parent ? { parent } : {}) } as FakeTask
            items.push(made)
            return json(route, 200, made)
        }
        const index = items.findIndex((task) => task.id === match[2])
        if (index === -1) return json(route, 404, { error: { code: 404, message: 'Not Found' } })
        if (method === 'DELETE') {
            items.splice(index, 1)
            return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } })
        }
        items[index] = { ...items[index], ...body }
        return json(route, 200, items[index])
    }

    /** Busy periods by calendar id or address, for Find a time. */
    readonly busy = new Map<string, { start: string; end: string }[]>()

    async #upload(route: Route): Promise<void> {
        const request = route.request()
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
        this.writes.push({ method: 'UPLOAD', url: new URL(request.url()), body: request.postData()?.length ?? 0, headers: request.headers() })
        return json(route, 200, { id: 'drivefile1', name: 'Seed list.txt', mimeType: 'text/plain', webViewLink: 'https://drive.google.com/file/d/drivefile1/view', iconLink: 'https://drive-thirdparty.googleusercontent.com/16/type/text/plain' })
    }

    /** The writes to Google so far, of a method, for a test to read. */
    sent(method: string): Write[] {
        return this.writes.filter((write) => write.method === method)
    }
}
