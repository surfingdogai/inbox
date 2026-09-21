# ADR-002 — The discovery manifest lives at `/.well-known/agent-inbox.json`

**Status:** accepted (21 Sep 2026)

## Decision
The manifest is served at `/.well-known/agent-inbox.json`. The DNS pointer on the business's main
domain is `_agent-inbox.<domain> TXT "v=sdi1; manifest=<url>"`. The path is one constant
(`MANIFEST_PATH` in `packages/spec`). We file a provisional IANA registration under RFC 8615
(Specification Required, `wellknown-uri-review@ietf.org`) once the spec page is stable.

## Why
The IANA registry (checked 21 Sep 2026) has no `inbox`, `inbox.json`, `mcp`, `ucp` or
`http-message-signatures-directory` entries; `agent-card.json` (A2A) is registered and permanent.
"inbox" is a loaded word in Linked Data Notifications and ActivityPub (an actor's inbox), so a bare
`inbox.json` invites the wrong reading. `agent-inbox.json` follows the `agent-card.json` pattern,
is vendor-neutral, and reads correctly to an agent.

## Consequences
Cross-link the manifest from the A2A card, the UCP profile, `llms.txt`, a `<link rel>` and DNS.
