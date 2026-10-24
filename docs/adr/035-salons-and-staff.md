# ADR-035 — Salons and staff: who gives what, their own calendars, what comes first, deposits, a salon's own system written first

**Status:** proposed, 21 October 2026. Builds on ADR-032 (money in every currency, policies and payment
schedules as data, write first) and ADR-022 (calendars). Spec 0.11, migration 0028. Numbered
provisionally; renumbering at merge is fine.

## Context

The founder, 20 October 2026: connect directly to hotels and get them to install the inbox, with
hotel-ready features, and the same for other industries. A salon, a barber or a beauty studio is booked
by person: the customer asks for Mei, or for whoever is free; each stylist works their own hours, keeps
their own calendar, takes longer or charges more for some services; a colour needs a patch test first; a
deposit holds a Saturday; cancelling late costs something. The inbox had a `resources` table and a
`resourceId` on bookings, and nothing that used them. Most salons run their days in a booking system of
their own (Phorest, Mindbody, Fresha, Booksy, Timely, Vagaro); only Phorest publishes a reference a
salon's own credentials can be used with.

## Decisions

### 1. Staff are resources of kind `staff`

- `resources` gains `kind` (`staff` | `table` | `room` | `vehicle` | `equipment`), `public_name`, a
  small `photo`, `sort`, and `external_id`/`source` for those a salon's system sent in.
- **Customers see a first name only**: `public_name`, else the first word of the name the owner knows
  them by (where names are written family name first, the owner says the name customers see). Never a
  surname, hours or anything else. `list_staff` (MCP and `GET /v1/staff`) gives the name, a photo and
  the services each gives, and is offered only once the business lists staff.
- **A photo** is a JPEG of at most 32 KB the owner app draws at 320 pixels at most, kept as a data URL.
  The inbox reads it again before keeping it: it must be a well-formed JPEG, and every segment that can
  carry metadata (EXIF and its GPS block, XMP, ICC, comments, thumbnails) is taken out. It is served at
  its own address with `nosniff` and a sandbox CSP, and not once the person is off the list. (Blob
  storage for attachments arrives with the trades track; a staff photo moves there then.)
- `service_resources` ties a member of staff to each service they give, with their own price (minor
  units, for the whole booking) and length when they are not the service's. Their price is money: the
  owner's in person, never the owner's AI's.
- **Their own hours** are an `availability_rules` row with their `resource_id`; without one they work the
  business's (or the service's) hours. Such rows are never read as the business's hours, closures or
  published hours.
- A service nobody is tied to is booked as it always was.

### 2. Times with staff, and anyone

- `check_availability` and `create_booking` take `staff_id` (`any` by default) and `add_ons`. Each
  member of staff's free times are their own hours, their own places (`resource:<id>` claims, at their
  own capacity), their own length, the add-ons added; asked for anyone, each time lists who is free.
- A booking for anyone goes to the first free in the owner's order, passing over anyone who already has
  a request at that time, so two requests go to two people. It keeps that it was for anyone
  (`payload.anyStaff`) and is confirmed with whoever is free then, at the same price and length. Nobody
  free: nobody is named before it binds ("with whoever is free"), and a person answers it, as any request
  for a taken time. A booking always carries who it is with and their first name, and its end follows
  their length, whatever the request said.
- Who a booking is with is never a customer's to set: `payload.resourceId` is dropped from every
  request, and the inbox sets it from `staff_id` or from whoever is free.
- A service's places were held under its own key (`service:<id>`) before anyone was tied to it, and
  under each member of staff's since. Each read sees the other: staff are busy wherever the service's own
  key holds a booking, and a service nobody gives any more counts what its staff still hold. A business
  calendar chosen for a service blocks the staff who give it.
- An add-on (`services.add_ons`: a name, the minutes it adds, an optional price) makes the booking
  longer and, priced, dearer; a booking keeps the add-ons as they were (`payload.addOns`).

### 3. Their own calendars

- A calendar connection may be tied to one member of staff (`connectors.resource_id`), for the
  connectors that say they can (`ConnectorDefinition.perResource`: Google, CalDAV, a calendar link,
  Cal.com). Its busy times then take only their times off, and only their bookings are written to it;
  tying or untying it looks at every booking again, so another's written there earlier is taken off.
  A calendar tied to nobody stays the whole business's.
- Only the owner, in person, ties a calendar to someone; never to someone who is not on the staff.

### 4. What must come first

- `services.requires` names another service (a patch test, a consultation), the days within which it
  must have come before, and how long before at least (`at_least_hours`, 48 by default: a patch test is
  read two days on). It is checked only against this business's own bookings (completed or confirmed,
  between those two bounds before the start), and only for a customer the inbox already knows for
  sure (their access token, an agent key bound to them). A name or an address someone types proves
  nothing, so it is never looked up.
- Known and not met: the customer is asked, in the business's voice, to book the first service first.
  Known, with that first service still a request nobody confirmed: a person checks. Not known: the
  booking is taken and waits for a person (`checkFirst` on its create; no rule, AI or key confirms it,
  and the owner's AI proposes no other time for it, which the customer's yes would confirm), with what to
  check beside its confirm and in the owner's email. The answer to a stranger is the same whatever
  anyone's bookings hold, and `requires` itself is never in `list_services`.

### 5. Deposits and a policy per service

- `services.deposit` is a share of the price or an amount (`depositRuleSchema`); a booking carries the
  deposit it asks (`payload.deposit`: amount, refundable, and once it is confirmed, due by), worked out
  with `depositFor` in the currency's own minor unit (₩10,500 is 10500). A request is only told a deposit
  holds it. Its time to pay opens when it is confirmed, a day or until the start when that is sooner, and
  only where a payment platform takes it: the link is made on the business's own platform through the
  ADR-032 schedule source for bookings; paid, it is recorded on the booking, read back with the
  business's key; not paid in time, the link closes and the owner decides. Without a payment platform
  the owner app offers no deposit, and a deposit set before says the owner asks for it themselves.
  Nothing is ever charged or refunded by us.
- `services.policy` is a `policySchema` of its own; a booking carries it dated in the business's zone
  (`payload.policy`), and keeps the terms it was made on (`payload.terms`). Wherever it moves (another
  time proposed, a change either side asks for), its deposit and policy are dated again for that time,
  against when it was booked, and the customer confirms them as they will apply. Without a policy, the
  business-wide cancellation window stands.
- A deposit the policy keeps (`deposit.refundable: false`) comes back while cancelling is free, and is
  kept once no free step is ahead, as the policy sentence says.
- Who it is with, the add-ons, the deposit and the policy are part of what a customer confirms (the
  confirm step's terms and summary). A confirmed booking with a policy answers a customer's cancel with
  the fee and what comes back (`409 confirm_terms`, `fee_sha`); it is cancelled, as a late cancellation
  when it costs something, only once they send that fingerprint back. The fee is the business's to take,
  from the deposit or through its own link.
- The owner's AI may name add-ons and tie staff to services; deposits, policies, what comes first and
  every price are the owner's in person.

### 6. A salon's own booking system, written first

- `ConnectorDefinition` gains `availability` (a booking system's free times, `availability_in`) and
  `setup` (services, staff and rosters to start from, `setup_in`); an `OutboundBooking` given to a
  booking system (group `booking`) carries its own ids for the service and the member of staff, and the
  customer, whom it books as its client. No calendar is ever given who the customer is beyond a title.
- A booking for a service the salon's system sent in (`services.source`) is written there first through
  `writeFirst` (ADR-032 §4), under the item's own key, before anything is promised; once the system took
  it, the inbox confirms it as automation named after the connection. Refused, it is a request for a
  person; no answer, it is looked for by the system's own means, and the resolver (owner `bookings`)
  settles it within minutes, keeping what it found as the booking's link so no sync writes it twice.
  Nothing is written first that the inbox could not confirm on its own anyway: a price a person sets,
  what a person checks first, a time inside the minimum notice, a time its own places or calendars hold.
  Taken there but then not confirmable here, it is cancelled there again (`rolled_back`) and the owner
  told.
- **Only the system's answer confirms such a booking** (the `system_first` guard in `transitionItem`): no
  rule, no owner's AI and no key, and nobody while the answer is on its way. A person's confirm is written
  there first and stands on the answer; a customer's yes to another time we proposed goes to a person.
- Cancelled here, it is cancelled there (`BookingWriter.remove`); a move is made in the salon's system.
- Its free times are offered when it can say them, asked of it once a minute at most for the same
  question; when it cannot (a rate limit, an outage, times it gives that cannot be read), the inbox's own
  are, and the write still decides.

### 7. Phorest and Mindbody

- **Phorest** is code-complete from its public reference: the salon's own credentials (which Phorest
  issues when the salon asks), Europe or the Americas and Australia as a way each, the branch chosen,
  the services it offers online with each member's own price (else their level's, `staffCategories`) and
  length, unpriced where the branch names no currency or another than the business's, staff (those
  hidden from online booking left out),
  a week of rosters as weekly hours, its free times, bookings written as ACTIVE for the salon's own
  client (found by the inbox's own id for them, else created), looked for among the client's
  appointments that day when an answer was lost, cancelled there. Phorest has no webhooks and no
  payments through its API, so neither is used. **Off** (`PHOREST_READY`) until the company confirms that
  a salon's own API access may be used by a tool like this one: the card says it is not available yet.
  Times are sent as instants (`PHOREST_TIMES`), one word from the branch's own wall time, until a test
  branch shows which Phorest reads.
- **Mindbody** needs our developer account and Mindbody's review, and a site owner's activation; its
  reference is drawn only in the browser. It is registered **off**, with no way to connect and nothing it
  would call, until the company has the account.
- **Not built**: Vagaro, Booksy, Timely and Fresha, which publish nothing a connector can be built from.
  Their salons are reached through doors elsewhere (the connectors workflow).

### 8. The salon preset

- `salon` (one file in the registry): a returning client (`customer.completed` here, no score of anyone
  from anywhere) with no no-shows is confirmed at once when their member of staff is free within their
  hours; a new client's first visit goes to a person; anything else asks a person. Hosted inboxes start
  with the owner confirming each booking.

## Consequences

- A salon lists its people once, and agents book them by name, at their own times and prices, with the
  deposit and the policy read back before anyone is bound.
- Booking systems join calendars and payments in Settings → Integrations, honest about what each needs.
- New vs returning comes only from the business's own bookings; scoring customers stays paused.

## Not decided here

Card guarantees for no-shows at salons (the stays' Stripe `mode=setup`, later); processing time (colour
developing while a stylist takes another client); tables by size; Square's team members as staff (the
connectors workflow's Square track).
