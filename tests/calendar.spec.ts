import { expect, type Locator, type Page, test } from '@playwright/test'

import { FakeGoogle, type FakeEvent } from './fake-google'

/**
 * Events for Google Calendar in a running EtherPK Client, over a local graph, with Google answered by
 * the test (`FakeGoogle`). The clock is fixed at 9:00 on Monday 12 October 2026, so "today" is the
 * same in every run. Every name and address is a generic stand-in.
 */

const TODAY = '2026-10-12'
const GARDENER = 'gardener@example.com'
const ORCHARD = 'orchard@example.com'
const CLIENT_ID = '1234567890-garden.apps.googleusercontent.com'

const timed = (id: string, summary: string, day: string, from: string, to: string, extra: Partial<FakeEvent> = {}): FakeEvent => ({
    id,
    etag: `"${id}-1"`,
    status: 'confirmed',
    summary,
    start: { dateTime: `${day}T${from}:00+01:00`, timeZone: 'Europe/London' },
    end: { dateTime: `${day}T${to}:00+01:00`, timeZone: 'Europe/London' },
    organizer: { email: GARDENER, self: true },
    ...extra,
})
const allDay = (id: string, summary: string, day: string, next: string): FakeEvent => ({
    id,
    etag: `"${id}-1"`,
    status: 'confirmed',
    summary,
    start: { date: day },
    end: { date: next },
    organizer: { email: GARDENER, self: true },
})

function gardenGoogle(): FakeGoogle {
    const google = new FakeGoogle()
    google.addAccount({
        email: GARDENER,
        calendars: [
            { id: GARDENER, summary: 'Garden', backgroundColor: '#9fe1e7', selected: true, primary: true, accessRole: 'owner' },
            { id: 'kitchen@group.calendar.google.com', summary: 'Kitchen', backgroundColor: '#f83a22', selected: true, accessRole: 'writer' },
            { id: 'shed@group.calendar.google.com', summary: 'Shed', backgroundColor: '#7bd148', selected: false, accessRole: 'reader' },
        ],
        events: {
            [GARDENER]: [timed('beans', 'Water the beans', TODAY, '10:00', '11:00'), allDay('harvest', 'Harvest week', TODAY, '2026-10-14'), timed('weed', 'Weed the beds', '2026-10-09', '14:00', '15:00')],
            'kitchen@group.calendar.google.com': [timed('soup', 'Make the soup', TODAY, '08:30', '09:15')],
            'shed@group.calendar.google.com': [timed('tools', 'Sort the tools', TODAY, '12:00', '13:00')],
        },
    })
    return google
}

/** Seed a local graph, through the Client's filesystem harness. */
async function seedGraph(page: Page, id: string, journals: Record<string, string>) {
    await page.goto('/dev/filesystem')
    await page.evaluate(
        async ({ id, journals }) => {
            const root = await navigator.storage.getDirectory()
            await root.removeEntry(`graph-${id}`, { recursive: true }).catch(() => {})
            const graph = await root.getDirectoryHandle(`graph-${id}`, { create: true })
            for (const sub of ['journals', 'pages', 'assets', 'etherpk']) await graph.getDirectoryHandle(sub, { create: true })
            const dir = await graph.getDirectoryHandle('journals')
            for (const [name, text] of Object.entries(journals)) {
                const writable = await (await dir.getFileHandle(name, { create: true })).createWritable()
                await writable.write(text)
                await writable.close()
            }
        },
        { id, journals },
    )
}

/** The person's settings and the extension's records, as another device would have synced them. */
async function seedPerson(
    page: Page,
    { clientSet = true, accounts = [GARDENER], journal = true, journalTasks = true, openTasks = true, scopes = 'openid email', records = {} as Record<string, unknown> } = {},
) {
    const setting = (value: string) => ({ value, changedAt: 1 })
    const settings: Record<string, { value: string; changedAt: number }> = {}
    if (clientSet) {
        settings['extension.google-calendar.client-id'] = setting(CLIENT_ID)
        settings['extension.google-calendar.client-secret'] = setting('garden-secret')
    }
    if (!journal) settings['extension.google-calendar.journal-events'] = setting('false')
    if (accounts.length > 0) {
        settings['extension-data.google-calendar.accounts'] = setting(JSON.stringify(accounts.map((email) => ({ email, refreshToken: `refresh-${email}`, scopes, addedAt: 1 }))))
    }
    if (!journalTasks) settings['extension.google-calendar.journal-tasks'] = setting('false')
    if (!openTasks) settings['extension.google-calendar.journal-open-tasks'] = setting('false')
    // The extension's own records, such as where new events and tasks go.
    for (const [key, value] of Object.entries(records)) settings[`extension-data.google-calendar.${key}`] = setting(JSON.stringify(value))
    await page.addInitScript((stored) => {
        if (!sessionStorage.getItem('seeded')) {
            localStorage.setItem('etherpk:person-settings', JSON.stringify({ settings: stored, pending: [] }))
            sessionStorage.setItem('seeded', '1')
        }
    }, settings)
}

async function openGraph(page: Page, google: FakeGoogle, options: Parameters<typeof seedPerson>[1] = {}, journals: Record<string, string> = { [`${TODAY}.md`]: '- plant the garlic\n', '2026-10-09.md': '- dig the plot\n' }) {
    await page.clock.setFixedTime(new Date(`${TODAY}T09:00:00`))
    await google.install(page.context(), String(test.info().project.use.baseURL))
    const id = `calendar-${test.info().testId.slice(0, 8)}`
    await seedGraph(page, id, journals)
    await seedPerson(page, options)
    await page.goto(`/g/${id}?fs=opfs&autosaveMs=150`)
    await expect(page.locator('[data-testid="document-view"] .cm-content').first()).toBeVisible({ timeout: 30_000 })
}

async function openCalendar(page: Page): Promise<Locator> {
    await page.getByRole('button', { name: 'Calendar Events' }).first().click()
    const view = page.getByTestId('gc-view')
    await expect(view).toBeVisible({ timeout: 15_000 })
    return view
}

// Any error the page throws fails the test that met it, with its message and where it came from.
const pageErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
    const errors: string[] = []
    pageErrors.set(page, errors)
    page.on('pageerror', (error) => errors.push(`${error.message}\n${error.stack ?? ''}`))
    page.on('console', (message) => {
        if (message.type() === 'error' && /svelte|effect/i.test(message.text())) errors.push(message.text())
    })
})
test.afterEach(({ page }) => {
    expect(pageErrors.get(page) ?? [], 'errors the page threw').toEqual([])
})

const journalTab = (page: Page, day: string) => page.locator(`[data-testid="document-view"][data-doc-target="${day}"]:not([data-rolled])`)

test.describe('setting up', () => {
    test('walks through the OAuth client, checks what is pasted, and connects an account in a popup', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google, { clientSet: false, accounts: [] })
        const view = await openCalendar(page)
        const setup = view.getByTestId('gc-setup')
        await expect(setup.getByTestId('gc-setup-origin')).toHaveText('http://127.0.0.1:5397')
        await expect(setup.getByTestId('gc-setup-redirect')).toHaveText('http://127.0.0.1:5397/extension-sign-in')

        await setup.getByTestId('gc-setup-save').click()
        await expect(setup.getByText('Paste the Client ID.')).toBeVisible()
        await expect(setup.getByTestId('gc-setup-client-id')).toBeFocused()
        await setup.getByTestId('gc-setup-client-id').fill('garden-client')
        await setup.getByTestId('gc-setup-client-id').blur()
        await expect(setup.getByText(/ends with \.apps\.googleusercontent\.com/)).toBeVisible()
        await setup.getByTestId('gc-setup-client-id').fill(CLIENT_ID)
        await setup.getByTestId('gc-setup-client-secret').fill('garden-secret')
        await setup.getByTestId('gc-setup-save').click()

        const popup = page.waitForEvent('popup')
        await setup.getByTestId('gc-connect').click()
        await popup
        const list = view.getByTestId('gc-calendar-list')
        await expect(list.getByTestId('gc-account')).toHaveAttribute('data-email', GARDENER)
        await expect(list.getByTestId('gc-account').getByText('Kitchen')).toBeVisible()
        await expect(view.getByText('Water the beans')).toBeVisible()
    })
})

test.describe('the calendar', () => {
    test('shows the ticked calendars’ events in the month, and hides a calendar unticked here', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('month')
        await expect(view.getByText('Water the beans')).toBeVisible()
        await expect(view.getByText('Make the soup')).toBeVisible()
        // Unticked in Google Calendar's own list: not shown until ticked here.
        await expect(view.getByText('Sort the tools')).toHaveCount(0)

        await view.locator('[data-testid="gc-calendar-toggle"][data-calendar="kitchen@group.calendar.google.com"]').uncheck()
        await expect(view.getByText('Make the soup')).toHaveCount(0)
        await view.locator('[data-testid="gc-calendar-toggle"][data-calendar="shed@group.calendar.google.com"]').check()
        await expect(view.getByText('Sort the tools')).toBeVisible()
    })

    test('creates an event, asking first whether to email its guest', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await view.getByTestId('gc-create').click()
        const editor = page.getByTestId('gc-editor')
        await editor.getByTestId('gc-editor-title').fill('Plant the garlic')
        await editor.getByTestId('gc-editor-start-time').fill('14:00')
        await editor.getByTestId('gc-editor-end-time').fill('15:30')
        await editor.getByTestId('gc-editor-location').fill('North bed')
        await editor.getByTestId('gc-editor-guest').fill('orchard@example.com')
        await editor.getByTestId('gc-editor-guest-add').click()
        await editor.getByTestId('gc-editor-save').click()
        await page.getByRole('button', { name: 'Send', exact: true }).click()

        await expect.poll(() => google.sent('POST').length).toBe(1)
        const [write] = google.sent('POST')
        expect(write.url.searchParams.get('sendUpdates')).toBe('all')
        expect(write.body).toMatchObject({ summary: 'Plant the garlic', location: 'North bed', attendees: [{ email: 'orchard@example.com' }] })
        expect((write.body as FakeEvent).start.dateTime).toMatch(/^2026-10-12T14:00:00/)
        await expect(view.getByText('Plant the garlic')).toBeVisible()
    })

    test('saves only what changed in an edit, with the event’s etag', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await view.getByText('Water the beans').click()
        await page.getByTestId('gc-details-edit').click()
        const editor = page.getByTestId('gc-editor')
        await editor.getByTestId('gc-editor-title').fill('Water the beans well')
        await editor.getByTestId('gc-editor-save').click()

        await expect.poll(() => google.sent('PATCH').length).toBe(1)
        const [write] = google.sent('PATCH')
        expect(write.body).toEqual({ summary: 'Water the beans well' })
        expect(write.headers['if-match']).toBe('"beans-1"')
        await expect(view.getByText('Water the beans well')).toBeVisible()
    })

    test('deletes an event, and Undo puts it back', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await view.getByText('Water the beans').click()
        await page.getByTestId('gc-details-delete').click()
        await expect(view.getByText('Water the beans')).toHaveCount(0)
        await expect.poll(() => google.sent('DELETE').length).toBe(1)
        await page.getByTestId('gc-undo-button').click()
        await expect.poll(() => google.sent('PATCH').map((write) => write.body)).toEqual([{ status: 'confirmed' }])
        await expect(view.getByText('Water the beans')).toBeVisible()
    })

    test('answers an invitation', async ({ page }) => {
        const google = gardenGoogle()
        google.accounts.get(GARDENER)!.events[GARDENER].push(
            timed('picnic', 'Picnic in the orchard', TODAY, '12:00', '13:00', {
                organizer: { email: ORCHARD },
                attendees: [
                    { email: ORCHARD, organizer: true, responseStatus: 'accepted' },
                    { email: GARDENER, self: true, responseStatus: 'needsAction' },
                ],
            }),
        )
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await view.getByText('Picnic in the orchard').click()
        await page.getByTestId('gc-rsvp-accepted').click()
        await expect.poll(() => google.sent('PATCH').length).toBe(1)
        expect((google.sent('PATCH')[0].body as FakeEvent).attendees).toEqual([
            { email: ORCHARD, organizer: true, responseStatus: 'accepted' },
            { email: GARDENER, self: true, responseStatus: 'accepted' },
        ])
        await expect(page.getByTestId('gc-rsvp-accepted')).toHaveAttribute('aria-pressed', 'true')
    })

    test('shows a description with its formatting, built without writing HTML', async ({ page }) => {
        const google = gardenGoogle()
        google.accounts.get(GARDENER)!.events[GARDENER][0].description = '<b>Bring</b> the <a href="https://garden.example/seeds">seeds</a><script>alert(1)</script>'
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await view.getByText('Water the beans').click()
        const description = page.getByTestId('gc-details-description')
        await expect(description.locator('b')).toHaveText('Bring')
        await expect(description.getByRole('link', { name: 'seeds' })).toHaveAttribute('href', 'https://garden.example/seeds')
        await expect(description.locator('script')).toHaveCount(0)
    })

    test("says when Google can't be reached, and Retry loads the events", async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        google.offline = true
        const view = await openCalendar(page)
        await expect(view.getByTestId('gc-banner')).toContainText("can't be reached", { timeout: 15_000 })
        google.offline = false
        await view.getByTestId('gc-retry').click()
        await expect(view.getByTestId('gc-banner')).toHaveCount(0)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await expect(view.getByText('Water the beans').first()).toBeVisible()
    })

    test('asks to connect again an account whose sign-in Google no longer accepts', async ({ page }) => {
        const google = gardenGoogle()
        google.revoked.add(`refresh-${GARDENER}`)
        await openGraph(page, google)
        const view = await openCalendar(page)
        const account = view.getByTestId('gc-account')
        await expect(account).toHaveAttribute('data-status', 'reconnect', { timeout: 15_000 })
        google.revoked.clear()
        const popup = page.waitForEvent('popup')
        await account.getByTestId('gc-connect').click()
        await popup
        await expect(account).toHaveAttribute('data-status', 'ready')
    })

    test("the year opens a day's journal entry", async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('year')
        await view.locator(`[data-testid="gc-year-day"][data-day="2026-10-09"]`).click()
        const popup = page.getByTestId('gc-year-popup')
        await expect(popup).toContainText('Weed the beds')
        await popup.getByTestId('gc-year-journal').click()
        await expect(journalTab(page, '2026-10-09').locator('.cm-content')).toContainText('dig the plot')
    })
})

test.describe('the Journal Panel', () => {
    test("lists the day's events beneath its entry, all-day first, each with its calendar", async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        const panel = journalTab(page, TODAY).getByTestId('gc-journal-panel')
        const rows = panel.getByTestId('gc-panel-event')
        await expect(rows).toHaveCount(3, { timeout: 15_000 })
        await expect(rows.nth(0)).toContainText('Harvest week')
        await expect(rows.nth(1)).toContainText('Make the soup')
        await expect(rows.nth(1)).toContainText('Kitchen')
        await expect(rows.nth(2)).toContainText('Water the beans')
        await expect(rows.nth(2)).toContainText('Garden')
    })

    test('shows a past day’s own events, and opens one in Calendar Events', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        await page.evaluate(() => (window as unknown as { __etherpkLayout: { openView(view: unknown): void } }).__etherpkLayout.openView({ kind: 'document', target: '2026-10-09' }))
        const panel = journalTab(page, '2026-10-09').getByTestId('gc-journal-panel')
        await expect(panel.getByTestId('gc-panel-event')).toHaveText([/Weed the beds/], { timeout: 15_000 })
        await panel.getByTestId('gc-panel-event').click()
        await page.getByTestId('gc-details-open-calendar').click()
        await expect(page.getByTestId('gc-view')).toBeVisible()
        await expect(page.getByTestId('gc-title')).toContainText('9')
    })

    test('starts a new event in the calendar chosen for new events, and in the main calendar once that one is gone', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        const view = await openCalendar(page)
        const picker = view.getByTestId('gc-default-calendar')
        await expect(picker).toHaveValue(`${GARDENER}|${GARDENER}`, { timeout: 15_000 })
        // A menu the extension draws in the theme's colours, not the system's list.
        expect(await picker.evaluate((select) => getComputedStyle(select).appearance)).toBe('base-select')
        await picker.click()
        await view.getByRole('option', { name: 'Kitchen' }).click()
        await expect(picker).toHaveValue(`${GARDENER}|kitchen@group.calendar.google.com`)
        await page.evaluate(() => (window as unknown as { __etherpkLayout: { openView(view: unknown): void } }).__etherpkLayout.openView({ kind: 'document', target: '2026-10-12' }))
        const panel = journalTab(page, TODAY).getByTestId('gc-journal-panel')
        await panel.getByTestId('gc-panel-add').click()
        const editor = page.getByTestId('gc-editor')
        await expect(editor.getByTestId('gc-editor-calendar')).toHaveValue(`${GARDENER}|kitchen@group.calendar.google.com`)
        await editor.getByRole('button', { name: 'Cancel' }).click()

        // Deleted in Google: the calendar is not in the account's list when it is next read.
        google.accounts.get(GARDENER)!.calendars.splice(1, 1)
        await page.reload()
        await expect(page.locator('[data-testid="document-view"] .cm-content').first()).toBeVisible({ timeout: 30_000 })
        await page.evaluate(() => (window as unknown as { __etherpkLayout: { openView(view: unknown): void } }).__etherpkLayout.openView({ kind: 'document', target: '2026-10-12' }))
        await expect(journalTab(page, TODAY).getByTestId('gc-panel-event').first()).toBeVisible({ timeout: 15_000 })
        await journalTab(page, TODAY).getByTestId('gc-panel-add').click()
        await expect(page.getByTestId('gc-editor').getByTestId('gc-editor-calendar')).toHaveValue(`${GARDENER}|${GARDENER}`)
    })

    test("draws its actions as EtherPK's own small buttons, about as tall as their heading, in either theme", async ({ page }) => {
        const google = gardenGoogle()
        google.accounts.get(GARDENER)!.tasks = { list1: { title: 'Garden jobs', items: [] } }
        await openGraph(page, google, { scopes: 'openid email https://www.googleapis.com/auth/tasks' })
        const panel = journalTab(page, TODAY).getByTestId('gc-journal-panel')
        await expect(panel.getByTestId('gc-panel-event').first()).toBeVisible({ timeout: 15_000 })
        const rows = [
            { head: panel.getByTestId('gc-panel-head'), buttons: ['gc-panel-add', 'gc-panel-open'] },
            { head: panel.getByTestId('gc-panel-tasks-head'), buttons: ['gc-panel-add-task'] },
        ]
        const looks = async () => {
            const out: string[] = []
            for (const { head, buttons } of rows) {
                const title = await head.getByRole('heading').boundingBox()
                for (const id of buttons) {
                    const button = head.getByTestId(id)
                    const box = (await button.boundingBox())!
                    expect(box.height, id).toBeLessThanOrEqual(title!.height + 4)
                    expect(Math.abs(box.y + box.height / 2 - (title!.y + title!.height / 2)), id).toBeLessThan(2)
                    // The same classes on a button in the Client's own page, outside the panel's shadow root.
                    const style = await button.evaluate((inPanel) => {
                        const inPage = document.createElement('button')
                        inPage.className = 'gk-button gk-button--small'
                        document.body.append(inPage)
                        const read = (element: Element) => {
                            const own = getComputedStyle(element)
                            return [own.borderTopColor, own.borderRadius, own.color, own.fontSize, own.fontWeight, own.paddingLeft, own.textDecorationLine].join(' ')
                        }
                        const both = { panel: read(inPanel), page: read(inPage) }
                        inPage.remove()
                        return both
                    })
                    expect(style.panel, id).toBe(style.page)
                    out.push(style.panel)
                }
            }
            return out
        }
        const light = await looks()
        await page.getByRole('radio', { name: 'Dark' }).click()
        await expect.poll(async () => (await looks())[0]).not.toBe(light[0])
    })

    test('says where to set up before an account is connected', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google, { accounts: [] })
        const panel = journalTab(page, TODAY).getByTestId('gc-journal-panel')
        await expect(panel).toHaveAttribute('data-state', 'not-set-up')
        await panel.getByTestId('gc-panel-setup').click()
        await expect(page.getByTestId('gc-setup')).toBeVisible()
    })

    test('is gone while every journal switch is off', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google, { journal: false, journalTasks: false, openTasks: false })
        await expect(journalTab(page, TODAY).locator('.cm-content')).toContainText('plant the garlic')
        await expect(page.getByTestId('gc-journal-panel')).toHaveCount(0)
    })
})

test.describe('editing in depth', () => {
    test('moves an event by dragging it to another time in the week', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        const event = view.locator('.ec-event', { hasText: 'Water the beans' })
        await expect(event).toBeVisible()
        const ten = (await view.locator('.ec-sidebar').getByText('10:00', { exact: true }).boundingBox())!
        const two = (await view.locator('.ec-sidebar').getByText('14:00', { exact: true }).boundingBox())!
        const box = (await event.boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + 8)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width / 2, box.y + 8 + (two.y - ten.y) / 2, { steps: 5 })
        await page.mouse.move(box.x + box.width / 2, box.y + 8 + (two.y - ten.y), { steps: 5 })
        await page.mouse.up()
        await expect.poll(() => google.sent('PATCH').length).toBe(1)
        const body = google.sent('PATCH')[0].body as FakeEvent
        expect(body.start.dateTime).toMatch(/^2026-10-12T14:00:00/)
        expect(body.end.dateTime).toMatch(/^2026-10-12T15:00:00/)
    })

    test('changes this and following events of a repeating event, ending the series and starting a new one', async ({ page }) => {
        const google = gardenGoogle()
        const events = google.accounts.get(GARDENER)!.events[GARDENER]
        const occurrence = (day: string) =>
            timed(`water_${day.replaceAll('-', '')}`, 'Water the pots', day, '07:00', '07:30', { recurringEventId: 'water', originalStartTime: { dateTime: `${day}T07:00:00+01:00` } })
        events.push(
            timed('water', 'Water the pots', '2026-10-05', '07:00', '07:30', { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] }),
            occurrence('2026-10-05'),
            occurrence('2026-10-12'),
            occurrence('2026-10-19'),
        )
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await view.locator('.ec-event', { hasText: 'Water the pots' }).click()
        await page.getByTestId('gc-details-edit').click()
        const editor = page.getByTestId('gc-editor')
        await expect(editor.getByTestId('gc-editor-repeat')).toHaveValue('weekly')
        await editor.getByTestId('gc-editor-title').fill('Water the big pots')
        await editor.getByTestId('gc-editor-save').click()
        await page.getByRole('button', { name: 'This and following events' }).click()

        await expect.poll(() => google.sent('POST').length).toBe(1)
        const ended = google.sent('PATCH').find((write) => write.url.pathname.endsWith('/events/water'))!
        expect((ended.body as FakeEvent).recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261012T055959Z'])
        const started = google.sent('POST')[0].body as FakeEvent
        expect(started).toMatchObject({ summary: 'Water the big pots', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] })
        expect(started.start.dateTime).toMatch(/^2026-10-12T07:00:00/)
    })

    test('adds a Google Meet link when saved', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await view.getByText('Water the beans').click()
        await page.getByTestId('gc-details-edit').click()
        await page.getByTestId('gc-editor-meet').click()
        await page.getByTestId('gc-editor-save').click()
        await expect.poll(() => google.sent('PATCH').length).toBe(1)
        const [write] = google.sent('PATCH')
        expect(write.url.searchParams.get('conferenceDataVersion')).toBe('1')
        expect(write.body).toMatchObject({ conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } } })
    })

    test('keeps a description’s formatting through an edit', async ({ page }) => {
        const google = gardenGoogle()
        google.accounts.get(GARDENER)!.events[GARDENER][0].description = '<b>Bring</b> the can'
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await view.getByText('Water the beans').click()
        await page.getByTestId('gc-details-edit').click()
        const field = page.getByTestId('gc-editor-description')
        await expect(field.locator('b')).toHaveText('Bring')
        await field.click()
        await page.keyboard.press('End')
        await page.keyboard.type(' and the hose')
        await page.getByTestId('gc-editor-save').click()
        await expect.poll(() => google.sent('PATCH').length).toBe(1)
        expect(google.sent('PATCH')[0].body).toEqual({ description: '<b>Bring</b> the can and the hose' })
    })

    test('attaches a file from the computer, uploaded to the person’s Drive', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await view.getByText('Water the beans').click()
        await page.getByTestId('gc-details-edit').click()
        await page.getByTestId('gc-editor').locator('input[type=file]').setInputFiles({ name: 'Seed list.txt', mimeType: 'text/plain', buffer: Buffer.from('beans, peas') })
        await expect(page.getByTestId('gc-editor').getByRole('link', { name: 'Seed list.txt' })).toBeVisible()
        await page.getByTestId('gc-editor-save').click()
        await expect.poll(() => google.sent('PATCH').length).toBe(1)
        const [write] = google.sent('PATCH')
        expect(write.url.searchParams.get('supportsAttachments')).toBe('true')
        expect(write.body).toMatchObject({ attachments: [{ fileUrl: 'https://drive.google.com/file/d/drivefile1/view', title: 'Seed list.txt' }] })
        expect(google.sent('UPLOAD')).toHaveLength(1)
    })

    test('Find a time offers the times when everyone is free, and moves the event there', async ({ page }) => {
        const google = gardenGoogle()
        google.busy.set(GARDENER, [{ start: '2026-10-12T08:00:00+01:00', end: '2026-10-12T12:00:00+01:00' }])
        google.busy.set(ORCHARD, [{ start: '2026-10-12T12:00:00+01:00', end: '2026-10-12T15:00:00+01:00' }])
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await view.getByTestId('gc-create').click()
        const editor = page.getByTestId('gc-editor')
        await editor.getByTestId('gc-editor-guest').fill(ORCHARD)
        await editor.getByTestId('gc-editor-guest-add').click()
        await editor.getByTestId('gc-editor-find-time').click()
        const slots = editor.getByTestId('gc-find-slot')
        await expect(slots.first()).toBeVisible()
        await expect(slots).toHaveText(['15:00', '15:30', '16:00', '16:30', '17:00'].map((time) => new RegExp(time)))
        await slots.first().click()
        await expect(editor.getByTestId('gc-editor-start-time')).toHaveValue('15:00')
    })

    test("moves an event to another calendar of the account", async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await view.getByText('Water the beans').click()
        await page.getByTestId('gc-details-edit').click()
        await page.getByTestId('gc-editor-calendar').selectOption(`${GARDENER}|kitchen@group.calendar.google.com`)
        await page.getByTestId('gc-editor-save').click()
        await expect.poll(() => google.sent('POST').map((write) => write.url.pathname)).toEqual([`/calendar/v3/calendars/${encodeURIComponent(GARDENER)}/events/beans/move`])
        expect(google.sent('POST')[0].url.searchParams.get('destination')).toBe('kitchen@group.calendar.google.com')
    })
})

test.describe('closing the editor', () => {
    test('closes at once when nothing was changed, and asks first when something was', async ({ page }) => {
        const google = gardenGoogle()
        google.accounts.get(GARDENER)!.events[GARDENER][0].attendees = [
            { email: ORCHARD, responseStatus: 'accepted' },
            { email: GARDENER, self: true, organizer: true, responseStatus: 'accepted' },
        ]
        await openGraph(page, google)
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await view.getByText('Water the beans').click()
        await page.getByTestId('gc-details-edit').click()
        const editor = page.getByTestId('gc-editor')
        await expect(editor).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(editor).toHaveCount(0)

        await view.getByText('Water the beans').click()
        await page.getByTestId('gc-details-edit').click()
        await editor.getByTestId('gc-editor-location').fill('South bed')
        await page.keyboard.press('Escape')
        await expect(page.getByText('Discard your changes?')).toBeVisible()
        await page.getByRole('button', { name: 'Keep editing' }).click()
        await expect(editor.getByTestId('gc-editor-location')).toHaveValue('South bed')
        await editor.getByTestId('gc-editor-save').click()
        await page.getByRole('button', { name: "Don't send" }).click()
        await expect.poll(() => google.sent('PATCH').map((write) => write.body)).toEqual([{ location: 'South bed' }])
        expect(google.sent('PATCH')[0].url.searchParams.get('sendUpdates')).toBe('none')
    })
})

test.describe('accounts', () => {
    test("shows every account's calendars, and disconnecting one ends its sign-in at Google", async ({ page }) => {
        const google = gardenGoogle()
        google.addAccount({
            email: ORCHARD,
            calendars: [{ id: ORCHARD, summary: 'Orchard', backgroundColor: '#ffad46', selected: true, primary: true, accessRole: 'owner' }],
            events: { [ORCHARD]: [timed('prune', 'Prune the apples', TODAY, '15:00', '16:00')] },
        })
        await openGraph(page, google, { accounts: [GARDENER, ORCHARD] })
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await expect(view.getByText('Prune the apples')).toBeVisible()
        await expect(view.getByText('Water the beans')).toBeVisible()

        // Signing in and out has its own section, below the calendars: each account's Disconnect, then Add account.
        const accounts = view.getByTestId('gc-accounts')
        await expect(accounts.getByRole('button', { name: /^Disconnect/ })).toHaveText(['Disconnect', 'Disconnect'])
        await expect(accounts.getByTestId('gc-connect')).toHaveText('Add account')
        const orchard = view.locator(`[data-testid="gc-account"][data-email="${ORCHARD}"]`)
        await accounts.getByRole('button', { name: `Disconnect ${ORCHARD}` }).click()
        await accounts.getByTestId('gc-disconnect-confirm').click()
        await expect(orchard).toHaveCount(0)
        await expect(accounts.getByRole('button', { name: /^Disconnect/ })).toHaveCount(1)
        await expect(view.getByText('Prune the apples')).toHaveCount(0)
        expect([...google.revoked]).toEqual([`refresh-${ORCHARD}`])
    })

    test('follows the dark theme', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        const view = await openCalendar(page)
        await expect(view).not.toHaveClass(/ec-dark/)
        await page.getByRole('radio', { name: 'Dark' }).click()
        await expect(view).toHaveClass(/ec-dark/)
    })
})

test.describe('Google Tasks', () => {
    const TASKS = 'https://www.googleapis.com/auth/tasks'

    function withTasks(): FakeGoogle {
        const google = gardenGoogle()
        google.accounts.get(GARDENER)!.tasks = {
            list1: {
                title: 'Garden jobs',
                items: [
                    { id: 'compost', title: 'Buy compost', status: 'needsAction', due: '2026-10-12T00:00:00.000Z', position: '00000000000000000001' },
                    { id: 'hoe', title: 'Sharpen the hoe', status: 'completed', due: '2026-10-13T00:00:00.000Z', position: '00000000000000000002' },
                    { id: 'seeds', title: 'Sort the seeds', status: 'needsAction', position: '00000000000000000003' },
                    { id: 'labels', title: 'Write the labels', status: 'needsAction', parent: 'seeds', position: '00000000000000000000' },
                    { id: 'fence', title: 'Mend the fence', status: 'needsAction', due: '2026-10-09T00:00:00.000Z', position: '00000000000000000004' },
                ],
            },
            list2: {
                title: 'Kitchen jobs',
                items: [
                    { id: 'jars', title: 'Wash the jars', status: 'needsAction', due: '2026-10-12T00:00:00.000Z', position: '00000000000000000001' },
                    { id: 'pans', title: 'Scrub the pans', status: 'completed', position: '00000000000000000002' },
                ],
            },
        }
        return google
    }

    test("lists the day's due tasks below its events, then every open task by list, and ticks one off", async ({ page }) => {
        const google = withTasks()
        await openGraph(page, google, { scopes: `openid email ${TASKS}` })
        const panel = journalTab(page, TODAY).getByTestId('gc-journal-panel')
        const due = panel.getByTestId('gc-panel-due')
        await expect(due.getByTestId('gc-panel-task')).toHaveText([/Buy compost\s*Garden jobs/, /Wash the jars\s*Kitchen jobs/], { timeout: 15_000 })
        await expect(due.getByRole('heading')).toHaveText('Due tasks')
        // The tasks have a heading of their own, as the events have Calendar.
        const heading = panel.getByRole('heading', { name: 'Tasks', exact: true })
        await expect(heading).toBeVisible()
        // Then each list's open tasks, subtasks beneath their parent, leaving out what is due today
        // (shown above) and what is done. A list with nothing else open is left out.
        const lists = panel.getByTestId('gc-panel-task-list')
        await expect(lists).toHaveCount(1)
        await expect(lists.getByRole('heading')).toHaveText('Garden jobs')
        // The browser's own date format: "9 Oct" or "Oct 9".
        await expect(lists.getByTestId('gc-panel-task')).toHaveText([/^Sort the seeds\s*$/, /^Write the labels\s*$/, /Mend the fence\s*Was due (9 Oct|Oct 9)/])
        const rows = lists.getByTestId('gc-panel-task-row')
        expect(await rows.nth(1).evaluate((row) => parseFloat(getComputedStyle(row).paddingLeft))).toBeGreaterThan(await rows.nth(0).evaluate((row) => parseFloat(getComputedStyle(row).paddingLeft)))
        // All below the day's events, the due tasks first.
        const [events, headingBox, dueBox, listBox] = await Promise.all([panel.getByTestId('gc-panel-events').boundingBox(), heading.boundingBox(), due.boundingBox(), lists.boundingBox()])
        expect(headingBox!.y).toBeGreaterThan(events!.y + events!.height - 1)
        expect(dueBox!.y).toBeGreaterThan(headingBox!.y + headingBox!.height - 1)
        expect(listBox!.y).toBeGreaterThan(dueBox!.y + dueBox!.height - 1)

        await due.getByTestId('gc-panel-task-done').first().check()
        await expect.poll(() => google.sent('TASK PATCH').map((write) => write.body)).toEqual([{ status: 'completed' }])
        // A task ticked off in the list stays where it was, struck through, rather than jumping away.
        await lists.getByRole('checkbox', { name: 'Done: Sort the seeds' }).check()
        await expect.poll(() => google.sent('TASK PATCH').length).toBe(2)
        await expect(lists.getByTestId('gc-panel-task')).toHaveText([/^Sort the seeds\s*$/, /^Write the labels\s*$/, /Mend the fence/])
        await expect(lists.getByRole('checkbox', { name: 'Done: Sort the seeds' })).toBeChecked()
    })

    test('shows the open tasks on today’s entry only, and a task with no due date opens and edits without one', async ({ page }) => {
        const google = withTasks()
        await openGraph(page, google, { scopes: `openid email ${TASKS}` })
        const today = journalTab(page, TODAY).getByTestId('gc-journal-panel')
        await expect(today.getByTestId('gc-panel-task-list')).toHaveCount(1, { timeout: 15_000 })
        await today.getByTestId('gc-panel-task').filter({ hasText: 'Sort the seeds' }).click()
        const details = page.getByTestId('gc-task-details')
        await expect(details).toContainText('Garden jobs')
        await expect(details).not.toContainText('Due')
        await details.getByTestId('gc-task-edit').click()
        const editor = page.getByTestId('gc-task-editor')
        await expect(editor.getByTestId('gc-task-due')).toHaveValue('')
        await editor.getByTestId('gc-task-title').fill('Sort the seed packets')
        await editor.getByTestId('gc-task-save').click()
        await expect.poll(() => google.sent('TASK PATCH').map((write) => write.body)).toEqual([{ title: 'Sort the seed packets', notes: '', due: null }])

        await page.evaluate(() => (window as unknown as { __etherpkLayout: { openView(view: unknown): void } }).__etherpkLayout.openView({ kind: 'document', target: '2026-10-09' }))
        const earlier = journalTab(page, '2026-10-09').getByTestId('gc-journal-panel')
        await expect(earlier.getByTestId('gc-panel-due').getByTestId('gc-panel-task')).toHaveText([/Mend the fence/], { timeout: 15_000 })
        await expect(earlier.getByTestId('gc-panel-task-list')).toHaveCount(0)
    })

    test('leaves the open tasks out while their switch is off, and keeps the due ones', async ({ page }) => {
        const google = withTasks()
        await openGraph(page, google, { scopes: `openid email ${TASKS}`, openTasks: false })
        const panel = journalTab(page, TODAY).getByTestId('gc-journal-panel')
        await expect(panel.getByTestId('gc-panel-due').getByTestId('gc-panel-task')).toHaveCount(2, { timeout: 15_000 })
        await expect(panel.getByTestId('gc-panel-task-list')).toHaveCount(0)
    })

    test('shows the task lists ticked under each account, in the calendar and beneath the journal entry, and adds a task', async ({ page }) => {
        const google = withTasks()
        await openGraph(page, google, { scopes: `openid email ${TASKS}` })
        const view = await openCalendar(page)
        await view.getByTestId('gc-view-picker').selectOption('week')
        await expect(view.locator('.gc-task', { hasText: 'Sharpen the hoe' })).toHaveClass(/gc-task--done/)
        await expect(view.locator('.gc-task', { hasText: 'Wash the jars' })).toBeVisible()
        // Google Tasks itself is a link away, as the account, in a new tab.
        const openTasks = view.getByRole('link', { name: 'Open in Google Tasks (opens in a new tab)' })
        await expect(openTasks).toHaveAttribute('href', 'https://tasks.google.com/?authuser=gardener%40example.com')
        await expect(openTasks).toHaveAttribute('target', '_blank')
        await view.locator('[data-testid="gc-task-list-toggle"][data-list="list2"]').uncheck()
        await expect(view.locator('.gc-task', { hasText: 'Wash the jars' })).toHaveCount(0)
        await expect(journalTab(page, TODAY).getByTestId('gc-panel-due').getByTestId('gc-panel-task')).toHaveText([/Buy compost/])

        await view.getByTestId('gc-add-task').click()
        const editor = page.getByTestId('gc-task-editor')
        // A new task has no due date until the person gives it one.
        await expect(editor.getByTestId('gc-task-due')).toHaveValue('')
        await editor.getByTestId('gc-task-title').fill('Order seed potatoes')
        await editor.getByTestId('gc-task-due').fill('2026-10-14')
        await editor.getByTestId('gc-task-save').click()
        await expect.poll(() => google.sent('TASK POST').map((write) => write.body)).toEqual([{ title: 'Order seed potatoes', due: '2026-10-14T00:00:00.000Z' }])
        await expect(view.locator('.gc-task', { hasText: 'Order seed potatoes' })).toBeVisible()
    })

    test("adds a task from the journal entry, with no due date, in the list chosen for new tasks", async ({ page }) => {
        const google = withTasks()
        await openGraph(page, google, { scopes: `openid email ${TASKS}`, records: { 'default-task-list': { account: GARDENER, listId: 'list2' } } })
        const panel = journalTab(page, TODAY).getByTestId('gc-journal-panel')
        await expect(panel.getByTestId('gc-panel-task-list')).toHaveCount(1, { timeout: 15_000 })
        // On the Tasks heading, not the Calendar one.
        await expect(panel.getByTestId('gc-panel-head').getByTestId('gc-panel-add-task')).toHaveCount(0)
        await panel.getByTestId('gc-panel-tasks-head').getByTestId('gc-panel-add-task').click()
        const editor = page.getByTestId('gc-task-editor')
        await expect(editor.getByTestId('gc-task-due')).toHaveValue('')
        await expect(editor.getByTestId('gc-task-list')).toHaveValue(`${GARDENER}|list2`)
        await expect(editor.getByTestId('gc-task-title')).toBeFocused()
        await editor.getByTestId('gc-task-title').fill('Label the jam')
        await editor.getByTestId('gc-task-title').press('Enter')
        await expect.poll(() => google.sent('TASK POST').map((write) => [write.url.pathname, write.body])).toEqual([['/tasks/v1/lists/list2/tasks', { title: 'Label the jam' }]])
        await expect(editor).toHaveCount(0)
        // Not due, so among today's open tasks, under its list.
        await expect(panel.getByTestId('gc-panel-task-list').filter({ hasText: 'Kitchen jobs' }).getByTestId('gc-panel-task')).toHaveText([/^Label the jam\s*$/])
    })

    test('offers Add task beneath a day with no tasks while the events are off', async ({ page }) => {
        const google = withTasks()
        await openGraph(page, google, { scopes: `openid email ${TASKS}`, journal: false, openTasks: false }, { [`${TODAY}.md`]: '- plant the garlic\n', '2026-10-10.md': '- rest\n' })
        await page.evaluate(() => (window as unknown as { __etherpkLayout: { openView(view: unknown): void } }).__etherpkLayout.openView({ kind: 'document', target: '2026-10-10' }))
        const panel = journalTab(page, '2026-10-10').getByTestId('gc-journal-panel')
        await expect(panel.getByTestId('gc-panel-tasks-empty')).toHaveText('No tasks due', { timeout: 15_000 })
        await expect(panel.getByTestId('gc-panel-add')).toHaveCount(0)
        await panel.getByTestId('gc-panel-add-task').click()
        await expect(page.getByTestId('gc-task-editor').getByTestId('gc-task-title')).toBeFocused()
        await expect(page.getByTestId('gc-task-editor').getByTestId('gc-task-due')).toHaveValue('')
    })

    test('the calendar list sets where new tasks go, and a list deleted in Google gives way to the first list', async ({ page }) => {
        const google = withTasks()
        await openGraph(page, google, { scopes: `openid email ${TASKS}` })
        const view = await openCalendar(page)
        const picker = view.getByTestId('gc-default-task-list')
        await expect(picker).toHaveValue(`${GARDENER}|list1`, { timeout: 15_000 })
        // Below where new events go.
        const [events, tasks] = await Promise.all([view.getByTestId('gc-default-calendar').boundingBox(), picker.boundingBox()])
        expect(tasks!.y).toBeGreaterThan(events!.y)
        expect(await picker.evaluate((select) => getComputedStyle(select).appearance)).toBe('base-select')
        await picker.click()
        await view.getByRole('option', { name: 'Kitchen jobs' }).click()
        await expect(picker).toHaveValue(`${GARDENER}|list2`)
        await view.getByTestId('gc-add-task').click()
        const editor = page.getByTestId('gc-task-editor')
        await expect(editor.getByTestId('gc-task-list')).toHaveValue(`${GARDENER}|list2`)
        await editor.getByRole('button', { name: 'Cancel' }).click()

        delete google.accounts.get(GARDENER)!.tasks!.list2
        await page.reload()
        await expect(page.getByRole('button', { name: 'Calendar Events' }).first()).toBeVisible({ timeout: 30_000 })
        const again = await openCalendar(page)
        await expect(again.getByTestId('gc-default-task-list')).toHaveValue(`${GARDENER}|list1`, { timeout: 15_000 })
        await again.getByTestId('gc-add-task').click()
        await expect(page.getByTestId('gc-task-editor').getByTestId('gc-task-list')).toHaveValue(`${GARDENER}|list1`)
    })

    test('says why the task lists could not be read, and Retry reads them', async ({ page }) => {
        const google = withTasks()
        google.tasksRefused = true
        await openGraph(page, google, { scopes: `openid email ${TASKS}` })
        const view = await openCalendar(page)
        await expect(view.getByTestId('gc-banner')).toContainText('Google Tasks', { timeout: 15_000 })
        await expect(view.getByTestId('gc-account').getByRole('alert')).toContainText(/Tasks API/)
        await view.getByTestId('gc-add-task').click()
        const editor = page.getByTestId('gc-task-editor')
        await expect(editor.getByRole('alert')).toContainText(/Tasks API/)
        await expect(editor.getByTestId('gc-task-list')).toBeDisabled()
        google.tasksRefused = false
        await editor.getByRole('button', { name: 'Retry' }).click()
        await expect(editor.getByTestId('gc-task-list')).toBeEnabled()
        await expect(editor.getByTestId('gc-task-list')).toHaveValue(`${GARDENER}|list1`)
    })

    test('asks to connect again an account connected before sign-in asked for Tasks', async ({ page }) => {
        const google = withTasks()
        await openGraph(page, google)
        const view = await openCalendar(page)
        const account = view.getByTestId('gc-account')
        await expect(account.getByText('Connect again to show Google Tasks.')).toBeVisible({ timeout: 15_000 })
        const popup = page.waitForEvent('popup')
        await account.getByRole('button', { name: 'Connect again' }).click()
        await popup
        await view.getByTestId('gc-view-picker').selectOption('week')
        await expect(view.locator('.gc-task', { hasText: 'Buy compost' })).toBeVisible()
    })

    test("leaves tasks out beneath the journal entry while both task switches are off", async ({ page }) => {
        const google = withTasks()
        await openGraph(page, google, { scopes: `openid email ${TASKS}`, journalTasks: false, openTasks: false })
        const panel = journalTab(page, TODAY).getByTestId('gc-journal-panel')
        await expect(panel.getByTestId('gc-panel-event').first()).toBeVisible({ timeout: 15_000 })
        await expect(panel.getByTestId('gc-panel-task')).toHaveCount(0)
        await expect(panel.getByRole('heading', { name: 'Tasks', exact: true })).toHaveCount(0)
    })
})

test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('opens on the schedule, each event with its calendar, and shows details as a sheet', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        await page.evaluate(() => (window as unknown as { __etherpkLayout: { openView(view: unknown): void } }).__etherpkLayout.openView({ kind: 'google-calendar.calendar', target: 'calendar' }))
        const view = page.getByTestId('gc-view')
        await expect(view.getByTestId('gc-view-picker')).toHaveValue('schedule', { timeout: 15_000 })
        // The view picker stands as tall as the buttons beside it, with the same border.
        const [picker, create] = await Promise.all([view.getByTestId('gc-view-picker'), view.getByTestId('gc-create')].map((control) =>
            control.evaluate((element) => ({ height: element.getBoundingClientRect().height, border: getComputedStyle(element).borderTopColor, radius: getComputedStyle(element).borderTopLeftRadius })),
        ))
        expect(picker).toEqual({ ...create, border: picker.border })
        expect(picker.border).toBe(await view.getByRole('button', { name: 'Today' }).evaluate((element) => getComputedStyle(element).borderTopColor))
        const soup = view.locator('.ec-event', { hasText: 'Make the soup' })
        await expect(soup).toContainText('Kitchen')
        await expect(view.getByTestId('gc-calendar-list')).toHaveCount(0)
        await soup.click()
        const details = page.getByTestId('gc-details')
        await expect(details).toHaveClass(/gc-details--sheet/)
        const box = (await details.boundingBox())!
        expect(box.y + box.height).toBeGreaterThan(844 - 2)
    })

    test('keeps the view picker on the left of its row, and a tap on the calendar closes the calendar list', async ({ page }) => {
        const google = gardenGoogle()
        await openGraph(page, google)
        await page.evaluate(() => (window as unknown as { __etherpkLayout: { openView(view: unknown): void } }).__etherpkLayout.openView({ kind: 'google-calendar.calendar', target: 'calendar' }))
        const view = page.getByTestId('gc-view')
        await expect(view.getByTestId('gc-view-picker')).toBeVisible({ timeout: 15_000 })
        const [picker, toolbar] = await Promise.all([view.getByTestId('gc-view-picker').boundingBox(), view.locator('.gc-toolbar').boundingBox()])
        expect(picker!.x - toolbar!.x).toBeLessThan(24)
        await view.getByRole('button', { name: 'Show the calendar list' }).click()
        await expect(view.getByTestId('gc-calendar-list')).toBeVisible()
        await view.getByTestId('gc-list-scrim').click({ position: { x: 360, y: 300 } })
        await expect(view.getByTestId('gc-calendar-list')).toHaveCount(0)
    })
})
