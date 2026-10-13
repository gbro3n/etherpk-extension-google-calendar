/**
 * The one way the extension calls Google's REST APIs (Calendar, Drive and Tasks) from the browser.
 *
 * - Every request carries the account's access token. A `401` means the token expired early or was
 *   revoked, so the client asks for a fresh one once and tries again. A second `401` is final.
 * - Google asks clients to back off and retry when it is busy: `429`, a `403` whose reason is a rate
 *   limit, and any `5xx`. Those are retried with exponential backoff and jitter, up to `maxRetries`.
 * - A `fetch` that rejects with a `TypeError` means the network failed. It is reported at once as
 *   `offline` rather than retried, so the person learns quickly and the caller can show stale data.
 * - Every other refusal becomes a `GoogleError` whose `kind` says what the UI should do next, and
 *   whose message is written for the person, not the developer.
 */
import type { GoogleErrorBody } from './types'

/** What went wrong, in terms of what the person can do about it. */
export type GoogleErrorKind =
    | 'auth'
    | 'forbidden'
    | 'not-found'
    | 'gone'
    | 'precondition'
    | 'rate-limit'
    | 'bad-request'
    | 'offline'
    | 'server'

/** The message each kind carries unless a more exact one applies. */
const MESSAGES: Record<GoogleErrorKind, string> = {
    auth: 'Google no longer accepts this account’s sign-in. Connect it again.',
    forbidden: 'Google refused that. This account may not have permission to do it.',
    'not-found': 'Google can’t find that. It may have been deleted, or this account may no longer have access to it.',
    gone: 'That has already been deleted in Google.',
    precondition: 'This changed in Google after it was loaded here. Reload it, then make your change again.',
    'rate-limit': 'Google is getting too many requests from this account. Wait a minute, then try again.',
    'bad-request': 'Google didn’t accept that request.',
    offline: 'Google can’t be reached. Check your connection, then try again.',
    server: 'Google had a problem with that request. Try again in a few minutes.',
}

/** The reasons Google gives on a `403` that means "slow down" rather than "not allowed". */
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded'])

/** The first wait before a retry. Each retry after it waits twice as long, plus up to this again at random. */
const BACKOFF_BASE_MS = 500

export class GoogleError extends Error {
    /** The HTTP status, or `0` when no answer came. */
    readonly status: number
    readonly kind: GoogleErrorKind
    /** Google's own reason, such as `forbiddenForNonOrganizer`, when it gave one. */
    readonly reason?: string
    readonly body?: GoogleErrorBody

    constructor(message: string, options: { status: number; kind: GoogleErrorKind; reason?: string; body?: GoogleErrorBody; cause?: unknown }) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause })
        this.name = 'GoogleError'
        this.status = options.status
        this.kind = options.kind
        this.reason = options.reason
        this.body = options.body
    }
}

/** Where an account's access token comes from. `refresh` gets a new one even if the held one looks valid. */
export interface AccessTokenSource {
    token(): Promise<string>
    refresh(): Promise<string>
}

export interface RequestOptions {
    method?: string
    /** Added to the URL. `undefined` values are left out, and an array adds the name once per value. */
    query?: Record<string, string | number | boolean | undefined | readonly string[]>
    /** Sent as the JSON body, with `Content-Type: application/json`. */
    json?: unknown
    /** Sent as it is, when `json` is not given. */
    body?: BodyInit
    contentType?: string
    headers?: Record<string, string>
    signal?: AbortSignal
    /** `response` hands back the `Response` itself, for a caller that needs its headers. */
    responseType?: 'json' | 'response'
}

export interface GoogleClient {
    request<T>(url: string, options?: RequestOptions): Promise<T>
}

export interface GoogleClientOptions {
    tokens: AccessTokenSource
    fetch: typeof fetch
    sleep?: (ms: number) => Promise<void>
    /** A number from 0 up to 1, for the jitter in each backoff. */
    random?: () => number
    maxRetries?: number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createGoogleClient(options: GoogleClientOptions): GoogleClient {
    // Held apart from `options` because a browser's `fetch` called as a method of any object other
    // than `window` throws "Illegal invocation", which would look like being offline.
    const send = options.fetch
    const sleep = options.sleep ?? defaultSleep
    const random = options.random ?? Math.random
    const maxRetries = options.maxRetries ?? 4

    async function attempt(url: string, init: RequestOptions, token: string): Promise<Response> {
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...init.headers }
        let body = init.body
        if (init.json !== undefined) {
            body = JSON.stringify(init.json)
            headers['Content-Type'] = 'application/json'
        } else if (init.contentType) {
            headers['Content-Type'] = init.contentType
        }
        try {
            return await send(url, { method: init.method ?? 'GET', headers, body, signal: init.signal })
        } catch (error) {
            // An abort is the caller's own doing, so it goes back to them unchanged.
            if (isAbort(error, init.signal)) throw error
            // A browser reports an answer it blocked for CORS the same way, but from Google that is
            // rare enough that "can't be reached" is the useful reading.
            if (error instanceof TypeError) throw new GoogleError(MESSAGES.offline, { status: 0, kind: 'offline', cause: error })
            throw error
        }
    }

    async function request<T>(url: string, init: RequestOptions = {}): Promise<T> {
        const target = withQuery(url, init.query)
        let token = await options.tokens.token()
        let refreshed = false
        let retries = 0
        for (;;) {
            const response = await attempt(target, init, token)
            if (response.ok) return (await readBody(response, init.responseType)) as T
            const body = await readErrorBody(response)
            const reason = body?.errors?.[0]?.reason
            if (response.status === 401 && !refreshed) {
                refreshed = true
                token = await options.tokens.refresh()
                continue
            }
            const kind = kindFor(response.status, reason)
            if ((kind === 'rate-limit' || kind === 'server') && retries < maxRetries) {
                await sleep(backoff(retries, random))
                init.signal?.throwIfAborted()
                retries++
                continue
            }
            throw new GoogleError(messageFor(kind, reason, body, target), { status: response.status, kind, reason, body })
        }
    }

    return { request }
}

/**
 * Read every page of a Google list method into one array. Calendar, Drive and Tasks all page the
 * same way: `items`, and a `nextPageToken` while more remain.
 */
export async function listAllPages<Item>(
    client: GoogleClient,
    url: string,
    query: RequestOptions['query'],
    signal?: AbortSignal,
): Promise<Item[]> {
    const items: Item[] = []
    let pageToken: string | undefined
    do {
        const page = await client.request<{ items?: Item[]; nextPageToken?: string } | undefined>(url, { query: { ...query, pageToken }, signal })
        items.push(...(page?.items ?? []))
        pageToken = page?.nextPageToken
    } while (pageToken)
    return items
}

/** The wait before retry number `retry` (from 0): 500 ms, 1 s, 2 s, 4 s, each plus up to 500 ms at random. */
export function backoff(retry: number, random: () => number): number {
    return BACKOFF_BASE_MS * 2 ** retry + Math.floor(random() * BACKOFF_BASE_MS)
}

function withQuery(url: string, query: RequestOptions['query']): string {
    if (!query) return url
    const target = new URL(url)
    for (const [name, value] of Object.entries(query)) {
        if (value === undefined) continue
        if (Array.isArray(value)) for (const item of value) target.searchParams.append(name, item)
        else target.searchParams.append(name, String(value))
    }
    return target.toString()
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
    return Boolean(signal?.aborted) || (error instanceof DOMException && error.name === 'AbortError')
}

async function readBody(response: Response, responseType: RequestOptions['responseType']): Promise<unknown> {
    if (responseType === 'response') return response
    if (response.status === 204) return undefined
    const text = await response.text()
    if (text === '') return undefined
    try {
        return JSON.parse(text)
    } catch (error) {
        throw new GoogleError('Google sent an answer that couldn’t be read. Try again in a few minutes.', { status: response.status, kind: 'server', cause: error })
    }
}

/** Google's error answer, `{ error: { code, message, errors: [{ reason }] } }`, when it sent one. */
async function readErrorBody(response: Response): Promise<GoogleErrorBody | undefined> {
    try {
        const parsed: unknown = JSON.parse(await response.text())
        const error = (parsed as { error?: unknown } | null)?.error
        return typeof error === 'object' && error !== null ? (error as GoogleErrorBody) : undefined
    } catch {
        return undefined
    }
}

function kindFor(status: number, reason: string | undefined): GoogleErrorKind {
    if (status === 401) return 'auth'
    if (status === 429 || (status === 403 && reason !== undefined && RATE_LIMIT_REASONS.has(reason))) return 'rate-limit'
    if (status === 403) return 'forbidden'
    if (status === 404) return 'not-found'
    if (status === 410) return 'gone'
    if (status === 412) return 'precondition'
    if (status >= 500) return 'server'
    return 'bad-request'
}

/** The API a URL belongs to, by the name the Google Cloud console gives it. */
function apiName(url: string): string {
    if (url.includes('/drive/')) return 'Google Drive API'
    if (url.includes('tasks.googleapis.com')) return 'Google Tasks API'
    return 'Google Calendar API'
}

function messageFor(kind: GoogleErrorKind, reason: string | undefined, body: GoogleErrorBody | undefined, url: string): string {
    if (kind === 'forbidden') {
        // The person made their own OAuth client, so an API left off in their Google Cloud project
        // is a likely first problem. Google's own message names the project, not the next step.
        if (reason === 'accessNotConfigured') return `The ${apiName(url)} is turned off in your Google Cloud project. Turn it on there, wait a few minutes, then try again.`
        if (reason === 'insufficientPermissions') return 'This account didn’t allow everything the extension asks for. Connect it again, and allow each permission.'
        if (reason === 'forbiddenForNonOrganizer') return 'Only the event’s organiser can change that.'
        if (reason === 'requiredAccessLevel') return 'This account can’t change events on this calendar.'
    }
    // A `400` is mostly a value Google refused, and its own words say which one.
    if (kind === 'bad-request' && body?.message) return `${MESSAGES['bad-request']} It said: ${body.message}`
    return MESSAGES[kind]
}
