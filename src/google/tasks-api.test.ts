import { describe, expect, it } from 'vitest'
import { bodyJson, fakeFetch, json } from './fake-fetch'
import { createGoogleClient } from './http'
import { deleteTask, insertTask, listTaskLists, listTasks, patchTask } from './tasks-api'

function setup(...replies: Parameters<typeof fakeFetch>) {
    const fetch = fakeFetch(...replies)
    const client = createGoogleClient({ tokens: { token: async () => 'token-1', refresh: async () => 'token-2' }, fetch, sleep: async () => {} })
    return { fetch, client }
}

const query = (request: { url: URL }) => Object.fromEntries(request.url.searchParams)

describe('listTaskLists', () => {
    it('reads every page', async () => {
        const { fetch, client } = setup(json({ items: [{ id: 'garden', title: 'Garden' }], nextPageToken: 'next' }), json({ items: [{ id: 'kitchen', title: 'Kitchen' }] }))
        const lists = await listTaskLists(client)
        expect(lists.map((list) => list.title)).toEqual(['Garden', 'Kitchen'])
        expect(fetch.requests[0].url.toString()).toBe('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100')
        expect(query(fetch.requests[1])).toEqual({ maxResults: '100', pageToken: 'next' })
    })
})

describe('listTasks', () => {
    it('asks for the due range, with completed and hidden tasks, over every page', async () => {
        const { fetch, client } = setup(
            json({ items: [{ id: 'beans', title: 'Water the beans', status: 'needsAction' }], nextPageToken: 'next' }),
            json({ items: [{ id: 'peas', title: 'Pick the peas', status: 'completed', hidden: true }] }),
        )
        const tasks = await listTasks(client, 'garden', { dueMin: new Date('2026-10-01T00:00:00Z'), dueMax: new Date('2026-11-01T00:00:00Z') })
        expect(tasks.map((task) => task.id)).toEqual(['beans', 'peas'])
        expect(fetch.requests[0].url.pathname).toBe('/tasks/v1/lists/garden/tasks')
        expect(query(fetch.requests[0])).toEqual({
            dueMin: '2026-10-01T00:00:00.000Z',
            dueMax: '2026-11-01T00:00:00.000Z',
            showCompleted: 'true',
            showHidden: 'true',
            maxResults: '100',
        })
        expect(query(fetch.requests[1]).pageToken).toBe('next')
    })

    it('leaves completed and hidden tasks out when asked', async () => {
        const { fetch, client } = setup(json({ items: [] }))
        await listTasks(client, 'garden', { showCompleted: false })
        expect(query(fetch.requests[0])).toEqual({ showCompleted: 'false', showHidden: 'false', maxResults: '100' })
    })
})

describe('task writes', () => {
    it('inserts a task into a list', async () => {
        const { fetch, client } = setup(json({ id: 'beans', title: 'Water the beans', status: 'needsAction' }))
        await insertTask(client, 'garden', { title: 'Water the beans', due: '2026-10-12T00:00:00.000Z' })
        const [request] = fetch.requests
        expect(request.method).toBe('POST')
        expect(request.url.toString()).toBe('https://tasks.googleapis.com/tasks/v1/lists/garden/tasks')
        expect(await bodyJson(request)).toEqual({ title: 'Water the beans', due: '2026-10-12T00:00:00.000Z' })
    })

    it('patches a task', async () => {
        const { fetch, client } = setup(json({ id: 'beans', title: 'Water the beans', status: 'completed' }))
        await patchTask(client, 'garden', 'beans', { status: 'completed' })
        const [request] = fetch.requests
        expect(request.method).toBe('PATCH')
        expect(request.url.pathname).toBe('/tasks/v1/lists/garden/tasks/beans')
        expect(await bodyJson(request)).toEqual({ status: 'completed' })
    })

    it('deletes a task', async () => {
        const { fetch, client } = setup(new Response(null, { status: 204 }))
        await expect(deleteTask(client, 'garden', 'beans')).resolves.toBeUndefined()
        expect(fetch.requests[0].method).toBe('DELETE')
        expect(fetch.requests[0].url.pathname).toBe('/tasks/v1/lists/garden/tasks/beans')
    })
})
