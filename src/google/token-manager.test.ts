import { describe, expect, it } from 'vitest'
import { bodyText, fakeFetch, json } from './fake-fetch'
import { GoogleError } from './http'
import { createTokenManager } from './token-manager'

const tokenAnswer = (accessToken: string, expiresIn = 3600) => json({ access_token: accessToken, expires_in: expiresIn, scope: 'openid', token_type: 'Bearer' })

function setup(fetch: ReturnType<typeof fakeFetch>, initial?: { accessToken: string; expiresAt: number }) {
    const clock = { now: 1_000_000 }
    const manager = createTokenManager({
        clientId: 'garden-client',
        clientSecret: 'kitchen-secret',
        refreshToken: 'refresh-beans',
        fetch,
        now: () => clock.now,
        initial,
    })
    return { manager, clock }
}

describe('createTokenManager', () => {
    it('uses the token in hand while it is fresh', async () => {
        const fetch = fakeFetch()
        const { manager } = setup(fetch, { accessToken: 'access-1', expiresAt: 1_000_000 + 120_000 })
        await expect(manager.token()).resolves.toBe('access-1')
        expect(fetch.requests).toHaveLength(0)
    })

    it('refreshes a minute before the token ends, then holds the new one', async () => {
        const fetch = fakeFetch(tokenAnswer('access-2'))
        const { manager, clock } = setup(fetch, { accessToken: 'access-1', expiresAt: 1_000_000 + 120_000 })
        clock.now += 60_000
        await expect(manager.token()).resolves.toBe('access-2')
        expect(Object.fromEntries(new URLSearchParams(await bodyText(fetch.requests[0])))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-beans' })
        clock.now += 3_000_000
        await expect(manager.token()).resolves.toBe('access-2')
        expect(fetch.requests).toHaveLength(1)
    })

    it('shares one refresh between callers that ask at once', async () => {
        let answer: (response: Response) => void = () => {}
        const fetch = fakeFetch(() => new Promise<Response>((resolve) => (answer = resolve)))
        const { manager } = setup(fetch)
        const asked = [manager.token(), manager.token(), manager.refresh()]
        await Promise.resolve()
        answer(tokenAnswer('access-1'))
        await expect(Promise.all(asked)).resolves.toEqual(['access-1', 'access-1', 'access-1'])
        expect(fetch.requests).toHaveLength(1)
    })

    it('refreshes again on request, even with a fresh token', async () => {
        const fetch = fakeFetch(tokenAnswer('access-2'), tokenAnswer('access-3'))
        const { manager } = setup(fetch, { accessToken: 'access-1', expiresAt: 1_000_000 + 3_600_000 })
        await expect(manager.refresh()).resolves.toBe('access-2')
        await expect(manager.refresh()).resolves.toBe('access-3')
        await expect(manager.token()).resolves.toBe('access-3')
    })

    it('turns a revoked grant into an auth error, and tries again on the next call', async () => {
        const fetch = fakeFetch(json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400), tokenAnswer('access-1'))
        const { manager } = setup(fetch)
        const error = await manager.token().catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(GoogleError)
        expect(error).toMatchObject({ kind: 'auth', reason: 'revoked', status: 400, message: 'Google no longer accepts this account’s sign-in. Connect it again.' })
        // A failed refresh is not remembered: the next call asks Google again.
        await expect(manager.token()).resolves.toBe('access-1')
    })

    it('turns a wrong client into a forbidden error that says what to fix', async () => {
        const fetch = fakeFetch(json({ error: 'invalid_client' }, 401))
        const { manager } = setup(fetch)
        await expect(manager.token()).rejects.toMatchObject({ kind: 'forbidden', reason: 'client', message: expect.stringContaining('extension’s settings') })
    })

    it('turns a network failure into an offline error', async () => {
        const fetch = fakeFetch(new TypeError('Failed to fetch'))
        const { manager } = setup(fetch)
        await expect(manager.token()).rejects.toMatchObject({ kind: 'offline', status: 0 })
    })

    it('forgets the token it holds', async () => {
        const fetch = fakeFetch(tokenAnswer('access-2'))
        const { manager } = setup(fetch, { accessToken: 'access-1', expiresAt: 1_000_000 + 3_600_000 })
        manager.forget()
        await expect(manager.token()).resolves.toBe('access-2')
    })

    it('doesn’t keep a token from a refresh that was on its way when it forgot', async () => {
        let answer: (response: Response) => void = () => {}
        const fetch = fakeFetch(() => new Promise<Response>((resolve) => (answer = resolve)), tokenAnswer('access-2'))
        const { manager } = setup(fetch)
        const first = manager.token()
        await Promise.resolve()
        manager.forget()
        answer(tokenAnswer('access-1'))
        await first
        await expect(manager.token()).resolves.toBe('access-2')
        expect(fetch.requests).toHaveLength(2)
    })
})
