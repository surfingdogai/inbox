# Example network

A small network at the **directory level** of the [network protocol](../../docs/protocol/network.md#10-levels).
Point an inbox at it and it is verified, listed and searchable, and the receipts it signs are
kept and counted. Node and one SQLite file; nothing else to run.

It is here to show that the protocol is enough to build a network from: everything it does is
in the spec, and [network-check](../../packages/network-check) passes it on every `must`. Read it,
copy it, change it. MIT.

## What it does

| | |
|---|---|
| **Joining** | `POST /v1/instances` reads the domain's manifest at `/.well-known/agent-inbox.json` (public address only, 5 s, 256 KB, no redirects) and lists the business once the manifest names itself. |
| **Staying** | Pings are recorded, and a signed one is answered with the rules. Every member's manifest is read again every six hours; registering again reads it at once. |
| **Leaving** | `POST /v1/instances/{domain}/listing`, signed with that domain's own key. Ten changes a day. |
| **Receipts** | `POST /v1/receipts` checks the signature against the issuer's published keys, the claims, the nonce and, for an outcome, the receipt it answers. A receipt it cannot check is refused, never kept. |
| **Directory** | `GET /v1/businesses` (`q`, `category`, `language`, `item_type`, `cursor`), `GET /v1/businesses/{domain}` with its counted outcomes, `GET /v1/categories`. |
| **Assistants** | `/llms.txt`, and `POST /mcp` with `search_businesses`, `get_business` and `list_categories`. |
| **Everything else** | `404 not_found`, as §10.1 asks: no persons, no reputation, no reviews. |

Its rules document says so, which is how an inbox knows not to ask it for more:

```json
{ "version": 1, "protocol": { "level": "directory", "claims": 2 } }
```

An inbox that joins it keeps signing receipts for it, and never asks it about a person.

## Run it

```bash
git clone https://github.com/surfingdogai/inbox && cd inbox
pnpm install
cd examples/network
NETWORK_ORIGIN=https://network.example.org PORT=8080 NETWORK_DB=network.db pnpm start
```

Put it behind a proxy that serves `NETWORK_ORIGIN` over https: an instance signs requests for
that authority, and the network refuses any other. Node 22.16 or later.

| Variable | |
|---|---|
| `NETWORK_ORIGIN` | The https origin the network is reached at. |
| `PORT` | Where it listens. 8080 by default. |
| `NETWORK_DB` | The SQLite file. `network.db` by default. |
| `NETWORK_TEST_MANIFESTS` | **Tests on one machine only.** `domain=url,…` reads those domains' manifests from those URLs instead of from the domain. Never set it on a network other people use. |

## Check it

From `packages/network-check`, against a copy running on this machine in test mode:

```bash
cd examples/network
NETWORK_ORIGIN=https://network.localhost PORT=8080 NETWORK_DB=:memory: \
NETWORK_TEST_MANIFESTS=inbox-check.test=http://127.0.0.1:8788/.well-known/agent-inbox.json \
pnpm start
```

```bash
cd packages/network-check
pnpm check https://network.localhost --base http://127.0.0.1:8080 --flow
```

The flow plays an inbox from start to finish: it joins, pings, replays a signature, leaves and
comes back, signs receipts and an outcome, and tries the forgeries a network must refuse.

## Joining an inbox to it

In the inbox, **Settings → Networks → Add a network**, and give it the origin. The inbox reads
the rules, sees the directory level, and from then on registers, pings and sends its receipts
there as it does to any network.
