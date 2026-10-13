<script lang="ts">
    /**
     * The Calendar Events View: the person's Google Calendar in day, week, four day, month, year and
     * schedule views, with every connected account's ticked calendars in their own colours.
     *
     * Before an OAuth client is set and an account connected, it is the setup guide. Then the
     * toolbar, the list of calendars, and the calendar itself: EventCalendar draws every view but
     * Year, which is the extension's own. Clicking an event shows its details, from which it can be
     * edited, deleted or answered. Dragging an event moves it, dragging its edge resizes it, and
     * dragging across empty time or clicking a day creates one.
     *
     * The range on screen loads as it changes, and again every five minutes while the View can be
     * seen, keeping what is shown meanwhile. States the person can meet: loading over nothing,
     * refreshing over what is shown, offline with Retry, an account that needs reconnecting, and an
     * error with Retry.
     */
    import { Calendar, DayGrid, Interaction, List, TimeGrid } from '@event-calendar/core'
    import type { ViewMountProps } from '@appsoftwareltd/etherpk-extension-api'
    import { onDestroy, untrack } from 'svelte'

    import type { CalendarApp } from '../app/app.svelte'
    import type { ShownEvent } from '../app/calendar-store.svelte'
    import { confirmChange } from '../app/prompts'
    import type { ViewName } from '../app/records'
    import { addDays, isoDay, parseIsoDay } from '../model/time'
    import CalendarList from './CalendarList.svelte'
    import { ask as askWith, type Choice, type PendingChoice } from '../app/choice'
    import ChoiceDialog from './ChoiceDialog.svelte'
    import EventDetails from './EventDetails.svelte'
    import EventEditor, { type EditorOpen } from './EventEditor.svelte'
    import SetupGuide from './SetupGuide.svelte'
    import TaskDetails from './TaskDetails.svelte'
    import TaskEditor, { type TaskEditorOpen } from './TaskEditor.svelte'
    import { dueOf } from '../app/task-store.svelte'
    import UndoBar, { type UndoOffer } from './UndoBar.svelte'
    import YearView from './YearView.svelte'

    let { app, visibility, panelId }: ViewMountProps & { app: CalendarApp } = $props()
    const store = $derived(app.store)

    const EC_VIEWS: Record<Exclude<ViewName, 'year'>, string> = {
        day: 'timeGridDay',
        week: 'timeGridWeek',
        'four-days': 'timeGridFourDays',
        month: 'dayGridMonth',
        schedule: 'listSchedule',
    }
    const VIEW_LABELS: Record<ViewName, string> = { day: 'Day', week: 'Week', 'four-days': '4 days', month: 'Month', year: 'Year', schedule: 'Schedule' }

    let viewName = $state<ViewName>(untrack(() => app.records.lastView() ?? (app.context.layout.isDesktop() ? 'month' : 'schedule')))
    /**
     * The day asked for: Today, a day picked, the Year view's year. EventCalendar goes there when it
     * changes. Its own back and forward leave it be, and report what they show in `datesSet`.
     */
    let anchor = $state(new Date())
    /** The period EventCalendar last showed (its current, not its padded, range). */
    let shownPeriod = { start: new Date(), end: new Date() }
    /** What EventCalendar shows, as it last said: its range and title. */
    let range = $state<{ start: Date; end: Date } | null>(null)
    let title = $state('')
    /** EventCalendar's own methods, for back, forward and clearing a selection. */
    interface CalendarMethods {
        next(): void
        prev(): void
        unselect(): void
    }
    let calendarInstance = $state<unknown>()
    const calendar = $derived(calendarInstance as CalendarMethods | undefined)
    let listOpen = $state(untrack(() => app.context.layout.isDesktop()))
    let onScreen = $state(untrack(() => visibility.onScreen))
    let problem = $state<string | null>(null)

    let pending = $state<PendingChoice | null>(null)
    const ask = <T,>(choice: Choice<T>) => askWith<T>((next) => (pending = next), choice)

    let details = $state<{ key: string; anchor: DOMRect | null } | null>(null)
    let taskDetails = $state<{ key: string; anchor: DOMRect | null } | null>(null)
    let taskEditor = $state<TaskEditorOpen | null>(null)
    let editor = $state<EditorOpen | null>(null)
    let undo = $state<UndoOffer | null>(null)

    const setUp = $derived(app.oauth !== null && app.accounts.length > 0)

    // A Journal Panel asked to show a day here.
    $effect(() => {
        const day = app.focusDay
        if (!day) return
        untrack(() => {
            goToDay(parseIsoDay(day))
            app.focusDay = null
        })
    })

    $effect(() => visibility.subscribe((next) => (onScreen = next)))

    /** The year on screen in the Year view. */
    const yearRange = $derived({ start: new Date(anchor.getFullYear(), 0, 1), end: new Date(anchor.getFullYear() + 1, 0, 1) })
    const shownRange = $derived(viewName === 'year' ? yearRange : range)

    // Load the range on screen, and keep it fresh while it can be seen.
    $effect(() => {
        const current = shownRange
        void store.accounts
        void store.selection
        void app.tasks.staleness
        if (!current || !onScreen || !setUp) return
        void store.ensure(current.start, current.end)
        void app.tasks.ensure(current.start, current.end)
        const timer = setInterval(() => {
            void store.ensure(current.start, current.end)
            void app.tasks.ensure(current.start, current.end)
        }, 5 * 60 * 1000)
        return () => clearInterval(timer)
    })

    const rangeState = $derived(shownRange && setUp ? store.rangeState(shownRange.start, shownRange.end) : 'ready')
    const shown = $derived.by(() => {
        void store.version
        return range && viewName !== 'year' ? store.events(range.start, range.end) : []
    })

    const shownTasks = $derived.by(() => {
        void store.version
        void app.tasks.version
        return range && viewName !== 'year' ? app.tasks.tasks(range.start, range.end) : []
    })
    const tasksReady = $derived.by(() => {
        void store.version
        return app.tasks.on
    })

    /** Problems loading Google Tasks for the range on screen, said beside the events' own. */
    const taskProblem = $derived.by(() => {
        void app.tasks.version
        return shownRange && app.tasks.on ? app.tasks.problem(shownRange.start, shownRange.end) : null
    })

    /** A layout narrow enough that the calendar list covers the calendar. */
    let narrow = $state(false)
    $effect(() => {
        const query = window.matchMedia('(max-width: 720px)')
        narrow = query.matches
        const changed = () => (narrow = query.matches)
        query.addEventListener('change', changed)
        return () => query.removeEventListener('change', changed)
    })

    const settings = $derived(store.accounts.find((account) => account.status === 'ready')?.settings ?? {})
    const hour12 = $derived(settings.format24HourTime === 'false')
    const firstDay = $derived(Number(settings.weekStart ?? '1') as 0 | 1 | 2 | 3 | 4 | 5 | 6)

    /**
     * A time as EventCalendar reads it: a date for an all-day event, a local time with no offset for a
     * timed one, which it takes as the device's own time. Date objects made it read an all-day event
     * as starting at midnight, shown as "00:00".
     */
    const pad = (value: number) => String(value).padStart(2, '0')
    const ecTime = (date: Date, allDay: boolean) =>
        allDay ? isoDay(date) : `${isoDay(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`

    const ecEvents = $derived(
        shown.map((event) => ({
            id: event.key,
            start: ecTime(event.span.start, event.span.allDay),
            end: ecTime(event.span.end, event.span.allDay),
            allDay: event.span.allDay,
            title: event.event.summary || '(No title)',
            backgroundColor: event.color,
            textColor: event.textColor,
            startEditable: event.editable,
            durationEditable: event.editable,
            extendedProps: { key: event.key, calendarName: event.calendarName },
        })).concat(
            // Tasks as Google Calendar draws them: on their day, with a box ticked when done.
            shownTasks.map((task) => ({
                id: task.key,
                start: task.day,
                end: isoDay(addDays(parseIsoDay(task.day), 1)),
                allDay: true,
                title: task.task.title || '(No title)',
                backgroundColor: 'var(--gk-surface-2)',
                textColor: 'var(--gk-text-default)',
                startEditable: true,
                durationEditable: false,
                classNames: ['gc-task', ...(task.done ? ['gc-task--done'] : [])],
                extendedProps: { task: task.key, done: task.done },
            })) as never[],
        ),
    )

    /**
     * The day a new view opens on: today when it is in the period on screen, else the period's first
     * day, as Google Calendar keeps your place when you change views. From the Year view, the first
     * of its year, unless today is in it.
     */
    function focusDay(): Date {
        const today = new Date()
        const period = viewName === 'year' ? yearRange : shownPeriod
        return today >= period.start && today < period.end ? today : new Date(period.start)
    }

    function chooseView(next: ViewName) {
        if (next === viewName) return
        anchor = focusDay()
        viewName = next
        app.records.setLastView(next)
    }

    function move(step: 1 | -1) {
        if (viewName === 'year') anchor = new Date(anchor.getFullYear() + step, anchor.getMonth(), 1)
        else if (step === 1) calendar?.next()
        else calendar?.prev()
    }

    function today() {
        anchor = new Date()
    }

    function goToDay(day: Date) {
        viewName = 'day'
        app.records.setLastView('day')
        anchor = day
    }

    function openDetails(key: string, element: HTMLElement | null) {
        details = { key, anchor: element?.getBoundingClientRect() ?? null }
    }

    /** A drag moved or resized an event: confirm what it needs, then save, or put it back. */
    async function dragged(key: string, span: { start: Date; end: Date; allDay: boolean }, revert: () => void) {
        const event = store.find(key)
        if (!event || !event.editable) return revert()
        const options = await confirmChange(ask, event, 'change')
        if (!options) return revert()
        try {
            await app.actions.save(event, { span }, options)
        } catch (error) {
            revert()
            problem = error instanceof Error ? error.message : String(error)
        }
    }

    /** A task dragged to another day: due then, or back where it was if Google refuses. */
    async function movedTask(key: string, day: Date, revert: () => void) {
        const task = shownTasks.find((candidate) => candidate.key === key)
        if (!task) return revert()
        try {
            await app.tasks.update(task, { due: dueOf(isoDay(day)) })
        } catch (error) {
            revert()
            problem = error instanceof Error ? error.message : String(error)
        }
    }

    async function removeTask(key: string) {
        const task = shownTasks.find((candidate) => candidate.key === key)
        if (!task) return
        taskDetails = null
        try {
            const restore = await app.tasks.remove(task)
            undo = { text: 'Task deleted', restore }
        } catch (error) {
            problem = error instanceof Error ? error.message : String(error)
        }
    }

    function create(start: Date, end: Date, allDay: boolean) {
        editor = { mode: 'create', span: { start, end, allDay } }
    }

    async function remove(event: ShownEvent) {
        const options = await confirmChange(ask, event, 'delete')
        if (!options) return
        details = null
        try {
            const restore = await app.actions.remove(event, options)
            undo = { text: options.scope && options.scope !== 'this' ? 'Events deleted' : 'Event deleted', restore }
        } catch (error) {
            problem = error instanceof Error ? error.message : String(error)
        }
    }

    // EventCalendar's handlers and fixed options are made once. A handler given anew each time the
    // options change is a changed option to EventCalendar, which calls a new `datesSet` again, and
    // setting the range from it changed the options again: an update loop.
    type DropInfo = { event: { start: Date; end: Date; allDay: boolean; extendedProps: Record<string, unknown> }; revert: () => void }
    const handlers = {
        datesSet: (info: { view: { title: string; activeStart: Date; activeEnd: Date; currentStart: Date; currentEnd: Date } }) => {
            const { activeStart, activeEnd } = info.view
            if (!range || range.start.getTime() !== activeStart.getTime() || range.end.getTime() !== activeEnd.getTime()) range = { start: activeStart, end: activeEnd }
            if (title !== info.view.title) title = info.view.title
            shownPeriod = { start: info.view.currentStart, end: info.view.currentEnd }
        },
        eventClick: (info: { el: HTMLElement; event: { extendedProps: Record<string, unknown> } }) => {
            if (info.event.extendedProps.task) taskDetails = { key: String(info.event.extendedProps.task), anchor: info.el.getBoundingClientRect() }
            else openDetails(String(info.event.extendedProps.key), info.el)
        },
        dateClick: (info: { date: Date; allDay: boolean }) => {
            const end = info.allDay ? new Date(info.date.getFullYear(), info.date.getMonth(), info.date.getDate() + 1) : new Date(info.date.getTime() + 60 * 60 * 1000)
            create(info.date, end, info.allDay)
        },
        select: (info: { start: Date; end: Date; allDay: boolean }) => {
            create(info.start, info.end, info.allDay)
            calendar?.unselect()
        },
        eventDrop: (info: DropInfo) =>
            info.event.extendedProps.task
                ? void movedTask(String(info.event.extendedProps.task), info.event.start, info.revert)
                : void dragged(String(info.event.extendedProps.key), { start: info.event.start, end: info.event.end, allDay: info.event.allDay }, info.revert),
        eventResize: (info: DropInfo) => void dragged(String(info.event.extendedProps.key), { start: info.event.start, end: info.event.end, allDay: info.event.allDay }, info.revert),
    }
    const views = {
        timeGridFourDays: { type: 'timeGridDay', duration: { days: 4 } },
        listSchedule: { type: 'listDay', duration: { days: 30 } },
    }
    const headerToolbar = { start: '', center: '', end: '' }
    const buttonText = (text: Record<string, string>) => ({ ...text, today: 'Today' })
    const locale = navigator.language
    const timeFormat = $derived({ hour: 'numeric', minute: '2-digit', hour12 } as Intl.DateTimeFormatOptions)

    const options = $derived({
        view: EC_VIEWS[viewName === 'year' ? 'month' : viewName],
        date: anchor,
        events: ecEvents,
        headerToolbar,
        height: '100%',
        firstDay,
        nowIndicator: true,
        scrollTime: '08:00:00',
        dayMaxEvents: true,
        selectable: true,
        editable: true,
        eventTimeFormat: timeFormat,
        // The start alone in a chip, as Google Calendar's month shows it; the details say when it ends.
        displayEventEnd: false,
        slotLabelFormat: timeFormat,
        locale,
        views,
        buttonText,
        noEventsContent: 'No events in this period',
        ...handlers,
    })

    onDestroy(() => pending?.answer(null))
</script>

<svelte:window
    onkeydown={(event) => {
        if (event.key === 'Escape' && narrow && listOpen && !event.defaultPrevented) listOpen = false
    }}
/>

<div class={['gc-view', app.dark && 'ec-dark']} data-testid="gc-view">
    {#if !setUp}
        <div class="gc-scroll"><SetupGuide {app} /></div>
    {:else}
        <header class="gc-toolbar">
            <button type="button" class="gc-icon-button" aria-label={listOpen ? 'Hide the calendar list' : 'Show the calendar list'} aria-expanded={listOpen} onclick={() => (listOpen = !listOpen)}>
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></svg>
            </button>
            <div class="gc-toolbar__lead">
            <button type="button" class="gc-button" onclick={today} data-testid="gc-today">Today</button>
            <div class="gc-toolbar__nav">
                <button type="button" class="gc-icon-button" aria-label="Back" onclick={() => move(-1)} data-testid="gc-prev">
                    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M10 3.5 5.5 8 10 12.5" /></svg>
                </button>
                <button type="button" class="gc-icon-button" aria-label="Forward" onclick={() => move(1)} data-testid="gc-next">
                    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
                </button>
            </div>
            <h2 class="gc-toolbar__title" data-testid="gc-title">{viewName === 'year' ? anchor.getFullYear() : title}</h2>
            <span class="gc-toolbar__state" role="status" data-testid="gc-range-state" data-state={rangeState}>
                {#if rangeState === 'refreshing'}Refreshing…{:else if rangeState === 'loading'}Loading…{/if}
            </span>
            </div>
            <!-- Together, on the right of a wide toolbar and on the left of the row they wrap to on a phone. -->
            <div class="gc-toolbar__actions">
            <label class="gc-toolbar__views">
                <span class="gc-visually-hidden">View</span>
                <select class="gc-select" value={viewName} onchange={(event) => chooseView(event.currentTarget.value as ViewName)} data-testid="gc-view-picker">
                    {#each Object.entries(VIEW_LABELS) as [value, label] (value)}
                        <option {value}>{label}</option>
                    {/each}
                </select>
            </label>
            {#if tasksReady}
                <button type="button" class="gc-button" data-testid="gc-add-task" onclick={() => (taskEditor = { mode: 'create', day: isoDay(new Date()) })}>Add task</button>
            {/if}
            <button type="button" class="gc-button gc-button--primary" data-testid="gc-create" onclick={() => create(new Date(Math.ceil(Date.now() / 1_800_000) * 1_800_000), new Date(Math.ceil(Date.now() / 1_800_000) * 1_800_000 + 3_600_000), false)}
                >Create</button
            >
            </div>
        </header>

        {#if rangeState === 'offline' || rangeState === 'error' || problem || taskProblem}
            <div class="gc-banner" role="alert" data-testid="gc-banner">
                <span>
                    {#if problem}{problem}{:else if rangeState === 'offline'}Google can't be reached, so the events shown may be out of date.{:else if rangeState === 'error'}{store.rangeProblem(shownRange!.start, shownRange!.end) ?? 'Some events could not be loaded.'}{:else}Google Tasks: {taskProblem}{/if}
                </span>
                {#if problem}
                    <button type="button" class="gc-button" onclick={() => (problem = null)}>Dismiss</button>
                {:else}
                    <button
                        type="button"
                        class="gc-button"
                        data-testid="gc-retry"
                        onclick={() => {
                            if (!shownRange) return
                            void store.ensure(shownRange.start, shownRange.end, { force: true })
                            app.tasks.reload()
                        }}>Retry</button
                    >
                {/if}
            </div>
        {/if}

        <div class="gc-body">
            {#if listOpen}
                <CalendarList {app} />
                <!-- On a phone the list covers the calendar: a tap on the calendar beside it closes it. -->
                {#if narrow}<button type="button" class="gc-scrim" aria-label="Close the calendar list" data-testid="gc-list-scrim" onclick={() => (listOpen = false)}></button>{/if}
            {/if}
            <main class="gc-main" aria-busy={rangeState === 'loading'}>
                {#if viewName === 'year'}
                    <YearView {app} year={anchor.getFullYear()} {firstDay} ongoto={goToDay} onopen={openDetails} />
                {:else}
                    <Calendar bind:this={calendarInstance} plugins={[DayGrid, TimeGrid, List, Interaction]} {options}>
                        {#snippet eventContent({ event, timeText }: { event: { title: unknown; allDay: boolean; extendedProps: Record<string, unknown> }; timeText: string })}
                            {@const time = event.allDay ? '' : timeText}
                            <!-- In a day or a week the title comes first, as in Google Calendar, so a short event shows what it is. -->
                            <span class={['gc-event', (viewName === 'day' || viewName === 'week' || viewName === 'four-days') && 'gc-event--stacked']}>
                                {#if event.extendedProps.task}<span class={['gc-event__box', Boolean(event.extendedProps.done) && 'gc-event__box--done']} aria-label={event.extendedProps.done ? 'Done' : 'Task'}></span>{/if}
                                {#if time && viewName !== 'day' && viewName !== 'week' && viewName !== 'four-days'}<span class="gc-event__time">{time}</span>{/if}
                                <span class="gc-event__title">{event.title}</span>
                                {#if time && (viewName === 'day' || viewName === 'week' || viewName === 'four-days')}<span class="gc-event__time">{time}</span>{/if}
                                {#if viewName === 'schedule'}<span class="gc-event__calendar">{event.extendedProps.calendarName}</span>{/if}
                            </span>
                        {/snippet}
                        {#snippet dayCellContent({ date }: { date: Date })}
                            <button type="button" class="gc-day-number" aria-label={`Go to ${date.toLocaleDateString(undefined, { dateStyle: 'full' })}`} onclick={(event) => (event.stopPropagation(), goToDay(date))}
                                >{date.getDate()}</button
                            >
                        {/snippet}
                    </Calendar>
                {/if}
            </main>
        </div>

        {#if details}
            {@const event = store.find(details.key)}
            {#if event}
                <EventDetails
                    {app}
                    {event}
                    anchor={details.anchor}
                    onclose={() => (details = null)}
                    onedit={() => {
                        editor = { mode: 'edit', key: event.key }
                        details = null
                    }}
                    ondelete={() => void remove(event)}
                    onproblem={(message) => (problem = message)}
                    onopenday={() => app.openDay(isoDay(event.span.start), panelId)}
                />
            {/if}
        {/if}

        <EventEditor {app} open={editor} {ask} onclose={() => (editor = null)} />
        {#if taskDetails}
            {@const task = shownTasks.find((candidate) => candidate.key === taskDetails?.key)}
            {#if task}
                <TaskDetails
                    {app}
                    {task}
                    anchor={taskDetails.anchor}
                    onclose={() => (taskDetails = null)}
                    onedit={() => {
                        taskEditor = { mode: 'edit', task }
                        taskDetails = null
                    }}
                    ondelete={() => void removeTask(task.key)}
                    onproblem={(message) => (problem = message)}
                />
            {/if}
        {/if}
        <TaskEditor {app} open={taskEditor} onclose={() => (taskEditor = null)} />
        <UndoBar offer={undo} ondone={() => (undo = null)} onproblem={(message) => (problem = message)} />
    {/if}
    <ChoiceDialog {pending} />
</div>

<style>
    .gc-view {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        font-size: 0.875rem;
    }
    .gc-scroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
    }
    .gc-toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid var(--gk-border-soft);
    }
    .gc-toolbar__nav {
        display: flex;
    }
    .gc-toolbar__title {
        margin: 0 0.25rem;
        font-size: 1.125rem;
        font-weight: 600;
        flex: 1 1 auto;
        min-width: 8rem;
    }
    .gc-toolbar__lead,
    .gc-toolbar__actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
    }
    .gc-toolbar__lead {
        flex: 1 1 auto;
        min-width: 0;
    }
    .gc-toolbar__state {
        color: var(--gk-text-muted);
    }
    /* The view picker matches the buttons beside it (`.gc-button`): their height and soft border. A
       select sizes itself unlike a button, so its height is set outright. */
    .gc-toolbar__views .gc-select {
        height: 2rem;
        min-height: 0;
        padding-block: 0;
        border-color: var(--gk-border-soft);
    }
    .gc-scrim {
        position: absolute;
        inset: 0;
        z-index: 4;
        border: 0;
        padding: 0;
        background: rgb(0 0 0 / 0.25);
        cursor: default;
    }
    .gc-banner {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid var(--gk-border-soft);
        background: var(--gk-warning-surface);
        color: var(--gk-text-default);
    }
    .gc-body {
        position: relative;
        display: flex;
        flex: 1 1 auto;
        min-height: 0;
    }
    .gc-main {
        flex: 1 1 auto;
        min-width: 0;
        min-height: 0;
        overflow: auto;
    }
    /* One line in a month, so as many events fit in a day as Google shows; wrapped in a day or week,
       where an event has the height of its time. */
    .gc-event {
        display: block;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }
    .gc-event > span + span {
        margin-left: 0.375rem;
    }
    .gc-event--stacked {
        display: flex;
        flex-direction: column;
        white-space: normal;
    }
    .gc-event--stacked > span + span {
        margin-left: 0;
    }
    .gc-event--stacked .gc-event__title {
        font-weight: 600;
    }
    .gc-event--stacked .gc-event__time {
        font-weight: 400;
    }
    .gc-event__time {
        font-weight: 600;
    }
    .gc-event__calendar {
        color: inherit;
    }
    .gc-event__box {
        display: inline-block;
        width: 0.75rem;
        height: 0.75rem;
        margin-right: 0.25rem;
        border: 1.5px solid currentColor;
        border-radius: 0.1875rem;
        vertical-align: -0.0625rem;
    }
    .gc-event__box--done {
        background: currentColor;
    }
    :global(.gc-task--done) .gc-event__title {
        text-decoration: line-through;
        color: var(--gk-text-muted);
    }
    .gc-day-number {
        min-width: 1.5rem;
        min-height: 1.5rem;
        padding: 0 0.25rem;
        border: 0;
        border-radius: 999px;
        background: transparent;
        cursor: pointer;
        font-size: 0.875rem;
    }
    .gc-day-number:hover {
        background: var(--gk-surface-2);
    }
    .gc-day-number:focus-visible {
        outline: 2px solid var(--gk-accent);
    }
</style>
