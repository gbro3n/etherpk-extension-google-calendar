<script lang="ts">
    /**
     * The calendars beside the Calendar Events View: each connected account, with its calendars in
     * their colours and a box to show or hide each, as Google Calendar's own list has. A calendar
     * starts as Google Calendar's list has it, and a choice made here is the person's, on every device.
     *
     * Under each account's calendars, its Google Tasks lists, ticked the same way, and a link to
     * Google Tasks itself. An account is connected again from its own section when Google no longer
     * accepts its sign-in.
     *
     * Below the accounts, between rules, signing in and out: each account's Disconnect, which asks
     * first because it ends the sign-in at Google on every device, and Add account. Then the calendar
     * new events go to and the task list new tasks go to, each the first one Google gives (the main
     * calendar, for events) until the person picks another, and again once the one picked is gone.
     */
    import type { CalendarApp } from '../app/app.svelte'
    import type { AccountView } from '../app/calendar-store.svelte'
    import { tasksWebUrl } from '../google/tasks-api'
    import { calendarColor } from '../model/colors'
    import ConnectButton from './ConnectButton.svelte'
    import OpensInNewTab from './OpensInNewTab.svelte'

    let { app }: { app: CalendarApp } = $props()
    const store = $derived(app.store)

    /** The account whose disconnect is being confirmed, and one being disconnected. */
    let confirming = $state<string | null>(null)
    let disconnecting = $state<string | null>(null)
    let problem = $state<string | null>(null)
    /** The account whose Disconnect takes focus back, once its confirmation is cancelled. */
    let refocus = $state<string | null>(null)

    /** Focus a control as it appears: the confirmation's Cancel, or Disconnect again after Cancel. */
    const focusOnShow = (when: boolean) => (node: HTMLElement) => {
        if (when) node.focus()
    }

    const choices = $derived.by(() => {
        void store.version
        return app.records.choices()
    })

    /** Each account's task lists and whether its sign-in allows Tasks, as the records now say. */
    const taskAccounts = $derived.by(() => {
        void store.version
        void app.tasks.lists
        const { allowed } = app.tasks.accounts()
        const choices = app.records.taskListChoices()
        return Object.fromEntries(
            store.accounts.map((account) => [
                account.email,
                {
                    allowed: allowed.includes(account.email),
                    lists: (app.tasks.lists[account.email] ?? []).map((list) => ({ list, shown: choices[account.email]?.[list.id] ?? true })),
                    problem: app.tasks.listProblems[account.email],
                },
            ]),
        )
    })

    const shownCalendar = (account: AccountView, id: string, selected: boolean | undefined) => choices[account.email]?.[id] ?? selected ?? false

    const writable = $derived(
        store.accounts.flatMap((account) =>
            account.status === 'ready'
                ? account.calendars.filter((calendar) => calendar.accessRole === 'owner' || calendar.accessRole === 'writer').map((calendar) => ({ account: account.email, calendar }))
                : [],
        ),
    )
    const defaultCalendar = $derived.by(() => {
        void store.version
        const chosen = app.records.defaultCalendar()
        if (chosen && writable.some((option) => option.account === chosen.account && option.calendar.id === chosen.calendarId)) return `${chosen.account}|${chosen.calendarId}`
        const first = writable.find((option) => option.calendar.primary) ?? writable[0]
        return first ? `${first.account}|${first.calendar.id}` : ''
    })

    /** The task lists a new task can go in, by account, and the one it starts in. */
    const taskListOptions = $derived.by(() => {
        void store.version
        void app.tasks.lists
        return app.tasks.listOptions()
    })
    const taskListAccounts = $derived([...new Set(taskListOptions.map((option) => option.email))])
    const defaultTaskList = $derived.by(() => {
        void store.version
        return taskListOptions.length > 0 ? (app.tasks.defaultList()?.key ?? '') : ''
    })

    async function disconnect(email: string) {
        disconnecting = email
        problem = null
        try {
            await app.disconnect(email)
        } catch (error) {
            problem = error instanceof Error ? error.message : 'The account could not be disconnected.'
        } finally {
            disconnecting = null
            confirming = null
        }
    }
</script>

<nav class="gc-list" aria-label="Calendars" data-testid="gc-calendar-list">
    {#each store.accounts as account (account.email)}
        <section class="gc-list__account" data-testid="gc-account" data-email={account.email} data-status={account.status}>
            <h3 class="gc-list__email" title={account.email}>{account.email}</h3>
            {#if account.status === 'loading' && account.calendars.length === 0}
                <p class="gc-muted" role="status">Loading calendars…</p>
            {:else if account.status === 'reconnect'}
                <p class="gk-error" role="alert">{account.message}</p>
                <ConnectButton {app} email={account.email} />
            {:else if account.status === 'error'}
                <p class="gk-error" role="alert">{account.message}</p>
                <button type="button" class="gk-button" onclick={() => void store.refreshAccounts()}>Retry</button>
            {/if}
            <ul class="gc-list__calendars">
                {#each account.calendars.filter((calendar) => calendar.accessRole !== 'freeBusyReader') as calendar (calendar.id)}
                    <li>
                        <label class="gc-list__calendar">
                            <input
                                type="checkbox"
                                checked={shownCalendar(account, calendar.id, calendar.selected)}
                                data-testid="gc-calendar-toggle"
                                data-calendar={calendar.id}
                                onchange={(event) => app.records.choose({ account: account.email, calendarId: calendar.id }, event.currentTarget.checked)}
                                style:accent-color={calendarColor(calendar)}
                            />
                            <span class="gc-swatch" style:background={calendarColor(calendar)}></span>
                            <span class="gc-list__name">{calendar.summaryOverride || calendar.summary}</span>
                        </label>
                    </li>
                {/each}
            </ul>
            {#if taskAccounts[account.email] && account.status === 'ready'}
                {@const tasks = taskAccounts[account.email]}
                <div class="gc-list__tasks" role="group" aria-label="Task lists of {account.email}">
                    <h4 class="gc-list__subhead">Task lists</h4>
                    {#if !tasks.allowed}
                        <p class="gc-muted">Connect again to show Google Tasks.</p>
                        <ConnectButton {app} email={account.email} label="Connect again" />
                    {:else if tasks.problem}
                        <p class="gk-error" role="alert">{tasks.problem}</p>
                        <button type="button" class="gk-button" onclick={() => void app.tasks.refreshLists()}>Retry</button>
                    {:else if tasks.lists.length === 0}
                        <p class="gc-muted">No task lists yet.</p>
                    {:else}
                        <ul class="gc-list__calendars">
                            {#each tasks.lists as { list, shown } (list.id)}
                                <li>
                                    <label class="gc-list__calendar">
                                        <input
                                            type="checkbox"
                                            checked={shown}
                                            data-testid="gc-task-list-toggle"
                                            data-list={list.id}
                                            onchange={(event) => app.records.chooseTaskList({ account: account.email, listId: list.id }, event.currentTarget.checked)}
                                        />
                                        <span class="gc-list__name">{list.title}</span>
                                    </label>
                                </li>
                            {/each}
                        </ul>
                    {/if}
                    {#if tasks.allowed}
                        <a class="gk-link gc-list__open-tasks" href={tasksWebUrl(account.email)} target="_blank" rel="noopener noreferrer" data-testid="gc-open-tasks">Open in Google Tasks<OpensInNewTab /></a>
                    {/if}
                </div>
            {/if}
        </section>
    {/each}

    <hr class="gc-list__rule" />
    <section class="gc-list__accounts" aria-label="Google accounts" data-testid="gc-accounts">
        {#if store.accounts.length > 0}
            <ul class="gc-list__signed-in">
                {#each store.accounts as account (account.email)}
                    <li>
                        {#if confirming === account.email}
                            <div class="gc-list__confirm" role="group" aria-label="Disconnect {account.email}">
                                <p>Disconnect {account.email}? Its sign-in ends at Google, on every device of yours.</p>
                                <div class="gc-list__confirm-actions">
                                    <button type="button" class="gk-button gk-button--danger" data-testid="gc-disconnect-confirm" disabled={disconnecting !== null} onclick={() => void disconnect(account.email)}
                                        >{disconnecting === account.email ? 'Disconnecting…' : 'Disconnect'}</button
                                    >
                                    <button
                                        type="button"
                                        class="gk-button"
                                        {@attach focusOnShow(true)}
                                        onclick={() => {
                                            refocus = account.email
                                            confirming = null
                                        }}>Cancel</button
                                    >
                                </div>
                            </div>
                        {:else}
                            <div class="gc-list__signed-in-row">
                                <span class="gc-list__name gc-muted" title={account.email}>{account.email}</span>
                                <button
                                    type="button"
                                    class="gk-link"
                                    data-testid="gc-disconnect"
                                    aria-label="Disconnect {account.email}"
                                    {@attach focusOnShow(refocus === account.email)}
                                    onclick={() => {
                                        refocus = null
                                        confirming = account.email
                                    }}>Disconnect</button
                                >
                            </div>
                        {/if}
                    </li>
                {/each}
            </ul>
        {/if}
        {#if problem}<p class="gk-error" role="alert">{problem}</p>{/if}
        <ConnectButton {app} label="Add account" />
    </section>
    <hr class="gc-list__rule" />

    {#if writable.length > 0}
        <label class="gk-field">
            <span class="gk-label">New events go to</span>
            <select
                class="gk-select"
                value={defaultCalendar}
                data-testid="gc-default-calendar"
                onchange={(event) => {
                    const [account, calendarId] = event.currentTarget.value.split('|')
                    app.records.setDefaultCalendar({ account, calendarId })
                }}
            >
                {#each store.accounts.filter((account) => account.status === 'ready') as account (account.email)}
                    <optgroup label={account.email}>
                        {#each writable.filter((option) => option.account === account.email) as option (option.calendar.id)}
                            <option value={`${option.account}|${option.calendar.id}`}>{option.calendar.summaryOverride || option.calendar.summary}</option>
                        {/each}
                    </optgroup>
                {/each}
            </select>
        </label>
    {/if}
    {#if taskListOptions.length > 0}
        <label class="gk-field">
            <span class="gk-label">New tasks go to</span>
            <select
                class="gk-select"
                value={defaultTaskList}
                data-testid="gc-default-task-list"
                onchange={(event) => {
                    const chosen = taskListOptions.find((option) => option.key === event.currentTarget.value)
                    if (chosen) app.records.setDefaultTaskList({ account: chosen.email, listId: chosen.list.id })
                }}
            >
                {#each taskListAccounts as email (email)}
                    <optgroup label={email}>
                        {#each taskListOptions.filter((option) => option.email === email) as option (option.key)}
                            <option value={option.key}>{option.list.title}</option>
                        {/each}
                    </optgroup>
                {/each}
            </select>
        </label>
    {/if}
</nav>

<style>
    .gc-list {
        flex: 0 0 15rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
        padding: 0.75rem;
        border-right: 1px solid var(--gk-border-soft);
        overflow: auto;
        font-size: 0.875rem;
    }
    .gc-list__email {
        margin: 0 0 0.375rem;
        font-size: 0.875rem;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .gc-list__calendars {
        display: grid;
        gap: 0.125rem;
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .gc-list__calendar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-height: 2rem;
        cursor: pointer;
    }
    .gc-list__calendar input {
        width: 1rem;
        height: 1rem;
        margin: 0;
    }
    .gc-list__name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    /* A rule each side of the accounts section, the width of the list. */
    .gc-list__rule {
        width: 100%;
        margin: 0;
        border: 0;
        border-top: 1px solid var(--gk-border-soft);
    }
    /* One column that may be narrower than an address, so a long one ends in an ellipsis instead. */
    .gc-list__accounts {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 0.5rem;
    }
    .gc-list__signed-in {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 0.25rem;
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .gc-list__signed-in-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        min-height: 2rem;
    }
    .gc-list__signed-in-row .gc-list__name {
        min-width: 0;
    }
    .gc-list__signed-in-row .gk-link {
        flex: none;
    }
    .gc-list__open-tasks {
        display: inline-block;
        margin-top: 0.375rem;
    }
    .gc-list__confirm {
        padding: 0.5rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 0.5rem;
        background: var(--gk-surface-1);
    }
    .gc-list__confirm p {
        margin: 0 0 0.5rem;
    }
    .gc-list__confirm-actions {
        display: flex;
        gap: 0.5rem;
    }
    .gc-list__tasks {
        margin-top: 0.5rem;
    }
    .gc-list__tasks p {
        margin: 0 0 0.25rem;
    }
    .gc-list__subhead {
        margin: 0 0 0.25rem;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--gk-text-muted);
    }
    /* On a narrow screen the list is a drawer over the calendar, which keeps its full width. */
    @media (max-width: 720px) {
        .gc-list {
            position: absolute;
            inset: 0 auto 0 0;
            z-index: 5;
            width: min(18rem, 85%);
            background: var(--gk-surface-0);
            box-shadow: var(--gk-shadow);
        }
    }
</style>
