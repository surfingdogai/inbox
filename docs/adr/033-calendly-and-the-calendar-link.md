# ADR-033 — Calendly, and the calendar link to share

**Status:** proposed, 20 October 2026. Builds on ADR-022 (calendars) and ADR-030 (the shared base for
connectors). Two connectors: Calendly (`calendly`), signed in with Calendly or with the business's own
token, and a calendar of the inbox's confirmed bookings that another platform imports by link
(`ics_feed`, shown as **Share your bookings**). No spec change.

## Context

Many businesses that book by appointment already take bookings on Calendly: trades, consultants, salons,
studios. Their inbox must not offer what Calendly has sold, and what the inbox confirms must not be sold
again on Calendly. Others sell the same nights or slots on a booking site (a guesthouse on two of them, a
studio with a second booking page): those sites import a calendar by link, and the inbox already reads
one (`ics`, ADR-022). What was missing was the other direction.

## Decisions

### 1. Calendly: sign in with Calendly, or the business's own token

- **Sign in with Calendly first** (preset `oauth`, "Continue with Calendly"): the authorization code flow
  with PKCE (S256) at `https://auth.calendly.com/oauth/authorize`, the code turned into tokens at
  `POST /oauth/token` with the server's Calendly app as HTTP Basic, as Calendly asks of web apps
  (https://developer.calendly.com/docs/authentication/creating-an-oauth-app,
  https://developer.calendly.com/api-docs/calendly-o-auth/o-auth/get-oauth-authorize,
  https://developer.calendly.com/api-docs/calendly-o-auth/o-auth/post-oauth-refresh-token). Access lasts
  two hours and a refresh token is taken once, so a refresh is sealed at once, shared by every call of the
  run (and by two at once), and anything the run saves after it (a new webhook key) carries the new one,
  never the spent one. Disconnecting revokes it (`POST /oauth/revoke`,
  https://developer.calendly.com/api-docs/calendly-o-auth/o-auth/post-oauth-revoke). It needs the Calendly
  app of whoever runs the server (`CALENDLY_CLIENT_ID`, `CALENDLY_CLIENT_SECRET`, ADR-030 §5): until then
  the way says "Soon" on a hosted inbox and "set up" on one's own server, as Google does. The app is
  registered with the scopes below and the redirect `<inbox>/oauth/connect/calendly/callback` (hosted: the
  host's one redirect address). A sign-in that reconnects the same account removes this inbox's webhook
  at its old address once the new one is kept (`settle`, which the base now calls on the way back too).
- **The token, under More options**: the owner makes a **personal access token** in Calendly
  (Integrations & apps → API & webhooks) with `users:read`, `organizations:read`, `event_types:read`,
  `availability:read`, `scheduled_events:write` and `webhooks:write`
  (https://developer.calendly.com/docs/authentication/scopes), and pastes it, in three steps. It is
  checked against `GET /users/me` before anything is kept, and sealed. While the sign-in is not set up the
  token is the way the drawer opens on.
- Both go to `https://api.calendly.com` and nowhere else (the app's secret to `auth.calendly.com` alone):
  requests are built from paths, never from an address an answer named; ids read back are taken only from
  `https://api.calendly.com/<kind>/<id>`.
- Calendly offers no way to revoke a personal access token over its API, so the disconnect sheet says
  where to revoke one (`disconnectNote`).
- **The plan is read when connecting**, and on each six-hourly refresh: `GET /organizations/{uuid}`, its
  `stage` (`free`, `trial`, `paid`; `OrganizationStage` in https://developer.calendly.com/openapi/calendly-api.yaml).
  On `free` the connection is made with **Add confirmed bookings off** (`Connected.defaults.bookings`), no
  webhook is asked for, and its line says **"Calendly Free: busy times only"** (`Connected.note`, a base
  addition shown on the connection). The drawer says it before connecting: "Busy times work on every
  Calendly plan. Adding your bookings to Calendly needs its Standard plan or above." A token without
  `organizations:read` connects as before (plan not known, bookings on).
- When none of the event types can take bookings from here, the line says so: "None of your Calendly event
  types can take bookings from here (one-on-one, no required questions, a place you set). Busy times still
  work." The owner app names, under the connection, each service whose length no usable event type has
  ("No 45-min event type on Calendly: Colour & cut bookings won't be added there.").

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
  Calendly opens to **Standard and above**; the Free plan is answered 403. On Free bookings start off
  (§1). An owner who switches them on anyway, or an account that went back to Free, is told on the booking
  in Calendly's terms: "Calendly's Free plan doesn't let other apps add bookings, so {when} is not blocked
  on Calendly. Block it there yourself, or switch off Add confirmed bookings." The plan is told apart
  from a token without `scheduled_events:write` by Calendly's own words (`InviteesErrorMessage`: "The
  Scheduling API is only available on paid Calendly plans…" against "You do not have permission").
- **The invitee is the business itself.** Calendly requires an invitee email and emails whoever it names
  (notifications run "as if booked via the Calendly UI"), so the invitee is the account's own address
  under the customer's name, in the business's time zone. The customer, whom the inbox has told already,
  hears nothing from Calendly; the base gives a booking writer no customer email in any case (ADR-030 §2,
  rule 5). The list's option "let Calendly email the customer too" is not built: it would need the
  customer's email given to a writer, a base change.
- **Event types it can use:** active, standard, one-on-one (`kind: solo`), booked at once (not a poll),
  the owner's own, with no enabled required question, and a place the business sets (an address, a
  conference, the business's phone). The location sent is the event type's own, read again just before
  each booking. A group event type is left out: its event is shared with others who booked it, and
  Calendly cancels events, not invitees. "Same length as the booking" picks the first that fits; the
  Scheduling API takes no length, so a booking goes only to an event type of exactly its length.
- **Moving** makes the new event first and cancels the old one after: Calendly has no reschedule in its
  API. A move first looks for an event it made already at the new time, by its mark (below), leaving out
  the old one: a run that made the new event and stopped before cancelling the old one (a 5xx, a 429, a
  timeout after Calendly made it) is finished on the next try (the old one cancelled, the one found kept),
  never made twice, which Calendly would refuse for a time the new event holds. When Calendly refuses the
  new time because the old event holds part of it, the old one is cancelled first and the new one made;
  when that is refused too the booking stays in the inbox, the owner sees Calendly's words, and the next
  try makes it. **Cancelling** is `POST /scheduled_events/{uuid}/cancellation`; gone, "Event is already
  canceled", or "Event in the past" (or a start already past) is done; any other refusal ("You are not
  allowed to cancel this event", `DeleteScheduledEventErrorMessage`) is said, since the event still holds
  its time.
- Each invitee carries a mark only this inbox can make (`tracking.utm_content`, from `ctx.marker`), by
  which a run that stopped before noting an event finds it (`find`, filtered by the business's address).
  `GET /scheduled_events` names its bounds "after" and "prior to", so it is asked a minute either side of
  the start and only an event at the very start is taken.
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
- `Calendly-Webhook-Signature: t=…,v1=…` is HMAC-SHA-256 over `t.body`, computed once and compared in
  constant time with each `v1` (five at most; a header past 2 KB is refused unread), and `t` must be
  within three minutes either way
  (https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures).
- A delivery's id is its topic and the invitee's id: an invitee is made once and cancelled at most once,
  so a delivery Calendly sends again is counted once. A delivery's body carries the invitee's name and
  email; only the scheduled event's and the invitee's ids are kept.
- What it does: busy times are read again at once (`HookFact` `busy`). **A booking made on Calendly does
  not become an inbox booking**: the base has no fact for it, and polling already blocks its time. A
  booking the inbox made and the business cancelled on Calendly stays confirmed in the inbox; telling the
  owner would need a base fact too. Both are left for a decision.
- Refresh keeps the subscription pointed at the inbox: one Calendly disabled (deliveries failing for a
  day) or that points at an old address is deleted and made again with a new key; one still to add is
  added once the inbox is live. Disconnecting deletes it.

### 5. The calendar link to share (Share your bookings)

- `auth: "link"`, served at `GET /v1/feeds/ics_feed/<token>.ics` by the base (ADR-030 §5): a 32-byte
  token, its hash for the lookup, sealed for the owner to see again; **Make a new link** stops the old
  one at once; shown to the owner in person only; `noindex`, no cookies, `private, max-age=300`.
- **Made only where other sites can fetch it.** A link is made (or made again) only at the inbox's own
  https address, once its host lets platforms reach it (`hooksLive`): never on plain http, nor on a hosted
  inbox's setup address, which answers only its owner (its allowlist refuses `/v1/feeds/*`) and changes
  when the inbox moves to the business's own domain. Until then the card says "Needs this inbox's address
  first", with where to add it, and `POST /v1/owner/integrations` refuses with the same words. A second
  link of the kind answers 409, "Your link is made already"; the drawer of a card with a link says
  **Show my link** and points at its line.
- The connection's line names it once ("Share your bookings", no account), its tag says **Made**, and the
  link sits on one line, cut short with the whole address in its title, beside a labelled **Copy link**,
  with where to paste it underneath.
- RFC 5545 (https://www.rfc-editor.org/rfc/rfc5545): one `VCALENDAR`, `METHOD:PUBLISH`, the business's
  name as `X-WR-CALNAME`, CRLF, lines folded at 75 octets; text escaped as §3.3.11 says, every line break
  (a lone CR too) as `\n` and other control characters dropped, so no name can end a line. Confirmed bookings from 30 days back to 18
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

- `builtInConnectors` gains `calendlyConnector(oauth.calendly, { hosted })` and `icsFeedConnector()`; their
  gallery cards are no longer `building`, so the gallery offers them wherever this release runs. No
  migration, no spec change, no dependency.
- Base additions, small and general: `Connected.note` (a line on the connection, refreshed by `refresh`)
  and `Connected.defaults.bookings`; `ConnectionView.note`; the gallery's `needs` for a link way and its
  `hooksLive`; links made only where reachable, with no account beside their title; `settle` on the OAuth
  way back. The owner app treats Calendly as a booking platform with Cal.com: the "each booking would show
  twice" warning, the **Event type** chooser and "bookings go out".
- The site's connector pages (`docs/connectors/calendly.md`, `calendar-link.md`) describe them; the
  integrations page keeps "Being built" until this is merged and deployed (ADR-030 §6).
- Not here: Calendly bookings as inbox items; a Calendly-side cancel told to the owner; booking sites'
  all-day exports counting as busy without `TRANSP:OPAQUE` (the `ics` connector counts an all-day event
  only when it is marked busy, ADR-022; many booking sites mark none).
- Not verified without an account: that Calendly takes the host's own address as an invitee, that its
  authorize page sends `state` back (standard OAuth 2.0, RFC 6749 §4.1.2), and that it accepts
  `code_verifier` in a web app's token request (its docs say PKCE is recommended for web apps and not
  enforced).
