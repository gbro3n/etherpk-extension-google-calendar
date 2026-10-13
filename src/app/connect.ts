/**
 * Connecting a Google account, and letting one go.
 *
 * Signing in is OAuth 2.0's authorization code flow with PKCE, through the Client's sign-in popup
 * (`context.auth`), with the person's own OAuth client. A browser blocks a popup that is not opened
 * inside the click that asked for it, and the PKCE challenge takes a moment to compute, so a
 * `SignInStarter` prepares the next sign-in ahead (`prepare`), and `start` opens the popup at once.
 *
 * Google gives a refresh token only when the person consents, so every sign-in asks for consent.
 * The account's address comes from the ID token the same exchange returns (`openid email`).
 */
import type { ExtensionAuth } from '@appsoftwareltd/etherpk-extension-api'

import { authorizeUrl, CALENDAR_SCOPES, createPkcePair, createState, emailFromIdToken, exchangeCode, revokeToken } from '../google/oauth'
import type { AccountRecord } from './records'

interface Prepared {
    verifier: string
    challenge: string
    state: string
}

export interface SignInOptions {
    auth: ExtensionAuth
    fetch: typeof fetch
    now?: () => number
}

export interface SignInRequest {
    clientId: string
    clientSecret: string
    /** The account to sign in as again, for a reconnect. */
    loginHint?: string
    signal?: AbortSignal
}

export interface SignInStarter {
    /** Ready to start: the next sign-in is prepared. */
    readonly ready: boolean
    /** Prepare the next sign-in. Resolves once `start` can be called. */
    prepare(): Promise<void>
    /**
     * Open Google's sign-in, inside the click that asked for it, and resolve with the account it
     * connected. Throws, saying why, when the person refused, the popup was blocked, or Google
     * would not accept the OAuth client.
     */
    start(request: SignInRequest): Promise<AccountRecord>
}

export function createSignInStarter(options: SignInOptions): SignInStarter {
    let prepared: Prepared | null = null
    let preparing: Promise<void> | null = null
    const now = options.now ?? Date.now

    const prepare = () => {
        preparing ??= (async () => {
            const pair = await createPkcePair()
            prepared = { ...pair, state: createState() }
            preparing = null
        })()
        return preparing
    }

    return {
        get ready() {
            return prepared !== null
        },
        prepare,
        async start(request) {
            const current = prepared
            if (!current) throw new Error('The sign-in is not ready yet. Try again in a moment.')
            // Used once: the next sign-in gets its own verifier and state.
            prepared = null
            void prepare()
            const scopes = CALENDAR_SCOPES
            const url = authorizeUrl({
                clientId: request.clientId,
                redirectUri: options.auth.redirectUri,
                scopes,
                state: current.state,
                challenge: current.challenge,
                ...(request.loginHint ? { loginHint: request.loginHint } : { selectAccount: true }),
            })
            // Synchronously from here to the popup opening: no await before this call.
            const answer = await options.auth.authorize(url, request.signal ? { signal: request.signal } : {})
            if (answer.state !== current.state) throw new Error('The sign-in came back for another request. Try again.')
            if (answer.error) throw new Error(refusalMessage(answer.error))
            if (!answer.code) throw new Error('Google sent no sign-in code. Try again.')
            const tokens = await exchangeCode({
                clientId: request.clientId,
                clientSecret: request.clientSecret,
                redirectUri: options.auth.redirectUri,
                code: answer.code,
                verifier: current.verifier,
                fetch: options.fetch,
                now,
            })
            const email = tokens.idToken ? emailFromIdToken(tokens.idToken) : null
            if (!email) throw new Error('Google did not say which account signed in. Try again.')
            if (!tokens.refreshToken) throw new Error('Google did not give a lasting sign-in. Remove EtherPK from your Google account’s third-party access, then connect again.')
            if (!tokens.scope.includes('calendar.events')) {
                throw new Error('Google Calendar access was not granted. Connect again and tick every box on Google’s consent screen.')
            }
            return { email, refreshToken: tokens.refreshToken, scopes: tokens.scope, addedAt: now() }
        },
    }
}

/** What an OAuth error Google returned means for the person. */
export function refusalMessage(error: string): string {
    switch (error) {
        case 'access_denied':
            return 'The sign-in was cancelled, or Google Calendar access was not allowed.'
        case 'admin_policy_enforced':
            return 'Your Google Workspace administrator does not allow this app. Ask them to trust your OAuth Client ID under Manage App Access.'
        case 'org_internal':
            return 'This OAuth client only lets accounts in its own Google Workspace sign in.'
        default:
            return `Google refused the sign-in (${error}). Check the OAuth client's settings in Google Cloud, then try again.`
    }
}

/** Let an account go: revoke its sign-in at Google, which signs it out on every device. */
export async function disconnect(account: AccountRecord, fetcher: typeof fetch): Promise<void> {
    await revokeToken({ token: account.refreshToken, fetch: fetcher })
}
