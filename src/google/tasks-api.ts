/**
 * The Google Tasks API calls the extension makes (https://developers.google.com/workspace/tasks/reference/rest),
 * over a `GoogleClient`. They need the `tasks` scope, which sign-in asks for with the calendar's.
 */
import { listAllPages, type GoogleClient } from './http'
import type { Task, TaskList } from './types'

export const TASKS_API = 'https://tasks.googleapis.com/tasks/v1'

/** Google Tasks on the web, as the account (`authuser`), where the browser is signed in to several. */
export function tasksWebUrl(email: string): string {
    return `https://tasks.google.com/?authuser=${encodeURIComponent(email)}`
}

function tasksPath(taskListId: string): string {
    return `${TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks`
}

function taskPath(taskListId: string, taskId: string): string {
    return `${tasksPath(taskListId)}/${encodeURIComponent(taskId)}`
}

export async function listTaskLists(client: GoogleClient, signal?: AbortSignal): Promise<TaskList[]> {
    return listAllPages<TaskList>(client, `${TASKS_API}/users/@me/lists`, { maxResults: 100 }, signal)
}

export interface TaskFilter {
    /** The earliest due date to list. */
    dueMin?: Date
    /** The latest due date to list. */
    dueMax?: Date
    /** Google's default is to include completed tasks. */
    showCompleted?: boolean
}

/**
 * A list's tasks, every page. Google Tasks' own apps hide a task once it is completed, and the API
 * then lists it only with `showHidden`, so completed tasks are asked for with both flags.
 */
export async function listTasks(client: GoogleClient, taskListId: string, filter: TaskFilter = {}, signal?: AbortSignal): Promise<Task[]> {
    const showCompleted = filter.showCompleted ?? true
    return listAllPages<Task>(
        client,
        tasksPath(taskListId),
        {
            dueMin: filter.dueMin?.toISOString(),
            dueMax: filter.dueMax?.toISOString(),
            showCompleted,
            showHidden: showCompleted,
            maxResults: 100,
        },
        signal,
    )
}

/** A change to a task: each field given is set, and a field given as null is cleared (a due date taken off). */
export type TaskPatch = { [Field in keyof Task]?: Task[Field] | null }

/** Add a task to a list, at the top, or beneath `parent` as its subtask. */
export async function insertTask(client: GoogleClient, taskListId: string, task: Partial<Task>, options: { parent?: string; signal?: AbortSignal } = {}): Promise<Task> {
    return client.request<Task>(tasksPath(taskListId), { method: 'POST', json: task, query: options.parent ? { parent: options.parent } : undefined, signal: options.signal })
}

export async function patchTask(
    client: GoogleClient,
    taskListId: string,
    taskId: string,
    patch: TaskPatch,
    options: { signal?: AbortSignal } = {},
): Promise<Task> {
    return client.request<Task>(taskPath(taskListId, taskId), { method: 'PATCH', json: patch, signal: options.signal })
}

export async function deleteTask(client: GoogleClient, taskListId: string, taskId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await client.request<void>(taskPath(taskListId, taskId), { method: 'DELETE', signal: options.signal })
}
