---
title: Calendars
description: Connect iCloud, Fastmail, Nextcloud, any CalDAV calendar, a calendar's private link, Google Calendar or Cal.com. Busy times take those times off what your Inbox offers; the bookings it confirms go into your calendar.
---

Your Inbox offers times from the opening hours you set. A calendar you connect makes those times honest: when it says you are busy, agents are not offered that time, and every booking your Inbox confirms is written into it, moved when the booking moves and taken off when it is cancelled.

Settings → Integrations → **Calendar** (iCloud, Fastmail, Nextcloud, any other that speaks CalDAV, a calendar link, or Google) or **Cal.com**.

## What it does, and what it never does

- **Busy times only remove times.** A busy time in your calendar takes that time off what your Inbox offers and refuses to confirm a booking over it. It never moves, cancels or refuses a booking that was already confirmed.
- **It takes the whole time.** For a service that takes several people at once, a busy time blocks all of its places: it means *you* are busy.
- **All services, or the ones you choose.** Settings → Integrations → **Change**.
- **About three months ahead.** Busy times are read 92 days ahead. Past that, no time is offered while a calendar is connected: a time nobody knows is free is not offered as free. A calendar with more ahead than is read says so on its connection, and the times after it stay closed.
- **Your own bookings never block themselves.** The events your Inbox writes are recognised as its own and left out of busy times, whichever connection wrote them.
- **Free events stay free.** An event marked *free* in your calendar app does not block anything, and neither does a cancelled one. An all-day event blocks the day only when it is marked *busy*: birthdays and holidays sit on whole days and are rarely meant to close a business.
- **Test bookings never go out.** Bookings made in test mode stay in your Inbox.
- **Disconnecting stops the busy times at once.** Bookings already written stay in your calendar: they are your entries now.

Busy times are read every five minutes, and **Sync now** reads them at once. A booking goes into the calendar within seconds of being confirmed.

When a connection stops working (an app password withdrawn, a key that expired), it says **Failing** with the reason, you get one email, and the inbox shows it beside Settings. **Connect again** asks only for the new password or key; everything you chose stays. Until then its last busy times keep blocking, and new events in that calendar do not. A sign-in refused for a day is not tried again until you connect again or press **Sync now**.

## iCloud, Fastmail, Nextcloud and other CalDAV calendars

You give an email and an **app password**, never your usual password:

| | Where to make the app password |
| --- | --- |
| **iCloud** | [account.apple.com](https://account.apple.com/account/manage/section/security) → Sign-In and Security → App-Specific Passwords. Apple shows it once: copy it. Your Apple Account needs two-factor authentication. |
| **Fastmail** | Settings → Privacy & Security → Manage app passwords and access → New app password, with calendar access ([how](https://www.fastmail.help/hc/en-us/articles/360058752854)). |
| **Nextcloud** | Settings → Security → Devices & sessions → Create new app password. Give your Nextcloud's address too. |
| **Other** | Your provider's settings. The server is found from your email's domain (its DNS `_caldavs._tcp` record, then `/.well-known/caldav`); if it is not, add its address under **More options**. |

Every calendar for events in the account blocks busy times until you choose otherwise, and bookings go to the first one you can write to. **Change** changes both.

Gmail and Outlook addresses are told at once where they connect instead: their calendars do not open with an app password.

## A calendar link

**Calendar link** takes the private link your calendar gives for subscribing to it, the one that ends in `.ics` (Google: Settings → your calendar → *Secret address in iCal format*; Outlook: Settings → Calendar → Shared calendars → *Publish a calendar*). It blocks your busy times and adds nothing to the calendar. The link is a secret: anyone who has it can read the calendar, so it is kept like a password and never shown again. Use it for a calendar that cannot connect here yet.

## Cal.com

Paste an API key from Cal.com: **Settings → Developer → API keys → New**, with *Never expires* on. It is checked against Cal.com before anything is kept.

- **Busy times** are your Cal.com bookings, and the calendars Cal.com checks for conflicts.
- **Bookings** are created on the event type as long as the booking, or the one you choose. The customer is named, but Cal.com is given no email for them, so Cal.com sends them nothing: your Inbox has already told them. A booking that moves is rescheduled in Cal.com; one that is cancelled is cancelled there.
- A time Cal.com will not take is said in Settings, on the connection, in Cal.com's own words.
- Cal.com adds the bookings it is given to the calendar it checks. If you connect that calendar here too, Settings offers to stop one of them adding bookings, so each shows once.
- Cal.com cannot change the name on a booking it has: when a customer is erased, their name stays on the Cal.com bookings already made. Calendars connected directly lose it on the next sync.

For a Cal.com you run yourself, give its API address under **More options**.

## Google Calendar

**Continue with Google** signs you in on Google's own page. Google asks to let the Inbox see when you are busy (`calendar.freebusy`, times only, never what your events are) and to manage events on calendars you own (`calendar.events.owned`), which it uses only to add, move and remove the bookings it confirms; and who you are (`openid email`), so the connection is known by your Google account and not by a calendar's name. It reads and writes your main calendar.

Google needs an OAuth client. On a hosted inbox, Google shows as **Soon** until our Google client is approved; then it works with nothing to set up. On your own server, create one in Google Cloud (an OAuth client of type *Web application*, with `https://<your inbox>/oauth/connect/google_calendar/callback` as its redirect URI and the Google Calendar API switched on) and set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`; until then Google shows as **set up**. For a business's own Google Workspace, an *Internal* app needs no verification by Google. Until Google is connected, a [calendar link](#a-calendar-link) blocks your Google calendar's busy times.

## Secrets

App passwords, API keys, calendar links and Google's tokens are sealed with your `INBOX_SECRET_KEY` (AES-256-GCM) before they are stored, and no answer of any door ever carries them back, to you or to your AI. Without `INBOX_SECRET_KEY` nothing can be connected. Every call to a calendar goes over https to a public address, with the same checks as [webhooks](/docs/webhooks/): no private or local address, redirects followed by hand and checked again, and a limit on time and size. An app password goes only to the calendar server that asks for it: every address found on the way is asked first without it, a redirect to another host goes without it (iCloud's own hosts excepted), and a calendar a server names on another host is refused.

## Over the API

```bash
# What can be connected, and what is
curl https://<your-instance>/v1/owner/integrations -H "authorization: Bearer sdi_own_…"

# Connect iCloud
curl -X POST https://<your-instance>/v1/owner/integrations \
  -H "authorization: Bearer sdi_own_…" -H 'content-type: application/json' \
  -d '{ "kind": "caldav", "preset": "icloud", "values": { "username": "you@icloud.com", "password": "abcd-efgh-ijkl-mnop" } }'

# Connect it again with a new app password, keeping every choice
curl -X POST https://<your-instance>/v1/owner/integrations \
  -H "authorization: Bearer sdi_own_…" -H 'content-type: application/json' \
  -d '{ "kind": "caldav", "connection_id": "<id>", "values": { "password": "qrst-uvwx-yzab-cdef" } }'
```

`PATCH /v1/owner/integrations/{id}` chooses calendars (`busy_calendars`), where bookings go (`destination`), which services busy times apply to (`services`, `null` for all) and pauses (`paused`); `POST …/{id}/sync` syncs now; `DELETE …/{id}` disconnects. `POST /v1/owner/integrations/authorize` with `{"kind": "google_calendar"}` answers the address to open for Google's sign-in. Connecting, changing and disconnecting are yours, in person: your AI and an integration key are refused (`403`). Your AI, over the owner MCP, can `list_integrations` and `sync_integration`, and an integration key with `integrations:write` can list and sync.

## Writing a connector

A connector is a small object in `packages/adapters/src/connectors`: what it does for the Inbox (`busy_times`, `write_bookings`), a Zod schema for what the owner gives it with its secret fields marked (`secretField`), and the handlers that sync. The Settings form is drawn from the schema; sealing, the HTTP client's checks, claims that stop two jobs writing one booking twice, the five-minute schedule and its back-off, and telling the owner when it fails are the Inbox's. See `packages/core/src/connectors/sdk.ts`.
