# ADR-039 — Trades and projects: files on a request, where a business works, the job, its job tool

**Status:** proposed, 21 October 2026. Builds on ADR-036 (money in every currency's own minor unit,
payment schedules, write first) and ADR-030 (the connectors' shared base). Spec 0.12.0, migration 0031.

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
  tag. A PDF is kept as sent, photos inside it as they were, and served only as a download. A PDF's
  header may follow at most 16 bytes and its `%%EOF` must be in its last kilobyte, so a page of HTML
  with a PDF header further in is not taken for one.
- **Kept in the inbox's own database**, in pieces of 512 KB (`attachment_chunks`), so every runtime keeps
  them the same way with no store to set up, and an erasure or a copy of the database takes them with
  the rest. `blobs.kind = 'attachment'` is the row; the item's batch hands its files to it and fails
  whole when one was not there to take (its hour ran out, another request took it), so an item never
  names a file it does not hold. What no request took within the hour is swept. Node opens SQLite with
  `secure_delete`, so what an erasure or the sweep removes is overwritten, not left in free pages.
- **For the business alone.** The owner sees a file through a link that names it, says when it stops
  (ten minutes) and carries a MAC under the instance's own key (`attachment-link`); it is served with its
  real type, `nosniff`, a `sandbox` CSP, `no-referrer`, and a private cache. A file never goes to a
  network. Erasing a customer deletes their files' bytes in the same batch. A customer's download of the
  inbox leaves the bytes out.
- **Room for files.** Anyone may upload, so files no request has taken yet have an allowance of their
  own (`ATTACHMENT_LIMITS`): 60 MB in an inbox and 30 MB from one sender's address (`blobs.sent_by`, the
  rate limits' address, cleared when a request takes the file), counted only within their hour. A
  hosted inbox keeps 100 MB of files in all (`HostPolicy.attachmentsQuotaBytes`, est., I-Q9), well under
  the 200 MB a hosted inbox may hold, and the shard holds an inbox to the pages it uses (`liveBytes`),
  not the size of its file, so what the sweep frees counts at once though the file does not shrink.
  Uploads take a rate limit of their own besides. Self-hosted inboxes have no quota but these
  allowances and their database's.

### 2. Where a business works

- Settings → Area: `radius`, `postal` or `anywhere`; what a request from outside gets (`decline`, or
  `on_request`: the owner decides). Delivery zones (`zones[]`: a ring or prefixes, with a fee, a minimum
  and a time) are in the same section, with an exported matcher (`matchZone`) for food to reuse.
- **The base is a place, never typed numbers**: the business's premises as Settings → General has them,
  or where the owner's device is when they set it ("Where I am now"), rounded to about 100 m. It is never
  published and never told as a distance: a site is told as a band (within 5, 10, 25 or 50 km).
- **A device's point is never what an answer depends on.** It is often the tradesperson's home, and
  anyone may ask whether a site is inside, again and again: every check measures from the middle of the
  cell of a grid of about 5 km that the point falls in (`blurredBase`), and tells no band nearer than
  10 km, so asking round the edge finds the cell at best. **The radius edge from a device is therefore
  approximate**, by up to about 4 km. Premises the business publishes are measured as they are.
  `check_area` and `GET /v1/area` take a rate limit of their own: twenty at once and sixty an hour per
  address.
- **Nothing is geocoded.** A postal code is matched as text against prefixes, in each country's own shape
  (`area/postal.ts`: numeric systems by their length; GB by its outward code, so M1 is not M12 and S is
  not SW; CA's forward sortation areas; NL; IE's routing keys; AR). A radius needs the site's point,
  which the agent sends when it has one. **What cannot be told is on request, never a yes.**
- What agents are told (`areaSummarySchema`): the radius, or the prefixes. H3 cells wait on a decision
  (I-Q3) and a dependency. Postal codes and none of them is refused (a stored one reads as anywhere):
  it would turn away every request with a code. The owner's screen puts postal codes first, as most
  agents send one, and says a distance is checked only when an agent sends the site's location; the
  setup asks a trade where it works, after who it is.
- `check_area` (MCP and `GET /v1/area`) answers `inside`, `outside` or `on_request`, in the business's
  words.

### 3. The job

`quote_request.payload.job`: `urgency` (emergency, within 24 hours, this week, flexible), `visit`
(needed, not needed, unsure), `site` (an address, its point, how to find the way, home or business), up
to three `windows`, `budgetMax` for a range; and, written by the inbox only, `areaCheck` (status, how,
band) and `visitBookingId`. The customer's agent never sends the inbox's fields.

- A site outside an area that declines is refused (`outside_area`); outside one that does not, or not
  known, the request is taken and marked for a person.
- **The emergency door** (Settings → Work): off, while open, or at any hour. An emergency the door does
  not take is refused with what to do instead (within 24 hours, or call the business, on its phone
  when Settings has one). One it takes comes first (priority 3), for a person: that includes one whose
  site the area cannot place (a radius, and only a postal code sent, which is never geocoded), since an
  area that cannot tell is on request, never a refusal. The trade presets write urgency last, after
  the rule for customers you know, so a returning customer's emergency ends at 3.
- Out of hours: a surcharge (an amount or a share) the business states; said in its profile. A call-out
  fee, and whether accepting the quote takes it off. Free estimates. All of it is
  `get_business_profile.work` and, for a network, the attributes `free_estimates` and `emergency_service`.
- **A site visit** is a booking of the service the owner chose for visits, made by the customer's agent
  naming the request it is for (`create_booking.visit_for`, with the request's access token): each names
  the other. Visits are on request; capacity set aside for instant visits is not in this build.

### 4. A trade's quote

The quote gains `kind` (estimate or fixed), `stages` (the ADR-036 payment schedule, at most four, adding
up to the total, a later one with its date), `callOutFee` and `visitFee` (with `creditedIfAccepted`),
`tax` (included or not, with lines), and a `kind` on each line (labour, materials, other). The quote is
refused, field by field, when they do not add up.

- **The total is what the customer pays, tax included, always** (consumer law asks for the total with
  taxes before they commit): it is what they say yes to, what the order holds and what a pay link asks
  for. Prices before tax (`tax.included: false`) name their tax, at least one line, and the lines
  before tax and the tax lines make the total; the customer reads *before tax + tax = total*.
- A call-out or visit fee credited if they accept is **already taken off the total**; one that is not
  is paid apart from it. The words say which, so they and the amount charged agree.
- The owner's screen takes the total and the stages before the last: the last is the rest. A stage's
  date is noon in the business's own time zone. They are part of the offer's terms (as `quoteKind`, so
the offer's own kind stays apart in its fingerprint) and of the summary the customer says yes to. The
order an accepted staged quote becomes carries its `schedule`, and **no link for the whole total is
made**: the business asks for each stage. A link per stage waits on a schedule source for orders, which
is the connectors base's file to change.

### 5. The owner's job tool

- Group `work` ("Job tools"), card **Job tool**: ServiceM8 with the business's own key (ready);
  Housecall Pro and Fergus with it too, **set up** until whoever runs the server clears their API terms
  for this use (`JOB_TOOLS_CLEARED=housecallpro,fergus`: Housecall Pro's terms page did not load when
  this was built, and Fergus's terms speak of an approved use case); Jobber and ServiceM8's own sign-in
  through a partner app on the server (**set up**, nothing to press, until it holds them). Jobber needs
  the API version its app was checked against too (`JOBBER_API_VERSION`, never the template's
  2022-03-10), so holding the keys to start its review switches nothing on. simPRO is not built and has
  no card: its developer documentation could not be read (HTTP 403), and nobody builds from a guess.
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
  the tool takes files (ServiceM8's job diary, Fergus's enquiry under names of their own; Housecall Pro's
  leads take none, and the lead's note links to the request). Fergus's enquiry carries its reference
  first, so a long description never cuts it. A Jobber request goes to the customer's client, found by
  email or phone, before one is made. Nothing goes back to any network. No card data, ever.
- Busy times: each tool's scheduled visits remove those times from the visit service, through the
  existing calendar machinery, read a week back for a visit still going. Webhooks are nudges:
  ServiceM8's API-key subscriptions are unsigned, so the connection's own address lets one in and the
  schedule is read again; its sign-in's subscription is proved by a challenge (`HookChallenge`,
  answered as plain text, nothing kept), so it is made on the first sync after the connection is kept;
  Housecall Pro's are checked (`Api-Signature`, HMAC-SHA-256 over `Api-Timestamp.body`, hex or base64,
  five minutes); Jobber's, set per app, come to the app's one address (`POST /v1/hooks/jobber/app`,
  `HooksHandler.account`), are checked with its app's secret and go to the connection of the account
  they name. Fergus has none in its reference.
- **Start from your tool** (`setup_in`): ServiceM8's vendor record keeps the business's opening hours
  (`opening_time_<day>`, `closing_time_<day>`, minutes from midnight, in its `timezone_name`).
  Settings → Work reads them when the owner asks (`GET /v1/owner/integrations/:id/setup`), shows them
  beside the inbox's own, and keeps them only when the owner presses; hours kept in another zone are
  shown, never copied. The reader is the `SetupReader` seam (`setup_in`), which a booking system can use too.
- A Fergus token lasts a year: when it was connected is kept, and Settings → Work says when it runs out.

### 6. Presets

`trades` gains its emergencies and within-a-day first, and a site outside the area for a person;
`projects` (Building & renovation) is new: every project to a person, plans and photos first. Each is one
file in `rules/presets/` and one registry line; the setup's first question gains **Building and
renovation**.

## Consequences

- A hosted inbox's database holds its customers' files: 100 MB of files under a 200 MB cap per inbox.
  More room for files means a store of the host's own behind the same seam.
- A hosted inbox passes only Google's OAuth client today: the job tools' partner apps, the cleared
  tools and Jobber's app address need the host's wiring (and, for Jobber, one webhook address that finds
  the inbox by account), in the founder's checklist.
- Housecall Pro's API needs its MAX plan; Fergus's terms speak of an approved use case; Jobber retires
  API versions on a schedule. Each is in the founder's checklist.
- Nothing here charges anything, sets a price, or takes a share of a job.
