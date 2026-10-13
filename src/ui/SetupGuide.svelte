<script lang="ts">
    /**
     * The first screen of Calendar Events: how to make an OAuth client in the person's own Google
     * Cloud project, the two addresses Google asks for with Copy buttons, the fields for the Client
     * ID and secret, and then Connect. Once a client is set and an account connected, the calendar
     * shows instead.
     */
    import { untrack } from 'svelte'

    import type { CalendarApp } from '../app/app.svelte'
    import ConnectButton from './ConnectButton.svelte'

    let { app }: { app: CalendarApp } = $props()

    const origin = location.origin
    const redirect = $derived(app.context.auth.redirectUri)

    let clientId = $state(untrack(() => app.oauth?.clientId ?? ''))
    let clientSecret = $state(untrack(() => app.oauth?.clientSecret ?? ''))
    let idError = $state<string | null>(null)
    let secretError = $state<string | null>(null)
    let copied = $state<string | null>(null)
    let editing = $state(untrack(() => app.oauth === null))

    function validateId(): boolean {
        const value = clientId.trim()
        idError = value === '' ? 'Paste the Client ID.' : !value.endsWith('.apps.googleusercontent.com') ? 'A Client ID ends with .apps.googleusercontent.com. Check you copied the whole of it.' : null
        return idError === null
    }

    function validateSecret(): boolean {
        secretError = clientSecret.trim() === '' ? 'Paste the Client secret.' : null
        return secretError === null
    }

    let idField = $state<HTMLInputElement>()
    let secretField = $state<HTMLInputElement>()

    function save(event: SubmitEvent) {
        event.preventDefault()
        const idOk = validateId()
        const secretOk = validateSecret()
        if (!idOk) return idField?.focus()
        if (!secretOk) return secretField?.focus()
        app.setOAuthClient(clientId, clientSecret)
        editing = false
    }

    async function copy(text: string, what: string) {
        try {
            await navigator.clipboard.writeText(text)
            copied = what
            setTimeout(() => {
                if (copied === what) copied = null
            }, 2000)
        } catch {
            copied = null
        }
    }
</script>

<div class="gc-setup" data-testid="gc-setup">
    <h1 class="gc-setup__title">Connect Google Calendar</h1>
    <p>
        Calendar Events reads and changes your Google Calendar through an OAuth client you make in your own Google Cloud project. It takes about ten minutes, once. Your browser talks to Google directly,
        and nothing about your events is written into this graph.
    </p>

    <ol class="gc-setup__steps">
        <li>
            <a class="gc-link" href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer">Create a Google Cloud project</a>. Any name works, such as EtherPK Calendar.
        </li>
        <li>
            Turn on the <a class="gc-link" href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener noreferrer">Google Calendar API</a>, the
            <a class="gc-link" href="https://console.cloud.google.com/apis/library/tasks.googleapis.com" target="_blank" rel="noopener noreferrer">Google Tasks API</a> and, for attachments, the
            <a class="gc-link" href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener noreferrer">Google Drive API</a>.
        </li>
        <li>
            Set up the <a class="gc-link" href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noopener noreferrer">consent screen</a>: give the app a name, such as EtherPK Calendar
            (Google does not allow its own product names there), choose External, and add your email address where it asks. Then, under Audience, choose Publish app, so your sign-in does not end after 7 days.
            Google does not need to review an app only you use. When you sign in, it warns that the app is unverified, and Advanced, then Go to your app's name, carries on.
        </li>
        <li>
            <a class="gc-link" href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noopener noreferrer">Create an OAuth client</a> of the type Web application, with these two addresses:
            <dl class="gc-setup__addresses">
                <dt>Authorised JavaScript origin</dt>
                <dd>
                    <code data-testid="gc-setup-origin">{origin}</code>
                    <button type="button" class="gc-button" onclick={() => copy(origin, 'origin')}>{copied === 'origin' ? 'Copied' : 'Copy'}</button>
                </dd>
                <dt>Authorised redirect URI</dt>
                <dd>
                    <code data-testid="gc-setup-redirect">{redirect}</code>
                    <button type="button" class="gc-button" onclick={() => copy(redirect, 'redirect')}>{copied === 'redirect' ? 'Copied' : 'Copy'}</button>
                </dd>
            </dl>
        </li>
        <li>Paste the client's Client ID and Client secret here.</li>
    </ol>

    {#if editing}
        <form class="gc-setup__form" onsubmit={save} novalidate>
            <label class="gc-field">
                <span>Client ID</span>
                <input
                    bind:this={idField}
                    class="gc-input"
                    data-testid="gc-setup-client-id"
                    bind:value={clientId}
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="1234567890-abc.apps.googleusercontent.com"
                    aria-invalid={idError !== null}
                    aria-describedby={idError ? 'gc-id-error' : undefined}
                    onblur={validateId}
                    oninput={() => idError !== null && validateId()}
                />
                {#if idError}<span id="gc-id-error" class="gc-error">{idError}</span>{/if}
            </label>
            <label class="gc-field">
                <span>Client secret</span>
                <input
                    bind:this={secretField}
                    class="gc-input"
                    type="password"
                    data-testid="gc-setup-client-secret"
                    bind:value={clientSecret}
                    autocomplete="off"
                    spellcheck="false"
                    aria-invalid={secretError !== null}
                    aria-describedby={secretError ? 'gc-secret-error' : undefined}
                    onblur={validateSecret}
                    oninput={() => secretError !== null && validateSecret()}
                />
                {#if secretError}<span id="gc-secret-error" class="gc-error">{secretError}</span>{/if}
            </label>
            <div class="gc-setup__actions">
                <button type="submit" class="gc-button gc-button--primary" data-testid="gc-setup-save">Save</button>
                {#if app.oauth}<button type="button" class="gc-button" onclick={() => (editing = false)}>Cancel</button>{/if}
            </div>
        </form>
    {:else}
        <div class="gc-setup__connect">
            <p class="gc-muted">Your OAuth client is set. Connect the Google account whose calendars you want to see.</p>
            <ConnectButton {app} primary />
            <button type="button" class="gc-link" onclick={() => (editing = true)}>Change the Client ID or secret</button>
        </div>
    {/if}

    <p class="gc-setup__note gc-muted">
        A work or school account may need its administrator to trust your Client ID, under Security, API controls, Manage app access in the Google Admin console.
    </p>
    <p class="gc-setup__note gc-muted">
        The Client secret and your sign-in are kept with your other EtherPK settings, encrypted, and follow you to your other devices where you sync. An agent you gave an agent token for your account can
        read them too. Disconnect ends the sign-in at Google on every device.
    </p>
</div>

<style>
    .gc-setup {
        max-width: 44rem;
        margin: 0 auto;
        padding: 1.5rem 1.25rem 3rem;
        font-size: 0.9375rem;
        line-height: 1.55;
    }
    .gc-setup__title {
        margin: 0 0 0.75rem;
        font-size: 1.375rem;
        font-weight: 650;
    }
    .gc-setup__steps {
        display: grid;
        gap: 0.75rem;
        padding-left: 1.25rem;
    }
    .gc-setup__addresses {
        display: grid;
        gap: 0.25rem 0.75rem;
        margin: 0.5rem 0 0;
    }
    .gc-setup__addresses dt {
        font-weight: 600;
        font-size: 0.875rem;
    }
    .gc-setup__addresses dd {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        margin: 0 0 0.5rem;
    }
    .gc-setup__addresses code {
        padding: 0.25rem 0.5rem;
        border-radius: 0.375rem;
        background: var(--gk-surface-2);
        font-family: var(--gk-mono, monospace);
        font-size: 0.875rem;
        overflow-wrap: anywhere;
    }
    .gc-setup__form,
    .gc-setup__connect {
        display: grid;
        gap: 0.875rem;
        margin: 1.25rem 0;
        padding: 1rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 0.75rem;
        background: var(--gk-surface-1);
    }
    .gc-setup__connect {
        justify-items: start;
    }
    .gc-setup__actions {
        display: flex;
        gap: 0.5rem;
    }
    .gc-setup__note {
        font-size: 0.875rem;
    }
</style>
