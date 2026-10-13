/**
 * A question with a few answers, such as which occurrences of a repeating event to change, and the
 * one asked now. `ChoiceDialog.svelte` draws the question; `ask` waits for its answer.
 */

export interface Choice<T> {
    title: string
    body?: string
    options: { value: T; label: string; primary?: boolean }[]
    /** The answer Escape and the backdrop give, which changes nothing. */
    cancelLabel?: string
}

/** One question asked, and how to answer it. */
export interface PendingChoice {
    choice: Choice<unknown>
    answer(value: unknown): void
}

/** Ask a question through `set`, resolving with the answer, or null when it was cancelled. */
export function ask<T>(set: (pending: PendingChoice | null) => void, choice: Choice<T>): Promise<T | null> {
    return new Promise((resolve) => {
        set({
            choice: choice as Choice<unknown>,
            answer(value) {
                set(null)
                resolve((value ?? null) as T | null)
            },
        })
    })
}
