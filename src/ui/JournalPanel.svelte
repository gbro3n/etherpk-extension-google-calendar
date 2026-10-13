<script lang="ts">
    /**
     * The day's events and tasks beneath a Journal Entry (its Journal Panel), each part behind its own
     * switch in the extension's settings:
     *
     * - every shown calendar's events of that day, all-day ones first, each with its colour, time,
     *   title and calendar;
     * - under Due tasks, the tasks due that day, each with its task list;
     * - on today's entry only, every task not yet completed, a group for each task list, subtasks
     *   beneath their parent, leaving out those already under Due tasks.
     *
     * Clicking an event or task shows its details, where it can be edited or deleted as in Calendar
     * Events, and Add event starts one on this day. A task ticked off in the open lists stays there,
     * struck through, for the rest of the day, so nothing moves under the pointer.
     *
     * It loads once the entry's tab can be seen, and again every five minutes while it can. Before an
     * account is connected it says where to set one up. With every switch off the panel is not
     * registered at all, and with events off it draws nothing on a day with no tasks to show.
     */
    import type { JournalPanelProps } from '@appsoftwareltd/etherpk-extension-api'
    import { onDestroy, untrack } from 'svelte'

    import type { CalendarApp } from '../app/app.svelte'
    import type { ShownEvent } from '../app/calendar-store.svelte'
    import { confirmChange } from '../app/prompts'
    import type { ShownTask } from '../app/task-store.svelte'
    import { dueWords, inListOrder } from '../model/tasks'
    import { dayBounds, eventsOnDay, formatTimeRange, isoDay, parseIsoDay } from '../model/time'
    import { ask as askWith, type Choice, type PendingChoice } from '../app/choice'
    import ChoiceDialog from './ChoiceDialog.svelte'
    import EventDetails from './EventDetails.svelte'
    import EventEditor, { type EditorOpen } from './EventEditor.svelte'
    import UndoBar, { type UndoOffer } from './UndoBar.svelte'
    import TaskDetails from './TaskDetails.svelte'
    import TaskEditor, { type TaskEditorOpen } from './TaskEditor.svelte'

    let { app, day, panelId, visibility }: JournalPanelProps & { app: CalendarApp } = $props()
    const store = $derived(app.store)

    let onScreen = $state(untrack(() => visibility.onScreen))
    $effect(() => visibility.subscribe((next) => (onScreen = next)))

    const bounds = $derived(dayBounds(day))
    const setUp = $derived(app.oauth !== null && app.accounts.length > 0)
    /**
     * Today, read again each time the panel loads (as its tab comes into view, and every five
     * minutes), never kept from the mount: a tab left open overnight moves on to the new day.
     */
    let today = $state(isoDay(new Date()))
    const showOpen = $derived(app.journalOpenTasks && day === today)

    $effect(() => {
        const { start, end } = bounds
        const withOpen = app.journalOpenTasks
        void store.accounts
        void store.selection
        void app.tasks.staleness
        if (!onScreen || !setUp) return
        const load = () => {
            const now = isoDay(new Date())
            today = now
            void store.ensure(start, end)
            void app.tasks.ensure(start, end)
            if (withOpen && day === now) void app.tasks.ensureOpen()
        }
        load()
        const timer = setInterval(load, 5 * 60 * 1000)
        return () => clearInterval(timer)
    })

    const rangeState = $derived(setUp ? store.rangeState(bounds.start, bounds.end) : 'ready')
    const events = $derived.by(() => {
        void store.version
        return eventsOnDay(
            store.events(bounds.start, bounds.end).map((shown) => ({ ...shown, start: shown.event.start, end: shown.event.end })),
            day,
        ) as (ShownEvent & { start: unknown; end: unknown })[]
    })
    /** A task list's name, with its account's address where there are several accounts. */
    const listTitle = (task: ShownTask) => (store.accounts.length > 1 ? `${task.list.title} (${task.account})` : task.list.title)

    /** The tasks due this day, in the store's order (by list, then Google's order within it). */
    const dueTasks = $derived.by(() => {
        void store.version
        void app.tasks.version
        return app.journalTasks ? app.tasks.tasks(bounds.start, bounds.end).filter((task) => task.day === day) : []
    })
    /**
     * On today's entry, every task not yet completed, a group for each task list in Google's order of
     * lists, each in Google's order within it. Tasks under Due tasks above are left out, and so is a
     * list with nothing left to show.
     */
    const openGroups = $derived.by(() => {
        void store.version
        void app.tasks.version
        if (!showOpen) return []
        const above = new Set(dueTasks.map((task) => task.key))
        const open = app.tasks.openTasks(today).filter((task) => !above.has(task.key))
        return app.tasks.accounts().allowed.flatMap((email) =>
            (app.tasks.lists[email] ?? []).flatMap((list) => {
                const tasks = open.filter((task) => task.account === email && task.list.id === list.id)
                return tasks.length > 0 ? [{ key: `${email}|${list.id}`, title: listTitle(tasks[0]), rows: inListOrder(tasks, (task) => task.task) }] : []
            }),
        )
    })
    const openProblem = $derived(showOpen ? app.tasks.openProblem() : null)
    /** Every task the panel shows, for finding the one clicked. */
    const tasks = $derived([...dueTasks, ...openGroups.flatMap((group) => group.rows.map((row) => row.item))])
    let taskDetails = $state<{ key: string; anchor: DOMRect | null } | null>(null)
    let taskEditor = $state<TaskEditorOpen | null>(null)

    async function toggleTask(key: string) {
        const task = tasks.find((candidate) => candidate.key === key)
        if (!task) return
        try {
            await app.tasks.setDone(task, !task.done)
        } catch (error) {
            problem = error instanceof Error ? error.message : String(error)
        }
    }

    async function removeTask(key: string) {
        const task = tasks.find((candidate) => candidate.key === key)
        if (!task) return
        taskDetails = null
        try {
            undo = { text: 'Task deleted', restore: await app.tasks.remove(task) }
        } catch (error) {
            problem = error instanceof Error ? error.message : String(error)
        }
    }

    const hour12 = $derived(store.accounts.find((account) => account.status === 'ready')?.settings.format24HourTime === 'false')
    const needsReconnect = $derived(store.accounts.some((account) => account.status === 'reconnect'))

    let details = $state<{ key: string; anchor: DOMRect | null } | null>(null)
    let editor = $state<EditorOpen | null>(null)
    let undo = $state<UndoOffer | null>(null)
    let problem = $state<string | null>(null)
    let pending = $state<PendingChoice | null>(null)
    const ask = <T,>(choice: Choice<T>) => askWith<T>((next) => (pending = next), choice)

    function addEvent() {
        const start = parseIsoDay(day)
        start.setHours(9, 0, 0, 0)
        editor = { mode: 'create', span: { start, end: new Date(start.getTime() + 60 * 60 * 1000), allDay: false } }
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

    onDestroy(() => pending?.answer(null))
</script>

{#snippet taskRow(task: ShownTask, depth: number, aside: { text: string; overdue: boolean } | null)}
    <li class="gc-panel__task" style:padding-left="{0.375 + depth * 1.5}rem" data-testid="gc-panel-task-row">
        <input type="checkbox" checked={task.done} aria-label="Done: {task.task.title || '(No title)'}" data-testid="gc-panel-task-done" onchange={() => void toggleTask(task.key)} />
        <button type="button" class="gc-panel__event gc-panel__event--task" data-testid="gc-panel-task" onclick={(clicked) => (taskDetails = { key: task.key, anchor: clicked.currentTarget.getBoundingClientRect() })}>
            <span class={['gc-panel__name', task.done && 'gc-panel__name--done']}>{task.task.title || '(No title)'}</span>
            {#if aside}<span class={['gc-panel__calendar', aside.overdue && 'gc-panel__overdue']}>{aside.text}</span>{/if}
        </button>
    </li>
{/snippet}

<!-- Nothing at all, taking no space, when only tasks are asked for and the day has none. -->
{#if setUp && !app.journalEvents && dueTasks.length === 0 && openGroups.length === 0 && !openProblem}{:else}
<section class={['gc-panel', app.dark && 'ec-dark']} aria-label="Calendar events" data-testid="gc-journal-panel" data-state={setUp ? rangeState : 'not-set-up'}>
    <header class="gc-panel__head">
        <h2 class="gc-panel__title">{app.journalEvents ? 'Calendar' : 'Tasks'}</h2>
        {#if setUp}
            {#if rangeState === 'refreshing'}<span class="gc-muted" role="status">Refreshing…</span>{/if}
            <div class="gc-panel__actions">
                <button type="button" class="gc-link" data-testid="gc-panel-add" onclick={addEvent}>Add event</button>
                <button type="button" class="gc-link" data-testid="gc-panel-open" onclick={() => app.openCalendar(day)}>Open Calendar Events</button>
            </div>
        {/if}
    </header>

    {#if !setUp}
        <p class="gc-muted">
            Connect Google Calendar to see this day's events and tasks here.
            <button type="button" class="gc-link" data-testid="gc-panel-setup" onclick={() => app.openCalendar()}>Set it up</button>
        </p>
    {:else if rangeState === 'loading' && events.length === 0}
        <ul class="gc-panel__list" aria-busy="true" aria-label="Loading events">
            {#each [0, 1] as row (row)}<li class="gc-panel__skeleton"></li>{/each}
        </ul>
    {:else}
        {#if rangeState === 'offline' || rangeState === 'error'}
            <p class="gc-panel__problem" role="alert">
                {rangeState === 'offline' ? "Google can't be reached, so this day's events can't be loaded." : (store.rangeProblem(bounds.start, bounds.end) ?? "This day's events could not be loaded.")}
                <button type="button" class="gc-link" data-testid="gc-panel-retry" onclick={() => void store.ensure(bounds.start, bounds.end, { force: true })}>Retry</button>
            </p>
        {/if}
        {#if needsReconnect}
            <p class="gc-muted">An account needs connecting again. <button type="button" class="gc-link" onclick={() => app.openCalendar()}>Open Calendar Events</button></p>
        {/if}
        {#if app.journalEvents && events.length === 0 && rangeState !== 'offline' && rangeState !== 'error'}
            <p class="gc-muted" data-testid="gc-panel-empty">No events</p>
        {:else if app.journalEvents && events.length > 0}
            <ul class="gc-panel__list" data-testid="gc-panel-events">
                {#each events as event (event.key)}
                    <li>
                        <button type="button" class="gc-panel__event" data-testid="gc-panel-event" onclick={(clicked) => (details = { key: event.key, anchor: clicked.currentTarget.getBoundingClientRect() })}>
                            <span class="gc-swatch" style:background={event.color}></span>
                            <span class="gc-panel__time">{formatTimeRange(event.span, { hour12, day })}</span>
                            <span class="gc-panel__name">{event.event.summary || '(No title)'}</span>
                            <span class="gc-panel__calendar">{event.calendarName}</span>
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}
        <!-- Below the events, under a heading of their own as the events have Calendar: the day's due
             tasks, each with its list, then (today) each list's open tasks. With events off, the
             panel's own heading already reads Tasks. -->
        {#if app.journalEvents && (dueTasks.length > 0 || openGroups.length > 0 || openProblem)}
            <h2 class="gc-panel__title gc-panel__title--tasks">Tasks</h2>
        {/if}
        {#if dueTasks.length > 0}
            <section class="gc-panel__group" aria-label="Due tasks" data-testid="gc-panel-due">
                <h3 class="gc-panel__group-title">Due tasks</h3>
                <ul class="gc-panel__list">
                    {#each dueTasks as task (task.key)}
                        {@render taskRow(task, 0, { text: listTitle(task), overdue: false })}
                    {/each}
                </ul>
            </section>
        {/if}
        {#if openProblem}
            <p class="gc-panel__problem" role="alert">
                {openProblem}
                <button type="button" class="gc-link" data-testid="gc-panel-tasks-retry" onclick={() => void app.tasks.ensureOpen({ force: true })}>Retry</button>
            </p>
        {/if}
        {#each openGroups as group (group.key)}
            <section class="gc-panel__group" aria-label={group.title} data-testid="gc-panel-task-list">
                <h3 class="gc-panel__group-title">{group.title}</h3>
                <ul class="gc-panel__list">
                    {#each group.rows as { item, depth } (item.key)}
                        {@render taskRow(item, depth, dueWords(item.task.due, today))}
                    {/each}
                </ul>
            </section>
        {/each}
    {/if}

    {#if problem}
        <p class="gc-panel__problem" role="alert">{problem} <button type="button" class="gc-link" onclick={() => (problem = null)}>Dismiss</button></p>
    {/if}
</section>
{/if}

{#if details}
    {@const event = store.find(details.key)}
    {#if event}
        <EventDetails
            {app}
            {event}
            anchor={details.anchor}
            showOpenCalendar
            onclose={() => (details = null)}
            onedit={() => {
                editor = { mode: 'edit', key: event.key }
                details = null
            }}
            ondelete={() => void remove(event)}
            onproblem={(message) => (problem = message)}
        />
    {/if}
{/if}
<EventEditor {app} open={editor} {ask} onclose={() => (editor = null)} />
{#if taskDetails}
    {@const task = tasks.find((candidate) => candidate.key === taskDetails?.key)}
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
<ChoiceDialog {pending} />

<style>
    .gc-panel {
        padding: 0.75rem 0 1rem;
        border-top: 1px solid var(--gk-border-soft);
        font-size: 0.875rem;
        line-height: 1.5;
    }
    .gc-panel__head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem 0.75rem;
        margin-bottom: 0.375rem;
    }
    /* Muted capitals, as EtherPK's own section headings beneath a document are. */
    .gc-panel__title {
        margin: 0;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--gk-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .gc-panel__title--tasks {
        margin-top: 0.75rem;
    }
    .gc-panel__actions {
        display: flex;
        gap: 0.75rem;
        margin-left: auto;
    }
    .gc-panel__list {
        display: grid;
        gap: 0.125rem;
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .gc-panel__event {
        display: grid;
        grid-template-columns: auto minmax(7.5rem, auto) 1fr auto;
        align-items: center;
        gap: 0.625rem;
        width: 100%;
        min-height: 2rem;
        padding: 0.25rem 0.375rem;
        border: 0;
        border-radius: 0.375rem;
        background: transparent;
        color: var(--gk-text-default);
        text-align: left;
        cursor: pointer;
    }
    .gc-panel__event:hover {
        background: var(--gk-surface-2);
    }
    .gc-panel__event:focus-visible {
        outline: 2px solid var(--gk-accent);
    }
    .gc-panel__time {
        color: var(--gk-text-muted);
        white-space: nowrap;
    }
    .gc-panel__name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .gc-panel__calendar {
        color: var(--gk-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 12rem;
    }
    .gc-panel__group {
        margin-top: 0.5rem;
    }
    .gc-panel__group-title {
        margin: 0 0 0.125rem;
        font-size: 0.875rem;
        font-weight: 600;
    }
    /* Its left padding is set on the row: a subtask sits a level in. */
    .gc-panel__task {
        display: flex;
        align-items: center;
        gap: 0.375rem;
    }
    .gc-panel__event--task {
        grid-template-columns: 1fr auto;
    }
    .gc-panel__name--done {
        text-decoration: line-through;
        color: var(--gk-text-muted);
    }
    .gc-panel__overdue {
        color: var(--gk-text-danger);
    }
    .gc-panel__skeleton {
        height: 1.75rem;
        margin: 0.125rem 0;
        border-radius: 0.375rem;
        background: var(--gk-surface-2);
    }
    .gc-panel__problem {
        color: var(--gk-text-default);
        margin: 0.25rem 0;
    }
    @media (max-width: 640px) {
        .gc-panel__event {
            grid-template-columns: auto 1fr;
        }
        .gc-panel__time {
            grid-column: 2;
        }
        .gc-panel__name {
            grid-column: 2;
        }
        .gc-panel__calendar {
            grid-column: 2;
            max-width: none;
        }
    }
</style>
