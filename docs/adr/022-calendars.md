# ADR-022 — The connector SDK and the first calendars

**Status:** proposed, 18 October 2026. Builds the connector SDK ADR-014 decided and the "one platform
connector" ADR-015 §7.4 left for later, starting with calendars: Cal.com, CalDAV (iCloud, Fastmail,
Nextcloud, any other), a calendar's private link, and Google Calendar.

## Context

An inbox offers times from the opening hours its owner set. A hairdresser's real day is in a calendar
somewhere else: the dentist at ten, the school run, the bookings that came in by phone. Without that
calendar the inbox offers times that are not free, and the bookings it confirms are invisible where
the owner actually looks. The owner asked for one place for every integration, in Settings.

## Decisions

### 1. The SDK

A connector declares what it does (`capabilities`: `busy_times`, `write_bookings`; payments, orders and
catalogue arrive with the platforms that need them), a Zod schema of what the owner gives it with its
secret fields marked (`secretField`), presets in the platform's own words (iCloud's "app-specific
password"), and handlers: `connect` (check against the platform before anything is kept), `refresh`,
`busy`, `bookings.put/remove/find`, `disconnect`, or an `oauth` flow. It is handed an HTTP client, its
credentials, what it said about itself, the inbox's own id (made once at random, never its host, which
moves) and a marker only this inbox can make for the account (an HMAC under the instance key); it never
sees the database, the settings or another connector. A connector that cannot read its whole window
says how far it got (`BusyRead`). The Settings form is drawn from the schema (`describeForm`), so a connector needs no screen
of its own. Core holds the SDK and the capability; the connectors live in `@surfingdog/adapters` and
the host attaches them (`caps.connectors.attach`), as it attaches the network port.

### 2. Secrets, and who connects

Credentials are sealed with the secret box (`connector-config`, bound to the row) and never returned by
any door. Without `INBOX_SECRET_KEY` nothing is connected (fail closed). Connecting, changing what a
connection does (busy times off, paused, other calendars) and disconnecting hand over a password or a
sign-in, or change what customers are offered, so they are the owner's in person (`isPerson`): the owner's
AI and a key handed to another system (an integration key, whatever its scopes) may list and sync, and are
refused the rest — the AI with a note to leave the owner. A connection that fails is connected again in
place (`connection_id`): only the new password or key, with what was typed before and every choice kept.
The idempotency layer keeps a connect request without its secret fields, so no hash of a password is ever
stored beside the answer.

### 3. Busy times only remove times

A connection's busy times are one generation of rows (`connector_busy`); a sync writes its rows under a
generation of its own, moves `connectors.busy_gen` forward only (and only while busy times are on and the
connection is not paused), deletes only the generations older than the current one, and deletes its own if
it did not become current. Two syncs that finish out of order, or interleave, leave the newer read whole; a
half-written one is never read or deleted; and a sync that was reading when the owner switched busy times
off never brings them back. `readClaims`, which every door that offers,
proposes, books or moves a time already reads through, takes a busy bucket as full, so a busy time is
honoured by all of them or none, with no change to the state machines. Busy times never move, cancel or
refuse a booking already confirmed. They apply to every service unless the owner chose some, and to every
place of a service that takes several.

Busy times are read about three months ahead (`BUSY_HORIZON_MS`, 92 days), and past what was read nothing
is offered: a time not known to be free is not offered as free. With more ahead than is kept (2,000 merged
busy times) or read (Cal.com: 20 pages), the read stops where it is complete (`busy_until`) and the
connection says so. A connection never read yet closes nothing. The owner is told which calendar holds a
time ("that time is busy in your iCloud calendar") or that it is further ahead than it was read.

A connection that fails keeps its last busy times (they only ever remove times) and says why on the
connection. It is read less often the more it fails (5 minutes doubling, at most 30 minutes, or 6 hours for
a refused sign-in: Nextcloud and Apple count failed sign-ins, and hosted inboxes share an address), and
after a day of refused sign-ins not at all until the owner connects again or syncs now. The owner is told
once, by email and in the owner app's rail: at once for a refused sign-in, after two hours for a platform
that does not answer.

What counts as busy is what calendars count: not cancelled, not marked free. An all-day event counts only
when marked busy. Repeating events are expanded by the server where it will (CalDAV `expand`), else here
for the rules people make (daily, weekly by day, monthly by date or nth weekday, yearly; interval, count,
until, excluded and moved occurrences), on wall time in the event's zone.

### 4. Bookings written once

A confirmed booking is written to the connection's destination; moved, it is written again; cancelled,
declined or expired, it is removed; completed or a no-show, it stays where it is and only its words are
kept up to date. A test booking is never written. An erased customer's name leaves the entry on the next
sync, past bookings included, on Google, CalDAV and every calendar written directly; Cal.com cannot
change the name on a booking it has, so there it stays on bookings already made. A booking that ended a
day ago and was never written is let go, not retried.

Each booking has a `connector_links` row whose `claim_until` and `claimed_by` are a compare-and-set: one
job, and only one, calls the platform for it at a time (for two minutes, past the slowest run of calls),
and only the job that still holds the claim records what it did. Two syncs that meet never create it
twice; a run that stopped between writing and recording is finished by the next — by the id the inbox
chose (CalDAV's `sdi-<item>.ics`, Google's `sdi<hex>` event id) or, where the platform chooses ids
(Cal.com), by finding the booking it made by its mark (a hash of the account's marker and the booking),
its exact times and its event type. Nothing a booking says of itself is trusted: anyone who books on an
owner's Cal.com page can set its metadata. The same find runs for a booking with no link yet, so an
account connected again adopts what it wrote before.

Writes follow every booking event within seconds (the webhook fanout queues a push per connection). A new
connection first writes every confirmed booking still to come, page by page in (start, id) order; then
the bookings that changed, themselves or their customer, are read in (time, id) order. The cursor keeps
both places and moves only past what was done: never past a booking another job holds, nor past one
changed in the last two minutes (a write stamped a moment before it landed).

Busy times leave out every booking any connection wrote, not only the connection's own: Cal.com writes
the bookings it is given into a calendar the owner may connect here too. Their ids, or their spans where
the answer has times only (Google's free/busy, Cal.com's busy times, a calendar link, an event another
connection wrote into a CalDAV calendar). The settings say so when Cal.com and a calendar both add
bookings, and offer to stop one. Where another event overlaps a booking's own time, the overlap is not
counted (the booking holds that time already); for a service with several places it does not close the
places left during that overlap.

### 5. The three connectors

- **Cal.com**, API v2 with the owner's API key: busy times from the account's bookings and the calendars
  Cal.com checks for conflicts; bookings created on the event type as long as the booking (or the one
  chosen), rescheduled, cancelled. The customer is named and given no email, so Cal.com sends them
  nothing: the inbox already confirmed in the business's name.
- **CalDAV** (RFC 4791), email and app password: iCloud, Fastmail and Nextcloud presets; any other server
  found by RFC 6764 (the email domain's `_caldavs._tcp` SRV and TXT records over DNS-over-HTTPS, then
  `/.well-known/caldav` at the domain and at `caldav.` under it), with an address under More options only
  when that fails, and within 25 seconds in all. Every address found is asked first without the password
  and taken only when it answers as a calendar server (207, or 401 asking for Basic); the password then
  goes to that host alone, or within iCloud's own hosts, and a calendar a server names elsewhere is
  refused. A Gmail or Microsoft mailbox (by its domain or its MX records) is told at once where it
  connects instead. The UID of what it writes is `sdi-<item>@<instance id>.inbox`.
- **Calendar link**: a calendar's private `.ics` subscription link (Google's secret address, Outlook's
  published calendar, `webcal://` too), sealed like a password; busy times only. It is how a calendar that
  cannot connect here yet still blocks the owner's busy times.
- **Google Calendar**, OAuth 2.0 authorization code with PKCE (S256) and offline access, scopes
  `calendar.freebusy` and `calendar.events.owned`, and `openid email` (not sensitive) so the account is
  known by Google's `sub` from the ID token, never a calendar's name; the primary calendar. Without a
  client (`GOOGLE_OAUTH_CLIENT_ID`/`SECRET`) it says "Soon" on a hosted inbox and "set up" on one's own
  server. A hosted runtime keeps one redirect address for every inbox (`HOSTED_OAUTH_RELAY_HOST`): the
  inbox puts its origin at the front of the state and the router passes the owner on to it, and only to a
  name it knows as an inbox.

Every call goes through the connectors' HTTP client: https only, public host names only, redirects
followed by hand and checked again, credentials only to the host they were given for (or within a provider
named as owning all its hosts, iCloud), bounded time and size, and the host's `pinnedFetch` on Node.

## Consequences

- Migration 22 adds `connector_busy`, `connector_links`, `connector_auth`, `instance_meta`, columns on
  `connectors` (`busy_gen`, `busy_at`, `busy_until`, `error_code`, `failing_since`, `failures`,
  `notified_at`) and indexes for the bookings that changed (`items_type_updated`, `parties_updated`);
  nothing that exists changes. An instance with nothing connected writes no row and queues no job: the
  fanout gate (`hasEventListeners`) also counts a connection that writes bookings.
- Settings → Integrations shows what is connected first, then the gallery: Calendar (iCloud, Fastmail,
  Nextcloud, other CalDAV, a calendar link; Google when set up; Outlook "Soon") and Cal.com, and Stripe,
  Mollie, Shopify and WooCommerce marked "Soon" with nothing to press (one line on a phone).
- REST `/v1/owner/integrations*`, owner MCP `list_integrations` and `sync_integration`, the browser's way
  back `/oauth/connect/<kind>/callback`.
- Not in this release: two-way sync (a booking cancelled in Cal.com is not cancelled here), push from the
  platforms (Google watch channels, Cal.com webhooks) instead of the five-minute read, calendars other than
  Google's primary one, and the payments and shop connectors.
