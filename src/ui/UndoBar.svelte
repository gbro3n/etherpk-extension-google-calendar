<script lang="ts" module>
    /** A change that can be taken back for a few seconds, such as a deleted event. */
    export interface UndoOffer {
        text: string
        /** Puts the change back, or null where Google offers no way to. */
        restore: (() => Promise<void>) | null
    }
</script>

<script lang="ts">
    import { popover } from './popover'

    /**
     * The notice after a change that can be taken back, as Google Calendar's own "Event deleted,
     * Undo" is: it stays for eight seconds, longer while the pointer or focus is on it, and Undo puts
     * the change back. Where Google gives no way back, it only reports.
     */
    let { offer, ondone, onproblem }: { offer: UndoOffer | null; ondone: () => void; onproblem: (message: string) => void } = $props()

    let held = $state(false)
    let undoing = $state(false)

    $effect(() => {
        if (!offer || held || undoing) return
        const timer = setTimeout(ondone, 8000)
        return () => clearTimeout(timer)
    })

    async function undo() {
        if (!offer?.restore || undoing) return
        undoing = true
        try {
            await offer.restore()
            ondone()
        } catch (error) {
            onproblem(error instanceof Error ? error.message : 'It could not be put back.')
            ondone()
        } finally {
            undoing = false
        }
    }
</script>

{#if offer}
    <div
        class="gc-undo"
        role="status"
        data-testid="gc-undo"
        onpointerenter={() => (held = true)}
        onpointerleave={() => (held = false)}
        onfocusin={() => (held = true)}
        onfocusout={() => (held = false)}
        {@attach popover(ondone, 'manual')}
    >
        <span>{offer.text}</span>
        {#if offer.restore}
            <button type="button" class="gk-button" data-testid="gc-undo-button" disabled={undoing} onclick={() => void undo()}>{undoing ? 'Putting it back…' : 'Undo'}</button>
        {/if}
        <button type="button" class="gk-icon-button" aria-label="Close" onclick={ondone}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
    </div>
{/if}

<style>
    .gc-undo {
        position: fixed;
        inset: auto auto 1.25rem 50%;
        margin: 0;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0.5rem 0.5rem 1rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 0.75rem;
        background: var(--gk-surface-0);
        box-shadow: var(--gk-shadow);
        font-size: 0.875rem;
        transform: translateX(-50%);
    }
</style>
