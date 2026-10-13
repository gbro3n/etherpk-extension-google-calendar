/**
 * The questions a change can need answering first, as Google Calendar asks them: which occurrences
 * of a repeating event it applies to, and whether guests are emailed about it.
 */
import type { Choice } from './choice'
import type { ActionOptions, EditScope, SendUpdates } from './actions'
import type { ShownEvent } from './calendar-store.svelte'

export type Ask = <T>(choice: Choice<T>) => Promise<T | null>

export type ChangeKind = 'change' | 'delete'

export function scopeChoice(kind: ChangeKind): Choice<EditScope> {
    return {
        title: kind === 'delete' ? 'Delete repeating event' : 'Change repeating event',
        options: [
            { value: 'this', label: 'This event', primary: true },
            { value: 'following', label: 'This and following events' },
            { value: 'all', label: 'All events' },
        ],
    }
}

export function sendUpdatesChoice(kind: ChangeKind | 'invite'): Choice<SendUpdates> {
    const body =
        kind === 'delete'
            ? 'Google can email the guests to say the event is cancelled.'
            : kind === 'invite'
              ? 'Google can email the guests an invitation.'
              : 'Google can email the guests to say what changed.'
    return {
        title: kind === 'invite' ? 'Send invitation emails to guests?' : 'Send update emails to guests?',
        body,
        options: [
            { value: 'all', label: 'Send', primary: true },
            { value: 'none', label: "Don't send" },
        ],
    }
}

/**
 * Ask what a change to `shown` needs answering: the scope for a repeating event, then emails for an
 * event with guests. Null when the person cancelled, which changes nothing.
 */
export async function confirmChange(ask: Ask, shown: ShownEvent, kind: ChangeKind): Promise<ActionOptions | null> {
    const options: ActionOptions = {}
    if (shown.event.recurringEventId) {
        const scope = await ask(scopeChoice(kind))
        if (scope === null) return null
        options.scope = scope
    }
    // Only the organiser's change reaches the guests: a guest's change stays on their own copy.
    // Google marks the organiser with `self` only when it is the person signed in.
    const organiser = !shown.event.organizer || shown.event.organizer.self === true
    if (shown.hasGuests && organiser) {
        const sendUpdates = await ask(sendUpdatesChoice(kind))
        if (sendUpdates === null) return null
        options.sendUpdates = sendUpdates
    } else options.sendUpdates = 'none'
    return options
}
