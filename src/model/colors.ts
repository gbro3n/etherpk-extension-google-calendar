/**
 * Calendar and event colours, as Google Calendar's web app shows them.
 *
 * Google's API still describes colours with the older pastel palette (`colors.get`, and a calendar
 * list entry's `backgroundColor`), while Google Calendar's web app has shown a stronger "modern"
 * palette under the same ids and names for years. The extension shows the modern colours, so the
 * calendar a person knows as Peacock looks the same here as in Google Calendar.
 *
 * Sources, checked on 12 October 2026:
 * - Event ids to names: Google's Apps Script `EventColor` enum, which names each id as the Calendar
 *   UI does (https://developers.google.com/apps-script/reference/calendar/event-color).
 * - Both palettes, classic and modern hex by id: the gcsa library's colour reference
 *   (https://google-calendar-simple-api.readthedocs.io/en/latest/colors.html), which agrees with
 *   https://calpalette.com/google-calendar-hex-codes and with the API's own classic values in
 *   https://gist.github.com/ansaso/accaddab0892a3b47d5f4884fda0468b. Google publishes no hex values
 *   for the modern palette, so these are as observed in its web app by those sources.
 * - Calendar colour 21 is Radicchio in current lists. The older gist calls it Beetroot.
 *
 * Since June 2026 an event can carry a label instead, with its own colour from 24 defaults or a
 * custom one (https://developers.google.com/workspace/calendar/api/guides/labels). A label's colour
 * comes with the label, so it needs no palette here.
 */
import type { CalendarEvent, CalendarListEntry, EventLabel } from '../google/types'

/** The 11 event colours by `colorId`, in the modern palette. */
export const EVENT_COLORS: Record<string, { name: string; background: string }> = {
    '1': { name: 'Lavender', background: '#7986cb' },
    '2': { name: 'Sage', background: '#33b679' },
    '3': { name: 'Grape', background: '#8e24aa' },
    '4': { name: 'Flamingo', background: '#e67c73' },
    '5': { name: 'Banana', background: '#f6bf26' },
    '6': { name: 'Tangerine', background: '#f4511e' },
    '7': { name: 'Peacock', background: '#039be5' },
    '8': { name: 'Graphite', background: '#616161' },
    '9': { name: 'Blueberry', background: '#3f51b5' },
    '10': { name: 'Basil', background: '#0b8043' },
    '11': { name: 'Tomato', background: '#d50000' },
}

/**
 * The 24 calendar colours in `colorId` order (id 1 first), each with the classic value the API
 * sends (`old`) and the modern value Google Calendar shows (`background`).
 */
export const CALENDAR_COLORS: { name: string; old: string; background: string }[] = [
    { name: 'Cocoa', old: '#ac725e', background: '#795548' },
    { name: 'Flamingo', old: '#d06b64', background: '#e67c73' },
    { name: 'Tomato', old: '#f83a22', background: '#d50000' },
    { name: 'Tangerine', old: '#fa573c', background: '#f4511e' },
    { name: 'Pumpkin', old: '#ff7537', background: '#ef6c00' },
    { name: 'Mango', old: '#ffad46', background: '#f09300' },
    { name: 'Eucalyptus', old: '#42d692', background: '#009688' },
    { name: 'Basil', old: '#16a765', background: '#0b8043' },
    { name: 'Pistachio', old: '#7bd148', background: '#7cb342' },
    { name: 'Avocado', old: '#b3dc6c', background: '#c0ca33' },
    { name: 'Citron', old: '#fbe983', background: '#e4c441' },
    { name: 'Banana', old: '#fad165', background: '#f6bf26' },
    { name: 'Sage', old: '#92e1c0', background: '#33b679' },
    { name: 'Peacock', old: '#9fe1e7', background: '#039be5' },
    { name: 'Cobalt', old: '#9fc6e7', background: '#4285f4' },
    { name: 'Blueberry', old: '#4986e7', background: '#3f51b5' },
    { name: 'Lavender', old: '#9a9cff', background: '#7986cb' },
    { name: 'Wisteria', old: '#b99aff', background: '#b39ddb' },
    { name: 'Graphite', old: '#c2c2c2', background: '#616161' },
    { name: 'Birch', old: '#cabdbf', background: '#a79b8e' },
    { name: 'Radicchio', old: '#cca6ac', background: '#ad1457' },
    { name: 'Cherry Blossom', old: '#f691b2', background: '#d81b60' },
    { name: 'Grape', old: '#cd74e6', background: '#8e24aa' },
    { name: 'Amethyst', old: '#a47ae2', background: '#9e69af' },
]

/** Google Calendar's default colour for a new calendar, used when an entry names none. */
const PEACOCK = '#039be5'

/** The modern colour for each classic calendar value. */
const MODERN_BY_OLD = new Map(CALENDAR_COLORS.map((color) => [color.old, color.background]))

/** `#rgb` or `#rrggbb`, in any case, as lower-case `#rrggbb`, or null for anything else. */
function normaliseHex(color: string): string | null {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
    if (!match) return null
    const digits = match[1].toLowerCase()
    return digits.length === 3 ? `#${[...digits].map((digit) => digit + digit).join('')}` : `#${digits}`
}

/**
 * A calendar's colour as Google Calendar shows it. A classic palette value becomes its modern
 * colour. Any other value is a colour the person picked themselves and is kept as it is. With no
 * value, the `colorId` gives the colour, and with neither the calendar is Peacock.
 */
export function calendarColor(entry: Pick<CalendarListEntry, 'backgroundColor' | 'colorId'>): string {
    if (entry.backgroundColor) {
        const normal = normaliseHex(entry.backgroundColor)
        return (normal && MODERN_BY_OLD.get(normal)) || entry.backgroundColor
    }
    const byId = entry.colorId ? CALENDAR_COLORS[Number(entry.colorId) - 1] : undefined
    return byId?.background ?? PEACOCK
}

/**
 * A label's colour. Google's labels guide names the field `backgroundColor`, while the extension's
 * `EventLabel` type calls it `color`, so both are read until the two agree.
 */
function labelColor(label: EventLabel): string | undefined {
    return label.color ?? (label as { backgroundColor?: string }).backgroundColor
}

/**
 * An event's colour: its label's colour where the event has a label the calendar defines, else its
 * own `colorId` in the modern palette, else its calendar's colour. A label comes first because
 * Google sends both on an event coloured from the defaults, and only the label on a custom colour.
 */
export function eventColor(event: Pick<CalendarEvent, 'colorId' | 'eventLabelId'>, calendarBackground: string, labels?: readonly EventLabel[]): string {
    if (event.eventLabelId && labels) {
        const label = labels.find((candidate) => candidate.id === event.eventLabelId)
        const color = label ? labelColor(label) : undefined
        if (color) return color
    }
    const byId = event.colorId ? EVENT_COLORS[event.colorId] : undefined
    return byId?.background ?? calendarBackground
}

/** WCAG 2 relative luminance of a colour, or NaN for a value that is not `#rgb` or `#rrggbb`. */
function relativeLuminance(color: string): number {
    const hex = normaliseHex(color)
    if (!hex) return Number.NaN
    const [red, green, blue] = [1, 3, 5].map((start) => {
        const channel = parseInt(hex.slice(start, start + 2), 16) / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

/** The WCAG 2 contrast ratio of two colours, from 1 to 21, or NaN where either cannot be read. */
export function contrastRatio(a: string, b: string): number {
    const first = relativeLuminance(a)
    const second = relativeLuminance(b)
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

const LIGHT_TEXT = '#ffffff'
const DARK_TEXT = '#1f1f1f'

/**
 * The text colour for a background: white or near-black, whichever contrasts more. A background
 * that cannot be read gets near-black.
 */
export function textColorOn(background: string): string {
    return contrastRatio(background, LIGHT_TEXT) > contrastRatio(background, DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT
}
