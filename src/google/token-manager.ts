/**
 * One account's access token, held in memory only and fetched again from its refresh token when it
 * nears its end. Access tokens are never stored: they last an hour, and a page that opens again gets
 * a new one in one request.
 *
 * - A token counts as fresh until a minute before Google says it ends, so a request never sets out
 *   with a token that expires on the way.
 * - Refreshes are shared. Every caller that needs a token while one refresh is on its way waits for
 *   that refresh, so a page that starts twenty requests at once refreshes once.
 * - A failed refresh becomes a `GoogleError`, the error the rest of the extension handles. A grant
 *   Google no longer accepts becomes kind `auth`, reason `revoked`, which the UI shows as "connect
 *   this account again".
 */
import { GoogleError, type AccessTokenSource } from './http'
import { GoogleAuthError, refreshAccessToken } from './oauth'

/** How long before its stated end a token stops being used. */
const EARLY_MS = 60_000

export interface TokenManagerOptions {
    clientId: string
    clientSecret: string
    refreshToken: string
    fetch: typeof fetch
    now?: () => number
    /** A token already in hand, such as the one the sign-in just gave. */
    initial?: { accessToken: string; expiresAt: number }
}

export function createTokenManager(options: TokenManagerOptions): AccessTokenSource & { forget(): void } {
    const now = options.now ?? Date.now
    let current = options.initial ?? null
    let pending: Promise<string> | null = null
    // Bumped by `forget`, so a refresh that was already on its way doesn't put back what was forgotten.
    let generation = 0

    async function fetchToken(started: number): Promise<string> {
        try {
            const tokens = await refreshAccessToken({
                clientId: options.clientId,
                clientSecret: options.clientSecret,
                refreshToken: options.refreshToken,
                fetch: options.fetch,
                now,
            })
            if (started === generation) current = { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt }
            return tokens.accessToken
        } catch (error) {
            throw asGoogleError(error)
        }
    }

    function refresh(): Promise<string> {
        if (pending) return pending
        const job: Promise<string> = fetchToken(generation).finally(() => {
            // Only this refresh's own slot is cleared: `forget` may have made way for a newer one.
            if (pending === job) pending = null
        })
        pending = job
        return job
    }

    return {
        async token() {
            if (current && current.expiresAt - EARLY_MS > now()) return current.accessToken
            return refresh()
        },
        refresh,
        forget() {
            current = null
            pending = null
            generation++
        },
    }
}

/** A sign-in failure as the `GoogleError` the rest of the extension handles. */
function asGoogleError(error: unknown): unknown {
    if (!(error instanceof GoogleAuthError)) return error
    const common = { status: error.status, reason: error.kind, cause: error }
    switch (error.kind) {
        case 'revoked':
            return new GoogleError(error.message, { ...common, kind: 'auth' })
        case 'client':
            // Kind `forbidden` rather than `auth`: connecting the account again won't help when the
            // OAuth client's settings are wrong, so the UI shows the message, which says what to fix.
            return new GoogleError(error.message, { ...common, kind: 'forbidden' })
        case 'offline':
            return new GoogleError(error.message, { ...common, kind: 'offline' })
        case 'server':
            return new GoogleError(error.message, { ...common, kind: 'server' })
    }
}
