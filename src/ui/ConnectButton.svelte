<script lang="ts">
    /**
     * Connect a Google account, or the same one again. The popup must open inside the click, so the
     * button waits, disabled for a moment, until the next sign-in is prepared, then opens Google's
     * sign-in at once. While Google is asking, the button gives way to "Waiting for Google" and a
     * Cancel, since the Client cannot always tell when the person closed the popup.
     */
    import { onMount, untrack } from 'svelte'

    import type { CalendarApp } from '../app/app.svelte'

    let {
        app,
        email,
        primary = false,
        label,
        onconnected,
    }: {
        app: CalendarApp
        /** The account to sign in as again, for a reconnect. */
        email?: string
        primary?: boolean
        label?: string
        onconnected?: (email: string) => void
    } = $props()

    let ready = $state(untrack(() => app.signIn.ready))
    let waiting = $state<AbortController | null>(null)
    let error = $state<string | null>(null)

    onMount(() => {
        if (!ready) void app.signIn.prepare().then(() => (ready = true))
    })

    function connect() {
        if (waiting || !app.signIn.ready) return
        error = null
        const controller = new AbortController()
        waiting = controller
        // No await before this call: the popup opens inside the click.
        const connecting = app.connect({ ...(email ? { loginHint: email } : {}), signal: controller.signal })
        ready = false
        void app.signIn.prepare().then(() => (ready = true))
        connecting.then(
            (account) => {
                waiting = null
                onconnected?.(account.email)
            },
            (reason: unknown) => {
                waiting = null
                if (controller.signal.aborted) return
                error = reason instanceof Error ? reason.message : 'The sign-in did not finish. Try again.'
            },
        )
    }
</script>

<div class="gc-connect">
    {#if waiting}
        <span class="gc-connect__waiting" role="status" data-testid="gc-connect-waiting">Waiting for Google… Finish signing in in the window that opened.</span>
        <button type="button" class="gc-button" onclick={() => waiting?.abort()}>Cancel</button>
    {:else}
        <button type="button" class={['gc-button', primary && 'gc-button--primary']} data-testid="gc-connect" disabled={!ready || !app.oauth} onclick={connect}
            >{label ?? (email ? 'Reconnect' : 'Connect Google account')}</button
        >
    {/if}
    {#if error}
        <p class="gc-error gc-connect__error" role="alert" data-testid="gc-connect-error">{error}</p>
    {/if}
</div>

<style>
    .gc-connect {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
    }
    .gc-connect__waiting {
        font-size: 0.875rem;
        color: var(--gk-text-muted);
    }
    .gc-connect__error {
        flex-basis: 100%;
        margin: 0;
        font-size: 0.875rem;
    }
</style>
