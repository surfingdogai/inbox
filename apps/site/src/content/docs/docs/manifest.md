---
title: Manifest
description: The discovery document an instance publishes at /.well-known/agent-inbox.json.
---

An instance publishes one small document at `/.well-known/agent-inbox.json`. It says what the instance accepts and where each protocol endpoint lives, so an agent can pick the door it prefers without fetching every card. The path is one constant, `MANIFEST_PATH`, in the MIT `@surfingdog/spec` package, and the name follows the `agent-card.json` pattern; a provisional IANA registration under RFC 8615 is planned once the spec page is stable ([ADR-002](https://github.com/surfingdogai/inbox/blob/main/docs/adr/002-well-known-name.md)).

## Shape

```json
{
  "spec": "surfingdog-inbox/0",
  "instance": "https://inbox.example",
  "profile": {
    "name": "Oficina Maré",
    "description": "Bicycle workshop",
    "categories": ["bicycle-repair"],
    "languages": ["pt", "en"],
    "address": { "addressLocality": "Ericeira", "addressCountry": "PT" },
    "geo": { "latitude": 38.96, "longitude": -9.42 },
    "url": "https://oficinamare.pt",
    "contact_email": "ola@oficinamare.pt"
  },
  "item_types": ["message", "quote_request", "booking", "order"],
  "protocols": {
    "openapi": "https://inbox.example/openapi.json",
    "rest": "https://inbox.example/v1",
    "mcp": "https://inbox.example/mcp",
    "mcp_owner": "https://inbox.example/mcp/owner"
  },
  "agent_policy": { "tiers": ["anonymous", "verified_principal"] },
  "receipt_keys": { "keys": [{ "kty": "OKP", "crv": "Ed25519", "x": "…", "kid": "…" }] },
  "review_services": []
}
```

| Field | Meaning |
| --- | --- |
| `spec` | The format version. Always `surfingdog-inbox/0` today. |
| `instance` | The instance's origin. |
| `profile` | Public profile data the directory may index: name, description, up to ten categories and languages, a postal address, coordinates, a website, a contact email. Nothing else about a business ever leaves the instance. Optional. |
| `item_types` | Which of `message`, `quote_request`, `booking`, `order`, `refund` this instance accepts. |
| `protocols` | Protocol name to entry URL. Today: `openapi`, `rest`, `mcp`, `mcp_owner`. Adapters add their own keys as they ship (`a2a`, `ucp`, `arp`, `email`, `form`). |
| `agent_policy.tiers` | The trust tiers the instance serves, from `anonymous`, `signed_agent`, `verified_principal`, `reputed_principal`. |
| `receipt_keys` | A JWKS with the instance's Ed25519 receipt-signing keys, the same keys `/.well-known/jwks.json` serves. Empty on an instance that has never issued one, or that has no `INBOX_SECRET_KEY` to seal a key with. |
| `review_services` | The networks this instance publishes [receipts](/docs/receipts/) (and, later, reviews) to. Empty means none. The network chosen in Settings appears here once the owner joins; `https://network.surfingdog.ai` is only the default. |

The schema is a Zod object in [`packages/spec/src/index.ts`](https://github.com/surfingdogai/inbox/blob/main/packages/spec/src/index.ts). The instance builds the document from its business profile and serves it with a five-minute cache header.

## Finding the manifest

Besides the well-known path, a business may point at its instance from its main domain with a DNS record:

```
_agent-inbox.example.com. TXT "v=sdi1; manifest=https://inbox.example/.well-known/agent-inbox.json"
```

The same URL will be cross-linked from the A2A card, the UCP profile, `llms.txt` and a `<link rel>` on the website as those adapters arrive.

## A live one

The live instance's manifest is at [inbox.surfingdog.ai/.well-known/agent-inbox.json](https://inbox.surfingdog.ai/.well-known/agent-inbox.json).
