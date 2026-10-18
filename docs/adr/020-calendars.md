# ADR-020 — The connector SDK and the first calendars

**Status:** proposed, 18 October 2026. Builds the connector SDK ADR-014 decided and the "one platform
connector" ADR-015 §7.4 left for later, starting with calendars: Cal.com, CalDAV (iCloud, Fastmail,
Nextcloud, any other) and Google Calendar.

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
credentials and what it said about itself; it never sees the database, the settings or another
connector. The Settings form is drawn from the schema (`describeForm`), so a connector needs no screen
of its own. Core holds the SDK and the capability; the connectors live in `@surfingdog/adapters` and
the host attaches them (`caps.connectors.attach`), as it attaches the network port.

### 2. Secrets, and who connects

Credentials are sealed with the secret box (`connector-config`, bound to the row) and never returned by
any door. Without `INBOX_SECRET_KEY` nothing is connected (fail closed). Connecting and disconnecting
hand over a password or a sign-in, so they are the owner's: the owner's AI may list and sync, and is
refused the rest with a note to leave the owner. The idempotency layer keeps a connect request without
its secret fields, so no hash of a password is ever stored beside the answer.

### 3. Busy times only remove times

A connection's busy times are one generation of rows (`connector_busy`); a sync writes its rows under a
generation of its own and moves `connectors.busy_gen` forward only, so two syncs that finish out of order
leave the newer read and a half-written one is never read. `readClaims`, which every door that offers,
proposes, books or moves a time already reads through, takes a busy bucket as full, so a busy time is
honoured by all of them or none, with no change to the state machines. Busy times never move, cancel or
refuse a booking already confirmed. They apply to every service unless the owner chose some, and to every
place of a service that takes several. A connection that fails keeps its last busy times (they only ever
remove times) and says why on the connection.

What counts as busy is what calendars count: not cancelled, not marked free. An all-day event counts only
when marked busy. Repeating events are expanded by the server where it will (CalDAV `expand`), else here
for the rules people make (daily, weekly by day, monthly by date or nth weekday, yearly; interval, count,
until, excluded and moved occurrences), on wall time in the event's zone.

### 4. Bookings written once

A confirmed booking is written to the connection's destination; moved, it is written again; cancelled,
declined or expired, it is removed; completed or a no-show, it is left alone. A test booking is never
written, and an erased customer's name leaves the title on the next sync. Each booking has a
`connector_links` row whose `claim_until` is a compare-and-set: one job, and only one, calls the platform
for it at a time, so two syncs that meet never create it twice, and a run that stopped between writing
and recording is finished by the next — by the id the inbox chose (CalDAV's `sdi-<item>.ics`, Google's
`sdi<hex>` event id) or, where the platform chooses ids (Cal.com), by finding the booking it made through
its metadata. Writes follow every booking event within seconds (the webhook fanout queues a push per
connection) and are reconciled every five minutes from a cursor with a two-minute look-back. The inbox's
own events are left out of busy times by their ids, or by their spans where the platform answers with
times only (Google's free/busy, Cal.com's busy times).

### 5. The three connectors

- **Cal.com**, API v2 with the owner's API key: busy times from the account's bookings and the calendars
  Cal.com checks for conflicts; bookings created on the event type as long as the booking (or the one
  chosen), rescheduled, cancelled. The customer is named and given no email, so Cal.com sends them
  nothing: the inbox already confirmed in the business's name.
- **CalDAV** (RFC 4791), email and app password: iCloud, Fastmail and Nextcloud presets; any other server
  found by RFC 6764 (the email domain's `_caldavs._tcp` SRV and TXT records over DNS-over-HTTPS, then
  `/.well-known/caldav`), with an address under More options only when that fails.
- **Google Calendar**, OAuth 2.0 authorization code with PKCE (S256) and offline access, scopes
  `calendar.freebusy` and `calendar.events.owned` and nothing else; the primary calendar. "Soon" until
  the instance has a client (`GOOGLE_OAUTH_CLIENT_ID`/`SECRET`). A hosted runtime keeps one redirect
  address for every inbox (`HOSTED_OAUTH_RELAY_HOST`): the inbox puts its origin at the front of the
  state and the router passes the owner on to it, and only to a name it knows as an inbox.

Every call goes through the connectors' HTTP client: https only, public host names only, redirects
followed by hand and checked again, credentials only within the same site, bounded time and size, and the
host's `pinnedFetch` on Node.

## Consequences

- Migration 22 adds `connector_busy`, `connector_links`, `connector_auth` and two columns on `connectors`;
  nothing that exists changes. An instance with nothing connected writes no row and queues no job: the
  fanout gate (`hasEventListeners`) also counts a connection that writes bookings.
- Settings → Integrations shows the gallery: Cal.com and Calendar, and Stripe, Mollie, Shopify and
  WooCommerce marked "Soon" with nothing to press.
- REST `/v1/owner/integrations*`, owner MCP `list_integrations` and `sync_integration`, the browser's way
  back `/oauth/connect/<kind>/callback`.
- Not in this release: two-way sync (a booking cancelled in Cal.com is not cancelled here), push from the
  platforms (Google watch channels, Cal.com webhooks) instead of the five-minute read, calendars other than
  Google's primary one, and the payments and shop connectors.
