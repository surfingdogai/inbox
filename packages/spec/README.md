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

`receipts.json` is written by `npx tsx scripts/gen-receipt-vectors.ts` from `packages/core`;
`receipts-v2.json`, `signatures.json`, `passes.json` and `schemas/` by
`npx tsx scripts/gen-network-vectors.ts` (then `npx biome format --write ../spec`). `scoring.json`,
`ordering.json`, `profile.json`, `mcp.json` and `score.json` come from the network unchanged. `packages/core/test/*-vectors.test.ts` checks
every file against the code on Node and in workerd; the network checks the same files in Go.
