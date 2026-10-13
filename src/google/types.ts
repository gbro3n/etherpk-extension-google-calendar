/**
 * The parts of Google's Calendar, Drive and Tasks resources the extension reads and writes, as the
 * APIs send them (https://developers.google.com/workspace/calendar/api/v3/reference). Only the
 * fields the extension uses are named; Google sends more, and a resource read and written back
 * keeps every field it came with, because writes are `patch`es of the fields that changed.
 */

/** A date-time as Google writes an event's start or end. An all-day event has `date` alone. */
export interface EventDateTime {
    /** `YYYY-MM-DD`, for an all-day event. Its end is the day after the last day. */
    date?: string
    /** RFC 3339 with an offset, for a timed event. */
    dateTime?: string
    /** An IANA time zone name, such as `Europe/London`. Required for a repeating event. */
    timeZone?: string
}

export interface EventAttendee {
    email: string
    displayName?: string
    /** The person signed in, among the guests. */
    self?: boolean
    organizer?: boolean
    /** A room or other resource. */
    resource?: boolean
    optional?: boolean
    responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted'
    comment?: string
    additionalGuests?: number
}

export interface EventReminderOverride {
    method: 'email' | 'popup'
    /** Minutes before the start, 0 to 40320. For an all-day event, before midnight at its start. */
    minutes: number
}

export interface EventAttachment {
    fileUrl: string
    title?: string
    mimeType?: string
    iconLink?: string
    fileId?: string
}

export interface ConferenceEntryPoint {
    entryPointType: 'video' | 'phone' | 'sip' | 'more'
    uri: string
    label?: string
    pin?: string
}

export interface ConferenceData {
    createRequest?: {
        requestId: string
        conferenceSolutionKey: { type: 'hangoutsMeet' | 'eventHangout' | 'eventNamedHangout' | 'addOn' }
        status?: { statusCode: 'pending' | 'success' | 'failure' }
    }
    entryPoints?: ConferenceEntryPoint[]
    conferenceSolution?: { key: { type: string }; name?: string; iconUri?: string }
    conferenceId?: string
}

export type EventType = 'default' | 'outOfOffice' | 'focusTime' | 'workingLocation' | 'birthday' | 'fromGmail'

export interface CalendarEvent {
    id: string
    /** Changes with every change to the event: sent as `If-Match` so a newer change is never overwritten. */
    etag: string
    status?: 'confirmed' | 'tentative' | 'cancelled'
    htmlLink?: string
    summary?: string
    /** HTML, as Google Calendar's editor writes it. */
    description?: string
    location?: string
    /** `1` to `11`, a key into the event palette (`colors.get`). */
    colorId?: string
    /** The event's label, where the calendar uses labels (`eventLabelVersion=1`). */
    eventLabelId?: string
    start: EventDateTime
    end: EventDateTime
    /** RRULE, EXRULE, RDATE and EXDATE lines, on the series itself only. */
    recurrence?: string[]
    /** On one occurrence of a series: the series' id. */
    recurringEventId?: string
    /** On one occurrence of a series: when it would have started had it not been moved. */
    originalStartTime?: EventDateTime
    transparency?: 'opaque' | 'transparent'
    visibility?: 'default' | 'public' | 'private' | 'confidential'
    attendees?: EventAttendee[]
    attendeesOmitted?: boolean
    organizer?: { email?: string; displayName?: string; self?: boolean }
    creator?: { email?: string; displayName?: string; self?: boolean }
    guestsCanModify?: boolean
    guestsCanInviteOthers?: boolean
    guestsCanSeeOtherGuests?: boolean
    reminders?: { useDefault: boolean; overrides?: EventReminderOverride[] }
    attachments?: EventAttachment[]
    conferenceData?: ConferenceData
    hangoutLink?: string
    eventType?: EventType
    /** Out of office: whether invitations are declined meanwhile, and with what message. */
    outOfOfficeProperties?: { autoDeclineMode?: string; declineMessage?: string }
    focusTimeProperties?: { autoDeclineMode?: string; declineMessage?: string; chatStatus?: string }
    workingLocationProperties?: {
        type?: 'homeOffice' | 'officeLocation' | 'customLocation'
        homeOffice?: Record<string, never>
        officeLocation?: { label?: string; buildingId?: string }
        customLocation?: { label?: string }
    }
    /** The event can't be changed through this account (another's copy, or a read-only calendar). */
    locked?: boolean
    privateCopy?: boolean
    updated?: string
    created?: string
}

/** One calendar in the person's list, as `calendarList.list` gives it. */
export interface CalendarListEntry {
    id: string
    etag?: string
    summary: string
    /** The person's own name for the calendar, which Google Calendar shows in place of `summary`. */
    summaryOverride?: string
    description?: string
    timeZone?: string
    /** The colour the person chose, which supersedes `colorId`. */
    backgroundColor?: string
    foregroundColor?: string
    colorId?: string
    /** Ticked in Google Calendar's list. */
    selected?: boolean
    /** Taken out of Google Calendar's list altogether. Listed only with `showHidden`. */
    hidden?: boolean
    primary?: boolean
    accessRole: 'freeBusyReader' | 'reader' | 'writer' | 'owner' | 'writerWithoutPrivateAccess'
    defaultReminders?: EventReminderOverride[]
    conferenceProperties?: { allowedConferenceSolutionTypes?: string[] }
    deleted?: boolean
}

/** Google's two palettes, by colour id: one for calendars, one for events. */
export interface ColorPalettes {
    calendar: Record<string, { background: string; foreground: string }>
    event: Record<string, { background: string; foreground: string }>
}

/** The person's Google Calendar settings the extension follows, by their setting ids. */
export interface CalendarSettings {
    /** `0` Sunday to `6` Saturday. */
    weekStart?: string
    /** `'true'` or `'false'`. */
    format24HourTime?: string
    timezone?: string
    /** `'true'` or `'false'`. */
    showDeclinedEvents?: string
    hideWeekends?: string
    defaultEventLength?: string
    locale?: string
}

/**
 * An event label a calendar defines (July 2026), where it uses labels. `listLabels` makes it from
 * Google's own shape, `CalendarLabel`.
 */
export interface EventLabel {
    id: string
    /** Empty when the calendar's owner gave the label no name. */
    name: string
    /** The label's colour, `#rrggbb`. */
    color?: string
}

/** An event label as `calendars.get` gives it, in `labelProperties.eventLabels`. */
export interface CalendarLabel {
    /** A UUID. */
    id: string
    /** Hexadecimal, such as `#039be5`. */
    backgroundColor?: string
    /** At most 50 characters, and optional. */
    name?: string
}

/** A calendar's own resource, as `calendars.get` gives it. Only its labels are read. */
export interface CalendarResource {
    id?: string
    summary?: string
    timeZone?: string
    labelProperties?: { eventLabels?: CalendarLabel[] }
}

/** One calendar's busy times, as `freeBusy.query` gives them. */
export interface FreeBusyCalendar {
    /** RFC 3339 start and end of each busy period. */
    busy: { start: string; end: string }[]
    /** Why the calendar's times could not be read, such as `notFound`. */
    errors?: { domain?: string; reason?: string }[]
}

/** A Google Tasks list. */
export interface TaskList {
    id: string
    title: string
    updated?: string
}

/** A Google Task. Tasks carry a date and no time: `due` is midnight UTC of that date. */
export interface Task {
    id: string
    etag?: string
    title: string
    notes?: string
    status: 'needsAction' | 'completed'
    /** RFC 3339, the date at midnight UTC. */
    due?: string
    completed?: string
    deleted?: boolean
    hidden?: boolean
    parent?: string
    position?: string
    webViewLink?: string
}

/** A file the extension put in the person's Google Drive, to attach to an event. */
export interface DriveFile {
    id: string
    name: string
    mimeType: string
    webViewLink: string
    iconLink?: string
}

/** What a refused request to Google said, as `GoogleError` carries it. */
export interface GoogleErrorBody {
    code?: number
    message?: string
    status?: string
    errors?: { reason?: string; message?: string; domain?: string }[]
}
