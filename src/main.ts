/**
 * Events for Google Calendar: the extension's entry module, which the Client imports from its own
 * origin and calls `activate` on as each graph opens.
 *
 * It adds the Calendar Events View (day, week, four days, month, year and schedule), a Graph Sidebar
 * button that opens it, and a Journal Panel listing each day's events and Google Tasks beneath that
 * day's entry, while the person leaves a journal switch on. Events and tasks come from Google and
 * stay there: nothing about them is written into the graph.
 */
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'

import { CalendarApp } from './app/app.svelte'
import { sveltePanel, svelteView } from './svelte-mount.svelte'
import CalendarView from './ui/CalendarView.svelte'
import JournalPanel from './ui/JournalPanel.svelte'
import './styles.css'

export const VIEW_KIND = 'google-calendar.calendar'
export const OPEN_COMMAND = 'google-calendar.open'
const PANEL_ID = 'google-calendar.day'

export function activate(context: ExtensionContext): () => void {
    const app = new CalendarApp(context)
    context.views.register(VIEW_KIND, svelteView(CalendarView, { app }))
    context.commands.register(OPEN_COMMAND, (day) => app.openCalendar(typeof day === 'string' ? day : undefined))
    context.graphSidebar.register({
        id: OPEN_COMMAND,
        title: 'Calendar Events',
        description: 'Open your Google Calendar events',
        icon: 'calendar-events',
        order: 25,
        command: OPEN_COMMAND,
    })

    // The Journal Panel is there while any journal switch is on (events, due tasks, open tasks), and
    // taken back when all are off.
    let withdrawPanel: (() => void) | null = null
    const followSwitch = () => {
        const wanted = app.journalEvents || app.journalTasks || app.journalOpenTasks
        if (wanted && !withdrawPanel) withdrawPanel = context.journalPanels.register(sveltePanel(PANEL_ID, JournalPanel, { app }))
        else if (!wanted && withdrawPanel) {
            withdrawPanel()
            withdrawPanel = null
        }
    }
    followSwitch()
    const stopFollowing = context.settings.subscribe(followSwitch)

    return () => {
        stopFollowing()
        app.destroy()
    }
}
