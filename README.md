# Events for Google Calendar

An [EtherPK](https://etherpk.com) extension that shows and edits your Google Calendar inside EtherPK.

- **Calendar Events**, a tab with day, week, four day, month, year and schedule views of every
  calendar you tick, in the colours you chose in Google Calendar. The Calendar Events button in the
  graph sidebar opens it.
- **Each day's events and tasks beneath that day's journal entry**: the events first, all-day ones at
  the top, each with the name of its calendar, then the Google Tasks due that day under Due tasks,
  each with its task list. Today's entry also lists every task not yet completed, due or not,
  grouped by task list. A switch in the extension's settings turns off each of the three.
- **Google Tasks** on their days, from the task lists you tick under each account, as calendars are.
- **Editing as in Google Calendar**: create, edit, drag to move, drag to resize and delete events,
  with Undo. Repeating events ask whether a change is for this event, this and following events, or
  all events. You can set guests and what they may do, a Google Meet link, notifications, colour or
  label, busy or free, visibility, attachments, and a formatted description, and answer invitations.
- **Several Google accounts**, each with its own calendars.

It is listed in the EtherPK Extension Directory. Install it in EtherPK from Settings and Extensions,
then Extensions. It needs EtherPK 0.11.0 or later.

Google stays the only store of your events. Nothing about them is written into your graph, so they
are never synced with it, searched, exported or published.

Works with Google Calendar™. Google Calendar is a trademark of Google LLC. This extension is not made
or endorsed by Google.

## Setting it up

The extension reads and changes your calendar through an OAuth client you make in your own Google
Cloud project. This takes about ten minutes, once. Calendar Events shows these steps too, with your
EtherPK's own addresses and Copy buttons.

1. [Create a Google Cloud project](https://console.cloud.google.com/projectcreate).
2. Turn on:
   - [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
   - [Google Tasks API](https://console.cloud.google.com/apis/library/tasks.googleapis.com)
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) (for attachments)
3. Set up the [consent screen](https://console.cloud.google.com/auth/branding). Give the app a name
   such as EtherPK Calendar, choose External, and add your email address. Under Audience, choose
   Publish app, so your sign-in does not end after 7 days. Google does not review an app only you
   use: when you sign in it warns that the app is unverified, and Advanced, then Go to the app's
   name, carries on.
4. [Create an OAuth client](https://console.cloud.google.com/auth/clients/create) of the type Web
   application. Add your EtherPK's address (for example `https://app.etherpk.com`) as an Authorised
   JavaScript origin, and the same address followed by `/extension-sign-in` as an Authorised
   redirect URI - e.g:

   ```
   Authorised JavaScript origins:

   https://app.etherpk.com
   
   Authorised redirect URIs:
   
   https://app.etherpk.com/extension-sign-in
   ```

5. Paste the client's Client ID and Client secret into Calendar Events, or into the extension's
   settings in Settings and Extensions, then press Connect Google account.

A work or school account may need its administrator to trust your Client ID, under Security, API
controls, Manage app access in the Google Admin console.

Following set up, with the extension enabled go back to the EtherPK user interface where you will be prompted to sign in using your Google OAuth client.

## What is kept, and where

- The Client ID and Client secret are the extension's settings.
- Each connected account's sign-in (a refresh token) and your calendar and task list choices are
  kept with your other EtherPK settings.

Where you sync with an EtherPK Sync Server, both follow you to your other devices, encrypted on your
device so the server cannot read them. Without sync they stay on the device. Any code running in
EtherPK's page can read them, as it can every setting, and so can an agent you gave an agent token
for your account. Disconnect ends an account's sign-in at Google, on every device. Uninstalling the
extension clears its records. You can also remove the app at any time from your Google account's
[third-party access](https://myaccount.google.com/connections).

Events are kept in memory only, while EtherPK is open. Your browser talks to Google directly, and no
EtherPK server sees your events.

## Developing

```bash
pnpm install
pnpm build          # dist/main.js and dist/main.css
pnpm test           # unit tests
pnpm check          # type check
ETHERPK_CLIENT_DIR=../etherpk pnpm test:e2e   # browser tests against an EtherPK checkout
```

The browser tests start the EtherPK Client from `ETHERPK_CLIENT_DIR` as a development server that
loads this extension, and answer Google's addresses themselves, so they never reach Google.

## Licence

MIT
