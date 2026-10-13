/**
 * Repeat rules, as Google keeps them on a series: an `RRULE` line from RFC 5545, beside any
 * `EXDATE`, `RDATE` and `EXRULE` lines.
 *
 * The extension reads and writes the part of RRULE that Google Calendar's own repeat menu and custom
 * repeat dialog produce: a frequency, an interval, weekdays (with an ordinal for "the second
 * Tuesday"), days of the month, months, and an end by count or date. A rule with anything else is
 * marked `unsupported` and written back exactly as it was read, so the extension never changes a
 * rule it does not understand.
 */

export type RepeatFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export interface RepeatRule {
    freq: RepeatFrequency
    /** Every how many days, weeks, months or years. 1 for every one. */
    interval: number
    /** Weekday codes, with an optional ordinal in a monthly or yearly rule: `MO`, `2TU`, `-1FR`. */
    byDay?: string[]
    /** Days of the month, 1 to 31, or -1 to -31 counting back from the last. */
    byMonthDay?: number[]
    /** Months, 1 to 12. */
    byMonth?: number[]
    /** How many times the event happens in all. */
    count?: number
    /** The last moment the series may start: `YYYYMMDD`, or `YYYYMMDDTHHMMSSZ` in UTC. */
    until?: string
    /** The weekday a week starts on, which matters to a rule every two weeks or more. */
    weekStart?: string
    /**
     * The rule has parts this module does not model (`BYSETPOS`, `BYHOUR` and the like), more than
     * one RRULE, or a frequency other than the four above. Its fields are a best reading only, and
     * `source` is written back in place of them.
     */
    unsupported?: boolean
    /** The RRULE line as read. Set on an unsupported rule only. */
    source?: string
}

const FREQUENCIES: readonly RepeatFrequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']

/** RFC 5545 weekday codes, in `Date.getDay()` order. */
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

/** Monday to Friday, as Google's "Every weekday" writes them. */
const WORKING_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR']

const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth']

const BY_DAY_PATTERN = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/
const UNTIL_PATTERN = /^\d{8}(T\d{6}Z?)?$/

/** A rule part that holds a whole number, within the bounds it allows. */
function readInteger(value: string, min: number, max: number): number | null {
    if (!/^[+-]?\d+$/.test(value)) return null
    const number = Number(value)
    return number >= min && number <= max ? number : null
}

/** A comma list of whole numbers. Zero is never valid in RRULE, so it fails the whole list. */
function readIntegerList(value: string, min: number, max: number): number[] | null {
    const numbers: number[] = []
    for (const item of value.split(',')) {
        const number = readInteger(item, min, max)
        if (number === null || number === 0) return null
        numbers.push(number)
    }
    return numbers
}

/** A comma list of weekday codes, each with an optional ordinal. A `+` on an ordinal is dropped. */
function readByDay(value: string): string[] | null {
    const days: string[] = []
    for (const item of value.split(',')) {
        const match = BY_DAY_PATTERN.exec(item)
        if (!match) return null
        const ordinal = match[1] === undefined ? '' : String(Number(match[1]))
        if (ordinal === '0' || Math.abs(Number(ordinal)) > 53) return null
        days.push(`${ordinal}${match[2]}`)
    }
    return days
}

/**
 * Reads one RRULE line. Every part is read where it can be. A part this module does not model, a
 * repeated part, or a value it cannot read marks the rule unsupported and keeps the line as it was.
 */
function parseRule(line: string): RepeatRule {
    const rule: RepeatRule = { freq: 'DAILY', interval: 1 }
    let unsupported = false
    let frequencySeen = false
    const seen = new Set<string>()
    for (const part of line.slice(line.indexOf(':') + 1).split(';')) {
        if (part === '') continue
        const equals = part.indexOf('=')
        const key = (equals < 0 ? part : part.slice(0, equals)).toUpperCase()
        const value = equals < 0 ? '' : part.slice(equals + 1).toUpperCase()
        if (seen.has(key)) {
            unsupported = true
            continue
        }
        seen.add(key)
        switch (key) {
            case 'FREQ':
                if ((FREQUENCIES as readonly string[]).includes(value)) {
                    rule.freq = value as RepeatFrequency
                    frequencySeen = true
                }
                break
            case 'INTERVAL': {
                const interval = readInteger(value, 1, Number.MAX_SAFE_INTEGER)
                if (interval === null) unsupported = true
                else rule.interval = interval
                break
            }
            case 'BYDAY': {
                const days = readByDay(value)
                if (days === null) unsupported = true
                else rule.byDay = days
                break
            }
            case 'BYMONTHDAY': {
                const days = readIntegerList(value, -31, 31)
                if (days === null) unsupported = true
                else rule.byMonthDay = days
                break
            }
            case 'BYMONTH': {
                const months = readIntegerList(value, 1, 12)
                if (months === null) unsupported = true
                else rule.byMonth = months
                break
            }
            case 'COUNT': {
                const count = readInteger(value, 1, Number.MAX_SAFE_INTEGER)
                if (count === null) unsupported = true
                else rule.count = count
                break
            }
            case 'UNTIL':
                if (UNTIL_PATTERN.test(value)) rule.until = value
                else unsupported = true
                break
            case 'WKST':
                if ((WEEKDAY_CODES as readonly string[]).includes(value)) rule.weekStart = value
                else unsupported = true
                break
            default:
                unsupported = true
        }
    }
    if (!frequencySeen) unsupported = true
    if (unsupported) {
        rule.unsupported = true
        rule.source = line
    }
    return rule
}

function isRuleLine(line: string): boolean {
    return /^RRULE[:;]/i.test(line)
}

/**
 * Splits a series' recurrence lines into its repeat rule and every other line. The other lines
 * (`EXDATE`, `RDATE`, `EXRULE`) are kept as they were. A series with more than one RRULE keeps the
 * first as its rule, marked unsupported, and the rest among the other lines.
 */
export function parseRecurrence(lines: readonly string[] | undefined): { rule: RepeatRule | null; others: string[] } {
    let rule: RepeatRule | null = null
    let ruleLine = ''
    const others: string[] = []
    for (const raw of lines ?? []) {
        const line = raw.trim()
        if (line === '') continue
        if (isRuleLine(line) && rule === null) {
            rule = parseRule(line)
            ruleLine = line
            continue
        }
        if (isRuleLine(line) && rule !== null) rule = { ...rule, unsupported: true, source: ruleLine }
        others.push(line)
    }
    return { rule, others }
}

/** Google's recurrence lines for a rule and the other lines that go with it, the RRULE first. */
export function formatRecurrence(rule: RepeatRule, others: readonly string[] = []): string[] {
    if (rule.unsupported && rule.source) return [rule.source, ...others]
    const parts = [`FREQ=${rule.freq}`]
    const interval = Math.max(1, Math.round(rule.interval || 1))
    if (interval > 1) parts.push(`INTERVAL=${interval}`)
    if (rule.byMonth?.length) parts.push(`BYMONTH=${rule.byMonth.join(',')}`)
    if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`)
    if (rule.byDay?.length) parts.push(`BYDAY=${rule.byDay.join(',')}`)
    if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`)
    if (rule.until) parts.push(`UNTIL=${rule.until}`)
    if (rule.weekStart) parts.push(`WKST=${rule.weekStart}`)
    return [`RRULE:${parts.join(';')}`, ...others]
}

/**
 * An unsupported rule's source line with some parts set and others taken out, every other part kept
 * in its place. This is how the series edits below reach a rule the module cannot rebuild.
 */
function rewriteSource(source: string, set: Record<string, string>, remove: readonly string[]): string {
    const colon = source.indexOf(':')
    const head = source.slice(0, colon + 1)
    const pending = new Map(Object.entries(set))
    const parts: string[] = []
    for (const part of source.slice(colon + 1).split(';')) {
        if (part === '') continue
        const key = part.split('=')[0].toUpperCase()
        if (remove.includes(key)) continue
        const replacement = pending.get(key)
        if (replacement === undefined) {
            parts.push(part)
            continue
        }
        parts.push(`${key}=${replacement}`)
        pending.delete(key)
    }
    for (const [key, value] of pending) parts.push(`${key}=${value}`)
    return `${head}${parts.join(';')}`
}

function weekdayCode(date: Date): string {
    return WEEKDAY_CODES[date.getDay()]
}

/** Which of its weekday in the month a date is: the 8th to the 14th is the second, and so on. */
function nthInMonth(date: Date): number {
    return Math.ceil(date.getDate() / 7)
}

function daysInMonth(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
}

/** Whether a date is the last of its weekday in its month, being in the month's last seven days. */
function isInLastWeek(date: Date): boolean {
    return date.getDate() + 7 > daysInMonth(date)
}

/** A day in the first week of 2024, which began on a Monday, for each weekday code. */
function sampleDay(code: string): Date {
    const offset = (WEEKDAY_CODES.indexOf(code as (typeof WEEKDAY_CODES)[number]) + 6) % 7
    return new Date(2024, 0, 1 + offset)
}

function weekdayName(code: string, locale: string): string {
    return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(sampleDay(code))
}

/** `Garden`, `Garden and Kitchen`, `Garden, Kitchen and Shed`. */
function listWords(words: readonly string[], conjunction = 'and'): string {
    if (words.length <= 1) return words.join('')
    return `${words.slice(0, -1).join(', ')} ${conjunction} ${words[words.length - 1]}`
}

export type RepeatPresetId = 'none' | 'daily' | 'weekly' | 'monthly-nth' | 'monthly-last' | 'yearly' | 'weekdays'

export interface RepeatPreset {
    id: RepeatPresetId
    label: string
    rule: RepeatRule | null
}

/**
 * The choices Google Calendar's repeat menu offers for an event that starts on `start`, in its
 * order. "Monthly on the first to fourth weekday" is offered from the first four weeks of a month,
 * and "Monthly on the last weekday" from its last seven days, so a date can offer both. Weekday and
 * month names come from `Intl` in the given locale. The words around them are English.
 */
export function repeatPresets(start: Date, locale = 'en-GB'): RepeatPreset[] {
    const day = weekdayCode(start)
    const dayName = weekdayName(day, locale)
    const nth = nthInMonth(start)
    const presets: RepeatPreset[] = [
        { id: 'none', label: 'Does not repeat', rule: null },
        { id: 'daily', label: 'Daily', rule: { freq: 'DAILY', interval: 1 } },
        { id: 'weekly', label: `Weekly on ${dayName}`, rule: { freq: 'WEEKLY', interval: 1, byDay: [day] } },
    ]
    if (nth <= 4) {
        presets.push({ id: 'monthly-nth', label: `Monthly on the ${ORDINAL_WORDS[nth - 1]} ${dayName}`, rule: { freq: 'MONTHLY', interval: 1, byDay: [`${nth}${day}`] } })
    }
    if (isInLastWeek(start)) {
        presets.push({ id: 'monthly-last', label: `Monthly on the last ${dayName}`, rule: { freq: 'MONTHLY', interval: 1, byDay: [`-1${day}`] } })
    }
    const monthDay = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(start)
    presets.push({ id: 'yearly', label: `Annually on ${monthDay}`, rule: { freq: 'YEARLY', interval: 1 } })
    presets.push({
        id: 'weekdays',
        label: `Every weekday (${weekdayName('MO', locale)} to ${weekdayName('FR', locale)})`,
        rule: { freq: 'WEEKLY', interval: 1, byDay: [...WORKING_DAYS] },
    })
    return presets
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && b.every((item) => a.includes(item))
}

/**
 * Which repeat menu choice a rule is, for a series that starts on `start`, or `custom` when it is
 * none of them. Google writes some choices in more than one way (`FREQ=WEEKLY` alone repeats on the
 * start's weekday, the same as naming it), so each is matched by meaning rather than by text.
 */
export function presetFor(rule: RepeatRule | null, start: Date): RepeatPresetId | 'custom' {
    if (rule === null) return 'none'
    if (rule.unsupported || rule.interval !== 1 || rule.count !== undefined || rule.until !== undefined) return 'custom'
    const byDay = rule.byDay ?? []
    const byMonth = rule.byMonth ?? []
    const byMonthDay = rule.byMonthDay ?? []
    const day = weekdayCode(start)
    switch (rule.freq) {
        case 'DAILY':
            return byDay.length === 0 && byMonth.length === 0 && byMonthDay.length === 0 ? 'daily' : 'custom'
        case 'WEEKLY':
            if (byMonth.length > 0 || byMonthDay.length > 0) return 'custom'
            if (byDay.length === 0 || sameSet(byDay, [day])) return 'weekly'
            return sameSet(byDay, WORKING_DAYS) ? 'weekdays' : 'custom'
        case 'MONTHLY': {
            if (byMonth.length > 0 || byMonthDay.length > 0 || byDay.length !== 1) return 'custom'
            const nth = nthInMonth(start)
            if (nth <= 4 && byDay[0] === `${nth}${day}`) return 'monthly-nth'
            if (isInLastWeek(start) && byDay[0] === `-1${day}`) return 'monthly-last'
            return 'custom'
        }
        case 'YEARLY': {
            const sameMonth = byMonth.length === 0 || (byMonth.length === 1 && byMonth[0] === start.getMonth() + 1)
            const sameDay = byMonthDay.length === 0 || (byMonthDay.length === 1 && byMonthDay[0] === start.getDate())
            return byDay.length === 0 && sameMonth && sameDay ? 'yearly' : 'custom'
        }
    }
}

/** `second Tuesday`, `last Friday`, `second to last Monday`. A code with no ordinal is `every Monday`. */
function ordinalWeekday(code: string, locale: string): string {
    const match = BY_DAY_PATTERN.exec(code)
    if (!match) return code
    const name = weekdayName(match[2], locale)
    if (match[1] === undefined) return `every ${name}`
    const ordinal = Number(match[1])
    if (ordinal === -1) return `the last ${name}`
    if (ordinal < 0) return `the ${ordinalWord(-ordinal)} to last ${name}`
    return `the ${ordinalWord(ordinal)} ${name}`
}

function ordinalWord(n: number): string {
    if (n <= ORDINAL_WORDS.length) return ORDINAL_WORDS[n - 1]
    const lastTwo = n % 100
    const suffix = lastTwo >= 11 && lastTwo <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
    return `${n}${suffix}`
}

/** `day 12`, `days 1 and 15`, `the last day`. */
function monthDayWords(days: readonly number[]): string {
    const counted = days.filter((day) => day > 0)
    const fromEnd = days.filter((day) => day < 0).map((day) => (day === -1 ? 'the last day' : `the ${ordinalWord(-day)} to last day`))
    const phrases = counted.length === 0 ? [] : [`${counted.length === 1 ? 'day' : 'days'} ${listWords(counted.map(String))}`]
    return listWords([...phrases, ...fromEnd])
}

/** Weekday names in week order from Monday, so a rule reads the same however it was written. */
function weekdayNames(codes: readonly string[], locale: string): string {
    const order = (code: string): number => (WEEKDAY_CODES.indexOf(code as (typeof WEEKDAY_CODES)[number]) + 6) % 7
    return listWords([...codes].sort((a, b) => order(a) - order(b)).map((code) => weekdayName(code, locale)))
}

/** An UNTIL value as the local date it ends on. A UTC time is read in the local zone. */
function untilDate(until: string): Date {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(until)
    if (!match) return new Date(Number.NaN)
    const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
    if (match[4] === undefined) return new Date(year, month, day)
    const [hour, minute, second] = [Number(match[4]), Number(match[5]), Number(match[6])]
    return match[7] === 'Z' ? new Date(Date.UTC(year, month, day, hour, minute, second)) : new Date(year, month, day, hour, minute, second)
}

const UNIT_WORDS: Record<RepeatFrequency, string> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }
const ADVERBS: Record<RepeatFrequency, string> = { DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Annually' }

/** The words after the frequency: which days, for a rule that names them or takes them from the start. */
function describeDays(rule: RepeatRule, start: Date, locale: string): string {
    const byDay = rule.byDay ?? []
    const byMonthDay = rule.byMonthDay ?? []
    switch (rule.freq) {
        case 'DAILY':
            return byDay.length > 0 ? ` on ${weekdayNames(byDay, locale)}` : ''
        case 'WEEKLY': {
            const days = byDay.length > 0 ? byDay : [weekdayCode(start)]
            if (sameSet(days, WORKING_DAYS)) return ' on weekdays'
            return ` on ${weekdayNames(days, locale)}`
        }
        case 'MONTHLY': {
            if (byDay.length > 0 && byMonthDay.length > 0) {
                return ` on ${monthDayWords(byMonthDay)}, when that is a ${listWords(byDay.map((code) => weekdayName(code.slice(-2), locale)), 'or')}`
            }
            if (byDay.length > 0) return ` on ${listWords(byDay.map((code) => ordinalWeekday(code, locale)))}`
            return ` on ${monthDayWords(byMonthDay.length > 0 ? byMonthDay : [start.getDate()])}`
        }
        case 'YEARLY': {
            const months = rule.byMonth?.length ? rule.byMonth : [start.getMonth() + 1]
            const monthNames = listWords(months.map((month) => new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(2024, month - 1, 1))))
            if (byDay.length > 0) return ` on ${listWords(byDay.map((code) => ordinalWeekday(code, locale)))} of ${monthNames}`
            const days = byMonthDay.length > 0 ? byMonthDay : [start.getDate()]
            if (days.some((day) => day < 0)) return ` on ${monthDayWords(days)} of ${monthNames}`
            // 2024 is a leap year, so 29 February has a date to format.
            const format = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' })
            return ` on ${listWords(months.flatMap((month) => days.map((day) => format.format(new Date(2024, month - 1, day)))))}`
        }
    }
}

/**
 * A rule in plain words, for an event's details: `Weekly on Monday`, `Every 2 weeks on Monday and
 * Wednesday`, `Monthly on day 12, 5 times`, `Daily, until 1 December 2026`. An unsupported rule is
 * described as one set in Google Calendar, since a partial reading of it could mislead.
 */
export function describeRule(rule: RepeatRule, start: Date, locale = 'en-GB'): string {
    if (rule.unsupported) return 'Custom rule set in Google Calendar'
    const interval = Math.max(1, Math.round(rule.interval || 1))
    let text = interval > 1 ? `Every ${interval} ${UNIT_WORDS[rule.freq]}s` : ADVERBS[rule.freq]
    text += describeDays(rule, start, locale)
    if (rule.count !== undefined) text += rule.count === 1 ? ', once' : `, ${rule.count} times`
    if (rule.until) {
        const until = untilDate(rule.until)
        if (!Number.isNaN(until.getTime())) {
            text += `, until ${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(until)}`
        }
    }
    return text
}

function pad2(value: number): string {
    return String(value).padStart(2, '0')
}

/** `YYYYMMDD` for the local day a date falls on. */
function compactLocalDate(date: Date): string {
    return `${String(date.getFullYear()).padStart(4, '0')}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
}

/** `YYYYMMDDTHHMMSSZ` for a moment in UTC. */
function compactUtc(date: Date): string {
    const day = `${String(date.getUTCFullYear()).padStart(4, '0')}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`
    return `${day}T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`
}

/**
 * The old series' rule when one occurrence and those after it become a series of their own: it ends
 * just before that occurrence. RFC 5545 needs UNTIL to match the series' start, so an all-day series
 * ends on the day before as a date, and a timed one a second before the occurrence, in UTC. UNTIL
 * replaces any COUNT, since a rule may not have both.
 */
export function endSeriesBefore(rule: RepeatRule, occurrenceStart: Date, allDay: boolean): RepeatRule {
    const until = allDay
        ? compactLocalDate(new Date(occurrenceStart.getFullYear(), occurrenceStart.getMonth(), occurrenceStart.getDate() - 1))
        : compactUtc(new Date(occurrenceStart.getTime() - 1000))
    const ended: RepeatRule = { ...rule, until }
    delete ended.count
    if (ended.unsupported && ended.source) ended.source = rewriteSource(ended.source, { UNTIL: until }, ['COUNT'])
    return ended
}

/**
 * The new series' rule for "this and following events". A series that ends after a number of times
 * keeps the times not yet used, and at least one. A series that ends on a date, or never, is
 * unchanged.
 */
export function continueSeriesFrom(rule: RepeatRule, occurrencesBefore: number): RepeatRule {
    if (rule.count === undefined) return { ...rule }
    const count = Math.max(1, rule.count - Math.max(0, occurrencesBefore))
    const continued: RepeatRule = { ...rule, count }
    if (continued.unsupported && continued.source) continued.source = rewriteSource(continued.source, { COUNT: String(count) }, [])
    return continued
}

/** The index of the first `:` outside double quotes, which ends a content line's name and parameters. */
function valueSeparator(line: string): number {
    let quoted = false
    for (let index = 0; index < line.length; index++) {
        const char = line[index]
        if (char === '"') quoted = !quoted
        else if (char === ':' && !quoted) return index
    }
    return -1
}

/** A line's parameters, such as `TZID` and `VALUE`, by upper-case name, quotes removed. */
function lineParameters(head: string): Map<string, string> {
    const parameters = new Map<string, string>()
    for (const part of head.split(';').slice(1)) {
        const equals = part.indexOf('=')
        if (equals < 0) continue
        parameters.set(part.slice(0, equals).toUpperCase(), part.slice(equals + 1).replace(/^"|"$/g, ''))
    }
    return parameters
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>()

/** How far a zone's wall clock is ahead of UTC at a moment, in milliseconds. */
function zoneOffset(instant: number, timeZone: string): number {
    let format = zoneFormats.get(timeZone)
    if (!format) {
        format = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
        })
        zoneFormats.set(timeZone, format)
    }
    const fields: Record<string, number> = {}
    for (const part of format.formatToParts(new Date(instant))) fields[part.type] = Number(part.value)
    const wall = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second)
    return wall - Math.floor(instant / 1000) * 1000
}

/**
 * The moment a wall-clock time in a named zone stands for. The zone's offset is read at a first
 * guess and then again at the corrected moment, which settles it on either side of a clock change.
 */
function zonedInstant(wall: number, timeZone: string): number {
    const guess = wall - zoneOffset(wall, timeZone)
    return wall - zoneOffset(guess, timeZone)
}

/**
 * The moment an EXDATE or RDATE value stands for: a DATE is local midnight, a DATE-TIME ending in Z
 * is UTC, one with a TZID is that zone's wall clock, and one with neither is local wall-clock time.
 * A PERIOD is read by its start. An unreadable value, or an unknown zone, gives NaN.
 */
function dateValueInstant(value: string, timeZone: string | undefined): number {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value.split('/')[0].trim().toUpperCase())
    if (!match) return Number.NaN
    const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
    if (match[4] === undefined) return new Date(year, month, day).getTime()
    const [hour, minute, second] = [Number(match[4]), Number(match[5]), Number(match[6])]
    if (match[7] === 'Z') return Date.UTC(year, month, day, hour, minute, second)
    if (timeZone) {
        try {
            return zonedInstant(Date.UTC(year, month, day, hour, minute, second), timeZone)
        } catch {
            return Number.NaN
        }
    }
    return new Date(year, month, day, hour, minute, second).getTime()
}

/**
 * Shares a series' other lines between the old series and the new one when it is split at `at`.
 * Each EXDATE and RDATE value before `at` stays with the old series and the rest move to the new
 * one, a line split in two where its values fall on both sides. A value that cannot be read stays
 * with the old series, unchanged. Any other line (an EXRULE) describes a pattern rather than dates,
 * so both series keep it.
 */
export function splitExceptions(others: readonly string[], at: Date): { before: string[]; after: string[] } {
    const before: string[] = []
    const after: string[] = []
    for (const line of others) {
        const separator = valueSeparator(line)
        const head = separator < 0 ? '' : line.slice(0, separator)
        const name = head.split(';')[0].toUpperCase()
        if (name !== 'EXDATE' && name !== 'RDATE') {
            before.push(line)
            after.push(line)
            continue
        }
        const timeZone = lineParameters(head).get('TZID')
        const early: string[] = []
        const late: string[] = []
        for (const value of line.slice(separator + 1).split(',')) {
            if (value.trim() === '') continue
            const instant = dateValueInstant(value, timeZone)
            if (Number.isNaN(instant) || instant < at.getTime()) early.push(value)
            else late.push(value)
        }
        if (early.length > 0) before.push(`${head}:${early.join(',')}`)
        if (late.length > 0) after.push(`${head}:${late.join(',')}`)
    }
    return { before, after }
}
