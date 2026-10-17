import { describe, expect, it } from 'vitest'

import { TASKS_SCOPE } from '../google/oauth'
import type { CalendarStore } from './calendar-store.svelte'
import { createRecords } from './records'
import { TaskStore } from './task-store.svelte'
import { memoryPersonStorage, memoryStorage } from './testing'

const GARDENER = 'gardener@example.com'
const ORCHARD = 'orchard@example.com'

/** A task store over two accounts whose sign-in allows Tasks, with their lists already read. */
function twoAccounts() {
    const records = createRecords(memoryPersonStorage(), memoryStorage())
    for (const email of [GARDENER, ORCHARD]) records.putAccount({ email, refreshToken: `refresh-${email}`, scopes: `openid email ${TASKS_SCOPE}`, addedAt: 1 })
    // The lists are read already, so the calendar store (which signs requests) is never asked.
    const tasks = new TaskStore({} as CalendarStore, records)
    tasks.lists = {
        [GARDENER]: [
            { id: 'jobs', title: 'Garden jobs' },
            { id: 'seeds', title: 'Seeds to buy' },
        ],
        [ORCHARD]: [{ id: 'pruning', title: 'Pruning' }],
    }
    return { records, tasks }
}

describe('the task lists a new task can go in', () => {
    it("are every list read, account by account, in Google's order", () => {
        const { tasks } = twoAccounts()
        expect(tasks.listOptions().map((option) => [option.key, option.email, option.list.title])).toEqual([
            [`${GARDENER}|jobs`, GARDENER, 'Garden jobs'],
            [`${GARDENER}|seeds`, GARDENER, 'Seeds to buy'],
            [`${ORCHARD}|pruning`, ORCHARD, 'Pruning'],
        ])
    })

    it('leave out an account whose sign-in does not allow Tasks', () => {
        const { records, tasks } = twoAccounts()
        records.putAccount({ email: ORCHARD, refreshToken: 'refresh-orchard', scopes: 'openid email', addedAt: 1 })
        expect(tasks.listOptions().map((option) => option.key)).toEqual([`${GARDENER}|jobs`, `${GARDENER}|seeds`])
    })
})

describe('the task list a new task starts in', () => {
    it('is the first list of the first account until the person chooses one', () => {
        const { tasks } = twoAccounts()
        expect(tasks.defaultList()?.key).toBe(`${GARDENER}|jobs`)
    })

    it('is the list the person chose for new tasks', () => {
        const { records, tasks } = twoAccounts()
        records.setDefaultTaskList({ account: ORCHARD, listId: 'pruning' })
        expect(tasks.defaultList()?.key).toBe(`${ORCHARD}|pruning`)
    })

    it('is the first list again once the chosen list is deleted, or its account no longer allows Tasks', () => {
        const { records, tasks } = twoAccounts()
        records.setDefaultTaskList({ account: GARDENER, listId: 'seeds' })
        tasks.lists = { ...tasks.lists, [GARDENER]: [{ id: 'jobs', title: 'Garden jobs' }] }
        expect(tasks.defaultList()?.key).toBe(`${GARDENER}|jobs`)

        records.setDefaultTaskList({ account: ORCHARD, listId: 'pruning' })
        records.putAccount({ email: ORCHARD, refreshToken: 'refresh-orchard', scopes: 'openid email', addedAt: 1 })
        expect(tasks.defaultList()?.key).toBe(`${GARDENER}|jobs`)
    })

    it('is none while no list has been read', () => {
        const { tasks } = twoAccounts()
        tasks.lists = {}
        expect(tasks.defaultList()).toBeNull()
    })
})
