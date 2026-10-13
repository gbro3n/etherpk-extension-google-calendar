<script lang="ts" module>
    import type { ShownTask } from '../app/task-store.svelte'

    /** What the task editor is open for: a new task due on a day, or a task to change. */
    export type TaskEditorOpen = { mode: 'create'; day: string } | { mode: 'edit'; task: ShownTask }
</script>

<script lang="ts">
    /**
     * Creating or editing a Google Task: its title, due date and notes, and for a new one the account
     * and list it goes in. A task carries a date and no time, as Google Tasks has it, or no date at
     * all: clearing Due takes the date off. Saving waits for Google and keeps the form if Google
     * refuses.
     */
    import { untrack } from 'svelte'

    import type { CalendarApp } from '../app/app.svelte'
    import { dueOf } from '../app/task-store.svelte'
    import Modal from './Modal.svelte'

    let { app, open, onclose }: { app: CalendarApp; open: TaskEditorOpen | null; onclose: () => void } = $props()
    const listFieldId = $props.id()

    let title = $state('')
    let day = $state('')
    let notes = $state('')
    let listKey = $state('')
    let saving = $state(false)
    let error = $state<string | null>(null)

    const lists = $derived(app.tasks.accounts().allowed.flatMap((email) => (app.tasks.lists[email] ?? []).map((list) => ({ key: `${email}|${list.id}`, email, list }))))
    /** Reading the lists for a new task, when they have not been read yet, and why that failed. */
    let listsLoading = $state(false)
    let listsError = $state<string | null>(null)

    async function loadLists() {
        listsLoading = true
        listsError = null
        try {
            await Promise.all(app.tasks.accounts().allowed.map((email) => app.tasks.loadLists(email)))
            if (!lists.some((option) => option.key === listKey)) listKey = lists[0]?.key ?? ''
        } catch (error) {
            listsError = error instanceof Error ? error.message : 'Your task lists could not be read.'
        } finally {
            listsLoading = false
        }
    }

    $effect(() => {
        const request = open
        untrack(() => {
            if (!request) return
            error = null
            if (request.mode === 'create') {
                title = ''
                notes = ''
                day = request.day
                listKey = lists[0]?.key ?? ''
                if (lists.length === 0) void loadLists()
            } else {
                title = request.task.task.title
                notes = request.task.task.notes ?? ''
                day = request.task.day ?? ''
                listKey = `${request.task.account}|${request.task.list.id}`
            }
        })
    })

    async function save(event: SubmitEvent) {
        event.preventDefault()
        if (!open || saving) return
        saving = true
        error = null
        try {
            if (open.mode === 'create') {
                const chosen = lists.find((candidate) => candidate.key === listKey)
                if (!chosen) throw new Error('Choose a task list.')
                await app.tasks.create(chosen.email, chosen.list.id, { title: title.trim(), notes: notes.trim() || undefined, due: day ? dueOf(day) : undefined })
            } else {
                await app.tasks.update(open.task, { title: title.trim(), notes: notes.trim(), due: day ? dueOf(day) : null })
            }
            onclose()
        } catch (reason) {
            error = reason instanceof Error ? reason.message : 'The task could not be saved.'
        } finally {
            saving = false
        }
    }
</script>

<Modal open={open !== null} label={open?.mode === 'edit' ? 'Edit task' : 'New task'} onclose={() => !saving && onclose()}>
    {#if open}
        <form class="gc-task-editor" onsubmit={save} novalidate data-testid="gc-task-editor">
            <input class="gc-input gc-task-editor__title" placeholder="Add title" aria-label="Title" data-autofocus data-testid="gc-task-title" bind:value={title} />
            {#if error}<p class="gc-error" role="alert">{error}</p>{/if}
            <label class="gc-field">
                <span>Due</span>
                <input class="gc-input" type="date" bind:value={day} data-testid="gc-task-due" />
            </label>
            {#if open.mode === 'create'}
                <!-- The messages sit outside the label: a button inside a label takes the label as its name. -->
                <div class="gc-field">
                    <label for={listFieldId}>List</label>
                    {#if listsLoading}<span class="gc-muted" role="status">Reading your task lists…</span>{/if}
                    {#if listsError}
                        <span class="gc-error" role="alert">{listsError} <button type="button" class="gc-link" onclick={() => void loadLists()}>Retry</button></span>
                    {/if}
                    <select id={listFieldId} class="gc-select" bind:value={listKey} disabled={lists.length === 0} data-testid="gc-task-list">
                        {#each lists as option (option.key)}
                            <option value={option.key}>{option.list.title}{app.store.accounts.length > 1 ? `, ${option.email}` : ''}</option>
                        {/each}
                    </select>
                </div>
            {/if}
            <label class="gc-field">
                <span>Notes</span>
                <textarea class="gc-input" rows="3" bind:value={notes}></textarea>
            </label>
            <div class="gc-task-editor__footer">
                <button type="button" class="gc-button" disabled={saving} onclick={onclose}>Cancel</button>
                <button type="submit" class="gc-button gc-button--primary" disabled={saving} data-testid="gc-task-save">{saving ? 'Saving…' : 'Save'}</button>
            </div>
        </form>
    {/if}
</Modal>

<style>
    .gc-task-editor {
        display: grid;
        gap: 0.875rem;
        font-size: 0.875rem;
    }
    .gc-task-editor__title {
        font-size: 1.125rem;
    }
    .gc-task-editor__footer {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
    }
</style>
