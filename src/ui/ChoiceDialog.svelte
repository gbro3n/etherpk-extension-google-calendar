<script lang="ts">
    /** The question asked now, if any, drawn as a modal dialog with one button per answer. */
    import type { PendingChoice } from '../app/choice'
    import Modal from './Modal.svelte'

    let { pending }: { pending: PendingChoice | null } = $props()
    const titleId = $props.id()
</script>

<Modal open={pending !== null} label={pending?.choice.title ?? ''} onclose={() => pending?.answer(null)}>
    {#if pending}
        <div class="gc-choice" role="group" aria-labelledby={titleId}>
            <h2 id={titleId} class="gc-choice__title">{pending.choice.title}</h2>
            {#if pending.choice.body}
                <p class="gc-choice__body">{pending.choice.body}</p>
            {/if}
            <div class="gc-choice__options">
                {#each pending.choice.options as option, index (index)}
                    <button
                        type="button"
                        class={['gc-button', option.primary && 'gc-button--primary']}
                        data-autofocus={option.primary || undefined}
                        data-testid="gc-choice-option"
                        onclick={() => pending.answer(option.value)}>{option.label}</button
                    >
                {/each}
                <button type="button" class="gc-button" data-testid="gc-choice-cancel" onclick={() => pending.answer(null)}
                    >{pending.choice.cancelLabel ?? 'Cancel'}</button
                >
            </div>
        </div>
    {/if}
</Modal>

<style>
    .gc-choice__title {
        margin: 0 0 0.5rem;
        font-size: 1rem;
        font-weight: 600;
    }
    .gc-choice__body {
        margin: 0 0 1rem;
        color: var(--gk-text-muted);
        font-size: 0.875rem;
    }
    .gc-choice__options {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }
</style>
