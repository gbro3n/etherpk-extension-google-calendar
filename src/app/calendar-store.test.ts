import { describe, expect, it } from 'vitest'

import { monthsOf, splitKey } from './calendar-store.svelte'

describe('the months a range covers', () => {
    it('are each month the range touches, by local calendar month', () => {
        expect(monthsOf(new Date(2026, 8, 28), new Date(2026, 10, 9)).map((month) => month.key)).toEqual(['2026-09', '2026-10', '2026-11'])
        expect(monthsOf(new Date(2026, 9, 12), new Date(2026, 9, 13)).map((month) => month.key)).toEqual(['2026-10'])
    })

    it('do not count a month the range ends exactly at', () => {
        expect(monthsOf(new Date(2026, 9, 1), new Date(2026, 10, 1)).map((month) => month.key)).toEqual(['2026-10'])
    })
})

describe("an event's key", () => {
    it('comes apart into account, calendar and event, whatever the event id holds', () => {
        expect(splitKey('gardener@example.com|kitchen@group.calendar.google.com|beans_20261012T090000Z')).toEqual([
            'gardener@example.com',
            'kitchen@group.calendar.google.com',
            'beans_20261012T090000Z',
        ])
    })
})
