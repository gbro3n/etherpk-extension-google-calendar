/**
 * Times when everyone is free, for Find a time: given each person's busy periods on a day, the
 * starts within working hours at which an event of the given length clashes with nobody, on the
 * half hour, as Google Calendar suggests them.
 */

export interface Busy {
    start: Date
    end: Date
}

export interface SlotQuery {
    /** The day, at local midnight. */
    day: Date
    /** How long the event is, in milliseconds. */
    length: number
    /** Everyone's busy periods together. */
    busy: readonly Busy[]
    /** Working hours, local: from 8:00 to 18:00 unless given. */
    from?: number
    to?: number
    /** Steps between suggested starts, in minutes. */
    step?: number
}

export function freeSlots(query: SlotQuery): Date[] {
    const { day, length, busy } = query
    const from = query.from ?? 8
    const to = query.to ?? 18
    const step = (query.step ?? 30) * 60 * 1000
    const slots: Date[] = []
    const first = new Date(day.getFullYear(), day.getMonth(), day.getDate(), from, 0, 0, 0).getTime()
    const last = new Date(day.getFullYear(), day.getMonth(), day.getDate(), to, 0, 0, 0).getTime()
    for (let start = first; start + length <= last; start += step) {
        const end = start + length
        const clash = busy.some((period) => period.start.getTime() < end && period.end.getTime() > start)
        if (!clash) slots.push(new Date(start))
    }
    return slots
}

/** Who is busy during a time, by the periods each person has. */
export function busyDuring(byPerson: ReadonlyMap<string, readonly Busy[]>, start: Date, end: Date): string[] {
    const clashing: string[] = []
    for (const [person, periods] of byPerson) {
        if (periods.some((period) => period.start < end && period.end > start)) clashing.push(person)
    }
    return clashing
}
