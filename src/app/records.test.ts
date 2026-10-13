import { describe, expect, it, vi } from 'vitest'

import { createRecords } from './records'
import { memoryPersonStorage, memoryStorage } from './testing'

const account = (email: string, refreshToken = `refresh-${email}`) => ({ email, refreshToken, scopes: 'openid email', addedAt: 1 })

describe("the person's records", () => {
    it('adds accounts in order, and a reconnect keeps the account in its place', () => {
        const records = createRecords(memoryPersonStorage(), memoryStorage())
        records.putAccount(account('gardener@example.com'))
        records.putAccount(account('orchard@example.com'))
        records.putAccount(account('gardener@example.com', 'refresh-new'))
        expect(records.accounts().map((kept) => [kept.email, kept.refreshToken])).toEqual([
            ['gardener@example.com', 'refresh-new'],
            ['orchard@example.com', 'refresh-orchard@example.com'],
        ])
    })

    it('removes an account with its calendar choices, and its calendar as the default for new events', () => {
        const records = createRecords(memoryPersonStorage(), memoryStorage())
        records.putAccount(account('gardener@example.com'))
        records.putAccount(account('orchard@example.com'))
        records.choose({ account: 'gardener@example.com', calendarId: 'kitchen' }, false)
        records.choose({ account: 'orchard@example.com', calendarId: 'trees' }, true)
        records.setDefaultCalendar({ account: 'gardener@example.com', calendarId: 'kitchen' })
        records.removeAccount('gardener@example.com')
        expect(records.accounts().map((kept) => kept.email)).toEqual(['orchard@example.com'])
        expect(records.choices()).toEqual({ 'orchard@example.com': { trees: true } })
        expect(records.defaultCalendar()).toBeNull()
    })

    it('reads past records of a shape it does not know, as another release might have written them', () => {
        const person = memoryPersonStorage()
        person.set('accounts', [{ email: 'gardener@example.com' }, account('orchard@example.com'), 'beans'])
        person.set('calendars', { 'orchard@example.com': { trees: true, beds: 'yes' }, broken: 3 })
        person.set('default-calendar', { account: 1 })
        const records = createRecords(person, memoryStorage())
        expect(records.accounts().map((kept) => kept.email)).toEqual(['orchard@example.com'])
        expect(records.choices()).toEqual({ 'orchard@example.com': { trees: true } })
        expect(records.defaultCalendar()).toBeNull()
    })

    it('keeps the view last picked on this device only, and hears changes to the person’s records', () => {
        const person = memoryPersonStorage()
        const records = createRecords(person, memoryStorage())
        const heard = vi.fn()
        records.subscribe(heard)
        expect(records.lastView()).toBeNull()
        records.setLastView('year')
        expect(records.lastView()).toBe('year')
        expect(heard).not.toHaveBeenCalled()
        records.chooseTaskList({ account: 'gardener@example.com', listId: 'jobs' }, false)
        expect(records.taskListChoices()).toEqual({ 'gardener@example.com': { jobs: false } })
        expect(heard).toHaveBeenCalledTimes(1)
    })
})
