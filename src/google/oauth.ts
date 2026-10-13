/**
 * Signing in to Google with the person's own OAuth client, from the browser alone.
 *
 * The flow is the authorization code flow with PKCE (RFC 7636). The person's OAuth client is of the
 * "Web application" type, and Google's token endpoint wants that client's secret even when PKCE is
 * used, so the secret is sent too. It is the person's own secret for their own client, kept with
 * them, so sending it from their browser gives nothing away to anyone else. Google's token and
 * revoke endpoints answer browsers (CORS), so no server stands in between.
 *
 * Every function takes `fetch`, the clock and the random source as parameters, so tests use fakes.
 */

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

/**
 * What the calendar asks for: the person's address (to label the account), their events, their
 * calendar list, calendars (for event labels) and settings, and the Drive files the extension
 * itself puts there (to attach to events). `drive.file` reaches only those files, not the rest of
 * the person's Drive.
 */
export const CALENDAR_SCOPES: readonly string[] = [
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.calendars.readonly',
    'https://www.googleapis.com/auth/calendar.settings.readonly',
    // When guests and the calendars the person can see are free, for Find a time (freeBusy.query).
    'https://www.googleapis.com/auth/calendar.freebusy',
    'https://www.googleapis.com/auth/drive.file',
    // Google Tasks, shown on their days as Google Calendar shows them.
    'https://www.googleapis.com/auth/tasks',
]

/** Google Tasks, asked for with the calendar scopes, so one consent covers both. */
export const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks'

/** Why a sign-in step failed, in terms of what the person can do about it. */
export type GoogleAuthErrorKind = 'revoked' | 'client' | 'offline' | 'server'

export class GoogleAuthError extends Error {
    /**
     * - `revoked`: Google no longer accepts the grant. The person connects the account again.
     * - `client`: the OAuth client's ID, secret or redirect URI is wrong. The person fixes the settings.
     * - `offline`: Google couldn't be reached.
     * - `server`: Google failed, or refused for some other reason.
     */
    readonly kind: GoogleAuthErrorKind
    /** The HTTP status, or `0` when no answer came. */
    readonly status: number
    /** Google's OAuth error code, such as `invalid_grant`, when it gave one. */
    readonly code?: string

    constructor(message: string, options: { kind: GoogleAuthErrorKind; status: number; code?: string; cause?: unknown }) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause })
        this.name = 'GoogleAuthError'
        this.kind = options.kind
        this.status = options.status
        this.code = options.code
    }
}

const OFFLINE_MESSAGE = 'Google can’t be reached. Check your connection, then try again.'
const REVOKED_MESSAGE = 'Google no longer accepts this account’s sign-in. Connect it again.'
const CLIENT_MESSAGE = 'Google didn’t accept the OAuth Client ID or Client secret. Check them in the extension’s settings, then connect again.'

type RandomBytes = (length: number) => Uint8Array

const defaultRandom: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length))

/** Bytes as base64url without padding (RFC 4648 section 5), as PKCE and JWTs use it. */
export function base64url(bytes: Uint8Array): string {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(text: string): Uint8Array {
    const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

export interface PkcePair {
    verifier: string
    challenge: string
}

/** The S256 challenge for a verifier: base64url of the SHA-256 of its ASCII bytes. */
export async function pkceChallenge(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    return base64url(new Uint8Array(digest))
}

/**
 * A new PKCE verifier and its challenge. 48 random bytes make a 64-character verifier, inside the
 * 43 to 128 characters RFC 7636 allows.
 */
export async function createPkcePair(random: RandomBytes = defaultRandom): Promise<PkcePair> {
    const verifier = base64url(random(48))
    return { verifier, challenge: await pkceChallenge(verifier) }
}

/** A new `state` value, which ties Google's redirect back to the sign-in this page started. */
export function createState(random: RandomBytes = defaultRandom): string {
    return base64url(random(24))
}

export interface AuthorizeRequest {
    clientId: string
    redirectUri: string
    scopes: readonly string[]
    state: string
    challenge: string
    /** The address of the account expected, so Google offers it first. */
    loginHint?: string
    /** Let the person pick which Google account, for adding a second one. */
    selectAccount?: boolean
}

/** The address of Google's sign-in page for a request. */
export function authorizeUrl(request: AuthorizeRequest): string {
    const url = new URL(GOOGLE_AUTHORIZE_URL)
    const params = url.searchParams
    params.set('client_id', request.clientId)
    params.set('redirect_uri', request.redirectUri)
    params.set('response_type', 'code')
    params.set('scope', request.scopes.join(' '))
    params.set('state', request.state)
    params.set('code_challenge', request.challenge)
    params.set('code_challenge_method', 'S256')
    // A refresh token, so the account keeps working after the hour an access token lasts.
    params.set('access_type', 'offline')
    // A scope asked for in a later sign-in (connecting again) keeps those already granted.
    params.set('include_granted_scopes', 'true')
    // Google gives a refresh token again, on an account already granted, only when consent is asked.
    params.set('prompt', request.selectAccount ? 'select_account consent' : 'consent')
    if (request.loginHint) params.set('login_hint', request.loginHint)
    return url.toString()
}

export interface TokenSet {
    accessToken: string
    /** Milliseconds since the epoch. */
    expiresAt: number
    /** Sent on the first exchange, and again whenever consent was asked. */
    refreshToken?: string
    /** The scopes granted, space-separated. */
    scope: string
    idToken?: string
}

/** POST a form to one of Google's OAuth endpoints. */
async function postForm(send: typeof fetch, url: string, form: Record<string, string>): Promise<Response> {
    try {
        return await send(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(form).toString(),
        })
    } catch (error) {
        if (error instanceof TypeError) throw new GoogleAuthError(OFFLINE_MESSAGE, { kind: 'offline', status: 0, cause: error })
        throw error
    }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
    try {
        const parsed: unknown = await response.json()
        return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    } catch {
        return {}
    }
}

/** The error for a refused token request, from Google's `{ error, error_description }`. */
function tokenError(status: number, body: Record<string, unknown>, step: 'exchange' | 'refresh'): GoogleAuthError {
    const code = typeof body.error === 'string' ? body.error : undefined
    if (code === 'invalid_grant') {
        // On an exchange, the code was used already or took too long. On a refresh, the grant is gone.
        const message = step === 'exchange' ? 'Google didn’t accept this sign-in. It may have taken too long. Connect the account again.' : REVOKED_MESSAGE
        return new GoogleAuthError(message, { kind: 'revoked', status, code })
    }
    if (code === 'invalid_client' || code === 'unauthorized_client') return new GoogleAuthError(CLIENT_MESSAGE, { kind: 'client', status, code })
    if (code === 'redirect_uri_mismatch') {
        return new GoogleAuthError('Google didn’t accept this page’s address as a redirect URI. Add it to the OAuth client’s Authorized redirect URIs in Google Cloud, then connect again.', { kind: 'client', status, code })
    }
    if (status >= 500) return new GoogleAuthError('Google’s sign-in service had a problem. Try again in a few minutes.', { kind: 'server', status, code })
    return new GoogleAuthError(`Google couldn’t complete the sign-in${code ? ` (${code})` : ''}. Try again, and if it keeps happening, connect the account again.`, { kind: 'server', status, code })
}

async function readTokens(response: Response, now: () => number, step: 'exchange' | 'refresh'): Promise<TokenSet> {
    const body = await readJson(response)
    if (!response.ok) throw tokenError(response.status, body, step)
    if (typeof body.access_token !== 'string') {
        throw new GoogleAuthError('Google’s sign-in answer had no access token. Try again in a few minutes.', { kind: 'server', status: response.status })
    }
    // Google gives the lifetime in seconds. An hour is its usual value, if it is ever missing.
    const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 3600
    return {
        accessToken: body.access_token,
        expiresAt: now() + lifetime * 1000,
        scope: typeof body.scope === 'string' ? body.scope : '',
        ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
        ...(typeof body.id_token === 'string' ? { idToken: body.id_token } : {}),
    }
}

/** Swap the code Google's redirect brought back for tokens. */
export async function exchangeCode(options: {
    clientId: string
    clientSecret: string
    redirectUri: string
    code: string
    verifier: string
    fetch: typeof fetch
    now?: () => number
}): Promise<TokenSet> {
    const response = await postForm(options.fetch, GOOGLE_TOKEN_URL, {
        grant_type: 'authorization_code',
        code: options.code,
        code_verifier: options.verifier,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: options.redirectUri,
    })
    return readTokens(response, options.now ?? Date.now, 'exchange')
}

/** A new access token for an account, from its refresh token. */
export async function refreshAccessToken(options: {
    clientId: string
    clientSecret: string
    refreshToken: string
    fetch: typeof fetch
    now?: () => number
}): Promise<TokenSet> {
    const response = await postForm(options.fetch, GOOGLE_TOKEN_URL, {
        grant_type: 'refresh_token',
        refresh_token: options.refreshToken,
        client_id: options.clientId,
        client_secret: options.clientSecret,
    })
    return readTokens(response, options.now ?? Date.now, 'refresh')
}

/**
 * Ask Google to forget a grant, for a disconnect. A token Google no longer knows (`invalid_token`)
 * was revoked already, which is the outcome wanted, so that counts as done.
 */
export async function revokeToken(options: { token: string; fetch: typeof fetch }): Promise<void> {
    const response = await postForm(options.fetch, GOOGLE_REVOKE_URL, { token: options.token })
    if (response.ok) return
    const body = await readJson(response)
    if (response.status === 400 && body.error === 'invalid_token') return
    if (response.status >= 500) throw new GoogleAuthError('Google’s sign-in service had a problem. Try again in a few minutes.', { kind: 'server', status: response.status })
    throw new GoogleAuthError('Google didn’t confirm that it forgot this account’s sign-in. You can remove access yourself at myaccount.google.com/permissions.', {
        kind: 'server',
        status: response.status,
        code: typeof body.error === 'string' ? body.error : undefined,
    })
}

/**
 * The address in an ID token, or null. The signature is not checked: the token came straight from
 * Google's token endpoint over TLS, and the address is used only to label the account.
 */
export function emailFromIdToken(idToken: string): string | null {
    const parts = idToken.split('.')
    if (parts.length !== 3) return null
    try {
        const payload: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])))
        const email = (payload as { email?: unknown } | null)?.email
        return typeof email === 'string' && email !== '' ? email : null
    } catch {
        return null
    }
}
