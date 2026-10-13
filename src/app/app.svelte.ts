/**
 * The extension in one open graph: the person's records, the events store, the actions that change
 * events, and connecting accounts, shared by the Calendar Events View and every Journal Panel.
 *
 * It follows the person's settings and records as they change, here or on another device: a new
 * Client ID, an account connected or disconnected elsewhere, the journal switch.
 */
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'

import { createActions, type Actions } from './actions'
import { CalendarStore } from './calendar-store.svelte'
import { createSignInStarter, disconnect as revoke, type SignInStarter } from './connect'
import { createRecords, type AccountRecord, type Records } from './records'
import { TaskStore } from './task-store.svelte'

export interface OAuthClient {
    clientId: string
    clientSecret: string
}

export class CalendarApp {
    readonly context: ExtensionContext
    readonly records: Records
    readonly store: CalendarStore
    readonly tasks: TaskStore
    readonly actions: Actions
    readonly signIn: SignInStarter
    /** The OAuth client the person set up, or null until both its parts are set. */
    oauth = $state<OAuthClient | null>(null)
    /** The connected accounts, as the person's records hold them. */
    accounts = $state.raw<AccountRecord[]>([])
    /** Whether each day's events show beneath its journal entry. */
    journalEvents = $state(true)
    /** Whether each day's due tasks show beneath its journal entry, below its events. */
    journalTasks = $state(true)
    /** Whether every task not yet completed shows beneath today's journal entry, below the due tasks. */
    journalOpenTasks = $state(true)
    /** Whether the light or dark theme shows. */
    dark = $state(false)
    readonly #stops: (() => void)[] = []

    constructor(context: ExtensionContext, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
        this.context = context
        this.records = createRecords(context.personStorage, context.storage)
        this.store = new CalendarStore({ records: this.records, client: () => this.oauth, fetch: fetcher })
        this.tasks = new TaskStore(this.store, this.records)
        this.actions = createActions(this.store)
        this.signIn = createSignInStarter({ auth: context.auth, fetch: fetcher })
        this.#fetch = fetcher
        this.#readSettings()
        this.accounts = this.records.accounts()
        this.dark = context.theme.isDark()
        this.#stops.push(context.settings.subscribe(() => this.#readSettings()))
        this.#stops.push(
            this.records.subscribe(() => {
                const before = this.accounts.map((account) => `${account.email} ${account.refreshToken}`).join(',')
                this.accounts = this.records.accounts()
                if (this.accounts.map((account) => `${account.email} ${account.refreshToken}`).join(',') !== before) void this.refresh()
                else this.store.recordsChanged()
            }),
        )
        this.#stops.push(context.events.on('theme:changed', ({ dark }) => (this.dark = dark)))
        if (this.oauth && this.accounts.length > 0) void this.refresh()
    }

    readonly #fetch: typeof fetch

    #readSettings() {
        const clientId = this.context.settings.get('client-id')?.trim()
        const clientSecret = this.context.settings.get('client-secret')?.trim()
        const before = this.oauth
        this.oauth = clientId && clientSecret ? { clientId, clientSecret } : null
        this.journalEvents = this.context.settings.get('journal-events') !== 'false'
        this.journalTasks = this.context.settings.get('journal-tasks') !== 'false'
        this.journalOpenTasks = this.context.settings.get('journal-open-tasks') !== 'false'
        if ((before?.clientId ?? '') !== (this.oauth?.clientId ?? '') || (before?.clientSecret ?? '') !== (this.oauth?.clientSecret ?? '')) {
            if (this.oauth && this.accounts.length > 0) void this.refresh()
        }
    }

    /** Read every account's calendars, settings and task lists again. */
    refresh(): Promise<unknown> {
        return Promise.all([this.store.refreshAccounts(), this.tasks.refreshLists()])
    }

    /** Set the OAuth client from the setup screen, into the extension's own settings. */
    setOAuthClient(clientId: string, clientSecret: string) {
        this.context.settings.set('client-id', clientId.trim() || null)
        this.context.settings.set('client-secret', clientSecret.trim() || null)
    }

    /** Connect an account, or the same account again. Must be called inside the click that asked. */
    async connect(options: { loginHint?: string; signal?: AbortSignal } = {}): Promise<AccountRecord> {
        const oauth = this.oauth
        if (!oauth) throw new Error('Set the Client ID and Client secret first.')
        const account = await this.signIn.start({ ...oauth, ...options })
        this.records.putAccount(account)
        // Read again even when Google gave the same refresh token: a reconnect is the person asking.
        this.store.forgetClient(account.email)
        this.tasks.forget(account.email)
        void this.refresh()
        return account
    }

    /** Disconnect an account: its sign-in is revoked at Google, and it goes from every device. */
    async disconnect(email: string): Promise<void> {
        const account = this.records.accounts().find((candidate) => candidate.email === email)
        if (!account) return
        try {
            await revoke(account, this.#fetch)
        } finally {
            // Gone here whether or not Google answered: the person can also revoke it in their Google account.
            this.records.removeAccount(email)
            this.store.forget(email)
            this.tasks.forget(email)
        }
    }

    /** Open a day's Journal Entry, or a Draft of it. */
    openDay(day: string, panelId?: string) {
        this.context.layout.openDocument(day, panelId ? { inPaneOf: panelId } : undefined)
    }

    /** Open the Calendar Events View, on a day when given. */
    openCalendar(day?: string) {
        this.context.layout.openView({ kind: 'google-calendar.calendar', target: 'calendar' })
        this.focusDay = day ?? null
    }

    /** A day the next Calendar Events View draw should show, asked for from a Journal Panel. */
    focusDay = $state<string | null>(null)

    destroy() {
        for (const stop of this.#stops.splice(0)) stop()
    }
}
