/**
 * Google Tasks as a list draws them: in Google's own order with each subtask beneath its parent, and
 * a task's due date in words beside it.
 */
import type { Task } from '../google/types'
import { parseIsoDay } from './time'

/** An item in list order, with how many levels in it sits (0 for a top-level task). */
export interface Placed<T> {
    item: T
    depth: number
}

/** Google's positions are fixed-length digit strings, so they compare as plain strings, not by locale. */
const comparePositions = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Tasks in the order Google Tasks lists them: siblings by `position`, and each task's subtasks right
 * after it, a level in. A subtask whose parent is not among the items (done, or in no shown list)
 * stands at the top level. Every item comes back once, even where malformed records name each other
 * as parents and so reach no top-level task: those follow at the top level.
 */
export function inListOrder<T>(items: readonly T[], taskOf: (item: T) => Task): Placed<T>[] {
    const ids = new Set(items.map((item) => taskOf(item).id))
    const children = new Map<string, T[]>()
    for (const item of items) {
        const parent = taskOf(item).parent
        const key = parent && ids.has(parent) ? parent : ''
        children.set(key, [...(children.get(key) ?? []), item])
    }
    const bySibling = (a: T, b: T) => comparePositions(taskOf(a).position ?? '', taskOf(b).position ?? '') || taskOf(a).title.localeCompare(taskOf(b).title)
    const out: Placed<T>[] = []
    const placed = new Set<T>()
    const visit = (key: string, depth: number) => {
        for (const item of [...(children.get(key) ?? [])].sort(bySibling)) {
            if (placed.has(item)) continue
            placed.add(item)
            out.push({ item, depth })
            visit(taskOf(item).id, depth + 1)
        }
    }
    visit('', 0)
    for (const item of items) {
        if (placed.has(item)) continue
        placed.add(item)
        out.push({ item, depth: 0 })
        visit(taskOf(item).id, 1)
    }
    return out
}

/**
 * A task's due date in words, for beside it in a list: "Due today", "Due 15 Oct", or "Was due 9 Oct"
 * once the day has passed (`overdue`). The year shows only when it is not this year's. Null for a
 * task with no due date. `due` is Google's midnight UTC of the date, so its date part is the day.
 */
export function dueWords(due: string | undefined, today: string, locale?: string): { text: string; overdue: boolean } | null {
    if (!due) return null
    const day = due.slice(0, 10)
    if (day === today) return { text: 'Due today', overdue: false }
    const date = parseIsoDay(day).toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }) })
    return day < today ? { text: `Was due ${date}`, overdue: true } : { text: `Due ${date}`, overdue: false }
}
