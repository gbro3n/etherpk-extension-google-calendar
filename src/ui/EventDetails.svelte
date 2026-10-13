<script lang="ts">
    /**
     * One event's details, beside where it was clicked (a sheet across the bottom on a phone): its
     * time, how it repeats, where, the Meet link, the guests and their answers, attachments, the
     * description with its formatting, notifications, and the calendar it is in.
     *
     * From here an event is edited, deleted, answered (Yes, No or Maybe, for an invitation), opened
     * in Google Calendar, or its day's Journal Entry opened. Escape closes it.
     */
    import type { CalendarApp } from '../app/app.svelte'
    import { ownResponse, type ShownEvent } from '../app/calendar-store.svelte'
    import { getEvent } from '../google/calendar-api'
    import { parseDescription, renderDescription } from '../model/description'
    import { describeRule, parseRecurrence } from '../model/recurrence'
    import { formatTimeRange, isoDay } from '../model/time'
    import OpensInNewTab from './OpensInNewTab.svelte'
    import { popover } from './popover'
    import { safeUrl } from './safe-url'

    let {
        app,
        event,
        anchor,
        onclose,
        onedit,
        ondelete,
        onproblem,
        onopenday,
        showOpenCalendar = false,
    }: {
        app: CalendarApp
        event: ShownEvent
        anchor: DOMRect | null
        onclose: () => void
        onedit: () => void
        ondelete: () => void
        onproblem: (message: string) => void
        onopenday?: () => void
        /** In a Journal Panel: offer Open in Calendar Events. */
        showOpenCalendar?: boolean
    } = $props()

    const settings = $derived(app.store.accounts.find((account) => account.email === event.account)?.settings ?? {})
    const hour12 = $derived(settings.format24HourTime === 'false')
    const response = $derived(ownResponse(event.event))
    const invited = $derived(response !== undefined && !event.event.organizer?.self)
    const meetEntry = $derived(event.event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === 'video') ?? (event.event.hangoutLink ? { uri: event.event.hangoutLink, label: undefined } : undefined))
    const meet = $derived(meetEntry && safeUrl(meetEntry.uri) ? meetEntry : undefined)
    const phones = $derived(event.event.conferenceData?.entryPoints?.filter((entry) => entry.entryPointType === 'phone' && safeUrl(entry.uri)) ?? [])
    const attachments = $derived((event.event.attachments ?? []).filter((attachment) => safeUrl(attachment.fileUrl)))
    const googleLink = $derived(safeUrl(event.event.htmlLink))
    const guests = $derived((event.event.attendees ?? []).filter((attendee) => !attendee.resource))
    const rooms = $derived((event.event.attendees ?? []).filter((attendee) => attendee.resource))
    const answerWords: Record<string, string> = { accepted: 'Yes', declined: 'No', tentative: 'Maybe', needsAction: 'Awaiting' }

    /** How the series repeats, read from the series itself, which its occurrences do not carry. */
    let repeat = $state<string | null>(null)
    $effect(() => {
        const series = event.event.recurringEventId
        repeat = null
        if (!series) return
        const client = app.store.client(event.account)
        if (!client) return
        const controller = new AbortController()
        getEvent(client, event.calendar.id, series, controller.signal).then(
            (found) => {
                const { rule } = parseRecurrence(found.recurrence)
                repeat = rule ? describeRule(rule, event.span.start) : 'Repeats'
            },
            () => (repeat = 'Repeats'),
        )
        return () => controller.abort()
    })

    let answering = $state(false)
    async function answer(next: 'accepted' | 'declined' | 'tentative') {
        if (answering || next === response) return
        answering = true
        try {
            await app.actions.respond(event, next)
        } catch (error) {
            onproblem(error instanceof Error ? error.message : String(error))
        } finally {
            answering = false
        }
    }

    function reminderText(minutes: number, method: string): string {
        const unit = minutes % 10080 === 0 && minutes > 0 ? ['week', minutes / 10080] : minutes % 1440 === 0 && minutes > 0 ? ['day', minutes / 1440] : minutes % 60 === 0 && minutes > 0 ? ['hour', minutes / 60] : ['minute', minutes]
        const [word, count] = unit as [string, number]
        const amount = minutes === 0 ? 'At the start' : `${count} ${word}${count === 1 ? '' : 's'} before`
        return `${amount}, by ${method === 'email' ? 'email' : 'notification'}`
    }

    const narrow = $derived(typeof window !== 'undefined' && window.innerWidth < 640)
    const position = $derived.by(() => {
        if (narrow || !anchor) return null
        const width = 360
        const left = anchor.right + 8 + width < window.innerWidth ? anchor.right + 8 : Math.max(8, anchor.left - width - 8)
        const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 480))
        return { left, top }
    })
</script>

<div
    class={['gc-details', narrow && 'gc-details--sheet']}
    role="dialog"
    aria-label={event.event.summary || '(No title)'}
    data-testid="gc-details"
    tabindex="-1"
    style:left={position ? `${position.left}px` : undefined}
    style:top={position ? `${position.top}px` : undefined}
    {@attach popover(onclose)}
>
    <div class="gc-details__actions">
        {#if event.editable}
            <button type="button" class="gc-icon-button" aria-label="Edit event" title="Edit event" data-testid="gc-details-edit" onclick={onedit}>
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z" /></svg>
            </button>
            <button type="button" class="gc-icon-button" aria-label="Delete event" title="Delete event" data-testid="gc-details-delete" onclick={ondelete}>
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.75 9h5.5l.75-9" /></svg>
            </button>
        {/if}
        <button type="button" class="gc-icon-button" aria-label="Close" data-autofocus data-testid="gc-details-close" onclick={onclose}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
    </div>

    <div class="gc-details__head">
        <span class="gc-swatch gc-details__swatch" style:background={event.color}></span>
        <div>
            <h3 class="gc-details__title" data-testid="gc-details-title">{event.event.summary || '(No title)'}</h3>
            <p class="gc-details__when">
                {event.span.start.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}{#if !event.span.allDay || event.span.end.getTime() - event.span.start.getTime() > 86_400_000},
                    {formatTimeRange(event.span, { hour12 })}{/if}
            </p>
            {#if repeat}<p class="gc-muted" data-testid="gc-details-repeat">{repeat}</p>{/if}
        </div>
    </div>

    {#if meet}
        <div class="gc-details__row">
            <a class="gc-button gc-button--primary" href={meet.uri} target="_blank" rel="noopener noreferrer" data-testid="gc-details-meet">Join with Google Meet</a>
            <span class="gc-muted gc-details__wrap">{meet.uri.replace(/^https:\/\//, '')}</span>
        </div>
        {#each phones as phone (phone.uri)}
            <p class="gc-details__row gc-muted">Join by phone: <a class="gc-link" href={phone.uri}>{phone.label ?? phone.uri}</a>{#if phone.pin}, PIN {phone.pin}{/if}</p>
        {/each}
    {/if}

    {#if event.event.location}
        <p class="gc-details__row">
            <span class="gc-details__wrap">{event.event.location}</span>
            <a class="gc-link" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.event.location)}`} target="_blank" rel="noopener noreferrer">Map</a>
        </p>
    {/if}

    {#if guests.length > 0}
        <div class="gc-details__section">
            <h4>{guests.length} {guests.length === 1 ? 'guest' : 'guests'}</h4>
            <ul class="gc-details__guests" data-testid="gc-details-guests">
                {#each guests as guest (guest.email)}
                    <li>
                        <span class="gc-details__wrap">{guest.displayName ?? guest.email}{#if guest.organizer}, organiser{/if}{#if guest.optional}, optional{/if}</span>
                        <span class="gc-muted">{answerWords[guest.responseStatus ?? 'needsAction']}</span>
                    </li>
                {/each}
            </ul>
        </div>
    {/if}
    {#if rooms.length > 0}
        <p class="gc-details__row gc-muted">Rooms: {rooms.map((room) => room.displayName ?? room.email).join(', ')}</p>
    {/if}

    {#if attachments.length}
        <div class="gc-details__section">
            <h4>Attachments</h4>
            <ul class="gc-details__attachments">
                {#each attachments as attachment (attachment.fileUrl)}
                    <li><a class="gc-link" href={attachment.fileUrl} target="_blank" rel="noopener noreferrer">{attachment.title ?? attachment.fileUrl}</a></li>
                {/each}
            </ul>
        </div>
    {/if}

    {#if event.event.description}
        <div class="gc-details__description" data-testid="gc-details-description" {@attach (element) => element.replaceChildren(renderDescription(parseDescription(event.event.description ?? ''), element.ownerDocument))}></div>
    {/if}

    {#if event.event.reminders}
        <div class="gc-details__section">
            <h4>Notifications</h4>
            {#if event.event.reminders.useDefault}
                <p class="gc-muted">The calendar's default notifications</p>
            {:else if event.event.reminders.overrides?.length}
                <ul class="gc-details__plain">
                    {#each event.event.reminders.overrides as reminder, index (index)}
                        <li>{reminderText(reminder.minutes, reminder.method)}</li>
                    {/each}
                </ul>
            {:else}
                <p class="gc-muted">None</p>
            {/if}
        </div>
    {/if}

    <p class="gc-details__row gc-muted">
        <span class="gc-swatch" style:background={event.color}></span>
        <span data-testid="gc-details-calendar">{event.calendarName}</span>
        {#if app.store.accounts.length > 1}<span class="gc-details__wrap">({event.account})</span>{/if}
    </p>
    {#if event.event.transparency === 'transparent'}<p class="gc-muted">Shown as free</p>{/if}
    {#if event.event.visibility === 'private'}<p class="gc-muted">Private</p>{/if}

    {#if invited}
        <div class="gc-details__rsvp" role="group" aria-label="Going?">
            <span>Going?</span>
            {#each [['accepted', 'Yes'], ['declined', 'No'], ['tentative', 'Maybe']] as [value, label] (value)}
                <button type="button" class="gc-button" aria-pressed={response === value} disabled={answering} data-testid="gc-rsvp-{value}" onclick={() => void answer(value as 'accepted' | 'declined' | 'tentative')}
                    >{label}</button
                >
            {/each}
        </div>
    {/if}

    <div class="gc-details__footer">
        {#if googleLink}
            <a class="gc-link" href={googleLink} target="_blank" rel="noopener noreferrer">Open in Google Calendar<OpensInNewTab /></a>
        {/if}
        <button type="button" class="gc-link" data-testid="gc-details-journal" onclick={() => (onopenday ? onopenday() : app.openDay(isoDay(event.span.start)))}>Open journal entry</button>
        {#if showOpenCalendar}
            <button type="button" class="gc-link" data-testid="gc-details-open-calendar" onclick={() => app.openCalendar(isoDay(event.span.start))}>Open in Calendar Events</button>
        {/if}
    </div>
</div>

<style>
    /* A pop-up in the top layer (`popover.ts`): placed from the viewport, with the browser's own
       centring for pop-ups taken away. */
    .gc-details {
        position: fixed;
        inset: auto;
        margin: 0;
        width: 22.5rem;
        max-height: min(36rem, calc(100vh - 1rem));
        overflow: auto;
        padding: 0.75rem 1rem 1rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 0.75rem;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        box-shadow: var(--gk-shadow);
        font-size: 0.875rem;
        line-height: 1.5;
        top: 4rem;
        right: 1rem;
    }
    .gc-details--sheet {
        inset: auto 0 0 0;
        width: auto;
        max-height: 80vh;
        border-radius: 0.75rem 0.75rem 0 0;
    }
    .gc-details__actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.125rem;
    }
    .gc-details__head {
        display: flex;
        gap: 0.75rem;
        margin-bottom: 0.5rem;
    }
    .gc-details__swatch {
        margin-top: 0.375rem;
        width: 0.875rem;
        height: 0.875rem;
    }
    .gc-details__title {
        margin: 0;
        font-size: 1.125rem;
        font-weight: 600;
        overflow-wrap: anywhere;
    }
    .gc-details__when {
        margin: 0.125rem 0 0;
    }
    .gc-details__row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        margin: 0.5rem 0;
    }
    .gc-details__wrap {
        overflow-wrap: anywhere;
    }
    .gc-details__section h4 {
        margin: 0.75rem 0 0.25rem;
        font-size: 0.875rem;
        font-weight: 600;
    }
    .gc-details__guests,
    .gc-details__attachments,
    .gc-details__plain {
        display: grid;
        gap: 0.125rem;
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .gc-details__guests li {
        display: flex;
        justify-content: space-between;
        gap: 0.5rem;
    }
    .gc-details__description {
        margin: 0.75rem 0;
        overflow-wrap: anywhere;
    }
    .gc-details__description :global(ul),
    .gc-details__description :global(ol) {
        padding-left: 1.25rem;
    }
    .gc-details__description :global(a) {
        color: var(--gk-accent);
    }
    .gc-details__rsvp {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        margin: 0.75rem 0;
    }
    .gc-details__footer {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        margin-top: 0.75rem;
        padding-top: 0.75rem;
        border-top: 1px solid var(--gk-border-soft);
    }
</style>
