import { describe, expect, it } from 'vitest'

import { busyDuring, freeSlots } from './free-slots'

const at = (hours: number, minutes = 0) => new Date(2026, 9, 12, hours, minutes)
const hour = 60 * 60 * 1000

describe('times when everyone is free', () => {
    it('are the half hours in working hours that clash with nobody', () => {
        const slots = freeSlots({ day: at(0), length: hour, busy: [{ start: at(8), end: at(10, 30) }, { start: at(12), end: at(16) }], from: 8, to: 18 })
        expect(slots.map((slot) => slot.getHours() * 100 + slot.getMinutes())).toEqual([1030, 1100, 1600, 1630, 1700])
    })

    it('fit the whole event before the working day ends', () => {
        expect(freeSlots({ day: at(0), length: 2 * hour, busy: [], from: 16, to: 18 }).map((slot) => slot.getHours())).toEqual([16])
    })
})

describe('who is busy during a time', () => {
    it('is each person with a period overlapping it, and nobody whose period only touches it', () => {
        const people = new Map([
            ['gardener@example.com', [{ start: at(9), end: at(10) }]],
            ['orchard@example.com', [{ start: at(10, 30), end: at(11) }]],
        ])
        expect(busyDuring(people, at(10), at(11))).toEqual(['orchard@example.com'])
    })
})
