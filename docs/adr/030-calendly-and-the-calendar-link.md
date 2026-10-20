# ADR-030 — Calendly, and the calendar link to share

**Status:** proposed, 20 October 2026. Builds on ADR-022 (calendars) and ADR-026 (the shared base for
connectors). Two connectors: Calendly (`calendly`), with the business's own token, and a calendar of the
inbox's confirmed bookings that another platform imports by link (`ics_feed`). No spec change.

## Context

Many businesses that book by appointment already take bookings on Calendly: trades, consultants, salons,
studios. Their inbox must not offer what Calendly has sold, and what the inbox confirms must not be sold
again on Calendly. Others sell the same nights or slots on a booking site (a guesthouse on two of them, a
studio with a second booking page): those sites import a calendar by link, and the inbox already reads
one (`ics`, ADR-022). What was missing was the other direction.

## Decisions

### 1. Calendly: the business's own token

- The owner makes a **personal access token** in Calendly (Integrations & apps → API & webhooks) with
  `users:read`, `event_types:read`, `availability:read`, `scheduled_events:write` and `webhooks:write`
  (https://developer.calendly.com/docs/authentication/scopes), and pastes it. It is checked against
  `GET /users/me` before anything is kept, and sealed. One form way on both editions; a one-click sign-in
  needs a Calendly OAuth app of the founder's (`CALENDLY_CLIENT_ID`, read by the base and unused here).
- The token goes to `https://api.calendly.com` and nowhere else: requests are built from paths, never from
  an address an answer named; ids read back are taken only from `https://api.calendly.com/<kind>/<id>`.
- Calendly offers no way to revoke a personal access token over its API, so the disconnect sheet says
  where to revoke it (`disconnectNote`).

### 2. Busy times in

`GET /user_busy_times` (https://developer.calendly.com/api-docs/calendly-api/availability/list-user-busy-times)
holds the Calendly events and the events of every calendar Calendly checks for conflicts. It takes seven
days a call and no start in the past, so the 92 days ahead are read a week at a time from the next whole
minute (fourteen calls; past fourteen weeks the read says how far it got, `BusyRead`). A Calendly event's
buffers count (`buffered_start_time`). Events this inbox made are left out by the ids it keeps for them;
their copies in a connected calendar, which carry no id here, by their times (`own.spans`), as Cal.com.

### 3. Bookings out, where Calendly's plan allows

- Through the Scheduling API, `POST /invitees`
  (https://developer.calendly.com/api-docs/calendly-api/scheduled-events/create-event-invitee), which
  Calendly opens to **Standard and above**; the Free plan is answered 403. On Free the connector does
  busy times only: the first booking it tries says so on the connection, in one line with what to do
  (switch off Add confirmed bookings) and the business's own booking page; the owner keeps busy times.
- **The invitee is the business itself.** Calendly requires an invitee email and emails whoever it names
  (notifications run "as if booked via the Calendly UI"), so the invitee is the account's own address
  under the customer's name, in the business's time zone. The customer, whom the inbox has told already,
  hears nothing from Calendly; the base gives a booking writer no customer email in any case (ADR-026 §2,
  rule 5). The list's option "let Calendly email the customer too" is not built: it would need the
  customer's email given to a writer, a base change.
- **Event types it can use:** active, standard, one-on-one (`kind: solo`), booked at once (not a poll),
  the owner's own, with no enabled required question, and a place the business sets (an address, a
  conference, the business's phone). The location sent is the event type's own, read again just before
  each booking. A group event type is left out: its event is shared with others who booked it, and
  Calendly cancels events, not invitees. "Same length as the booking" picks the first that fits; the
  Scheduling API takes no length, so a booking goes only to an event type of exactly its length.
- **Moving** makes the new event first and cancels the old one after: Calendly has no reschedule in its
  API. When Calendly refuses the new time because the old event holds part of it, the old one is
  cancelled first and the new one made; when that is refused too the booking stays in the inbox, the
  owner sees Calendly's words, and the next try makes it. **Cancelling** is
  `POST /scheduled_events/{uuid}/cancellation`; gone, cancelled already, or over is done.
- Each invitee carries a mark only this inbox can make (`tracking.utm_content`, from `ctx.marker`), by
  which a run that stopped before noting an event finds it (`find`, filtered by the business's address).
- Calendly cannot rename an invitee: after a customer is erased their name stays on Calendly events
  already made, as on Cal.com.
- Calendly limits invitee creation to 10 a minute, 50 an hour and 100 a day on paid non-Enterprise plans
  (https://developer.calendly.com/api-docs/overview/rate-limits); a 429 waits `X-RateLimit-Reset`.

### 4. Webhooks are a nudge

- In `connect`, when the inbox can be reached (`hookUrl`, `hooksLive`), one user-scoped subscription to
  `invitee.created` and `invitee.canceled` at the connection's own address, with a signing key the inbox
  makes for it (32 random bytes), sealed beside the token. Calendly sends webhooks on paid plans only
  (https://developer.calendly.com/docs/getting-started/frequently-asked-questions): a 403 leaves the
  connection on polling, tried again on the six-hourly refresh.
- `Calendly-Webhook-Signature: t=…,v1=…` is HMAC-SHA-256 over `t.body`, compared in constant time, and
  `t` must be within three minutes either way
  (https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures).
- A delivery's id is its topic and the invitee's id: an invitee is made once and cancelled at most once,
  so a delivery Calendly sends again is counted once. Only the scheduled event's and the invitee's ids
  are kept, never the name or email in the body.
- What it does: busy times are read again at once (`HookFact` `busy`). **A booking made on Calendly does
  not become an inbox booking**: the base has no fact for it, and polling already blocks its time. A
  booking the inbox made and the business cancelled on Calendly stays confirmed in the inbox; telling the
  owner would need a base fact too. Both are left for a decision.
- Refresh keeps the subscription pointed at the inbox: one Calendly disabled (deliveries failing for a
  day) or that points at an old address is deleted and made again with a new key; one still to add is
  added once the inbox is live. Disconnecting deletes it.

### 5. The calendar link to share

- `auth: "link"`, served at `GET /v1/feeds/ics_feed/<token>.ics` by the base (ADR-026 §5): a 32-byte
  token, its hash for the lookup, sealed for the owner to see again; **Make a new link** stops the old
  one at once; shown to the owner in person only; `noindex`, no cookies, `private, max-age=300`.
- RFC 5545 (https://www.rfc-editor.org/rfc/rfc5545): one `VCALENDAR`, `METHOD:PUBLISH`, the business's
  name as `X-WR-CALNAME`, CRLF, lines folded at 75 octets. Confirmed bookings from 30 days back to 18
  months ahead, each a `VEVENT` with `SUMMARY` the service's name ("Booked" without one), times in UTC,
  `STATUS:CONFIRMED`, `TRANSP:OPAQUE`, `SEQUENCE` the item's version, and `DTSTAMP`/`LAST-MODIFIED` its
  last change, so the same bookings give the same bytes and an `ETag` answers 304 to an importer that
  has them. Nothing about who booked, no price, no address of the inbox's.
- A booking that starts and ends at midnight in the business's zone, a day or more long, is an all-day
  event (`VALUE=DATE`), ready for nights when the stay model lands. An unknown zone gives times.
- **No loops.** Each `UID` is `ownUid(item, inbox)`, the one CalDAV writes, so an importer updates the
  event in place, and the inbox's own calendar link (`ics`) skips it when a platform copies it back
  (`isOwnUid`), even when it reads its own link.

## Consequences

- `builtInConnectors` gains `calendlyConnector()` and `icsFeedConnector()`; their gallery cards are no
  longer `building`, so the gallery offers them wherever this release runs. No migration, no spec change,
  no dependency.
- The site's connector pages (`docs/connectors/calendly.md`, `calendar-link.md`) describe them; the
  integrations page keeps "Being built" until this is merged and deployed (ADR-026 §6).
- Not here: OAuth for Calendly; Calendly bookings as inbox items; a Calendly-side cancel told to the
  owner; booking sites' all-day exports counting as busy without `TRANSP:OPAQUE` (the `ics` connector
  counts an all-day event only when it is marked busy, ADR-022; many booking sites mark none).
