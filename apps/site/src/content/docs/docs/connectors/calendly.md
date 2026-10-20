---
title: Calendly
description: Connect Calendly with a token you make in your own account. What is booked on Calendly is never offered twice, and bookings your Inbox confirms are held on Calendly too.
sidebar:
  order: 4
---

If you already take bookings on Calendly, your Inbox works with it. Times booked on Calendly, or busy in a calendar Calendly checks, are not offered to agents. Each booking your Inbox confirms is held on Calendly too, so nobody books that time there.

Settings → Integrations → **Calendly** → **Connect**.

## Connecting

1. In Calendly: **Integrations & apps → API & webhooks → Generate new token** ([open it](https://calendly.com/integrations/api_webhooks)).
2. Name it after your Inbox, and tick `users:read`, `event_types:read`, `availability:read`, `scheduled_events:write` and `webhooks:write`.
3. Create it, copy the token (Calendly shows it once), and paste it into your Inbox.

The token is checked with Calendly before anything is kept. It is encrypted before it is stored, and never shown again, to you or to your AI.

Then, under **Change**, choose where bookings go: **Same length as the booking** (the default), or one event type.

## What your Inbox reads and writes

| | |
| --- | --- |
| **Reads** | Your account (name, email, booking page), your event types, and your busy times: your Calendly events and the calendars Calendly checks for conflicts. Never your invitees' details. |
| **Writes** | One Calendly event per booking your Inbox confirms, on a one-on-one event type of the same length. Moved in your Inbox: a new event, then the old one cancelled. Cancelled in your Inbox: cancelled on Calendly. |
| **Webhook** | One, at your Inbox's own address, for bookings made or cancelled on Calendly. Each delivery is signed with a key made for it, and only its ids are kept. |

- **Your customer hears from you, not from Calendly.** Calendly emails whoever is booked, so the booking is made in your name, with your customer's name on it. Calendly writes to you, and your Inbox has already told your customer.
- **Event types it can use** are one-on-one, booked at once, with no required question and a place you set (an address, a video call, your phone). Group events, polls, and event types that ask the customer where to meet are left out.
- **Busy times are read every five minutes**, about three months ahead, and at once when Calendly's webhook says something changed.
- **A booking made on Calendly blocks its time here.** It stays on Calendly: it does not become a booking in your Inbox.
- Calendly cannot rename a booking: when a customer is erased, their name stays on the Calendly events already made.

## Calendly's plans

| | Free | Standard and above |
| --- | --- | --- |
| Busy times | yes | yes |
| Bookings held on Calendly | no | yes |
| Webhook | no | yes |

On Free, Calendly lets other apps read, not book ([Calendly](https://developer.calendly.com/api-docs/calendly-api/scheduled-events/create-event-invitee)). The first booking your Inbox tries says so on the connection. Switch off **Add confirmed bookings** under **Change** to keep Calendly's busy times only. Without the webhook, the five-minute sync covers it.

Calendly limits how many bookings other apps make: 10 a minute and 100 a day on a paid plan ([rate limits](https://developer.calendly.com/api-docs/overview/rate-limits)). Past that, your Inbox waits and tries again.

## Disconnecting

Settings → Integrations → **Calendly** → **Disconnect**. Your Inbox stops reading at once and removes its webhook from Calendly. Events already made on Calendly stay there: they are yours now.

A token can only be revoked in Calendly: **Integrations & apps → API & webhooks**, then **Revoke** beside it.
