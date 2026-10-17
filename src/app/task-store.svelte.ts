/**
 * Google Tasks from the task lists the person has ticked (every list until they untick one), for
 * every account whose sign-in allows Tasks: an account connected before sign-in asked for Tasks is
 * connected again to allow it. Kept in memory only, like events, in two kinds of read:
 *
 * - by month, the tasks due in it, which Calendar Events and each day's Journal Panel show on their
 *   day as Google Calendar does;
 * - every task not yet completed, due or not, which today's Journal Panel lists by task list.
 *
 * A task's due date is a date alone: Google writes it as midnight UTC of that date, so the day is the
 * date part of `due`, whatever the device's time zone.
 */
import { untrack } from 'svelte'

import { GoogleError } from '../google/http'
import { TASKS_SCOPE } from '../google/oauth'
import { deleteTask, insertTask, listTaskLists, listTasks, patchTask, type TaskFilter, type TaskPatch } from '../google/tasks-api'
import type { Task, TaskList } from '../google/types'
import { isoDay } from '../model/time'
import { readable } from './actions'
import { monthsOf, type CalendarStore } from './calendar-store.svelte'
import type { Records } from './records'

const FRESH_MS = 5 * 60 * 1000

/** A task as the Views and panels draw it. */
export interface ShownTask {
    key: string
    account: string
    list: TaskList
    task: Task
    /** The due date, `YYYY-MM-DD`, or null for a task with none. */
    day: string | null
    done: boolean
}

/** A task with a due date, as the calendar and each day's panel show it on that day. */
export type DueTask = ShownTask & { day: string }

/** A task list a new task can go in, with the key the list pickers use for it. */
export interface ListOption {
    /** `<account>|<list id>`. */
    key: string
    email: string
    list: TaskList
}

type ListedTask = Task & { listId: string }

/** One read of an account's tasks (a month's due tasks, or every open task), as last fetched. */
interface Held {
    tasks: ListedTask[]
    fetchedAt: number
    /** Whether a read has ever succeeded, so `tasks` says what Google holds. `fetchedAt` is reset to read again. */
    read: boolean
    pending: Promise<void> | null
    error: GoogleError | null
}

/** The key the open tasks are held under, beside the months' (`YYYY-MM`). */
const OPEN = 'open'

/** A due date as Google writes it, for a day. */
export function dueOf(day: string): string {
    return `${day}T00:00:00.000Z`
}

export class TaskStore {
    version = $state(0)
    /** Changes when held months must be read again (after a change here), which the Views follow. */
    staleness = $state(0)
    /** Each account's task lists, once read, by account. */
    lists = $state.raw<Record<string, TaskList[]>>({})
    readonly #calendars: CalendarStore
    readonly #records: Records
    /** Each account's reads, by `<account>|<month key or OPEN>`. */
    readonly #held = new Map<string, Held>()
    /**
     * Tasks ticked or unticked here, by key, with the day that happened. Today's open tasks keep them
     * in place, struck through or not, for the rest of that day, rather than dropping one from under
     * the pointer when Google next lists only what is still open.
     */
    readonly #tickedToday = new Map<string, { shown: ShownTask; on: string }>()
    readonly #now: () => number

    constructor(calendars: CalendarStore, records: Records, now: () => number = Date.now) {
        this.#calendars = calendars
        this.#records = records
        this.#now = now
    }

    #changed() {
        this.version = untrack(() => this.version) + 1
    }

    /** Whether any account's sign-in allows Tasks. */
    get on(): boolean {
        return this.accounts().allowed.length > 0
    }

    /** Why an account's task lists could not be read, by account, for the calendar list to say. */
    listProblems = $state.raw<Record<string, string>>({})

    /** Whether a task list shows: the person's choice, else shown. */
    listShown(email: string, listId: string): boolean {
        return this.#records.taskListChoices()[email]?.[listId] ?? true
    }

    /** Read every allowed account's task lists, for the calendar list, saying why where Google refuses. */
    async refreshLists(): Promise<void> {
        await Promise.all(
            this.accounts().allowed.map(async (email) => {
                try {
                    await this.#listsOf(email)
                    if (this.listProblems[email]) {
                        const { [email]: _solved, ...rest } = this.listProblems
                        this.listProblems = rest
                    }
                } catch (error) {
                    this.listProblems = { ...this.listProblems, [email]: readable(error).message }
                }
            }),
        )
    }

    /** The accounts whose sign-in allows Tasks, and those that need connecting again for them. */
    accounts(): { allowed: string[]; needConsent: string[] } {
        const allowed: string[] = []
        const needConsent: string[] = []
        for (const account of this.#records.accounts()) (account.scopes.includes(TASKS_SCOPE) ? allowed : needConsent).push(account.email)
        return { allowed, needConsent }
    }

    /**
     * Every task list a new task can go in: those read so far of each account whose sign-in allows
     * Tasks, account by account, each account's in Google's order.
     */
    listOptions(): ListOption[] {
        return this.accounts().allowed.flatMap((email) => (this.lists[email] ?? []).map((list) => ({ key: `${email}|${list.id}`, email, list })))
    }

    /**
     * The list a new task starts in: the one the person chose for new tasks while Google still has
     * it and its account allows Tasks, else the first list Google gave for the first account. Null
     * while no list has been read.
     */
    defaultList(): ListOption | null {
        const options = this.listOptions()
        const chosen = this.#records.defaultTaskList()
        return (chosen && options.find((option) => option.email === chosen.account && option.list.id === chosen.listId)) || options[0] || null
    }

    /** An account's task lists, read from Google when not yet read. Throws, saying why, when Google refuses. */
    async loadLists(email: string): Promise<TaskList[]> {
        try {
            return await this.#listsOf(email)
        } catch (error) {
            throw readable(error)
        }
    }

    async #listsOf(email: string): Promise<TaskList[]> {
        const known = this.lists[email]
        if (known) return known
        const client = this.#calendars.client(email)
        if (!client) return []
        const lists = await listTaskLists(client)
        this.lists = { ...this.lists, [email]: lists }
        return lists
    }

    /** Load the tasks due in every month of the range that is missing or stale. */
    async ensure(start: Date, end: Date, { force = false } = {}): Promise<void> {
        if (!this.on) return
        const jobs: Promise<void>[] = []
        for (const email of this.accounts().allowed) {
            for (const month of monthsOf(start, end)) {
                // Due dates are dates in UTC: the month's first date, to the next month's, as Google filters them.
                const dueMin = new Date(Date.UTC(month.start.getFullYear(), month.start.getMonth(), 1))
                const dueMax = new Date(Date.UTC(month.end.getFullYear(), month.end.getMonth(), 1))
                this.#ensureHeld(`${email}|${month.key}`, email, { dueMin, dueMax, showCompleted: true }, force, jobs)
            }
        }
        await Promise.all(jobs)
    }

    /** Load every account's tasks that are not yet completed, when missing or stale. */
    async ensureOpen({ force = false } = {}): Promise<void> {
        if (!this.on) return
        const jobs: Promise<void>[] = []
        for (const email of this.accounts().allowed) this.#ensureHeld(`${email}|${OPEN}`, email, { showCompleted: false }, force, jobs)
        await Promise.all(jobs)
    }

    /** Join a read under way, or start one when the held copy is missing, stale or failed. */
    #ensureHeld(key: string, email: string, filter: TaskFilter, force: boolean, jobs: Promise<void>[]) {
        const held = this.#held.get(key)
        if (held?.pending && !force) {
            jobs.push(held.pending)
            return
        }
        if (held && !force && !held.error && this.#now() - held.fetchedAt < FRESH_MS) return
        jobs.push(this.#fetch(key, email, filter))
    }

    #fetch(key: string, email: string, filter: TaskFilter): Promise<void> {
        const held: Held = this.#held.get(key) ?? { tasks: [], fetchedAt: 0, read: false, pending: null, error: null }
        const pending = (async () => {
            const client = this.#calendars.client(email)
            if (!client) return
            try {
                const lists = await this.#listsOf(email)
                const found = await Promise.all(lists.map((list) => listTasks(client, list.id, filter).then((tasks) => tasks.map((task) => ({ ...task, listId: list.id })))))
                held.tasks = found.flat()
                held.fetchedAt = this.#now()
                held.read = true
                held.error = null
            } catch (error) {
                held.error = error instanceof GoogleError ? error : new GoogleError('Google Tasks could not be reached.', { status: 0, kind: 'offline' })
            } finally {
                held.pending = null
                this.#changed()
            }
        })()
        held.pending = pending
        this.#held.set(key, held)
        this.#changed()
        return pending
    }

    #shown(email: string, task: ListedTask): ShownTask {
        const list = (this.lists[email] ?? []).find((candidate) => candidate.id === task.listId) ?? { id: task.listId, title: 'Tasks' }
        return { key: `${email}|${task.listId}|${task.id}`, account: email, list, task, day: task.due ? task.due.slice(0, 10) : null, done: task.status === 'completed' }
    }

    /** The tasks due in the range, once each. */
    tasks(start: Date, end: Date): DueTask[] {
        void this.version
        if (!this.on) return []
        const out = new Map<string, DueTask>()
        for (const email of this.accounts().allowed) {
            for (const month of monthsOf(start, end)) {
                for (const task of this.#held.get(`${email}|${month.key}`)?.tasks ?? []) {
                    if (!task.due || task.deleted) continue
                    const day = task.due.slice(0, 10)
                    const [year, monthNumber, date] = day.split('-').map(Number)
                    const at = new Date(year, monthNumber - 1, date)
                    if (at < new Date(start.getFullYear(), start.getMonth(), start.getDate()) || at >= end) continue
                    if (!this.listShown(email, task.listId)) continue
                    const shown = { ...this.#shown(email, task), day }
                    out.set(shown.key, shown)
                }
            }
        }
        // By day, then list, then Google's own order within the list.
        return [...out.values()].sort((a, b) => a.day.localeCompare(b.day) || a.list.title.localeCompare(b.list.title) || (a.task.position ?? '').localeCompare(b.task.position ?? '') || a.task.title.localeCompare(b.task.title))
    }

    /**
     * Every task not yet completed in the shown lists, due or not, and those ticked or unticked here
     * `today` (`YYYY-MM-DD`), each as it now stands. In no order: `inListOrder` gives Google's.
     */
    openTasks(today: string): ShownTask[] {
        void this.version
        if (!this.on) return []
        const allowed = this.accounts().allowed
        const out = new Map<string, ShownTask>()
        for (const email of allowed) {
            for (const task of this.#held.get(`${email}|${OPEN}`)?.tasks ?? []) {
                if (task.deleted || task.status === 'completed' || !this.listShown(email, task.listId)) continue
                const shown = this.#shown(email, task)
                out.set(shown.key, shown)
            }
        }
        for (const [key, { shown, on }] of this.#tickedToday) {
            if (on !== today || out.has(key) || !allowed.includes(shown.account) || !this.listShown(shown.account, shown.list.id)) continue
            out.set(key, { ...shown, done: shown.task.status === 'completed' })
        }
        return [...out.values()]
    }

    /** Whether the tasks due in the range have been read from Google, for every account that allows Tasks. */
    read(start: Date, end: Date): boolean {
        void this.version
        return this.accounts().allowed.every((email) => monthsOf(start, end).every((month) => this.#held.get(`${email}|${month.key}`)?.read === true))
    }

    /** The first problem a range met, in words for the person. */
    problem(start: Date, end: Date): string | null {
        for (const email of this.accounts().allowed) {
            for (const month of monthsOf(start, end)) {
                const error = this.#held.get(`${email}|${month.key}`)?.error
                if (error) return error.message
            }
        }
        return null
    }

    /** Why the open tasks could not be read, in words for the person, or null. */
    openProblem(): string | null {
        void this.version
        for (const email of this.accounts().allowed) {
            const error = this.#held.get(`${email}|${OPEN}`)?.error
            if (error) return error.message
        }
        return null
    }

    #forgetMonths(email: string) {
        for (const [key, held] of this.#held) if (key.startsWith(`${email}|`)) held.fetchedAt = 0
        this.staleness = untrack(() => this.staleness) + 1
    }

    async #write<T>(email: string, run: () => Promise<T>): Promise<T> {
        try {
            return await run()
        } catch (error) {
            throw readable(error)
        } finally {
            this.#forgetMonths(email)
            this.#changed()
        }
    }

    /** Tick a task off, or open it again. Shown at once, and put back if Google refuses. */
    async setDone(shown: ShownTask, done: boolean): Promise<void> {
        const client = this.#calendars.client(shown.account)
        if (!client) return
        const before = { ...shown.task }
        const today = isoDay(new Date(this.#now()))
        const ticked = this.#tickedToday.get(shown.key)
        for (const [key, { on }] of this.#tickedToday) if (on !== today) this.#tickedToday.delete(key)
        this.#tickedToday.set(shown.key, { shown, on: today })
        shown.task.status = done ? 'completed' : 'needsAction'
        this.#changed()
        try {
            await this.#write(shown.account, () => patchTask(client, shown.list.id, shown.task.id, done ? { status: 'completed' } : { status: 'needsAction', completed: null }))
        } catch (error) {
            Object.assign(shown.task, before)
            if (ticked) this.#tickedToday.set(shown.key, ticked)
            else this.#tickedToday.delete(shown.key)
            this.#changed()
            throw error
        }
    }

    async create(email: string, listId: string, task: Partial<Task>): Promise<Task> {
        const client = this.#calendars.client(email)
        if (!client) throw new Error('This account is not connected on this device.')
        return this.#write(email, () => insertTask(client, listId, task))
    }

    async update(shown: ShownTask, patch: TaskPatch): Promise<void> {
        const client = this.#calendars.client(shown.account)
        if (!client) return
        await this.#write(shown.account, () => patchTask(client, shown.list.id, shown.task.id, patch))
    }

    /**
     * Delete a task, and resolve with how to put it back: as a new task with what it held, beneath
     * the same parent when it was a subtask.
     */
    async remove(shown: ShownTask): Promise<() => Promise<void>> {
        const client = this.#calendars.client(shown.account)
        if (!client) throw new Error('This account is not connected on this device.')
        await this.#write(shown.account, () => deleteTask(client, shown.list.id, shown.task.id))
        this.#tickedToday.delete(shown.key)
        const { title, notes, due, status, parent } = shown.task
        return async () => {
            await this.#write(shown.account, () => insertTask(client, shown.list.id, { title, notes, due, status }, { parent }))
        }
    }

    /** Read every month, and the open tasks, again now. */
    reload(): void {
        for (const held of this.#held.values()) held.fetchedAt = 0
        this.staleness = untrack(() => this.staleness) + 1
    }

    /** Forget an account's lists and tasks, for a disconnect or a new sign-in. */
    forget(email: string): void {
        for (const key of [...this.#held.keys()]) if (key.startsWith(`${email}|`)) this.#held.delete(key)
        for (const [key, { shown }] of this.#tickedToday) if (shown.account === email) this.#tickedToday.delete(key)
        const { [email]: _gone, ...rest } = this.lists
        this.lists = rest
        this.#changed()
    }
}
