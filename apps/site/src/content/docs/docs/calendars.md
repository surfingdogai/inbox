---
title: Calendars
description: Connect Cal.com, Google Calendar, iCloud, Fastmail, Nextcloud or any CalDAV calendar. Busy times take those times off what your Inbox offers; the bookings it confirms go into your calendar.
---

Your Inbox offers times from the opening hours you set. A calendar you connect makes those times honest: when it says you are busy, agents are not offered that time, and every booking your Inbox confirms is written into it, moved when the booking moves and taken off when it is cancelled.

Settings → Integrations → **Calendar** (Google, iCloud, Fastmail, Nextcloud, or any other that speaks CalDAV) or **Cal.com**.

## What it does, and what it never does

- **Busy times only remove times.** A busy time in your calendar takes that time off what your Inbox offers and refuses to confirm a booking over it. It never moves, cancels or refuses a booking that was already confirmed.
- **It takes the whole time.** For a service that takes several people at once, a busy time blocks all of its places: it means *you* are busy.
- **All services, or the ones you choose.** Settings → Integrations → **Choose**.
- **Your own bookings never block themselves.** The events your Inbox writes are recognised as its own and left out of busy times.
- **Free events stay free.** An event marked *free* in your calendar app does not block anything, and neither does a cancelled one. An all-day event blocks the day only when it is marked *busy*: birthdays and holidays sit on whole days and are rarely meant to close a business.
- **Test bookings never go out.** Bookings made in test mode stay in your Inbox.
- **Disconnecting stops the busy times at once.** Bookings already written stay in your calendar: they are your entries now.

Busy times are read every five minutes, and **Sync now** reads them at once. A booking goes into the calendar within seconds of being confirmed.

## iCloud, Fastmail, Nextcloud and other CalDAV calendars

You give an email and an **app password**, never your usual password:

| | Where to make the app password |
| --- | --- |
| **iCloud** | [account.apple.com](https://account.apple.com/account/manage) → Sign-In and Security → App-Specific Passwords. Your Apple Account needs two-factor authentication. |
| **Fastmail** | Settings → Privacy & Security → Manage app passwords and access → New app password, with calendar access ([how](https://www.fastmail.help/hc/en-us/articles/360058752854)). |
| **Nextcloud** | Settings → Security → Devices & sessions → Create new app password. Give your Nextcloud's address too. |
| **Other** | Your provider's settings. The server is found from your email's domain (its DNS `_caldavs._tcp` record, then `/.well-known/caldav`); if it is not, add its address under **More options**. |

Every calendar for events in the account blocks busy times until you choose otherwise, and bookings go to the first one you can write to. **Choose** changes both.

## Cal.com

Paste an API key from Cal.com: **Settings → Developer → API keys**. It is checked against Cal.com before anything is kept.

- **Busy times** are your Cal.com bookings, and the calendars Cal.com checks for conflicts.
- **Bookings** are created on the event type as long as the booking, or the one you choose. The customer is named, but Cal.com is given no email for them, so Cal.com sends them nothing: your Inbox has already told them. A booking that moves is rescheduled in Cal.com; one that is cancelled is cancelled there.
- A time Cal.com will not take (outside the hours you set in Cal.com) is said in Settings, on the connection, in Cal.com's own words.

For a Cal.com you run yourself, give its API address under **More options**.

## Google Calendar

**Continue with Google** signs you in on Google's own page. The Inbox asks for two permissions and no more: to see when you are busy (`calendar.freebusy`, times only, never what your events are) and to add, move and remove the bookings it confirms on your own calendars (`calendar.events.owned`). It reads and writes your main calendar.

Google needs an OAuth client. Hosted inboxes have ours. On your own server, create one in Google Cloud (an OAuth client of type *Web application*, with `https://<your inbox>/oauth/connect/google_calendar/callback` as its redirect URI and the Google Calendar API switched on) and set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. For a business's own Google Workspace, an *Internal* app needs no verification by Google. Without a client, Google shows as **Soon**.

## Secrets

App passwords, API keys and Google's tokens are sealed with your `INBOX_SECRET_KEY` (AES-256-GCM) before they are stored, and no answer of any door ever carries them back, to you or to your AI. Without `INBOX_SECRET_KEY` nothing can be connected. Every call to a calendar goes over https to a public address, with the same checks as [webhooks](/docs/webhooks/): no private or local address, redirects followed by hand and checked again, and a limit on time and size. A sign-in follows a redirect only within the calendar's own site.

## Over the API

```bash
# What can be connected, and what is
curl https://<your-instance>/v1/owner/integrations -H "authorization: Bearer sdi_own_…"

# Connect iCloud
curl -X POST https://<your-instance>/v1/owner/integrations \
  -H "authorization: Bearer sdi_own_…" -H 'content-type: application/json' \
  -d '{ "kind": "caldav", "preset": "icloud", "values": { "username": "you@icloud.com", "password": "abcd-efgh-ijkl-mnop" } }'
```

`PATCH /v1/owner/integrations/{id}` chooses calendars (`busy_calendars`), where bookings go (`destination`), which services busy times apply to (`services`, `null` for all) and pauses (`paused`); `POST …/{id}/sync` syncs now; `DELETE …/{id}` disconnects. `POST /v1/owner/integrations/authorize` with `{"kind": "google_calendar"}` answers the address to open for Google's sign-in. Your AI, over the owner MCP, can `list_integrations` and `sync_integration`; connecting takes your password or your sign-in, so only you do it.

## Writing a connector

A connector is a small object in `packages/adapters/src/connectors`: what it does for the Inbox (`busy_times`, `write_bookings`), a Zod schema for what the owner gives it with its secret fields marked (`secretField`), and the handlers that sync. The Settings form is drawn from the schema; sealing, the HTTP client's checks, claims that stop two jobs writing one booking twice, and the five-minute schedule are the Inbox's. See `packages/core/src/connectors/sdk.ts`.
