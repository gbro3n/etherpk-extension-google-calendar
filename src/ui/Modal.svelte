<script lang="ts">
    /**
     * A modal dialog on the native `<dialog>`: the browser traps focus inside it and puts it above
     * everything (its top layer), and Escape asks it to close (`oncancel`). Focus goes to the first
     * field or button inside when it opens, and back to what had it when it closes.
     */
    import type { Snippet } from 'svelte'

    let {
        open,
        label,
        onclose,
        wide = false,
        children,
    }: {
        open: boolean
        /** The dialog's accessible name. */
        label: string
        /** Escape, or the backdrop: the owner decides whether closing is safe. */
        onclose: () => void
        wide?: boolean
        children: Snippet
    } = $props()

    let dialog = $state<HTMLDialogElement>()
    let returnTo: HTMLElement | null = null

    $effect(() => {
        const element = dialog
        if (!element) return
        if (open && !element.open) {
            const root = element.getRootNode() as Document | ShadowRoot
            returnTo = (root.activeElement as HTMLElement | null) ?? null
            element.showModal()
            const first = element.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]), select, textarea, button')
            first?.focus()
        } else if (!open && element.open) {
            element.close()
            returnTo?.focus()
            returnTo = null
        }
    })
</script>

<dialog
    bind:this={dialog}
    class={['gc-modal', wide && 'gc-modal--wide']}
    aria-label={label}
    oncancel={(event) => {
        event.preventDefault()
        onclose()
    }}
    onclick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === dialog) onclose()
    }}
>
    {#if open}
        {@render children()}
    {/if}
</dialog>

<style>
    .gc-modal {
        /* A <dialog> is centred by its user agent margin, which a reset would take away. */
        margin: auto;
        width: min(28rem, calc(100vw - 2rem));
        max-height: calc(100vh - 2rem);
        padding: 1.25rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 0.75rem;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        box-shadow: var(--gk-shadow);
        overflow: auto;
    }
    .gc-modal--wide {
        width: min(44rem, calc(100vw - 2rem));
    }
    .gc-modal::backdrop {
        background: rgb(0 0 0 / 0.35);
    }
    @media (prefers-reduced-motion: no-preference) {
        .gc-modal[open] {
            animation: gc-modal-in 150ms ease-out;
        }
    }
    @keyframes gc-modal-in {
        from {
            transform: translateY(0.5rem);
        }
    }
</style>
