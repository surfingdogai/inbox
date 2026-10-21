# @surfingdog/spec (MIT)

The open formats of Surfing Dog Inbox, so anyone can implement a compatible instance, agent,
or network:

- the discovery manifest (`/.well-known/…`, see ADR-002),
- the receipt format (compact JWS, Ed25519) and its counter-signature (ADR-016), and receipt
  claims v2 (ADR-017 §3.2),
- every message an inbox exchanges with a network (ADR-017 §7): registration and the ping,
  persons, presentations, passes, delegations, recovery, reports and contests, the directory and
  the published rules — described for people in [`docs/protocol/network.md`](../../docs/protocol/network.md),
- the tools a network offers assistants at `/mcp` (ADR-017 A2.7): what each takes and answers,
- protocol 0.2: doors, readiness levels, listing fields, entries a network found on businesses'
  own websites, claims (`register_business`, `update_business`) and rules version 7, with
  version 8, version 7 amended before it took effect (ADR-017 Amendment 4): a record on the
  business's own word alone shows its counts and no score, and the bounds on what a network takes,
- 0.3 (optional for a network): capabilities and the agentic score (`check_business`, the score's
  published rules, result pages and leaderboards), and the discovery documents an agent reads to find a network,
- 0.3.1: the manifest's optional `doors_elsewhere`, the kinds of request a business takes somewhere
  else and where, read with `readDoorsElsewhere` (`vectors/doors-elsewhere.json`). A manifest
  without it reads as before.
- 0.4 (optional for a network): door reports, how an agent says each use of a business's door went,
  done or not (`POST /v1/door-reports`, the `report_door` tool, a strict body that can carry nothing
  about a person), the classes they use (`vocab/door-report-classes.json`), the `doors` block a signed
  ping's answer gives the business, the `report` hint on a network's answers, and how a network's
  own reads move a door between live, failing and gone (`readDoorReports`, `doorReportEffect`,
  `classifyDoorRead`, `doorStatusAfter`; `vectors/door-reports.json`).
- 0.5: `orderable` is a level of its own, the same rung as `bookable`, for doors that take orders
  and none that books; `level=bookable` and `level=orderable` filter by what the doors take, so
  `level=bookable` no longer returns a shop whose doors take orders alone; and a UCP or ACP profile
  raises a business only on a site that shows it sells (Product markup with a price, another door
  of its own that takes orders, or, since 18 October 2026, a product for sale in the catalogue its
  UCP profile names, when that catalogue is the site's own). A reader pinned to 0.4 rejects
  `orderable`.
- 0.5.1 (optional for a network): a door's history from the network's own reads (`door_history` on
  a listing's detail, `get_business` and a check result; `doorHistorySchema`, `doorHistoryOf`;
  `vectors/door-history.json`). An answer without it reads as before.
- 0.6 ([ADR-021](../../docs/adr/021-the-reference.md)): the capability vocabulary, version 2
  (`vocab/capabilities.json`; version 1 kept as `vocab/capabilities-v1.json`): for each capability a
  definition, other words for it, what partial means, what has to be seen at each step of the
  evidence ladder, what is not enough, and how each kind of door carries it, by example names that
  the network's own door registry reads as that capability. The conformance check (`checkManifest`,
  `checkReceipt`, `checkAcknowledgement`, `checkDocument`), which says whether a document holds to
  these specs and why not, with the codes a network answers. How a door's names are read as
  capabilities, as vectors (`vectors/capability-names.json`, from the network). The census's data
  (`census-edition`, `census-editions`, an example in `vectors/census-edition.json`, and the MCP tool
  `get_census`; protocol §4.16, optional for a network), and the score rules version 3 it is counted
  under (`vocab/score-rules-v3.json`, as revised on 15 and 18 October 2026). Every JSON Schema but
  the MCP tools' now carries a `$id`, its address at `https://surfingdog.ai/spec/schemas/<name>.json`.
  In the vocabulary's and the census's schemas a capability, a kind of door and a scope are any
  lower-case name, so a later version that adds one still validates. `verifyReceipt` in
  `@surfingdog/sdk` reads amendments and refunds, as the check does.
- 0.7: how a business is paid. `vocab/payments.json` version 2 (every token with an English label,
  a bank transfer apart from SEPA, ways people pay in every region (M-Pesa, Interac, Venmo, Cash App,
  Zelle, Bizum, PayNow, PromptPay, GCash, PayPay, KakaoPay, Mercado Pago, OXXO), Afterpay, Affirm,
  Tabby, Tamara, Stripe Link, Amazon Pay, Visa Intelligent Commerce and Mastercard Agent Pay, and the
  UCP payment handler names a network reads, `handlers` and `handlers_last`); `PAYMENT_TOKENS`,
  `MAX_PROFILE_PAYMENTS`, `paymentLabel`, `paymentToken`, `isPaymentToken` and `sortPaymentTokens`;
  a profile's `payments`, at most 64 (`vectors/profile.json`); each payment of a listing with its
  evidence, declared by the business or only seen (`accepts.pay_with`, also on a check result as
  `pay_with`); and the census's payment metrics (`pay_read`, `pay:<token>`, `pay_declared:<token>`,
  and an edition's `payments`). A 0.6 reader of manifests, profiles and listings ignores what it does
  not know. A 0.6 reader that validates census editions against `schemas/census-edition.json` must
  move to 0.7: 0.6's metric pattern names its metrics one by one and refuses `pay_read`. From 0.7 the
  metric pattern is any lower-case name with at most one key after a colon, and `pay_with.via` any
  lower-case name, so a metric or a source of evidence added later validates: a reader skips one it
  does not know. With it, optional for a network ([ADR-024](../../docs/adr/024-owners-in-control.md)):
  a business's inbox found from its domain (`discovery-result`, the MCP tools `check_dns` and
  `start_inbox`, `vectors/discovery.json` and `vectors/discovery-words.json`; protocol §4.14a), and
  the owner's page in a listing's `owner.manage`.
- 0.8 (optional for a network): carried requests ([ADR-025](../../docs/adr/025-carried-requests.md)): `ask_business`, `request_quote` and
  `request_booking` carry a person's request to a business's own inbox (`schemas/mcp-ask-business-*`,
  `mcp-request-quote-*`, `mcp-request-booking-*`); the manifest's `carried_requests`, which an inbox with
  the owner's switch publishes either way (a network carries nothing to a manifest without it); the
  `Surfing-Dog-Carried` and `Surfing-Dog-Carried-For` headers a carried request comes with; and the
  `carried` counts a signed ping's answer gives the business. Over MCP a network may leave out the `report` hint, and may answer `initialize` with a
  signed session id used only for its limits.

- 0.10 ([ADR-032](../../docs/adr/032-money-policies-schedules.md)): money in every currency's own minor unit: a
  `money.value` is an integer count of the ISO 4217 minor unit of its `currency` (4500 is KSh 45.00,
  ¥4,500, KWD 4.500), read with `minorUnits`, `decimalOf`, `parseDecimal` and `shareOf` (the exponent
  table is `ISO_4217_MINOR_UNITS`; fund codes, metals and "no currency" are not money a price is in).
  A reader on 0.9 that assumed hundredths for every currency must move: its amounts were already in
  minor units for every currency it took. Policies as data (`policySchema`: steps before a start, fees
  `none`, `percent`, `amount`, `units` or `full`, a no-show fee and whether a deposit is refundable; a
  dated policy, `datedPolicySchema`), and payment schedules in UCP's `payment.terms` shape
  (`paymentScheduleSchema`: `immediate`, `deferred` or `at_property`; `scheduleProblem`, the invariant
  that the schedules add up to the total).
- 0.11 ([ADR-034](../../docs/adr/034-trades.md)): trades and projects. Files on a request
  (`attachmentRefSchema`: JPEG, PNG, WebP or PDF by their first bytes, at most six of 10 MB, and room of
  their own for files waiting for a request, `ATTACHMENT_LIMITS`); where a business works, as it says so in public (`areaSummarySchema`: a radius in
  km or postal prefixes, never the place a radius is measured from; `checkAreaInputSchema` and
  `checkAreaOutputSchema` for `check_area`; a site told as a band, `areaCheckSchema`); the job a request
  for a price describes (`jobSchema`: urgency, visit, site, up to three windows, a budget range); a trade's
  quote (`tradeQuoteSchema`: estimate or fixed, stages on the 0.10 payment schedule, call-out and visit
  fees already taken off the total or paid apart, tax included or not, the total always what the
  customer pays with its tax; a line's `quoteLineKindSchema`); and how a trade takes work
  (`workProfileSchema`, `get_business_profile`'s `work`). Schemas: `attachment-ref`, `area-summary`,
  `job`, `trade-quote`, `work-profile`, `mcp-check-area-input`, `mcp-check-area-output`.

Everything here is published, byte for byte, at https://surfingdog.ai/spec/ (the files under
`/spec/schemas/`, `/spec/vectors/` and `/spec/vocab/`, the vocabulary's versions at
`/spec/capabilities/v<N>.json` and the latest at `/spec/capabilities.json`, and `/spec/index.json`,
which lists them), readable from any origin, with a page for people for each spec and a page that
checks a pasted manifest, receipt or acknowledgement in the browser.

The Zod schemas in `src/` are the source; `schemas/` holds one JSON Schema per message, generated
from them. `vectors/` holds the test vectors, which decide any difference between two
implementations:

| File | What it pins down |
|---|---|
| `receipts.json` | receipts and acknowledgements (ADR-016): fixed keys, the `sub` derivation, JWS any Ed25519 implementation must reproduce byte for byte, and the refusals |
| `receipts-v2.json` | v2 claims: every promise kind and every outcome an inbox records, an acknowledgement naming a pass (`pas`), the refused claims with their codes, §3's outcome table, and every path through the booking and order machines with the outcome it records |
| `signatures.json` | RFC 9421 requests: sdi-instance/1, sdi-agent/1 with a self-held key and with Web Bot Auth (both `Signature-Agent` forms), forwarded signatures (`agent_key`), and refusals with their codes |
| `passes.json` | key, pass and pass-reference strings, `ppid`, `email_mac`, and 43 email normalisation cases |
| `scoring.json` | the network's scores (ADR-017 §5): every worked example, the R5 grid, ageing, hold and release |
| `ordering.json` | the network's order (ADR-017 §6): shuffles above 2^53, one snapshot's order, cursors |
| `profile.json` | what the network keeps from a manifest's profile (ADR-017 A2.5): each field checked and dropped alone, hours, categories and tags |
| `doors-elsewhere.json` | what a reader keeps of a manifest's `doors_elsewhere` (`readDoorsElsewhere`): the kinds of request a business takes somewhere else, and where, each entry checked and dropped alone |
| `mcp.json` | what an assistant reads from the network's tools (ADR-017 A2.7): the card derived from each listing, today's hours in the business's zone, and one answer of each tool |
| `score.json` | the agentic score, rules version 2 (§4.13): for each case a profile and every capability's state, and the score, grade, numerator and fixes the published formula gives; `score-v1.json` the same under version 1 |
| `door-reports.json` | door reports (§4.15): how a network reads a call (strict JSON, the limits, each report taken or ignored and why), what each report can do by its proof and source, and how the network's own reads move a door (§4.8) |
| `door-history.json` | a door's history (§4.8): the days seen answering, days checked, answered and refused, the floored share from 14 days, the last 90 days as a line, since or from…to, and the door types never shown; `summary` is informative |

`vocab/categories.json` is the categories list a profile names its categories from: each slug with
its English and Portuguese labels and synonyms. Protocol 0.2 adds `vocab/doors.json` (the door
types, and the human channels that are never doors) and `vocab/attributes.json` (the attributes a
listing may carry, with the categories each applies to and labels in five languages); the network
serves the same files. `vocab/capabilities.json` is the capability vocabulary (what an agent can do
with a business, from finding it to a refund) and `vocab/score-rules-v2.json` the agentic score's
rules, version 2, in force from 7 October 2026, as `GET /v1/score-rules` serves them
(`vocab/score-rules-v1.json` is version 1, retired, at `?version=1`); `doors.json` version 2 adds the
`experimental` door types, which count toward the score and never toward a level.
`vocab/door-report-classes.json` (0.4) lists the classes a door report may carry, by phase and
result, with the JSON-RPC, MCP, A2A and HTTP codes each one stands for.
`vocab/payments.json` (0.7) is the payments vocabulary, the network's own file byte for byte: the
tokens a profile's `payments` and a search's `accepts` name, their labels, and how a network reads
what a business writes (synonyms), what it sees on a site's pages (marks) and a UCP profile's payment
handlers (handlers). A token is never removed or renamed.

`receipts.json` is written by `npx tsx scripts/gen-receipt-vectors.ts` from `packages/core`;
`receipts-v2.json`, `signatures.json`, `passes.json` and `schemas/` by
`npx tsx scripts/gen-network-vectors.ts` (then `npx biome format --write ../spec`). `scoring.json`,
`ordering.json`, `profile.json`, `mcp.json` and `score.json` come from the network unchanged.
`door-history.json` is written by `python3 scripts/gen-door-history-vectors.py` (Python's standard
library only: an implementation of its own, in another language than either side it checks). `packages/core/test/*-vectors.test.ts` checks
every file against the code on Node and in workerd; the network checks the same files in Go.
