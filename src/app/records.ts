/**
 * What the extension keeps with the person (`context.personStorage`), which follows them to their
 * other devices, encrypted, where they sync (ADR 0140 in EtherPK):
 *
 * - `accounts`: each connected Google account, with the refresh token its sign-in gave. One
 *   sign-in serves every device of the person's, so they connect once.
 * - `calendars`: the calendars the person ticked or unticked here, by account and calendar. A
 *   calendar they never touched shows as Google Calendar's own list has it (`selected`).
 * - `default-calendar`: where a new event goes unless they pick another calendar.
 * - `task-lists`: the Google Tasks lists the person ticked or unticked here, by account and list. A
 *   list they never touched shows.
 *
 * And on this device only (`context.storage`), the view last picked.
 *
 * Every read checks the shape it gets, because a record arrives from another device, perhaps from
 * another release of the extension.
 */
import type { ExtensionPersonStorage, ExtensionStorage } from '@appsoftwareltd/etherpk-extension-api'

/** One connected Google account. */
export interface AccountRecord {
    /** The account's address, as Google's ID token gave it: what the person sees, and the key. */
    email: string
    refreshToken: string
    /** The scopes Google granted, space-separated. */
    scopes: string
    addedAt: number
}

/** A calendar, by the account it belongs to and its id. */
export interface CalendarRef {
    account: string
    calendarId: string
}

/** Calendar choices: account → calendar id → shown. */
export type CalendarChoices = Record<string, Record<string, boolean>>

export type ViewName = 'day' | 'week' | 'four-days' | 'month' | 'year' | 'schedule'

export const VIEW_NAMES: readonly ViewName[] = ['day', 'week', 'four-days', 'month', 'year', 'schedule']

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function isAccount(value: unknown): value is AccountRecord {
    if (!isObject(value)) return false
    return typeof value.email === 'string' && value.email !== '' && typeof value.refreshToken === 'string' && value.refreshToken !== '' && typeof value.scopes === 'string' && typeof value.addedAt === 'number'
}

export interface Records {
    accounts(): AccountRecord[]
    /** Add an account, or replace the one with the same address (a reconnect). */
    putAccount(account: AccountRecord): void
    removeAccount(email: string): void
    choices(): CalendarChoices
    choose(ref: CalendarRef, shown: boolean): void
    defaultCalendar(): CalendarRef | null
    setDefaultCalendar(ref: CalendarRef | null): void
    /** Task list choices: account → list id → shown. A list not named shows. */
    taskListChoices(): CalendarChoices
    chooseTaskList(ref: { account: string; listId: string }, shown: boolean): void
    lastView(): ViewName | null
    setLastView(view: ViewName): void
    /** Hear a change to any of the person's records, here or from another device. */
    subscribe(listener: () => void): () => void
}

/** Choices by account and id, as another device or release may have written them. */
function readChoices(value: unknown): CalendarChoices {
    if (!isObject(value)) return {}
    const out: CalendarChoices = {}
    for (const [account, entries] of Object.entries(value)) {
        if (!isObject(entries)) continue
        out[account] = {}
        for (const [id, shown] of Object.entries(entries)) if (typeof shown === 'boolean') out[account][id] = shown
    }
    return out
}

export function createRecords(person: ExtensionPersonStorage, device: ExtensionStorage): Records {
    const accounts = (): AccountRecord[] => {
        const value = person.get<unknown>('accounts')
        return Array.isArray(value) ? value.filter(isAccount) : []
    }
    const choices = (): CalendarChoices => readChoices(person.get<unknown>('calendars'))
    return {
        accounts,
        putAccount(account) {
            const others = accounts().filter((kept) => kept.email !== account.email)
            const at = accounts().findIndex((kept) => kept.email === account.email)
            // A reconnect keeps the account's place, so the first account stays first.
            const next = at === -1 ? [...others, account] : [...others.slice(0, at), account, ...others.slice(at)]
            person.set('accounts', next)
        },
        removeAccount(email) {
            person.set(
                'accounts',
                accounts().filter((kept) => kept.email !== email),
            )
            const { [email]: _gone, ...rest } = choices()
            person.set('calendars', rest)
            const { [email]: _goneLists, ...otherLists } = readChoices(person.get<unknown>('task-lists'))
            person.set('task-lists', otherLists)
            if (this.defaultCalendar()?.account === email) person.remove('default-calendar')
        },
        choices,
        choose(ref, shown) {
            const all = choices()
            person.set('calendars', { ...all, [ref.account]: { ...all[ref.account], [ref.calendarId]: shown } })
        },
        defaultCalendar() {
            const value = person.get<unknown>('default-calendar')
            return isObject(value) && typeof value.account === 'string' && typeof value.calendarId === 'string' ? { account: value.account, calendarId: value.calendarId } : null
        },
        setDefaultCalendar(ref) {
            if (ref) person.set('default-calendar', ref)
            else person.remove('default-calendar')
        },
        taskListChoices() {
            return readChoices(person.get<unknown>('task-lists'))
        },
        chooseTaskList(ref, shown) {
            const all = readChoices(person.get<unknown>('task-lists'))
            person.set('task-lists', { ...all, [ref.account]: { ...all[ref.account], [ref.listId]: shown } })
        },
        lastView() {
            const value = device.get<unknown>('view')
            return typeof value === 'string' && (VIEW_NAMES as readonly string[]).includes(value) ? (value as ViewName) : null
        },
        setLastView(view) {
            device.set('view', view)
        },
        subscribe: (listener) => person.subscribe(listener),
    }
}
