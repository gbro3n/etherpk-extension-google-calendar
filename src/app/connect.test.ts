import { describe, expect, it, vi } from 'vitest'

import type { ExtensionAuth } from '@appsoftwareltd/etherpk-extension-api'

import { createSignInStarter } from './connect'

const idToken = (email: string) => `e30.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.`

/** Google's token endpoint, answering a code exchange. */
function tokenEndpoint(answer: Record<string, unknown>) {
    return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        void init
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

function auth(reply: (url: URL) => Record<string, string>): ExtensionAuth & { opened: URL[] } {
    const opened: URL[] = []
    return {
        opened,
        redirectUri: 'https://client.example/extension-sign-in',
        authorize: async (address) => {
            const url = new URL(address)
            opened.push(url)
            return reply(url)
        },
    }
}

const granted = { access_token: 'a1', expires_in: 3600, refresh_token: 'r1', scope: 'openid email https://www.googleapis.com/auth/calendar.events', id_token: idToken('gardener@example.com') }

describe('connecting a Google account', () => {
    it('opens Google’s sign-in with PKCE and consent, exchanges the code with the secret, and names the account', async () => {
        const answers = auth((url) => ({ code: 'c1', state: url.searchParams.get('state')! }))
        const fetcher = tokenEndpoint(granted)
        const starter = createSignInStarter({ auth: answers, fetch: fetcher, now: () => 5 })
        await starter.prepare()
        const account = await starter.start({ clientId: 'garden.apps.googleusercontent.com', clientSecret: 's1' })
        expect(account).toEqual({ email: 'gardener@example.com', refreshToken: 'r1', scopes: granted.scope, addedAt: 5 })
        const opened = answers.opened[0]
        expect(opened.searchParams.get('code_challenge_method')).toBe('S256')
        expect(opened.searchParams.get('access_type')).toBe('offline')
        expect(opened.searchParams.get('prompt')).toContain('consent')
        expect(opened.searchParams.get('redirect_uri')).toBe('https://client.example/extension-sign-in')
        const body = new URLSearchParams(String((fetcher.mock.calls[0][1] as RequestInit).body))
        expect([body.get('code'), body.get('client_secret'), body.get('code_verifier')?.length]).toEqual(['c1', 's1', 64])
    })

    it('opens the popup at once, inside the click, with nothing awaited first', async () => {
        const answers = auth((url) => ({ code: 'c1', state: url.searchParams.get('state')! }))
        const starter = createSignInStarter({ auth: answers, fetch: tokenEndpoint(granted) })
        await starter.prepare()
        const started = starter.start({ clientId: 'garden', clientSecret: 's1' })
        expect(answers.opened).toHaveLength(1)
        await started
    })

    it('says so when the person refused, or Google came back for another sign-in', async () => {
        const refused = createSignInStarter({ auth: auth((url) => ({ error: 'access_denied', state: url.searchParams.get('state')! })), fetch: tokenEndpoint(granted) })
        await refused.prepare()
        await expect(refused.start({ clientId: 'garden', clientSecret: 's1' })).rejects.toThrow('The sign-in was cancelled, or Google Calendar access was not allowed.')
        const crossed = createSignInStarter({ auth: auth(() => ({ code: 'c1', state: 'another' })), fetch: tokenEndpoint(granted) })
        await crossed.prepare()
        await expect(crossed.start({ clientId: 'garden', clientSecret: 's1' })).rejects.toThrow('The sign-in came back for another request.')
    })

    it('refuses a sign-in without Calendar access or a lasting token', async () => {
        const answers = () => auth((url) => ({ code: 'c1', state: url.searchParams.get('state')! }))
        const narrow = createSignInStarter({ auth: answers(), fetch: tokenEndpoint({ ...granted, scope: 'openid email' }) })
        await narrow.prepare()
        await expect(narrow.start({ clientId: 'garden', clientSecret: 's1' })).rejects.toThrow(/tick every box/)
        const brief = createSignInStarter({ auth: answers(), fetch: tokenEndpoint({ ...granted, refresh_token: undefined }) })
        await brief.prepare()
        await expect(brief.start({ clientId: 'garden', clientSecret: 's1' })).rejects.toThrow(/lasting sign-in/)
    })

    it('asks for the same account again on a reconnect', async () => {
        const answers = auth((url) => ({ code: 'c1', state: url.searchParams.get('state')! }))
        const starter = createSignInStarter({ auth: answers, fetch: tokenEndpoint(granted) })
        await starter.prepare()
        await starter.start({ clientId: 'garden', clientSecret: 's1', loginHint: 'gardener@example.com' })
        expect(answers.opened[0].searchParams.get('login_hint')).toBe('gardener@example.com')
    })
})
