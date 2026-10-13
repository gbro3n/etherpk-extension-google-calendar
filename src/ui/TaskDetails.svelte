<script lang="ts">
    /**
     * A Google Task's details, beside where it was clicked: its title, due date (if it has one), list
     * and notes, with Mark complete (or Mark not done), Edit, Delete and Open in Google Tasks. Escape
     * closes it.
     */
    import type { CalendarApp } from '../app/app.svelte'
    import type { ShownTask } from '../app/task-store.svelte'
    import { parseIsoDay } from '../model/time'
    import OpensInNewTab from './OpensInNewTab.svelte'
    import { popover } from './popover'
    import { safeUrl } from './safe-url'

    let {
        app,
        task,
        anchor,
        onclose,
        onedit,
        ondelete,
        onproblem,
    }: {
        app: CalendarApp
        task: ShownTask
        anchor: DOMRect | null
        onclose: () => void
        onedit: () => void
        ondelete: () => void
        onproblem: (message: string) => void
    } = $props()

    let busy = $state(false)

    async function toggle() {
        if (busy) return
        busy = true
        try {
            await app.tasks.setDone(task, !task.done)
        } catch (error) {
            onproblem(error instanceof Error ? error.message : String(error))
        } finally {
            busy = false
        }
    }

    const narrow = typeof window !== 'undefined' && window.innerWidth < 640
    const position = $derived.by(() => {
        if (narrow || !anchor) return null
        const left = anchor.right + 8 + 320 < window.innerWidth ? anchor.right + 8 : Math.max(8, anchor.left - 328)
        return { left, top: Math.max(8, Math.min(anchor.top, window.innerHeight - 320)) }
    })
</script>

<div
    class={['gc-task-details', narrow && 'gc-task-details--sheet']}
    role="dialog"
    aria-label={task.task.title || '(No title)'}
    data-testid="gc-task-details"
    tabindex="-1"
    style:left={position ? `${position.left}px` : undefined}
    style:top={position ? `${position.top}px` : undefined}
    {@attach popover(onclose)}
>
    <div class="gc-task-details__actions">
        <button type="button" class="gc-icon-button" aria-label="Edit task" title="Edit task" data-testid="gc-task-edit" onclick={onedit}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z" /></svg>
        </button>
        <button type="button" class="gc-icon-button" aria-label="Delete task" title="Delete task" data-testid="gc-task-delete" onclick={ondelete}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.75 9h5.5l.75-9" /></svg>
        </button>
        <button type="button" class="gc-icon-button" aria-label="Close" data-autofocus onclick={onclose}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
    </div>
    <h3 class={['gc-task-details__title', task.done && 'gc-task-details__title--done']}>{task.task.title || '(No title)'}</h3>
    {#if task.day}<p>Due {parseIsoDay(task.day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>{/if}
    <p class="gc-muted">{task.list.title}{#if app.store.accounts.length > 1}, {task.account}{/if}</p>
    {#if task.task.notes}<p class="gc-task-details__notes">{task.task.notes}</p>{/if}
    <div class="gc-task-details__footer">
        <button type="button" class="gc-button" data-testid="gc-task-toggle" disabled={busy} onclick={() => void toggle()}>{task.done ? 'Mark not done' : 'Mark complete'}</button>
        {#if safeUrl(task.task.webViewLink)}<a class="gc-link" href={safeUrl(task.task.webViewLink)} target="_blank" rel="noopener noreferrer">Open in Google Tasks<OpensInNewTab /></a>{/if}
    </div>
</div>

<style>
    .gc-task-details {
        position: fixed;
        inset: auto;
        margin: 0;
        top: 4rem;
        right: 1rem;
        width: 20rem;
        padding: 0.75rem 1rem 1rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 0.75rem;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        box-shadow: var(--gk-shadow);
        font-size: 0.875rem;
        line-height: 1.5;
    }
    .gc-task-details--sheet {
        inset: auto 0 0 0;
        width: auto;
        border-radius: 0.75rem 0.75rem 0 0;
    }
    .gc-task-details__actions {
        display: flex;
        justify-content: flex-end;
    }
    .gc-task-details__title {
        margin: 0 0 0.25rem;
        font-size: 1.125rem;
        font-weight: 600;
        overflow-wrap: anywhere;
    }
    .gc-task-details__title--done {
        text-decoration: line-through;
        color: var(--gk-text-muted);
    }
    .gc-task-details p {
        margin: 0.25rem 0;
    }
    .gc-task-details__notes {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }
    .gc-task-details__footer {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.75rem;
        margin-top: 0.75rem;
    }
</style>
