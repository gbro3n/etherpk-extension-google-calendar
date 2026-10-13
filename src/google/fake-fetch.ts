/**
 * A stand-in for `fetch`, for the tests of the Google modules only. It records every request and
 * answers each with the next reply in its script, so a test says what Google answers and checks
 * what was asked. Nothing reaches the network.
 */

export interface RecordedRequest {
    method: string
    url: URL
    /** Header names in lower case. */
    headers: Record<string, string>
    body: BodyInit | null | undefined
    signal: AbortSignal | null | undefined
}

/** A canned answer, an error to throw (a `TypeError` is how `fetch` reports a network failure), or a function of the request. */
export type Reply = Response | Error | ((request: RecordedRequest) => Response | Promise<Response>)

export type FakeFetch = typeof fetch & { requests: RecordedRequest[] }

export function fakeFetch(...replies: Reply[]): FakeFetch {
    const requests: RecordedRequest[] = []
    const queue = [...replies]
    const fake = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
        const request: RecordedRequest = {
            method: init.method ?? 'GET',
            url: new URL(String(input)),
            headers: Object.fromEntries(new Headers(init.headers).entries()),
            body: init.body,
            signal: init.signal,
        }
        requests.push(request)
        if (init.signal?.aborted) throw init.signal.reason
        const reply = queue.shift()
        if (reply === undefined) throw new Error(`No reply scripted for ${request.method} ${request.url}`)
        if (reply instanceof Error) throw reply
        if (typeof reply === 'function') return reply(request)
        return reply
    }
    return Object.assign(fake, { requests }) as FakeFetch
}

/** A JSON answer, `200` unless another status is given. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

/** Google's error answer for an API call. */
export function googleError(status: number, reason: string, message = 'Refused'): Response {
    return json({ error: { code: status, message, errors: [{ reason, message, domain: 'global' }] } }, status)
}

/** The body a request sent, as text. */
export async function bodyText(request: RecordedRequest): Promise<string> {
    return new Response(request.body ?? null).text()
}

/** The JSON body a request sent. */
export async function bodyJson(request: RecordedRequest): Promise<unknown> {
    return JSON.parse(await bodyText(request))
}
