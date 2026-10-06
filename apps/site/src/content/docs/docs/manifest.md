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
    "hours": {
      "timezone": "Europe/Lisbon",
      "weekly": { "mon": [["09:00", "13:00"], ["14:00", "18:00"]], "sat": [["10:00", "13:00"]] },
      "closures": [{ "from": "2026-12-24", "to": "2026-12-26" }]
    },
    "services": [
      { "name": "Tune-up", "type": "booking" },
      { "name": "Wheel build", "type": "quote_request" }
    ]
  },
  "item_types": ["message", "quote_request", "booking", "refund"],
  "protocols": {
    "openapi": "https://inbox.example/openapi.json",
    "rest": "https://inbox.example/v1",
    "mcp": "https://inbox.example/mcp"
  },
  "agent_policy": {
    "tiers": ["anonymous", "signed_agent", "verified_principal", "reputed_principal"],
    "signatures": ["sdi-agent/1", "web-bot-auth"],
    "passes": true,
    "networks": ["https://network.surfingdog.ai"],
    "guide": "https://surfingdog.ai/for-agents.md"
  },
  "receipt_keys": { "keys": [{ "kty": "OKP", "crv": "Ed25519", "x": "…", "kid": "…" }] },
  "review_services": []
}
```

| Field | Meaning |
| --- | --- |
| `spec` | The format version. Always `surfingdog-inbox/0` today. |
| `instance` | The instance's origin. |
| `profile` | Public profile data the directory may index: the business's name and languages; the description, categories, postal address, coordinates and website the owner filled in under Settings (each only when it is not empty); its weekly hours with the closures that have not ended; and up to thirty active services, by name and how each is taken. The inbox never puts a contact email, a phone or the legal address in it. Absent until the business has a name. What else an instance sends each network it reports to is on [Security and privacy](/docs/security-and-privacy/). |
| `item_types` | Which of `message`, `quote_request`, `booking`, `order`, `refund` this instance really accepts, from what it offers: `message` always; `booking` with an active service that has weekly hours; `order` with an active product; `quote_request` with either; `refund` with orders, or with bookings of a priced service. A fresh inbox lists only `message`. |
| `protocols` | Protocol name to entry URL. Today: `openapi`, `rest`, `mcp`. Adapters add their own keys as they ship (`a2a`, `ucp`, `arp`, `email`, `form`). The owner's own door, `/mcp/owner`, is not listed: it is for the owner's AI, not for anyone reading the manifest. |
| `agent_policy.tiers` | The trust tiers the instance serves, from `anonymous`, `signed_agent`, `verified_principal`, `reputed_principal`. |
| `agent_policy.signatures` | Request signatures it verifies on every public door: `sdi-agent/1` (HTTP Message Signatures with the agent's own key) and `web-bot-auth` (a platform's key directory, named by `Signature-Agent`). |
| `agent_policy.passes` | Whether it presents a person's passes and keys to their networks (it needs `INBOX_SECRET_KEY` and a public address). |
| `agent_policy.networks` | The networks switched on in Settings → Networks: whose people it recognises, and which may issue a first-time customer a key through it. |
| `agent_policy.guide` | How an agent identifies itself and its person here, step by step. |
| `receipt_keys` | A JWKS with the instance's Ed25519 receipt-signing keys, the same keys `/.well-known/jwks.json` serves. Empty on an instance that has never issued one, or that has no `INBOX_SECRET_KEY` to seal a key with. |
| `review_services` | The networks this instance publishes [receipts](/docs/receipts/) (and, later, reviews) to, by origin: every network switched on in Settings → Networks that takes receipts. Empty means none. `https://network.surfingdog.ai` is only the default. |
| `directory` | `{"listed": false}` when the business has left the networks' directories: the owner switched the listing off, or every network switched on is kept from it. Absent means listed. A network reads it when it fetches the manifest; one this inbox can sign to is also told at once with a signed `POST /v1/instances/{domain}/listing`, which is the only way to leave one network's directory and stay in another's. |

The schema is a Zod object in [`packages/spec/src/index.ts`](https://github.com/surfingdogai/inbox/blob/main/packages/spec/src/index.ts). The instance builds the document from its business profile and serves it with a five-minute cache header.

## Finding the manifest

Besides the well-known path, a business may point at its instance from its main domain with a DNS record:

```
_agent-inbox.example.com. TXT "v=sdi1; manifest=https://inbox.example/.well-known/agent-inbox.json"
```

The same URL will be cross-linked from the A2A card, the UCP profile, `llms.txt` and a `<link rel>` on the website as those adapters arrive.

## A live one

The live instance's manifest is at [inbox.surfingdog.ai/.well-known/agent-inbox.json](https://inbox.surfingdog.ai/.well-known/agent-inbox.json).
