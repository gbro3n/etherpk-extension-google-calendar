<script lang="ts">
    /**
     * Find a time, in the event editor: when the person and their guests are busy on the event's day,
     * from Google's free and busy times, and the times in working hours when everyone is free. Picking
     * one moves the event there. A guest whose calendar the person can't see is named, since their
     * times are not counted.
     */
    import type { CalendarApp } from '../app/app.svelte'
    import { busyDuring, freeSlots, type Busy } from '../app/free-slots'
    import { freeBusy } from '../google/calendar-api'
    import { GoogleError } from '../google/http'

    let {
        app,
        account,
        guests,
        day,
        start,
        end,
        onpick,
    }: {
        app: CalendarApp
        /** The account the event is in, whose own calendar counts too. */
        account: string
        guests: string[]
        day: Date
        start: Date
        end: Date
        onpick: (start: Date) => void
    } = $props()

    let found = $state<{ kind: 'loading' } | { kind: 'ready'; busy: Map<string, Busy[]>; unseen: string[] } | { kind: 'failed'; message: string }>({ kind: 'loading' })

    // The parent makes new arrays and dates as the form changes: what is asked of Google is keyed by
    // their values, so it is asked again only when the people or the day change.
    const peopleKey = $derived([account, ...guests.filter((guest) => guest !== account)].join('\n'))
    const dayKey = $derived(`${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`)

    $effect(() => {
        const people = peopleKey.split('\n')
        const [year, month, date] = dayKey.split('-').map(Number)
        const day = new Date(year, month, date)
        const from = new Date(day.getFullYear(), day.getMonth(), day.getDate())
        const to = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
        const client = app.store.client(account)
        if (!client) return
        const controller = new AbortController()
        found = { kind: 'loading' }
        freeBusy(client, { timeMin: from, timeMax: to, items: people }, controller.signal).then(
            (calendars) => {
                const busy = new Map<string, Busy[]>()
                const unseen: string[] = []
                for (const person of people) {
                    const answer = calendars[person]
                    if (!answer || answer.errors?.length) unseen.push(person)
                    else busy.set(person, answer.busy.map((period) => ({ start: new Date(period.start), end: new Date(period.end) })))
                }
                found = { kind: 'ready', busy, unseen }
            },
            (error: unknown) => {
                if (controller.signal.aborted) return
                const message =
                    error instanceof GoogleError && error.kind === 'forbidden'
                        ? 'This account was connected before Find a time was added. Connect it again in Calendar Events to use it.'
                        : error instanceof Error
                          ? error.message
                          : 'Free and busy times could not be loaded.'
                found = { kind: 'failed', message }
            },
        )
        return () => controller.abort()
    })

    const slots = $derived(found.kind === 'ready' ? freeSlots({ day, length: end.getTime() - start.getTime(), busy: [...found.busy.values()].flat() }) : [])
    const clashing = $derived(found.kind === 'ready' ? busyDuring(found.busy, start, end) : [])
    const hour12 = $derived(app.store.accounts.find((candidate) => candidate.email === account)?.settings.format24HourTime === 'false')
    const time = (date: Date) => date.toLocaleTimeString(undefined, { hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12 })
</script>

<div class="gc-find" data-testid="gc-find-time">
    {#if found.kind === 'loading'}
        <p class="gc-muted" role="status">Looking at everyone's calendars…</p>
    {:else if found.kind === 'failed'}
        <p class="gk-error" role="alert">{found.message}</p>
    {:else}
        {#if clashing.length > 0}
            <p role="status">Busy at this time: {clashing.join(', ')}</p>
        {:else}
            <p role="status">Everyone is free at this time.</p>
        {/if}
        {#if found.unseen.length > 0}
            <p class="gc-muted">Not counted, because their calendars can't be seen from this account: {found.unseen.join(', ')}</p>
        {/if}
        {#if slots.length > 0}
            <p class="gc-muted">Everyone is free at:</p>
            <div class="gc-find__slots">
                {#each slots.slice(0, 12) as slot (slot.getTime())}
                    <button type="button" class="gk-button" data-testid="gc-find-slot" onclick={() => onpick(slot)}>{time(slot)}</button>
                {/each}
            </div>
        {:else}
            <p class="gc-muted">Nobody's free time lines up between 8:00 and 18:00 that day.</p>
        {/if}
    {/if}
</div>

<style>
    .gc-find {
        display: grid;
        gap: 0.375rem;
        padding: 0.75rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 0.5rem;
        background: var(--gk-surface-1);
    }
    .gc-find p {
        margin: 0;
    }
    .gc-find__slots {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem;
    }
</style>
