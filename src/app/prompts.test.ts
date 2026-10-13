import { describe, expect, it } from 'vitest'

import type { ShownEvent } from './calendar-store.svelte'
import type { Choice } from './choice'
import { confirmChange } from './prompts'

/** An event as a View holds it, with what a test needs set. */
function shown(overrides: Partial<ShownEvent['event']> = {}, hasGuests = false): ShownEvent {
    return { hasGuests, event: { id: 'beans', etag: '"1"', start: {}, end: {}, ...overrides } } as unknown as ShownEvent
}

/** Answers each question in turn, recording its title. */
function answers(...values: unknown[]) {
    const asked: string[] = []
    const ask = async <T,>(choice: Choice<T>) => {
        asked.push(choice.title)
        return (values.shift() ?? null) as T | null
    }
    return { ask, asked }
}

describe('what a change asks first', () => {
    it('asks nothing of a lone event without guests, and emails nobody', async () => {
        const { ask, asked } = answers()
        expect(await confirmChange(ask, shown(), 'change')).toEqual({ sendUpdates: 'none' })
        expect(asked).toEqual([])
    })

    it('asks which occurrences for a repeating event, then about emails for one with guests', async () => {
        const { ask, asked } = answers('following', 'all')
        expect(await confirmChange(ask, shown({ recurringEventId: 'series' }, true), 'delete')).toEqual({ scope: 'following', sendUpdates: 'all' })
        expect(asked).toEqual(['Delete repeating event', 'Send update emails to guests?'])
    })

    it('does not ask about emails when the person is a guest, whose change stays on their own copy', async () => {
        const { ask, asked } = answers()
        expect(await confirmChange(ask, shown({ organizer: { email: 'orchard@example.com' } }, true), 'change')).toEqual({ sendUpdates: 'none' })
        expect(asked).toEqual([])
    })

    it('changes nothing when either question is cancelled', async () => {
        expect(await confirmChange(answers(null).ask, shown({ recurringEventId: 'series' }), 'change')).toBeNull()
        expect(await confirmChange(answers('this', null).ask, shown({ recurringEventId: 'series' }, true), 'change')).toBeNull()
    })
})
