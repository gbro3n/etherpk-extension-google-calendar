import { describe, expect, it } from 'vitest'
import { bodyText, fakeFetch, json } from './fake-fetch'
import {
    authorizeUrl,
    base64url,
    CALENDAR_SCOPES,
    createPkcePair,
    createState,
    emailFromIdToken,
    exchangeCode,
    GOOGLE_AUTHORIZE_URL,
    GOOGLE_REVOKE_URL,
    GOOGLE_TOKEN_URL,
    GoogleAuthError,
    pkceChallenge,
    refreshAccessToken,
    revokeToken,
    TASKS_SCOPE,
} from './oauth'

/** The 32 octets RFC 7636 appendix B uses for its example verifier. */
const RFC_OCTETS = [
    116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
]
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

const BASE64URL = /^[A-Za-z0-9_-]+$/

/** An unsigned JWT with the given payload, shaped as Google's ID tokens are. */
function idToken(payload: Record<string, unknown>): string {
    const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)))
    return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`
}

const form = async (request: Parameters<typeof bodyText>[0]) => Object.fromEntries(new URLSearchParams(await bodyText(request)))

describe('PKCE', () => {
    it('makes the S256 challenge of RFC 7636 appendix B', async () => {
        expect(await pkceChallenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE)
    })

    it('encodes random bytes as the verifier, as RFC 7636 appendix B does', async () => {
        const pair = await createPkcePair(() => Uint8Array.from(RFC_OCTETS))
        expect(pair).toEqual({ verifier: RFC_VERIFIER, challenge: RFC_CHALLENGE })
    })

    it('makes a 64-character verifier from 48 random bytes', async () => {
        const asked: number[] = []
        const pair = await createPkcePair((length) => {
            asked.push(length)
            return crypto.getRandomValues(new Uint8Array(length))
        })
        expect(asked).toEqual([48])
        expect(pair.verifier).toHaveLength(64)
        expect(pair.verifier).toMatch(BASE64URL)
        expect(pair.challenge).toBe(await pkceChallenge(pair.verifier))
    })

    it('makes a new pair each time by default', async () => {
        const [first, second] = await Promise.all([createPkcePair(), createPkcePair()])
        expect(first.verifier).not.toBe(second.verifier)
    })
})

describe('createState', () => {
    it('is base64url of 24 random bytes', () => {
        const state = createState((length) => new Uint8Array(length).fill(255))
        expect(state).toBe('_'.repeat(32))
        expect(createState()).toMatch(BASE64URL)
        expect(createState()).toHaveLength(32)
    })
})

describe('authorizeUrl', () => {
    const request = {
        clientId: 'garden-client.apps.googleusercontent.com',
        redirectUri: 'https://app.example.com/extensions/google-calendar/callback',
        scopes: CALENDAR_SCOPES,
        state: 'state-beans',
        challenge: RFC_CHALLENGE,
    }

    it('asks for a code, offline access and consent, with the PKCE challenge', () => {
        const url = new URL(authorizeUrl(request))
        expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZE_URL)
        expect(Object.fromEntries(url.searchParams)).toEqual({
            client_id: 'garden-client.apps.googleusercontent.com',
            redirect_uri: 'https://app.example.com/extensions/google-calendar/callback',
            response_type: 'code',
            scope: CALENDAR_SCOPES.join(' '),
            state: 'state-beans',
            code_challenge: RFC_CHALLENGE,
            code_challenge_method: 'S256',
            access_type: 'offline',
            include_granted_scopes: 'true',
            prompt: 'consent',
        })
    })

    it('lets the person pick an account, and offers the expected one first', () => {
        const url = new URL(authorizeUrl({ ...request, scopes: [TASKS_SCOPE], selectAccount: true, loginHint: 'gardener@example.com' }))
        expect(url.searchParams.get('prompt')).toBe('select_account consent')
        expect(url.searchParams.get('login_hint')).toBe('gardener@example.com')
        expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/tasks')
    })

    it('asks for the calendar scopes the extension needs', () => {
        expect(CALENDAR_SCOPES).toEqual([
            'openid',
            'email',
            'https://www.googleapis.com/auth/calendar.events',
            'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
            'https://www.googleapis.com/auth/calendar.calendars.readonly',
            'https://www.googleapis.com/auth/calendar.settings.readonly',
            'https://www.googleapis.com/auth/calendar.freebusy',
            'https://www.googleapis.com/auth/drive.file',
            'https://www.googleapis.com/auth/tasks',
        ])
    })
})

describe('exchangeCode', () => {
    const options = {
        clientId: 'garden-client',
        clientSecret: 'kitchen-secret',
        redirectUri: 'https://app.example.com/callback',
        code: 'code-beans',
        verifier: RFC_VERIFIER,
        now: () => 1_000_000,
    }

    it('posts the code, verifier and client secret as a form, and reads the tokens', async () => {
        const fetch = fakeFetch(
            json({ access_token: 'access-1', expires_in: 3599, refresh_token: 'refresh-1', scope: 'openid email', token_type: 'Bearer', id_token: 'id.token.here' }),
        )
        const tokens = await exchangeCode({ ...options, fetch })
        expect(tokens).toEqual({ accessToken: 'access-1', expiresAt: 1_000_000 + 3_599_000, refreshToken: 'refresh-1', scope: 'openid email', idToken: 'id.token.here' })
        const [request] = fetch.requests
        expect(request.method).toBe('POST')
        expect(request.url.toString()).toBe(GOOGLE_TOKEN_URL)
        expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded')
        expect(await form(request)).toEqual({
            grant_type: 'authorization_code',
            code: 'code-beans',
            code_verifier: RFC_VERIFIER,
            client_id: 'garden-client',
            client_secret: 'kitchen-secret',
            redirect_uri: 'https://app.example.com/callback',
        })
    })

    it('reports a used or expired code as revoked', async () => {
        const fetch = fakeFetch(json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400))
        const error = await exchangeCode({ ...options, fetch }).catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(GoogleAuthError)
        expect(error).toMatchObject({ kind: 'revoked', status: 400, code: 'invalid_grant' })
    })

    it('reports a wrong redirect URI as a client problem', async () => {
        const fetch = fakeFetch(json({ error: 'redirect_uri_mismatch' }, 400))
        await expect(exchangeCode({ ...options, fetch })).rejects.toMatchObject({ kind: 'client', message: expect.stringContaining('redirect URI') })
    })
})

describe('refreshAccessToken', () => {
    const options = { clientId: 'garden-client', clientSecret: 'kitchen-secret', refreshToken: 'refresh-1', now: () => 5_000 }

    it('posts the refresh token and keeps no refresh token Google did not send', async () => {
        const fetch = fakeFetch(json({ access_token: 'access-2', expires_in: 3600, scope: 'openid', token_type: 'Bearer' }))
        const tokens = await refreshAccessToken({ ...options, fetch })
        expect(tokens).toEqual({ accessToken: 'access-2', expiresAt: 5_000 + 3_600_000, scope: 'openid' })
        expect(tokens).not.toHaveProperty('refreshToken')
        expect(await form(fetch.requests[0])).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'garden-client', client_secret: 'kitchen-secret' })
    })

    it('reports a grant Google no longer accepts as revoked, in words for the person', async () => {
        const fetch = fakeFetch(json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400))
        await expect(refreshAccessToken({ ...options, fetch })).rejects.toMatchObject({
            kind: 'revoked',
            message: 'Google no longer accepts this account’s sign-in. Connect it again.',
        })
    })

    it.each(['invalid_client', 'unauthorized_client'])('reports %s as a wrong Client ID or secret', async (code) => {
        const fetch = fakeFetch(json({ error: code }, 401))
        await expect(refreshAccessToken({ ...options, fetch })).rejects.toMatchObject({
            kind: 'client',
            code,
            message: expect.stringContaining('Client ID or Client secret'),
        })
    })

    it('reports a network failure as offline', async () => {
        const fetch = fakeFetch(new TypeError('Failed to fetch'))
        await expect(refreshAccessToken({ ...options, fetch })).rejects.toMatchObject({ kind: 'offline', status: 0, message: expect.stringContaining('can’t be reached') })
    })

    it('reports a failure on Google’s side as a server problem', async () => {
        const fetch = fakeFetch(new Response('Unavailable', { status: 503 }))
        await expect(refreshAccessToken({ ...options, fetch })).rejects.toMatchObject({ kind: 'server', status: 503 })
    })

    it('refuses an answer with no access token', async () => {
        const fetch = fakeFetch(json({ expires_in: 3600 }))
        await expect(refreshAccessToken({ ...options, fetch })).rejects.toMatchObject({ kind: 'server' })
    })
})

describe('revokeToken', () => {
    it('posts the token as a form', async () => {
        const fetch = fakeFetch(new Response('{}', { status: 200 }))
        await revokeToken({ token: 'refresh-1', fetch })
        const [request] = fetch.requests
        expect(request.method).toBe('POST')
        expect(request.url.toString()).toBe(GOOGLE_REVOKE_URL)
        expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded')
        expect(await bodyText(request)).toBe('token=refresh-1')
    })

    it('counts a token Google no longer knows as revoked', async () => {
        const fetch = fakeFetch(json({ error: 'invalid_token', error_description: 'Token expired or revoked' }, 400))
        await expect(revokeToken({ token: 'refresh-1', fetch })).resolves.toBeUndefined()
    })

    it('reports any other refusal', async () => {
        const fetch = fakeFetch(json({ error: 'invalid_request' }, 400))
        await expect(revokeToken({ token: 'refresh-1', fetch })).rejects.toBeInstanceOf(GoogleAuthError)
    })

    it('reports a network failure as offline', async () => {
        const fetch = fakeFetch(new TypeError('Failed to fetch'))
        await expect(revokeToken({ token: 'refresh-1', fetch })).rejects.toMatchObject({ kind: 'offline' })
    })
})

describe('emailFromIdToken', () => {
    it('reads the address from the payload', () => {
        expect(emailFromIdToken(idToken({ iss: 'https://accounts.google.com', email: 'gardener@example.com', email_verified: true }))).toBe('gardener@example.com')
    })

    it('reads a payload whose base64url uses - and _', () => {
        // A name of characters that encode to `-` and `_` checks the decoding, not only the happy path.
        const token = idToken({ email: 'gardener@example.com', name: 'Kitchen ~~~ ??? >>>' })
        expect(token.split('.')[1]).toMatch(/[-_]/)
        expect(emailFromIdToken(token)).toBe('gardener@example.com')
    })

    it('gives null for a payload without an address, or a token that is not a JWT', () => {
        expect(emailFromIdToken(idToken({ sub: '1234' }))).toBeNull()
        expect(emailFromIdToken('not-a-token')).toBeNull()
        expect(emailFromIdToken('a.%%%.c')).toBeNull()
        expect(emailFromIdToken(`a.${base64url(new TextEncoder().encode('not json'))}.c`)).toBeNull()
    })
})
