# ADR-010 — Many doors, one capability set

**Status:** accepted (21 Sep 2026)

## Decision
Exactly one implementation of the twenty operations lives in `packages/core`. Every protocol is a
thin adapter that formats requests and responses and extracts identity evidence; adapters never
touch storage or policy. Each adapter declares the discovery documents it publishes, the evidence
types it can produce, and the spec version it pins; it ships fixtures and its conformance suite
and can be disabled per instance.

Order by cost and reach:
- **the first release:** REST + OpenAPI, public MCP, owner MCP, email in, web form, manifest + DNS TXT +
  JSON-LD + llms.txt.
- **the next release:** RFC 9421 signed agents (Web Bot Auth `web-bot-auth` tag and Visa TAP
  `agent-browser-auth` / `agent-payer-auth` tags), A2A (card, `SendMessage`, `GetTask`,
  `CancelTask`; no streaming), receipts and acknowledgement.
- **a later release:** UCP profile + checkout (`requires_escalation` ↔ `needs_human`; payment deferred
  with `continue_url`), ACP product feed + checkout behind a flag, AP2 SD-JWT mandates stored as
  evidence and hashed into receipts, ARP (Tiago's protocol, v0.7.1) as one more door.
- **a later release:** x402 per-request pricing through a seam left now.

Discovery: the manifest lists every endpoint so an agent can choose a door without fetching each
card; the same item semantics and the same receipt come back through every door.

## Why
Tiago: "We should allow as many protocols as possible and just let agents choose." The landscape
moves monthly (MCP 2026-07-28 removed sessions; ACP's checkout was retired then revived as a spec;
AP2 moved to FIDO; x402 to the Linux Foundation). Betting on one is the only losing move; thin
adapters over one core make each bet cheap.

## Consequences
Conformance suites in CI: `@modelcontextprotocol/conformance`, `a2a-tck`, the UCP suite. A
cross-door simulator asserts "same item, same receipt through every door".
