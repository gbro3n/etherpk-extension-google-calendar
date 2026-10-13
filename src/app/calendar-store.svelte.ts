/**
 * The events on screen, for every connected account, kept in memory only (Google is their one store,
 * and nothing about them is written into the graph). The Calendar Events View and every Journal
 * Panel of one open graph share one store, so a day's events load once.
 *
 * - **Accounts.** For each account the store reads its calendar list, colour palettes, settings and
 *   event labels once, then on `refresh`. An account whose sign-in Google no longer accepts is marked
 *   `reconnect` and shows nothing until the person connects it again.
 * - **Events** load by calendar month: a View or a panel asks for a range (`ensure`), and each
 *   month of it that is missing, or older than five minutes, is fetched for every shown calendar.
 *   Months already held keep showing while they are fetched again, so a refresh never blanks the
 *   screen. A read made obsolete by a newer one for the same month is aborted.
 * - **Changes** made here are put in at once (`putEvent`, `dropEvent`), and the months they touch are
 *   fetched again afterwards, so what Google made of the change (a series expanded, a Meet link
 *   created) replaces the guess.
 *
 * `version` changes whenever anything shown changes, which is what a Svelte reader depends on.
 */
import { untrack } from 'svelte'

import type { CalendarEvent, CalendarListEntry, CalendarSettings, ColorPalettes, EventLabel } from '../google/types'
import { getColors, getSettings, listCalendars, listEvents, listLabels } from '../google/calendar-api'
import { createGoogleClient, GoogleError, type GoogleClient } from '../google/http'
import { createTokenManager } from '../google/token-manager'
import { calendarColor, eventColor, textColorOn } from '../model/colors'
import { eventSpan, type EventSpan } from '../model/time'
import type { AccountRecord, CalendarRef, Records } from './records'

/** How long a fetched month counts as fresh. */
const FRESH_MS = 5 * 60 * 1000
/** Requests to Google at once, across every account and calendar. */
const PARALLEL = 6

export type AccountStatus = 'loading' | 'ready' | 'reconnect' | 'error'

export interface AccountView {
    email: string
    status: AccountStatus
    /** Why the account is not ready, in words for the person. */
    message?: string
    /** The calendars in the person's Google Calendar list, primary first. */
    calendars: CalendarListEntry[]
    settings: CalendarSettings
    palettes: ColorPalettes | null
    /** Each calendar's event labels, by calendar id, where it has any. */
    labels: Record<string, EventLabel[]>
}

/** An event as the Views and panels draw it. */
export interface ShownEvent {
    /** Unique across accounts and calendars. */
    key: string
    account: string
    calendar: CalendarListEntry
    /** The calendar's name as the person sees it in Google Calendar. */
    calendarName: string
    event: CalendarEvent
    span: EventSpan
    color: string
    textColor: string
    /** The person may change it from here: their calendar allows it, and the event is not a copy. */
    editable: boolean
    /** Guests other than the person, who a change can email. */
    hasGuests: boolean
}

/** Whether the shown range has everything it needs, as a View's state says it. */
export type RangeState = 'loading' | 'refreshing' | 'ready' | 'offline' | 'error'

interface Month {
    events: CalendarEvent[]
    fetchedAt: number
    /** A fetch on its way, and how to abort it if a newer one replaces it. */
    pending: { controller: AbortController; promise: Promise<void> } | null
    error: GoogleError | null
}

export interface StoreOptions {
    records: Records
    /** The OAuth client the person set up: its Client ID and Client secret, or null until both are set. */
    client(): { clientId: string; clientSecret: string } | null
    fetch: typeof fetch
    now?: () => number
}

/** The months a range covers, as `YYYY-MM` keys with their bounds. */
export function monthsOf(start: Date, end: Date): { key: string; start: Date; end: Date }[] {
    const months: { key: string; start: Date; end: Date }[] = []
    let cursor = new Date(start.getFullYear(), start.getMonth(), 1)
    while (cursor < end) {
        const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`
        months.push({ key, start: cursor, end: next })
        cursor = next
    }
    return months
}

const writableRoles = new Set(['writer', 'owner'])

/** The person's own answer to an invitation, when they are a guest. */
export function ownResponse(event: CalendarEvent): string | undefined {
    return event.attendees?.find((attendee) => attendee.self)?.responseStatus
}

/** A small queue that runs at most `limit` tasks at once. */
function limiter(limit: number) {
    let running = 0
    const waiting: (() => void)[] = []
    return async function run<T>(task: () => Promise<T>): Promise<T> {
        if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
        running++
        try {
            return await task()
        } finally {
            running--
            waiting.shift()?.()
        }
    }
}

export class CalendarStore {
    /** Changes whenever anything shown changes. */
    version = $state(0)
    /** Changes when the person ticks or unticks a calendar, so the Views load what now shows. */
    selection = $state(0)
    accounts = $state.raw<AccountView[]>([])

    readonly #options: StoreOptions
    readonly #now: () => number
    readonly #clients = new Map<string, GoogleClient>()
    readonly #months = new Map<string, Month>()
    readonly #run = limiter(PARALLEL)
    /** The client id and refresh token each Google client was made with, to make a new one when they change. */
    readonly #madeWith = new Map<string, string>()

    constructor(options: StoreOptions) {
        this.#options = options
        this.#now = options.now ?? Date.now
    }

    /**
     * Tell readers something shown changed. Read untracked, so the effect that makes a change (a
     * View's `ensure`) does not come to depend on `version` by bumping it, and run again.
     */
    #changed() {
        this.version = untrack(() => this.version) + 1
    }

    /** Tell readers the person's records changed (a calendar ticked), which `events` reads. */
    recordsChanged() {
        this.selection = untrack(() => this.selection) + 1
        this.#changed()
    }

    /** The Google client for an account, made afresh when its sign-in or the OAuth client changed. */
    client(email: string): GoogleClient | null {
        const oauth = this.#options.client()
        const record = this.#options.records.accounts().find((account) => account.email === email)
        if (!oauth || !record) return null
        const madeWith = `${oauth.clientId} ${oauth.clientSecret} ${record.refreshToken}`
        let client = this.#clients.get(email)
        if (!client || this.#madeWith.get(email) !== madeWith) {
            const tokens = createTokenManager({ clientId: oauth.clientId, clientSecret: oauth.clientSecret, refreshToken: record.refreshToken, fetch: this.#options.fetch, now: this.#now })
            client = createGoogleClient({ tokens, fetch: this.#options.fetch })
            this.#clients.set(email, client)
            this.#madeWith.set(email, madeWith)
        }
        return client
    }

    /** Read every account's calendars, palettes, settings and labels again, keeping what is shown meanwhile. */
    async refreshAccounts(): Promise<void> {
        const records = this.#options.records.accounts()
        const known = new Map(this.accounts.map((account) => [account.email, account]))
        // Accounts removed elsewhere go at once, with their months.
        this.accounts = records.map(
            (record) => known.get(record.email) ?? { email: record.email, status: 'loading', calendars: [], settings: {}, palettes: null, labels: {} },
        )
        for (const key of [...this.#months.keys()]) if (!records.some((record) => key.startsWith(`${record.email}|`))) this.#months.delete(key)
        this.#changed()
        await Promise.all(records.map((record) => this.#loadAccount(record)))
    }

    async #loadAccount(record: AccountRecord): Promise<void> {
        const client = this.client(record.email)
        if (!client) return
        try {
            const [calendars, palettes, settings] = await Promise.all([
                this.#run(() => listCalendars(client)),
                this.#run(() => getColors(client)),
                this.#run(() => getSettings(client)),
            ])
            const sorted = [...calendars].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
            const labels: Record<string, EventLabel[]> = {}
            // Labels are read for the calendars the person can write to, where events carry them.
            await Promise.all(
                sorted
                    .filter((calendar) => writableRoles.has(calendar.accessRole))
                    .map(async (calendar) => {
                        try {
                            const found = await this.#run(() => listLabels(client, calendar.id))
                            if (found.length > 0) labels[calendar.id] = found
                        } catch {
                            // A calendar without labels, or an account whose sign-in predates the
                            // scope that reads them: its events take their colours as before.
                        }
                    }),
            )
            this.#setAccount(record.email, { status: 'ready', message: undefined, calendars: sorted, palettes, settings, labels })
        } catch (error) {
            this.#setAccount(record.email, accountProblem(error))
        }
    }

    #setAccount(email: string, change: Partial<AccountView>) {
        this.accounts = this.accounts.map((account) => (account.email === email ? { ...account, ...change } : account))
        this.#changed()
    }

    /** The calendars shown: the person's choice here, else as Google Calendar's own list has them. */
    shownCalendars(): { account: AccountView; calendar: CalendarListEntry }[] {
        const choices = this.#options.records.choices()
        const shown: { account: AccountView; calendar: CalendarListEntry }[] = []
        for (const account of this.accounts) {
            if (account.status !== 'ready') continue
            for (const calendar of account.calendars) {
                if (calendar.accessRole === 'freeBusyReader') continue
                const chosen = choices[account.email]?.[calendar.id]
                if (chosen ?? calendar.selected ?? false) shown.push({ account, calendar })
            }
        }
        return shown
    }

    isShown(ref: CalendarRef): boolean {
        return this.shownCalendars().some((shown) => shown.account.email === ref.account && shown.calendar.id === ref.calendarId)
    }

    /**
     * Make sure every month of the range is loaded for every shown calendar, fetching what is
     * missing or older than five minutes (all of it with `force`). Resolves once the fetches end,
     * whether they succeeded or not: a failure is kept on its month, for `rangeState` to report.
     */
    async ensure(start: Date, end: Date, { force = false } = {}): Promise<void> {
        const jobs: Promise<void>[] = []
        for (const { account, calendar } of this.shownCalendars()) {
            for (const month of monthsOf(start, end)) {
                const key = `${account.email}|${calendar.id}|${month.key}`
                const held = this.#months.get(key)
                if (held?.pending && !force) {
                    jobs.push(held.pending.promise)
                    continue
                }
                if (held && !force && !held.error && this.#now() - held.fetchedAt < FRESH_MS) continue
                jobs.push(this.#fetchMonth(key, account.email, calendar.id, month.start, month.end))
            }
        }
        await Promise.all(jobs)
    }

    #fetchMonth(key: string, email: string, calendarId: string, start: Date, end: Date): Promise<void> {
        const held = this.#months.get(key)
        // A newer read replaces an older one for the same month: its answer would be stale.
        held?.pending?.controller.abort()
        const controller = new AbortController()
        const month: Month = held ?? { events: [], fetchedAt: 0, pending: null, error: null }
        const promise = (async () => {
            const client = this.client(email)
            if (!client) return
            try {
                const events = await this.#run(() => listEvents(client, calendarId, { timeMin: start, timeMax: end }, controller.signal))
                if (controller.signal.aborted) return
                month.events = events
                month.fetchedAt = this.#now()
                month.error = null
            } catch (error) {
                if (controller.signal.aborted) return
                month.error = error instanceof GoogleError ? error : new GoogleError('Google could not be reached.', { status: 0, kind: 'offline' })
                if (month.error.kind === 'auth') this.#setAccount(email, accountProblem(month.error))
            } finally {
                if (month.pending?.controller === controller) month.pending = null
                this.#changed()
            }
        })()
        month.pending = { controller, promise }
        this.#months.set(key, month)
        this.#changed()
        return promise
    }

    /** Whether the range has what it needs: for a View's loading, refreshing, offline and error states. */
    rangeState(start: Date, end: Date): RangeState {
        void this.version
        let missing = false
        let pending = false
        let offline = false
        let failed = false
        for (const { account, calendar } of this.shownCalendars()) {
            for (const month of monthsOf(start, end)) {
                const held = this.#months.get(`${account.email}|${calendar.id}|${month.key}`)
                if (!held || (held.fetchedAt === 0 && !held.error)) missing = true
                if (held?.pending) pending = true
                if (held?.error?.kind === 'offline') offline = true
                else if (held?.error) failed = true
            }
        }
        if (missing && !offline && !failed) return 'loading'
        if (offline) return 'offline'
        if (failed) return 'error'
        return pending ? 'refreshing' : 'ready'
    }

    /** The first problem a range met, in words for the person. */
    rangeProblem(start: Date, end: Date): string | null {
        for (const { account, calendar } of this.shownCalendars()) {
            for (const month of monthsOf(start, end)) {
                const error = this.#months.get(`${account.email}|${calendar.id}|${month.key}`)?.error
                if (error) return error.message
            }
        }
        return null
    }

    /** Every shown event overlapping the range, once each, however many months hold it. */
    events(start: Date, end: Date): ShownEvent[] {
        void this.version
        const out = new Map<string, ShownEvent>()
        for (const { account, calendar } of this.shownCalendars()) {
            const calendarBackground = calendarColor(calendar)
            for (const month of monthsOf(start, end)) {
                const held = this.#months.get(`${account.email}|${calendar.id}|${month.key}`)
                for (const event of held?.events ?? []) {
                    if (event.status === 'cancelled') continue
                    // Declined invitations are hidden, as Google Calendar does with Show declined events off.
                    if (ownResponse(event) === 'declined') continue
                    const span = eventSpan(event)
                    if (span.end <= start || span.start >= end) {
                        // A zero-length event at the range's start still counts.
                        if (!(span.start.getTime() === span.end.getTime() && span.start >= start && span.start < end)) continue
                    }
                    const key = `${account.email}|${calendar.id}|${event.id}`
                    if (out.has(key)) continue
                    const color = eventColor(event, calendarBackground, account.labels[calendar.id])
                    out.set(key, {
                        key,
                        account: account.email,
                        calendar,
                        calendarName: calendar.summaryOverride || calendar.summary,
                        event,
                        span,
                        color,
                        textColor: textColorOn(color),
                        editable: writableRoles.has(calendar.accessRole) && !event.locked && !event.privateCopy && event.eventType !== 'birthday' && event.eventType !== 'fromGmail',
                        hasGuests: (event.attendees ?? []).some((attendee) => !attendee.self && !attendee.resource),
                    })
                }
            }
        }
        return [...out.values()]
    }

    /** One event, by its key, from whatever months hold it. */
    find(key: string): ShownEvent | undefined {
        const [account, calendarId, id] = splitKey(key)
        for (const [monthKey, month] of this.#months) {
            if (!monthKey.startsWith(`${account}|${calendarId}|`)) continue
            const event = month.events.find((candidate) => candidate.id === id)
            if (event) {
                const span = eventSpan(event)
                return this.events(span.start, new Date(Math.max(span.end.getTime(), span.start.getTime() + 1))).find((shown) => shown.key === key)
            }
        }
        return undefined
    }

    /** Put an event as it now is into every month it overlaps, replacing the copy held. */
    putEvent(ref: CalendarRef, event: CalendarEvent): void {
        const span = eventSpan(event)
        this.#dropFromMonths(ref, event.id)
        for (const month of monthsOf(span.start, new Date(Math.max(span.end.getTime(), span.start.getTime() + 1)))) {
            const key = `${ref.account}|${ref.calendarId}|${month.key}`
            const held = this.#months.get(key)
            if (held) held.events = [...held.events, event]
        }
        this.#changed()
    }

    /** Take an event out of what is shown. */
    dropEvent(ref: CalendarRef, eventId: string): void {
        this.#dropFromMonths(ref, eventId)
        this.#changed()
    }

    /** Take every occurrence of a series out, for a change to the whole series. */
    dropSeries(ref: CalendarRef, seriesId: string): void {
        for (const [key, month] of this.#months) {
            if (!key.startsWith(`${ref.account}|${ref.calendarId}|`)) continue
            month.events = month.events.filter((event) => event.id !== seriesId && event.recurringEventId !== seriesId)
        }
        this.#changed()
    }

    #dropFromMonths(ref: CalendarRef, eventId: string) {
        for (const [key, month] of this.#months) {
            if (!key.startsWith(`${ref.account}|${ref.calendarId}|`)) continue
            month.events = month.events.filter((event) => event.id !== eventId)
        }
    }

    /** Fetch again every held month of a calendar that a change touched, or of every calendar. */
    async reload(ref?: CalendarRef): Promise<void> {
        const jobs: Promise<void>[] = []
        for (const [key, month] of this.#months) {
            const [account, calendarId, monthKey] = splitKey(key)
            if (ref && (account !== ref.account || calendarId !== ref.calendarId)) continue
            const [year, number] = monthKey.split('-').map(Number)
            jobs.push(this.#fetchMonth(key, account, calendarId, new Date(year, number - 1, 1), new Date(year, number, 1)))
            void month
        }
        await Promise.all(jobs)
    }

    /** Make the account's Google client afresh on next use, for a new sign-in. */
    forgetClient(email: string): void {
        this.#clients.delete(email)
        this.#madeWith.delete(email)
    }

    /** Forget everything held for an account, for a disconnect. */
    forget(email: string): void {
        for (const key of [...this.#months.keys()]) if (key.startsWith(`${email}|`)) this.#months.delete(key)
        this.#clients.delete(email)
        this.#madeWith.delete(email)
        this.accounts = this.accounts.filter((account) => account.email !== email)
        this.#changed()
    }
}

/** An event's key apart: account, calendar id and event id. Calendar ids hold no `|`. */
export function splitKey(key: string): [string, string, string] {
    const first = key.indexOf('|')
    const second = key.indexOf('|', first + 1)
    return [key.slice(0, first), key.slice(first + 1, second), key.slice(second + 1)]
}

function accountProblem(error: unknown): Partial<AccountView> {
    if (error instanceof GoogleError && error.kind === 'auth') {
        return { status: 'reconnect', message: 'Google no longer accepts this account’s sign-in. Connect it again to see its calendars.' }
    }
    if (error instanceof GoogleError) return { status: 'error', message: error.message }
    return { status: 'error', message: 'This account’s calendars could not be loaded.' }
}
