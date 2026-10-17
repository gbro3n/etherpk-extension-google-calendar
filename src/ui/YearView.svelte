<script lang="ts">
    /**
     * The Year view: twelve small months, as Google Calendar draws its year. EventCalendar has no year
     * view of its own, so the extension draws it. A day with events has a mark under its number.
     * Clicking a day opens a pop-up listing its events, with Go to day and Open journal entry.
     */
    import type { CalendarApp } from '../app/app.svelte'
    import type { ShownEvent } from '../app/calendar-store.svelte'
    import { addDays, isoDay } from '../model/time'
    import { popover } from './popover'

    let {
        app,
        year,
        firstDay,
        ongoto,
        onopen,
    }: {
        app: CalendarApp
        year: number
        firstDay: number
        ongoto: (day: Date) => void
        onopen: (key: string, element: HTMLElement | null) => void
    } = $props()

    const store = $derived(app.store)
    const todayKey = isoDay(new Date())

    /** Every shown event of the year, by each day it covers. */
    const byDay = $derived.by(() => {
        void store.version
        const days = new Map<string, ShownEvent[]>()
        const start = new Date(year, 0, 1)
        const end = new Date(year + 1, 0, 1)
        for (const event of store.events(start, end)) {
            let day = new Date(Math.max(event.span.start.getTime(), start.getTime()))
            day = new Date(day.getFullYear(), day.getMonth(), day.getDate())
            // An event ending at midnight does not reach the next day; a moment-long one marks its day.
            const last = event.span.end > event.span.start ? new Date(event.span.end.getTime() - 1) : event.span.start
            while (day <= last && day < end) {
                const key = isoDay(day)
                days.set(key, [...(days.get(key) ?? []), event])
                day = addDays(day, 1)
            }
        }
        return days
    })

    const weekdays = $derived(Array.from({ length: 7 }, (_, index) => new Date(2026, 0, 4 + ((firstDay + index) % 7)).toLocaleDateString(undefined, { weekday: 'narrow' })))

    /** The days a month's grid shows, from the week its first day is in, in whole weeks. */
    function monthGrid(month: number): (Date | null)[] {
        const first = new Date(year, month, 1)
        const lead = (first.getDay() - firstDay + 7) % 7
        const length = new Date(year, month + 1, 0).getDate()
        const cells: (Date | null)[] = Array.from({ length: lead }, () => null)
        for (let day = 1; day <= length; day++) cells.push(new Date(year, month, day))
        while (cells.length % 7 !== 0) cells.push(null)
        return cells
    }

    let opened = $state<{ day: Date; rect: DOMRect } | null>(null)
    const openedEvents = $derived(opened ? (byDay.get(isoDay(opened.day)) ?? []) : [])

    const hour12 = $derived(store.accounts.find((account) => account.status === 'ready')?.settings.format24HourTime === 'false')

    function formatTime(event: ShownEvent): string {
        if (event.span.allDay) return 'All day'
        return event.span.start.toLocaleTimeString(undefined, { hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12 })
    }
</script>

<div class="gc-year" data-testid="gc-year">
    {#each Array.from({ length: 12 }, (_, month) => month) as month (month)}
        <section class="gc-year__month" aria-label={new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}>
            <h3 class="gc-year__name">{new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long' })}</h3>
            <div class="gc-year__grid" role="grid">
                <div class="gc-year__row" role="row">
                    {#each weekdays as weekday, index (index)}
                        <span class="gc-year__weekday" role="columnheader">{weekday}</span>
                    {/each}
                </div>
                {#each Array.from({ length: monthGrid(month).length / 7 }, (_, row) => row) as row (row)}
                    <div class="gc-year__row" role="row">
                        {#each monthGrid(month).slice(row * 7, row * 7 + 7) as day, index (index)}
                            {#if day}
                                {@const key = isoDay(day)}
                                {@const count = byDay.get(key)?.length ?? 0}
                                <button
                                    type="button"
                                    role="gridcell"
                                    class={['gc-year__day', key === todayKey && 'gc-year__day--today', count > 0 && 'gc-year__day--busy']}
                                    aria-label={`${day.toLocaleDateString(undefined, { dateStyle: 'full' })}, ${count === 0 ? 'no events' : count === 1 ? '1 event' : `${count} events`}`}
                                    data-day={key}
                                    data-testid="gc-year-day"
                                    onclick={(event) => (opened = { day, rect: event.currentTarget.getBoundingClientRect() })}
                                    >{day.getDate()}{#if count > 0}<span class="gc-year__mark" style:background={byDay.get(key)?.[0]?.color} aria-hidden="true"></span>{/if}</button
                                >
                            {:else}
                                <span class="gc-year__blank" role="gridcell"></span>
                            {/if}
                        {/each}
                    </div>
                {/each}
            </div>
        </section>
    {/each}
</div>

{#if opened}
    {@const day = opened.day}
    <div
        class="gc-year__popup"
        role="dialog"
        aria-label={day.toLocaleDateString(undefined, { dateStyle: 'full' })}
        data-testid="gc-year-popup"
        tabindex="-1"
        style:top="{Math.min(opened.rect.bottom + 4, window.innerHeight - 320)}px"
        style:left="{Math.min(opened.rect.left, window.innerWidth - 300)}px"
        {@attach popover(() => (opened = null))}
    >
        <div class="gc-year__popup-head">
            <h4>{day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</h4>
            <button type="button" class="gk-icon-button" aria-label="Close" data-autofocus onclick={() => (opened = null)}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
        </div>
        {#if openedEvents.length === 0}
            <p class="gc-muted">No events</p>
        {:else}
            <ul class="gc-year__events">
                {#each openedEvents as event (event.key)}
                    <li>
                        <button type="button" class="gc-year__event" onclick={(clicked) => onopen(event.key, clicked.currentTarget)}>
                            <span class="gc-swatch" style:background={event.color}></span>
                            <span class="gc-muted">{formatTime(event)}</span>
                            <span>{event.event.summary || '(No title)'}</span>
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}
        <div class="gc-year__popup-actions">
            <button type="button" class="gk-button" data-testid="gc-year-go" onclick={() => ongoto(day)}>Go to day</button>
            <button type="button" class="gk-button" data-testid="gc-year-journal" onclick={() => app.openDay(isoDay(day))}>Open journal entry</button>
        </div>
    </div>
{/if}

<style>
    .gc-year {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
        gap: 1.5rem 1.25rem;
        padding: 1rem 1.25rem 2rem;
    }
    .gc-year__name {
        margin: 0 0 0.5rem;
        font-size: 0.9375rem;
        font-weight: 600;
    }
    .gc-year__grid {
        display: grid;
        gap: 0.125rem;
    }
    .gc-year__row {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        justify-items: center;
    }
    .gc-year__weekday {
        font-size: 0.875rem;
        color: var(--gk-text-muted);
    }
    .gc-year__day {
        position: relative;
        width: 2rem;
        height: 2rem;
        border: 0;
        border-radius: 999px;
        background: transparent;
        color: var(--gk-text-default);
        font-size: 0.875rem;
        cursor: pointer;
    }
    .gc-year__day:hover {
        background: var(--gk-surface-2);
    }
    .gc-year__day:focus-visible {
        outline: 2px solid var(--gk-accent);
    }
    .gc-year__day--today {
        background: var(--gk-accent);
        color: var(--gk-surface-0);
        font-weight: 600;
    }
    .gc-year__day--today:hover {
        background: var(--gk-accent-hover);
    }
    .gc-year__mark {
        position: absolute;
        left: 50%;
        bottom: 0.1875rem;
        width: 0.3125rem;
        height: 0.3125rem;
        border-radius: 999px;
        transform: translateX(-50%);
    }
    .gc-year__blank {
        width: 2rem;
        height: 2rem;
    }
    .gc-year__popup {
        position: fixed;
        inset: auto;
        margin: 0;
        width: 18rem;
        max-height: 20rem;
        overflow: auto;
        padding: 0.75rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 0.75rem;
        background: var(--gk-surface-0);
        box-shadow: var(--gk-shadow);
    }
    .gc-year__popup-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .gc-year__popup-head h4 {
        margin: 0;
        font-size: 0.9375rem;
    }
    .gc-year__events {
        display: grid;
        gap: 0.125rem;
        margin: 0.5rem 0;
        padding: 0;
        list-style: none;
    }
    .gc-year__event {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        min-height: 2rem;
        padding: 0.25rem 0.375rem;
        border: 0;
        border-radius: 0.375rem;
        background: transparent;
        text-align: left;
        cursor: pointer;
    }
    .gc-year__event:hover {
        background: var(--gk-surface-2);
    }
    .gc-year__popup-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
    }
</style>
