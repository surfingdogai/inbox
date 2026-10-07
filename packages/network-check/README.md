# network-check

Checks a network against the [network protocol](../../docs/protocol/network.md), at the level
its rules say it offers ([§10](../../docs/protocol/network.md#10-levels)). Every check names
the section that asks for it, and whether it is a `must` or a `should`. MIT.

Two ways to run it:

- **Read-only**, against any network, a production one included. It reads the rules (a version
  newer than it knows, leniently), the directory, `/llms.txt` and the MCP door; checks that no
  door it lists is a human channel (mail, phone, messaging, forms, web pages) and that each
  filter only leaves businesses out, keeping the order; and sends only requests a correct network
  refuses without keeping anything: a listing change with no signature or the wrong one, a
  forged receipt, a ping for a domain nobody registered. Those about an instance (its status, its
  listing switch, its receipts) are asked of a listed member, never of an entry the network found
  or one registered without an inbox; with no member listed they are skipped.
- **`--flow`**, against a network in a test mode. It plays an inbox from start to finish: it
  publishes a manifest, registers, pings unsigned and signed, replays a signature, leaves the
  directory and comes back, signs receipts and an outcome, and tries the forgeries a network
  must refuse. The network has to read that manifest from this machine, so never point `--flow`
  at a network other people use.

## Run it

```bash
git clone https://github.com/surfingdogai/inbox && cd inbox
pnpm install
cd packages/network-check
pnpm check https://network.surfingdog.ai
```

```
✓ rules.read                   must   §4.4, §10    full level, claims 6, read from version 6
✓ directory.list               must   §4.3         1 listed
✓ doors.no-human-door          must   §4.8         no doors listed
✓ filters.narrow               should §4.3         each kept the order: language=pt: 1 of 1, …
✓ score.rules                  should §4.13        version 1, 7 profiles, 19 capabilities
✓ discovery.catalog            should §4.14        6 entries, every one at an https address
✓ listing.unsigned             must   §3, §4.5     401 bad_signature
✓ receipts.forged              must   §4.2         422 unknown_key
…
```

It exits 0 when every `must` passed and 1 otherwise, so it can sit in a network's CI.

| Option | |
|---|---|
| `<origin>` | The network's `https://` origin: what signatures name. |
| `--base <url>` | Where requests go when that is not the origin, like a network on this machine with no proxy in front. |
| `--flow` | Play an inbox (above). |
| `--flow-domain <domain>` | The inbox's domain. `inbox-check.test` by default. |
| `--flow-port <port>` | Where its manifest is served, on 127.0.0.1. 8788 by default. |
| `--json` | The whole report as JSON instead of lines. |

## The flow, on one machine

The [example network](../../examples/network) has a test mode for this: it reads the checker's
manifest from the checker instead of from the domain.

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

A network of your own needs the same switch: some way, in a test only, to read
`inbox-check.test`'s manifest from `http://127.0.0.1:8788/.well-known/agent-inbox.json`.

## From code

```ts
import { checkNetwork } from "@surfingdog/network-check";

const report = await checkNetwork({ network: "https://network.example.org" });
report.protocol; // { level: "directory", claims: 2 }
report.passed;   // every must passed
for (const r of report.results) if (r.outcome === "fail") console.log(r.id, r.section, r.detail);
```

`fetch` replaces the network call, so a network can be checked in its own tests without a
port: hand it the app's own `fetch`. With `flow`, `publishManifest` receives the manifest to
make readable; the [checker's own tests](test/check.node.test.ts) do both against the example
network in one process.
