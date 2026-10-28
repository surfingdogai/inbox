---
title: Calendly
description: Sign in with Calendly, or connect with a token you make in your own account. What is booked on Calendly is never offered twice, and on Calendly's paid plans bookings your Inbox confirms are held there too.
sidebar:
  order: 4
---

Built from Calendly's documentation and tested against a stand-in; not yet run with a real account.

If you already take bookings on Calendly, your Inbox works with it. Times booked on Calendly, or busy in a calendar Calendly checks, are not offered to agents. On Calendly's Standard plan and above, each booking your Inbox confirms is held on Calendly too, so nobody books that time there.

Settings → Integrations → **Calendly**.

## Sign in with Calendly

**Continue with Calendly** opens Calendly's own page, where you allow your Inbox to see when you are busy, read your event types and add the bookings it confirms. Nothing to copy or paste.

It needs a Calendly app on the server that runs your Inbox. On a hosted Inbox it is coming soon; until then, use a token. On your own server, register an app at [developer.calendly.com](https://developer.calendly.com/docs/authentication/creating-an-oauth-app) (a web app, production environment) with the scopes below and the redirect `https://<your inbox>/oauth/connect/calendly/callback`, then set `CALENDLY_CLIENT_ID` and `CALENDLY_CLIENT_SECRET`.

## Or a token

Under **More options** (or straight away, while signing in is not set up here):

1. In Calendly: **Integrations & apps → API & webhooks → Generate new token** ([open Calendly](https://calendly.com/integrations/api_webhooks)).
2. Name it Inbox. Under scopes, tick: `users:read` · `organizations:read` · `event_types:read` · `availability:read` · `scheduled_events:write` · `webhooks:write`
3. Create it and copy it: Calendly shows it once. Paste it into your Inbox.

The token is checked with Calendly before anything is kept. It is encrypted before it is stored, and never shown again, to you or to your AI.

Then, under **Change**, choose the **Event type** bookings go to: **Same length as the booking** (the default), or one event type.

## What your Inbox reads and writes

| | |
| --- | --- |
| **Reads** | Your account (name, email, booking page), your plan, your event types, and your busy times: your Calendly events and the calendars Calendly checks for conflicts. Never keeps your invitees' details: a webhook's body carries them, and only its ids are kept. |
| **Writes** | On a paid plan, one Calendly event per booking your Inbox confirms, on a one-on-one event type of the same length. Moved in your Inbox: a new event, then the old one cancelled. Cancelled in your Inbox: cancelled on Calendly. |
| **Webhook** | On a paid plan, one, at your Inbox's own address, for bookings made or cancelled on Calendly. Each delivery is signed with a key made for it. |

- **Your customer hears from you, not from Calendly.** Calendly emails whoever is booked, so the booking is made in your name, with your customer's name on it. Calendly writes to you, and your Inbox has already told your customer.
- **Event types it can use** are one-on-one, booked at once, with no required question and a place you set (an address, a video call, your phone). Group events, polls, and event types that ask the customer where to meet are left out. If none qualifies, the connection says so, and busy times still work.
- **Lengths.** Calendly books an event type at its own length. If a service of yours has no event type that long, the connection names it ("No 45-min event type on Calendly: …"), so you can add one in Calendly.
- **Busy times are read every five minutes**, about three months ahead, and at once when Calendly's webhook says something changed.
- **A booking made on Calendly blocks its time here.** It stays on Calendly: it does not become a booking in your Inbox.
- **Calendar too?** Calendly adds its bookings to the calendar it checks. If that calendar adds your Inbox's bookings as well, Settings offers to stop one of them, so each shows once.
- Calendly cannot rename a booking: when a customer is erased, their name stays on the Calendly events already made.

## Calendly's plans

| | Free | Standard and above |
| --- | --- | --- |
| Busy times | yes | yes |
| Bookings held on Calendly | no | yes |
| Webhook | no | yes |

Your Inbox reads your plan when you connect. On Free, Calendly lets other apps read, not book ([Calendly](https://developer.calendly.com/api-docs/calendly-api/scheduled-events/create-event-invitee)), so the connection starts with **Add confirmed bookings** off and says **Calendly Free: busy times only**. Block times your Inbox books on Calendly yourself, or upgrade there: the connection notices within six hours, and you switch bookings on under **Change**. Without the webhook, the five-minute sync covers it.

Calendly limits how many bookings other apps make: 10 a minute and 100 a day on a paid plan ([rate limits](https://developer.calendly.com/api-docs/overview/rate-limits)). Past that, your Inbox waits and tries again.

## Disconnecting

Settings → Integrations → **Calendly** → **Disconnect**. Your Inbox stops reading at once, removes its webhook from Calendly, and gives back the access you allowed when you signed in. Events already made on Calendly stay there: they are yours now.

A token can only be revoked in Calendly: **Integrations & apps → API & webhooks**, then **Revoke** beside it.
