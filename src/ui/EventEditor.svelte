<script lang="ts" module>
    import type { EventSpan } from '../model/time'

    /** What the editor is open for: a new event over a span, or an event by its key. */
    export type EditorOpen = { mode: 'create'; span: EventSpan; calendar?: { account: string; calendarId: string } } | { mode: 'edit'; key: string }
</script>

<script lang="ts">
    /**
     * Creating or editing an event, with what Google Calendar's own editor offers: title, all day,
     * start and end with a time zone, repeat, calendar, colour or label, place, Google Meet, guests
     * and what they may do, notifications, busy or free, visibility, attachments and a formatted
     * description. Out of office, focus time and working location are offered on the main calendar
     * of a Google Workspace account, which is the only place Google has them.
     *
     * Saving asks what it needs first (which occurrences, whether to email guests), waits for Google,
     * and keeps the form as it is if Google refuses, saying why. Closing with changes not saved asks
     * first. Ctrl+Enter or Cmd+Enter saves.
     */
    import { untrack } from 'svelte'
    import { on } from 'svelte/events'

    import type { CalendarApp } from '../app/app.svelte'
    import type { EventChanges } from '../app/actions'
    import type { ShownEvent } from '../app/calendar-store.svelte'
    import { confirmChange, sendUpdatesChoice, type Ask } from '../app/prompts'
    import { getEvent } from '../google/calendar-api'
    import { attachmentFromDriveFile, fileIdFromDriveLink, uploadFile } from '../google/drive-api'
    import type { CalendarEvent, EventAttachment, EventAttendee, EventReminderOverride } from '../google/types'
    import { calendarColor, EVENT_COLORS } from '../model/colors'
    import { nodesFromEditable, parseDescription, serializeDescription } from '../model/description'
    import { formatRecurrence, parseRecurrence, presetFor, repeatPresets, type RepeatRule } from '../model/recurrence'
    import { addDays, isoDay, localTimeZone, parseIsoDay, toEventDateTime } from '../model/time'
    import Modal from './Modal.svelte'
    import RichText from './RichText.svelte'
    import { safeUrl } from './safe-url'
    import FindTime from './FindTime.svelte'
    import RepeatEditor from './RepeatEditor.svelte'

    let {
        app,
        open,
        ask,
        onclose,
    }: {
        app: CalendarApp
        open: EditorOpen | null
        ask: Ask
        onclose: () => void
    } = $props()

    const store = $derived(app.store)

    type ReminderRow = { method: 'popup' | 'email'; amount: number; unit: 'minutes' | 'hours' | 'days' | 'weeks' }
    const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440, weeks: 10080 } as const

    interface Draft {
        summary: string
        allDay: boolean
        startDate: string
        startTime: string
        endDate: string
        endTime: string
        timeZone: string
        repeat: string
        rule: RepeatRule | null
        others: string[]
        calendarKey: string
        colorId: string
        labelId: string
        location: string
        meet: 'none' | 'keep' | 'new'
        attendees: EventAttendee[]
        guestsCanModify: boolean
        guestsCanInviteOthers: boolean
        guestsCanSeeOtherGuests: boolean
        remindersDefault: boolean
        reminders: ReminderRow[]
        transparency: 'opaque' | 'transparent'
        visibility: 'default' | 'public' | 'private'
        attachments: EventAttachment[]
        eventType: 'default' | 'outOfOffice' | 'focusTime' | 'workingLocation'
    }

    const pad = (value: number) => String(value).padStart(2, '0')
    const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`
    const atTime = (day: string, time: string) => {
        const [hours, minutes] = time.split(':').map(Number)
        const date = parseIsoDay(day)
        date.setHours(hours, minutes, 0, 0)
        return date
    }

    function toRows(overrides: readonly EventReminderOverride[] | undefined): ReminderRow[] {
        return (overrides ?? []).map((reminder) => {
            const unit = reminder.minutes > 0 && reminder.minutes % 10080 === 0 ? 'weeks' : reminder.minutes > 0 && reminder.minutes % 1440 === 0 ? 'days' : reminder.minutes > 0 && reminder.minutes % 60 === 0 ? 'hours' : 'minutes'
            return { method: reminder.method, amount: reminder.minutes / UNIT_MINUTES[unit], unit }
        })
    }

    /** The event being edited, or null for a new one. */
    // Raw, so it stays the very event the store gave, which an identity check below relies on.
    let editing = $state.raw<ShownEvent | null>(null)
    let draft = $state<Draft | null>(null)
    /** The draft as it opened, to tell whether closing would lose anything. */
    let opened = ''
    /** The repeat rule as it opened, so a save sends one only when the person changed it. */
    let openedRepeat = ''
    const repeatOf = (form: Draft) => JSON.stringify(form.rule ? formatRecurrence(form.rule, form.others) : null)
    let descriptionRoot = $state<HTMLElement>()
    let initialDescription = $state('')
    let descriptionTouched = $state(false)
    let saving = $state(false)
    let error = $state<string | null>(null)
    let guestInput = $state('')
    let guestError = $state<string | null>(null)
    let linkInput = $state('')
    let uploads = $state<{ name: string; state: 'uploading' | 'failed'; message?: string }[]>([])
    let findingTime = $state(false)

    /** Move the event to a time Find a time offered, keeping its length. */
    function pickTime(start: Date) {
        if (!draft) return
        const length = atTime(draft.endDate, draft.endTime).getTime() - atTime(draft.startDate, draft.startTime).getTime()
        const end = new Date(start.getTime() + length)
        draft.startDate = isoDay(start)
        draft.startTime = clock(start)
        draft.endDate = isoDay(end)
        draft.endTime = clock(end)
    }

    const writable = $derived(
        store.accounts.flatMap((account) =>
            account.status === 'ready'
                ? account.calendars.filter((calendar) => calendar.accessRole === 'owner' || calendar.accessRole === 'writer').map((calendar) => ({ key: `${account.email}|${calendar.id}`, account: account.email, calendar }))
                : [],
        ),
    )
    const chosen = $derived(writable.find((option) => option.key === draft?.calendarKey))
    const labels = $derived(chosen ? (store.accounts.find((account) => account.email === chosen.account)?.labels[chosen.calendar.id] ?? []) : [])
    const workspace = $derived(chosen ? chosen.calendar.primary === true && !/@(gmail|googlemail)\.com$/i.test(chosen.account) : false)
    const presets = $derived(draft ? repeatPresets(draft.allDay ? parseIsoDay(draft.startDate) : atTime(draft.startDate, draft.startTime)) : [])
    const zones = (() => {
        try {
            return Intl.supportedValuesOf('timeZone')
        } catch {
            return [localTimeZone()]
        }
    })()

    function defaultCalendarKey(requested?: { account: string; calendarId: string }): string {
        if (requested) return `${requested.account}|${requested.calendarId}`
        const chosenDefault = app.records.defaultCalendar()
        const preferred = chosenDefault && writable.find((option) => option.account === chosenDefault.account && option.calendar.id === chosenDefault.calendarId)
        return (preferred ?? writable.find((option) => option.calendar.primary) ?? writable[0])?.key ?? ''
    }

    // Fill the form each time the editor opens, and only then: an account's calendars arriving
    // meanwhile must never reset what the person is typing.
    $effect(() => {
        const request = open
        untrack(() => fill(request))
    })

    function fill(request: EditorOpen | null) {
        if (!request) {
            draft = null
            editing = null
            return
        }
        error = null
        findingTime = false
        uploads = []
        guestInput = ''
        guestError = null
        descriptionTouched = false
        if (request.mode === 'create') {
            editing = null
            const { span } = request
            const endShown = span.allDay ? addDays(span.end, -1) : span.end
            const calendarKey = defaultCalendarKey(request.calendar)
            const defaults = writable.find((option) => option.key === calendarKey)?.calendar.defaultReminders
            draft = {
                summary: '',
                allDay: span.allDay,
                startDate: isoDay(span.start),
                startTime: span.allDay ? '09:00' : clock(span.start),
                endDate: isoDay(endShown),
                endTime: span.allDay ? '10:00' : clock(span.end),
                timeZone: localTimeZone(),
                repeat: 'none',
                rule: null,
                others: [],
                calendarKey,
                colorId: '',
                labelId: '',
                location: '',
                meet: 'none',
                attendees: [],
                guestsCanModify: false,
                guestsCanInviteOthers: true,
                guestsCanSeeOtherGuests: true,
                remindersDefault: true,
                reminders: toRows(defaults),
                transparency: span.allDay ? 'transparent' : 'opaque',
                visibility: 'default',
                attachments: [],
                eventType: 'default',
            }
            initialDescription = ''
        } else {
            const shown = store.find(request.key)
            if (!shown) {
                onclose()
                return
            }
            editing = shown
            const event = shown.event
            const endShown = shown.span.allDay ? addDays(shown.span.end, -1) : shown.span.end
            draft = {
                summary: event.summary ?? '',
                allDay: shown.span.allDay,
                startDate: isoDay(shown.span.start),
                startTime: shown.span.allDay ? '09:00' : clock(shown.span.start),
                endDate: isoDay(endShown),
                endTime: shown.span.allDay ? '10:00' : clock(shown.span.end),
                timeZone: event.start.timeZone ?? localTimeZone(),
                repeat: 'none',
                rule: null,
                others: [],
                calendarKey: `${shown.account}|${shown.calendar.id}`,
                colorId: event.colorId ?? '',
                labelId: event.eventLabelId ?? '',
                location: event.location ?? '',
                meet: event.conferenceData || event.hangoutLink ? 'keep' : 'none',
                // `optional` filled in, as the Optional box's binding would write it as the form opens.
                attendees: (event.attendees ?? []).map((attendee) => ({ ...attendee, optional: attendee.optional ?? false })),
                guestsCanModify: event.guestsCanModify ?? false,
                guestsCanInviteOthers: event.guestsCanInviteOthers ?? true,
                guestsCanSeeOtherGuests: event.guestsCanSeeOtherGuests ?? true,
                remindersDefault: event.reminders?.useDefault ?? true,
                reminders: toRows(event.reminders?.overrides),
                transparency: event.transparency ?? 'opaque',
                visibility: event.visibility === 'public' || event.visibility === 'private' ? event.visibility : 'default',
                attachments: [...(event.attachments ?? [])],
                eventType: event.eventType === 'outOfOffice' || event.eventType === 'focusTime' || event.eventType === 'workingLocation' ? event.eventType : 'default',
            }
            initialDescription = event.description ?? ''
            // An occurrence carries no repeat rule: it is read from its series.
            if (event.recurrence) applyRecurrence(event.recurrence)
            else if (event.recurringEventId) void loadSeriesRule(shown)
        }
        opened = JSON.stringify(draft)
        openedRepeat = draft ? repeatOf(draft) : ''
    }

    function applyRecurrence(lines: string[]) {
        if (!draft) return
        const { rule, others } = parseRecurrence(lines)
        draft.rule = rule
        draft.others = others
        draft.repeat = presetFor(rule, atTime(draft.startDate, draft.startTime))
        opened = JSON.stringify(draft)
        openedRepeat = repeatOf(draft)
    }

    async function loadSeriesRule(shown: ShownEvent) {
        const client = store.client(shown.account)
        if (!client) return
        try {
            const series = await getEvent(client, shown.calendar.id, shown.event.recurringEventId!)
            if (editing === shown) applyRecurrence(series.recurrence ?? [])
        } catch {
            // Without the series the repeat shows as it is, and is not changed unless the person changes it.
        }
    }

    const dirty = $derived(draft !== null && (JSON.stringify(draft) !== opened || descriptionTouched || uploads.some((upload) => upload.state === 'uploading')))

    async function requestClose() {
        if (saving) return
        if (dirty) {
            const discard = await ask({ title: 'Discard your changes?', body: 'The changes you made to this event are not saved.', options: [{ value: true, label: 'Discard', primary: true }], cancelLabel: 'Keep editing' })
            if (!discard) return
        }
        onclose()
    }

    function addGuest() {
        const value = guestInput.trim().toLowerCase()
        if (!value) return
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            guestError = 'Enter an email address, such as gardener@example.com.'
            return
        }
        if (draft?.attendees.some((attendee) => attendee.email.toLowerCase() === value)) {
            guestError = 'That guest is already invited.'
            return
        }
        draft?.attendees.push({ email: value, responseStatus: 'needsAction', optional: false })
        guestInput = ''
        guestError = null
    }

    async function attachFiles(files: FileList | null) {
        if (!files || !chosen) return
        const client = store.client(chosen.account)
        if (!client) return
        for (const file of [...files]) {
            const upload = { name: file.name, state: 'uploading' as const }
            uploads.push(upload)
            try {
                const stored = await uploadFile(client, file, file.name)
                draft?.attachments.push(attachmentFromDriveFile(stored))
                uploads = uploads.filter((candidate) => candidate.name !== file.name)
            } catch (reason) {
                uploads = uploads.map((candidate) => (candidate.name === file.name ? { ...candidate, state: 'failed', message: reason instanceof Error ? reason.message : 'The file could not be uploaded.' } : candidate))
            }
        }
    }

    function attachLink() {
        const value = linkInput.trim()
        const id = fileIdFromDriveLink(value)
        if (!id) {
            error = 'That is not a Google Drive link. Copy the link from Share in Google Drive.'
            return
        }
        draft?.attachments.push({ fileUrl: value, fileId: id, title: value })
        linkInput = ''
        error = null
    }

    /** The span the form describes, or a reason it describes none. */
    function spanOf(form: Draft): EventSpan | string {
        if (form.allDay) {
            const start = parseIsoDay(form.startDate)
            const end = addDays(parseIsoDay(form.endDate), 1)
            if (end <= start) return 'The event ends before it starts.'
            return { start, end, allDay: true }
        }
        const start = atTime(form.startDate, form.startTime)
        const end = atTime(form.endDate, form.endTime)
        if (end <= start) return 'The event ends before it starts.'
        return { start, end, allDay: false }
    }

    /** The event fields the form sets, apart from times and calendar. */
    function fieldsOf(form: Draft): Partial<CalendarEvent> {
        const description = descriptionRoot ? serializeDescription(nodesFromEditable(descriptionRoot)) : initialDescription
        const original = editing?.event
        // A value Google takes as its default is left unsent where the event had none, so an edit
        // of the title does not also write the defaults into the event.
        const unlessDefault = <T,>(value: T, isDefault: boolean, had: unknown): T | undefined => (isDefault && had === undefined ? undefined : value)
        const fields: Partial<CalendarEvent> = {
            summary: form.summary.trim() || undefined,
            location: form.location.trim() || undefined,
            description: description || undefined,
            transparency: unlessDefault(form.transparency, form.transparency === 'opaque', original?.transparency),
            visibility: unlessDefault(form.visibility, form.visibility === 'default', original?.visibility),
            reminders: form.remindersDefault
                ? unlessDefault({ useDefault: true }, true, original ? original.reminders : undefined)
                : { useDefault: false, overrides: form.reminders.map((row) => ({ method: row.method, minutes: Math.max(0, Math.round(row.amount * UNIT_MINUTES[row.unit])) })) },
            attachments: form.attachments.length > 0 ? form.attachments : undefined,
        }
        if (labels.length > 0) fields.eventLabelId = form.labelId || undefined
        else fields.colorId = form.colorId || undefined
        if (form.attendees.length > 0 || (editing?.event.attendees?.length ?? 0) > 0) {
            // Written back as Google gave them: `optional` only where a guest is optional, so an
            // unchanged list compares equal and emails nobody.
            fields.attendees = form.attendees.length > 0 ? form.attendees.map(({ optional, ...guest }) => (optional ? { ...guest, optional } : guest)) : undefined
            fields.guestsCanModify = unlessDefault(form.guestsCanModify, !form.guestsCanModify, original?.guestsCanModify)
            fields.guestsCanInviteOthers = unlessDefault(form.guestsCanInviteOthers, form.guestsCanInviteOthers, original?.guestsCanInviteOthers)
            fields.guestsCanSeeOtherGuests = unlessDefault(form.guestsCanSeeOtherGuests, form.guestsCanSeeOtherGuests, original?.guestsCanSeeOtherGuests)
        }
        if (form.meet === 'new') fields.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
        else if (form.meet === 'none' && (editing?.event.conferenceData || editing?.event.hangoutLink)) fields.conferenceData = undefined
        else if (form.meet === 'keep' && editing) fields.conferenceData = editing.event.conferenceData
        // Sent only when the person changed how it repeats: an occurrence carries no rule of its own,
        // and "this and following" works out the rest of the series' rule itself.
        if (!editing || repeatOf(form) !== openedRepeat) fields.recurrence = form.rule ? formatRecurrence(form.rule, form.others) : undefined
        if (form.eventType !== 'default' && form.eventType !== original?.eventType) {
            // A Workspace entry type carries its own properties, which Google's own editor sets as
            // below unless the person changes them there (the events guide's defaults). Not checked
            // against a Workspace account yet.
            fields.eventType = form.eventType
            if (form.eventType === 'outOfOffice') fields.outOfOfficeProperties = { autoDeclineMode: 'declineOnlyNewConflictingInvitations', declineMessage: 'Declined because I am out of office' }
            if (form.eventType === 'focusTime') fields.focusTimeProperties = { autoDeclineMode: 'declineOnlyNewConflictingInvitations', chatStatus: 'doNotDisturb' }
            if (form.eventType === 'workingLocation') {
                fields.workingLocationProperties = { type: 'homeOffice', homeOffice: {} }
                fields.transparency = 'transparent'
                fields.visibility = 'public'
            }
        }
        return fields
    }

    async function save(submit?: SubmitEvent) {
        submit?.preventDefault()
        const form = draft
        if (!form || saving || !chosen) return
        const span = spanOf(form)
        if (typeof span === 'string') {
            error = span
            return
        }
        if (uploads.some((upload) => upload.state === 'uploading')) {
            error = 'Wait for the attachments to finish uploading.'
            return
        }
        saving = true
        error = null
        try {
            const fields = fieldsOf(form)
            const ref = { account: chosen.account, calendarId: chosen.calendar.id }
            if (!editing) {
                let sendUpdates: 'all' | 'none' = 'none'
                if (form.attendees.length > 0) {
                    const answer = await ask(sendUpdatesChoice('invite'))
                    if (answer === null) return
                    sendUpdates = answer
                }
                const timeZone = form.timeZone
                await app.actions.create(ref, { ...fields, start: toEventDateTime(span.start, span.allDay, timeZone), end: toEventDateTime(span.end, span.allDay, timeZone) }, { sendUpdates })
            } else {
                let target: ShownEvent = editing
                const addsGuests = form.attendees.some((attendee) => !(editing?.event.attendees ?? []).some((kept) => kept.email === attendee.email))
                const options = await confirmChange(ask, { ...editing, hasGuests: editing.hasGuests || addsGuests }, 'change')
                if (!options) return
                if (ref.account !== editing.account || ref.calendarId !== editing.calendar.id) {
                    const moved = await app.actions.moveToCalendar(editing, ref, options)
                    if (moved) target = moved
                }
                const changes: EventChanges = { ...fields, span, timeZone: form.timeZone }
                await app.actions.save(target, changes, options)
            }
            opened = JSON.stringify(draft)
            descriptionTouched = false
            onclose()
        } catch (reason) {
            // The form stays as the person left it.
            error = reason instanceof Error ? reason.message : 'The event could not be saved.'
        } finally {
            saving = false
        }
    }

    const titleId = $props.id()

    /** Ctrl+Enter or Cmd+Enter anywhere in the form saves, as in a multiline field. */
    const saveOnModEnter = (form: HTMLFormElement) =>
        on(form, 'keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                void save()
            }
        })
</script>

<Modal open={draft !== null} label={editing ? 'Edit event' : 'New event'} onclose={() => void requestClose()} wide>
    {#if draft}
        <form class="gc-editor" onsubmit={save} novalidate aria-labelledby={titleId} data-testid="gc-editor" {@attach saveOnModEnter}>
            <h2 id={titleId} class="gc-visually-hidden">{editing ? 'Edit event' : 'New event'}</h2>
            <input class="gk-input gc-editor__title" placeholder="Add title" aria-label="Title" data-autofocus data-testid="gc-editor-title" bind:value={draft.summary} />

            {#if error}<p class="gk-error" role="alert" data-testid="gc-editor-error">{error}</p>{/if}

            <fieldset class="gc-editor__when">
                <legend class="gc-visually-hidden">When</legend>
                <label class="gc-editor__inline"><input type="checkbox" bind:checked={draft.allDay} data-testid="gc-editor-all-day" /> All day</label>
                <div class="gc-editor__times">
                    <input class="gk-input" type="date" aria-label="Start date" bind:value={draft.startDate} data-testid="gc-editor-start-date" />
                    {#if !draft.allDay}<input class="gk-input" type="time" aria-label="Start time" bind:value={draft.startTime} data-testid="gc-editor-start-time" />{/if}
                    <span>to</span>
                    {#if !draft.allDay}<input class="gk-input" type="time" aria-label="End time" bind:value={draft.endTime} data-testid="gc-editor-end-time" />{/if}
                    <input class="gk-input" type="date" aria-label="End date" bind:value={draft.endDate} data-testid="gc-editor-end-date" />
                </div>
                {#if !draft.allDay}
                    <label class="gk-field">
                        <span class="gk-label">Time zone</span>
                        <select class="gk-select" bind:value={draft.timeZone}>
                            {#each zones as zone (zone)}<option value={zone}>{zone.replaceAll('_', ' ')}</option>{/each}
                        </select>
                    </label>
                {/if}
                <label class="gk-field">
                    <span class="gk-label">Repeat</span>
                    <select
                        class="gk-select"
                        value={draft.repeat}
                        data-testid="gc-editor-repeat"
                        onchange={(event) => {
                            if (!draft) return
                            const value = event.currentTarget.value
                            draft.repeat = value
                            if (value === 'custom') draft.rule = draft.rule ?? { freq: 'WEEKLY', interval: 1 }
                            else draft.rule = presets.find((preset) => preset.id === value)?.rule ?? null
                        }}
                    >
                        {#each presets as preset (preset.id)}<option value={preset.id}>{preset.label}</option>{/each}
                        <option value="custom">Custom…</option>
                    </select>
                </label>
                {#if draft.repeat === 'custom' && draft.rule}
                    <RepeatEditor bind:rule={draft.rule} start={draft.allDay ? parseIsoDay(draft.startDate) : atTime(draft.startDate, draft.startTime)} />
                {/if}
            </fieldset>

            <div class="gc-editor__grid">
                <label class="gk-field">
                    <span class="gk-label">Calendar</span>
                    <select class="gk-select" bind:value={draft.calendarKey} data-testid="gc-editor-calendar">
                        {#each store.accounts.filter((account) => account.status === 'ready') as account (account.email)}
                            <optgroup label={account.email}>
                                {#each writable.filter((option) => option.account === account.email) as option (option.key)}
                                    <option value={option.key}>{option.calendar.summaryOverride || option.calendar.summary}</option>
                                {/each}
                            </optgroup>
                        {/each}
                    </select>
                </label>
                {#if labels.length > 0}
                    <label class="gk-field">
                        <span class="gk-label">Label</span>
                        <select class="gk-select" bind:value={draft.labelId}>
                            <option value="">None</option>
                            {#each labels as label (label.id)}<option value={label.id}>{label.name || 'Unnamed label'}</option>{/each}
                        </select>
                    </label>
                {:else}
                    <fieldset class="gk-field gc-editor__colours">
                        <legend class="gk-label">Colour</legend>
                        <label class="gc-editor__colour" title="Calendar colour">
                            <input type="radio" name="gc-colour" value="" bind:group={draft.colorId} />
                            <span class="gc-swatch" style:background={chosen ? calendarColor(chosen.calendar) : undefined}></span>
                            <span class="gc-visually-hidden">Calendar colour</span>
                        </label>
                        {#each Object.entries(EVENT_COLORS) as [id, colour] (id)}
                            <label class="gc-editor__colour" title={colour.name}>
                                <input type="radio" name="gc-colour" value={id} bind:group={draft.colorId} />
                                <span class="gc-swatch" style:background={colour.background}></span>
                                <span class="gc-visually-hidden">{colour.name}</span>
                            </label>
                        {/each}
                    </fieldset>
                {/if}
                {#if workspace}
                    <label class="gk-field">
                        <span class="gk-label">Type</span>
                        <select class="gk-select" bind:value={draft.eventType}>
                            <option value="default">Event</option>
                            <option value="outOfOffice">Out of office</option>
                            <option value="focusTime">Focus time</option>
                            <option value="workingLocation">Working location</option>
                        </select>
                    </label>
                {/if}
                <label class="gk-field">
                    <span class="gk-label">Show as</span>
                    <select class="gk-select" bind:value={draft.transparency}>
                        <option value="opaque">Busy</option>
                        <option value="transparent">Free</option>
                    </select>
                </label>
                <label class="gk-field">
                    <span class="gk-label">Visibility</span>
                    <select class="gk-select" bind:value={draft.visibility}>
                        <option value="default">Calendar's default</option>
                        <option value="public">Public</option>
                        <option value="private">Private</option>
                    </select>
                </label>
            </div>

            <label class="gk-field">
                <span class="gk-label">Location</span>
                <input class="gk-input" bind:value={draft.location} placeholder="Add location" data-testid="gc-editor-location" />
            </label>

            <div class="gk-field">
                <span class="gk-label">Video call</span>
                {#if draft.meet === 'none'}
                    <button type="button" class="gk-button" data-testid="gc-editor-meet" onclick={() => draft && (draft.meet = 'new')}>Add Google Meet video conferencing</button>
                {:else}
                    <p class="gc-editor__inline">
                        {draft.meet === 'new' ? 'A Google Meet link is made when you save.' : 'This event has a Google Meet link.'}
                        <button type="button" class="gk-link" onclick={() => draft && (draft.meet = 'none')}>Remove</button>
                    </p>
                {/if}
            </div>

            <fieldset class="gk-field">
                <legend class="gk-label">Guests</legend>
                <div class="gc-editor__inline">
                    <input
                        class="gk-input"
                        type="email"
                        placeholder="Add guests"
                        aria-label="Guest's email address"
                        bind:value={guestInput}
                        aria-invalid={guestError !== null}
                        data-testid="gc-editor-guest"
                        onkeydown={(event) => {
                            if (event.key === 'Enter' && !(event.ctrlKey || event.metaKey)) {
                                event.preventDefault()
                                addGuest()
                            }
                        }}
                    />
                    <button type="button" class="gk-button" onclick={addGuest} data-testid="gc-editor-guest-add">Add</button>
                </div>
                {#if guestError}<span class="gk-error">{guestError}</span>{/if}
                {#if draft.attendees.length > 0}
                    <ul class="gc-editor__list">
                        {#each draft.attendees as attendee, index (attendee.email)}
                            <li>
                                <span class="gc-editor__grow">{attendee.displayName ?? attendee.email}{#if attendee.organizer}, organiser{/if}</span>
                                {#if !attendee.organizer && !attendee.self}
                                    <label class="gc-editor__inline"><input type="checkbox" bind:checked={draft.attendees[index].optional} /> Optional</label>
                                    <button type="button" class="gk-link" aria-label="Remove {attendee.email}" onclick={() => draft?.attendees.splice(index, 1)}>Remove</button>
                                {/if}
                            </li>
                        {/each}
                    </ul>
                    {#if !draft.allDay && chosen}
                        <button type="button" class="gk-button gc-editor__find" aria-expanded={findingTime} data-testid="gc-editor-find-time" onclick={() => (findingTime = !findingTime)}>Find a time</button>
                        {#if findingTime}
                            <FindTime
                                {app}
                                account={chosen.account}
                                guests={draft.attendees.filter((attendee) => !attendee.resource).map((attendee) => attendee.email)}
                                day={parseIsoDay(draft.startDate)}
                                start={atTime(draft.startDate, draft.startTime)}
                                end={atTime(draft.endDate, draft.endTime)}
                                onpick={pickTime}
                            />
                        {/if}
                    {/if}
                    <div class="gc-editor__permissions">
                        <span class="gc-muted">Guests can</span>
                        <label class="gc-editor__inline"><input type="checkbox" bind:checked={draft.guestsCanModify} /> change the event</label>
                        <label class="gc-editor__inline"><input type="checkbox" bind:checked={draft.guestsCanInviteOthers} /> invite others</label>
                        <label class="gc-editor__inline"><input type="checkbox" bind:checked={draft.guestsCanSeeOtherGuests} /> see the guest list</label>
                    </div>
                {/if}
            </fieldset>

            <fieldset class="gk-field">
                <legend class="gk-label">Notifications</legend>
                <label class="gc-editor__inline"><input type="checkbox" bind:checked={draft.remindersDefault} /> Use the calendar's default notifications</label>
                {#if !draft.remindersDefault}
                    <ul class="gc-editor__list">
                        {#each draft.reminders as reminder, index (index)}
                            <li>
                                <select class="gk-select" aria-label="How" bind:value={reminder.method}>
                                    <option value="popup">Notification</option>
                                    <option value="email">Email</option>
                                </select>
                                <input class="gk-input gc-editor__number" type="number" min="0" aria-label="How long before" bind:value={reminder.amount} />
                                <select class="gk-select" aria-label="Unit" bind:value={reminder.unit}>
                                    <option value="minutes">minutes</option>
                                    <option value="hours">hours</option>
                                    <option value="days">days</option>
                                    <option value="weeks">weeks</option>
                                </select>
                                <span class="gc-muted">before</span>
                                <button type="button" class="gk-link" onclick={() => draft?.reminders.splice(index, 1)}>Remove</button>
                            </li>
                        {/each}
                    </ul>
                    {#if draft.reminders.length < 5}
                        <button type="button" class="gk-button" onclick={() => draft?.reminders.push({ method: 'popup', amount: 10, unit: 'minutes' })}>Add notification</button>
                    {:else}
                        <p class="gc-muted">Google allows five notifications per event.</p>
                    {/if}
                {/if}
            </fieldset>

            <fieldset class="gk-field">
                <legend class="gk-label">Attachments</legend>
                {#if draft.attachments.length > 0}
                    <ul class="gc-editor__list">
                        {#each draft.attachments as attachment, index (attachment.fileUrl)}
                            <li>
                                <a class="gk-link gc-editor__grow" href={safeUrl(attachment.fileUrl)} target="_blank" rel="noopener noreferrer">{attachment.title ?? attachment.fileUrl}</a>
                                <button type="button" class="gk-link" onclick={() => draft?.attachments.splice(index, 1)}>Remove</button>
                            </li>
                        {/each}
                    </ul>
                {/if}
                {#each uploads as upload (upload.name)}
                    <p class={upload.state === 'failed' ? 'gk-error' : 'gc-muted'} role="status">{upload.name}: {upload.state === 'uploading' ? 'uploading to your Google Drive…' : upload.message}</p>
                {/each}
                {#if draft.attachments.length < 25}
                    <div class="gc-editor__inline">
                        <label class="gk-button">
                            Attach a file
                            <input class="gc-visually-hidden" type="file" multiple onchange={(event) => void attachFiles(event.currentTarget.files)} />
                        </label>
                        <input class="gk-input gc-editor__grow" placeholder="Or paste a Google Drive link" aria-label="Google Drive link" bind:value={linkInput} />
                        <button type="button" class="gk-button" onclick={attachLink} disabled={linkInput.trim() === ''}>Attach link</button>
                    </div>
                    <p class="gc-muted gc-editor__hint">A file you attach is uploaded to your Google Drive, as Google Calendar does.</p>
                {/if}
            </fieldset>

            <div class="gk-field">
                <span class="gk-label">Description</span>
                <RichText initial={parseDescription(initialDescription)} bind:root={descriptionRoot} oninput={() => (descriptionTouched = true)} />
            </div>

            <div class="gc-editor__footer">
                <span class="gc-muted gc-editor__hint">Ctrl+Enter saves</span>
                <button type="button" class="gk-button" onclick={() => void requestClose()} disabled={saving}>Cancel</button>
                <button type="submit" class="gk-button gk-button--primary" disabled={saving} data-testid="gc-editor-save">{saving ? 'Saving…' : 'Save'}</button>
            </div>
        </form>
    {/if}
</Modal>

<style>
    .gc-editor {
        display: grid;
        gap: 1rem;
        font-size: 0.875rem;
    }
    .gc-editor__title {
        font-size: 1.25rem;
        min-height: 2.75rem;
    }
    .gc-editor__when,
    .gc-editor fieldset {
        display: grid;
        gap: 0.5rem;
        margin: 0;
        padding: 0;
        border: 0;
        min-width: 0;
    }
    .gc-editor legend {
        padding: 0;
        margin-bottom: 0.25rem;
        font-weight: 600;
    }
    .gc-editor__times {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
    }
    .gc-editor__grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
        gap: 0.75rem;
    }
    .gc-editor__colours {
        display: flex !important;
        flex-wrap: wrap;
        gap: 0.25rem !important;
        align-items: center;
    }
    .gc-editor__colours legend {
        flex-basis: 100%;
    }
    .gc-editor__colour {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.75rem;
        height: 1.75rem;
        border-radius: 999px;
        cursor: pointer;
    }
    .gc-editor__colour input {
        position: absolute;
        opacity: 0;
        width: 1px;
        height: 1px;
    }
    .gc-editor__colour .gc-swatch {
        width: 1.125rem;
        height: 1.125rem;
        border-radius: 999px;
    }
    .gc-editor__colour:has(input:checked) {
        outline: 2px solid var(--gk-text-default);
    }
    .gc-editor__colour:has(input:focus-visible) {
        outline: 2px solid var(--gk-accent);
    }
    .gc-editor__inline {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        margin: 0;
    }
    .gc-editor__list {
        display: grid;
        gap: 0.375rem;
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .gc-editor__list li {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
    }
    .gc-editor__grow {
        flex: 1 1 10rem;
        min-width: 0;
        overflow-wrap: anywhere;
    }
    .gc-editor__find {
        justify-self: start;
    }
    .gc-editor__number {
        width: 5rem;
    }
    .gc-editor__permissions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem 1rem;
    }
    .gc-editor__hint {
        font-size: 0.875rem;
    }
    .gc-editor__footer {
        position: sticky;
        bottom: -1.25rem;
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 0.5rem;
        padding: 0.75rem 0;
        background: var(--gk-surface-0);
        border-top: 1px solid var(--gk-border-soft);
    }
    .gc-editor__footer .gc-editor__hint {
        margin-right: auto;
    }
</style>
