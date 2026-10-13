import { describe, expect, it } from 'vitest'

import type { Task } from '../google/types'
import { dueWords, inListOrder } from './tasks'

const task = (id: string, position: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'needsAction', position, ...extra })
const order = (tasks: Task[]) => inListOrder(tasks, (item) => item).map(({ item, depth }) => `${'  '.repeat(depth)}${item.id}`)

describe('inListOrder', () => {
    it("puts tasks in Google's order, by position", () => {
        expect(order([task('rake', '00000000000000000002'), task('hoe', '00000000000000000001'), task('spade', '00000000000000000003')])).toEqual(['hoe', 'rake', 'spade'])
    })

    it('puts each subtask right after its parent, a level in, in its own order', () => {
        expect(
            order([
                task('labels', '00000000000000000001', { parent: 'seeds' }),
                task('fence', '00000000000000000002'),
                task('trays', '00000000000000000000', { parent: 'seeds' }),
                task('seeds', '00000000000000000001'),
            ]),
        ).toEqual(['seeds', '  trays', '  labels', 'fence'])
    })

    it('stands a subtask whose parent is not listed at the top level', () => {
        expect(order([task('labels', '00000000000000000001', { parent: 'gone' }), task('fence', '00000000000000000000')])).toEqual(['fence', 'labels'])
    })

    it('keeps every task, even ones whose parents name each other', () => {
        const placed = inListOrder([task('one', '1', { parent: 'two' }), task('two', '2', { parent: 'one' }), task('three', '3')], (item) => item)
        expect(placed.map(({ item }) => item.id).sort()).toEqual(['one', 'three', 'two'])
    })
})

describe('dueWords', () => {
    const today = '2026-10-12'

    it('says nothing for a task with no due date', () => {
        expect(dueWords(undefined, today, 'en-GB')).toBeNull()
    })

    it('says Due today on its day', () => {
        expect(dueWords('2026-10-12T00:00:00.000Z', today, 'en-GB')).toEqual({ text: 'Due today', overdue: false })
    })

    it('names a later day, and the year only when it is another year', () => {
        expect(dueWords('2026-10-15T00:00:00.000Z', today, 'en-GB')).toEqual({ text: 'Due 15 Oct', overdue: false })
        expect(dueWords('2027-01-04T00:00:00.000Z', today, 'en-GB')).toEqual({ text: 'Due 4 Jan 2027', overdue: false })
    })

    it('says a day that has passed was the due date', () => {
        expect(dueWords('2026-10-09T00:00:00.000Z', today, 'en-GB')).toEqual({ text: 'Was due 9 Oct', overdue: true })
    })
})
