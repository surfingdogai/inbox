# ADR-034 — Trades and projects: files on a request, where a business works, the job, its job tool

**Status:** proposed, 21 October 2026. Builds on ADR-032 (money in every currency's own minor unit,
payment schedules, write first) and ADR-026 (the connectors' shared base). Spec 0.11.0, migration 0027.
Numbered provisionally; renumbering at merge is fine.

## Context

The founder, 20 October 2026: connect directly to hotels and get them to install the inbox, with
hotel-ready features, "the same with other industries". A plumber, an electrician or a builder needs
what a request for a price did not carry: photos and plans, where the job is and whether it is inside
where they go, how urgent it is, whether a visit comes first, a quote paid in stages, and the request in
the tool they already run their jobs in. Restaurants and bakeries need the same area matcher for their
delivery zones, and the same files for a cake's picture.

## Decisions

### 1. Files on a request

- `request_quote`, `create_booking` and `create_order` take `attachments`: up to six files of 10 MB,
  JPEG, PNG, WebP or PDF, **told apart by their first bytes**, never by the type or name sent. HEIC and
  AVIF are refused with "send it as a JPEG": no conversion library is added.
- Three ways in: `{upload_id}` from `POST /v1/uploads` (the bytes as the body, kept an hour); inline
  `{data_base64}` over MCP, 4 MB each and 8 MB a call; `{url}`, fetched only from a public https host,
  each redirect checked again, the body bounded (`attachments/fetch.ts`). The body limits follow: 10 MB
  and a little for an upload, 12 MB for a request with its files inline, 1 MB everywhere else.
- **Metadata out, in pure TypeScript** (`attachments/strip.ts`): every EXIF and XMP block (GPS with
  them), IPTC, comments, the MPF index and anything after a JPEG's end; a PNG's text, time and eXIf; a
  WebP's EXIF and XMP. Which way up a photo is (the EXIF orientation) is written back as a record of one
  tag. A PDF is kept as sent and served only as a download.
- **Kept in the inbox's own database**, in pieces of 512 KB (`attachment_chunks`), so every runtime keeps
  them the same way with no store to set up, and an erasure or a copy of the database takes them with
  the rest. `blobs.kind = 'attachment'` is the row; the item's batch hands its files to it, so an item
  never names a file it does not hold. What no request took within the hour is swept.
- **For the business alone.** The owner sees a file through a link that names it, says when it stops
  (ten minutes) and carries a MAC under the instance's own key (`attachment-link`); it is served with its
  real type, `nosniff`, a `sandbox` CSP, `no-referrer`, and a private cache. A file never goes to a
  network. Erasing a customer deletes their files' bytes in the same batch. A customer's download of the
  inbox leaves the bytes out.
- **A quota on a hosted inbox**: 500 MB of files (`HostPolicy.attachmentsQuotaBytes`, est., I-Q9).
  Self-hosted inboxes have none but their database's.

### 2. Where a business works

- Settings → Area: `radius`, `postal` or `anywhere`; what a request from outside gets (`decline`, or
  `on_request`: the owner decides). Delivery zones (`zones[]`: a ring or prefixes, with a fee, a minimum
  and a time) are in the same section, with an exported matcher (`matchZone`) for food to reuse.
- **The base is a place, never typed numbers**: the business's premises as Settings → General has them,
  or where the owner's device is when they set it ("Use where I am"), rounded to about 100 m. It is never
  published and never told as a distance: a site is told as a band (within 5, 10, 25 or 50 km).
- **Nothing is geocoded.** A postal code is matched as text against prefixes, in each country's own shape
  (`area/postal.ts`: numeric systems by their length; GB by its outward code, so M1 is not M12 and S is
  not SW; CA's forward sortation areas; NL; IE's routing keys; AR). A radius needs the site's point,
  which the agent sends when it has one. **What cannot be told is on request, never a yes.**
- What agents are told (`areaSummarySchema`): the radius, or the prefixes. H3 cells wait on a decision
  (I-Q3) and a dependency.
- `check_area` (MCP and `GET /v1/area`) answers `inside`, `outside` or `on_request`, in the business's
  words.

### 3. The job

`quote_request.payload.job`: `urgency` (emergency, within 24 hours, this week, flexible), `visit`
(needed, not needed, unsure), `site` (an address, its point, how to find the way, home or business), up
to three `windows`, `budgetMax` for a range; and, written by the inbox only, `areaCheck` (status, how,
band) and `visitBookingId`. The customer's agent never sends the inbox's fields.

- A site outside an area that declines is refused (`outside_area`); outside one that does not, or not
  known, the request is taken and marked for a person.
- **The emergency door** (Settings → Work): off, while open, or at any hour — and only inside the area.
  An emergency the door does not take is refused with what to do instead (within 24 hours, or call).
  One it takes comes first (priority 3).
- Out of hours: a surcharge (an amount or a share) the business states; said in its profile. A call-out
  fee, and whether accepting the quote takes it off. Free estimates. All of it is
  `get_business_profile.work` and, for a network, the attributes `free_estimates` and `emergency_service`.
- **A site visit** is a booking of the service the owner chose for visits, made by the customer's agent
  naming the request it is for (`create_booking.visit_for`, with the request's access token): each names
  the other. Visits are on request; capacity set aside for instant visits is not in this build.

### 4. A trade's quote

The quote gains `kind` (estimate or fixed), `stages` (the ADR-032 payment schedule, at most four, adding
up to the total, a later one with its date), `callOutFee` and `visitFee` (with `creditedIfAccepted`),
`tax` (included or not, with lines), and a `kind` on each line (labour, materials, other). The quote is
refused, field by field, when they do not add up. They are part of the offer's terms (as `quoteKind`, so
the offer's own kind stays apart in its fingerprint) and of the summary the customer says yes to. The
order an accepted staged quote becomes carries its `schedule`, and **no link for the whole total is
made**: the business asks for each stage. A link per stage waits on a schedule source for orders, which
is the connectors base's file to change.

### 5. The owner's job tool

- Group `work` ("Job tools"), card **Job tool**: ServiceM8, Housecall Pro and Fergus with the business's
  own key (ready), Jobber and ServiceM8's own sign-in through our partner apps (**set up**, nothing to
  press, until the server holds them). simPRO is not built and has no card: its developer documentation
  could not be read (HTTP 403), and nobody builds from a guess.
- Capability `requests_out` and `ConnectorDefinition.requests` (`put`, `find`, `openUrl`). **Which
  requests go is the owner's choice** (`work.jobTool`): every one as it arrives, only the ones they take
  on (they quote it, or press **Send to …**, a person at the business only), or none. The default is the
  ones they take on (I-Q2). A test request never goes.
- **Written first** (`writeFirst`, op `request`, owner `trades`): one at a time per request and tool,
  under a key that is the same on every retry, looked for by it after an answer that never came, and
  settled by the resolver. ServiceM8 takes the caller's UUIDs, made from the inbox's own mark; Housecall
  Pro and Fergus choose their own ids, so a lead carries a tag and an enquiry a reference, found again by
  them.
- What goes: who to answer, the site, what it is, the windows, the customer's words, the photos where
  the tool takes files (ServiceM8's job diary, Fergus's enquiry; Housecall Pro's leads take none, and the
  lead's note links to the request). Nothing goes back to any network. No card data, ever.
- Busy times: each tool's scheduled visits remove those times from the visit service, through the
  existing calendar machinery. Webhooks are nudges: ServiceM8's API-key subscriptions are unsigned, so
  the connection's own address lets one in and the schedule is read again; Housecall Pro's are checked
  (`Api-Signature`, HMAC-SHA-256 over `Api-Timestamp.body`, hex or base64, five minutes); Jobber's with
  its app's secret. Fergus has none in its reference.
- A Fergus token lasts a year: when it was connected is kept, and Settings → Work says when it runs out.

### 6. Presets

`trades` gains its emergencies and within-a-day first, and a site outside the area for a person;
`projects` (Building & renovation) is new: every project to a person, plans and photos first. Each is one
file in `rules/presets/` and one registry line; the setup's first question gains **Building and
renovation**.

## Consequences

- A hosted inbox's file holds its customers' files: the shard's cap per file (200 MB today) has to leave
  room for the 500 MB quota, or files move to a store of the host's own behind the same seam.
- Housecall Pro's API needs its MAX plan; Fergus's terms speak of an approved use case; Jobber retires
  API versions on a schedule. Each is in the founder's checklist.
- Nothing here charges anything, sets a price, or takes a share of a job.
