# ADR-013 — surfingdog.ai is a live dashboard; networks are pluggable; telemetry is counts only

**Status:** accepted (21 Sep 2026, Tiago: "surfingdog.ai should feel like a live dashboard of live
installations, businesses, orders, bookings, messages, queries; network status and easy signup,
deploy to Cloudflare etc. Businesses should be able to deploy it in their server as well.
network.surfingdog.ai is just one network, configurable by the business owner in settings.")

## Decision
- **The root site is the Go network app**, not a static marketing page. `surfingdog.ai` shows
  live numbers: instances online (pinged in the last 24 hours), businesses listed, items handled
  today by type (bookings, orders, quotes, messages), receipts issued, reviews published, and the
  network's own status (API health, job lag). Around the numbers: sign-up for hosted (magic link),
  and the **three ways to run**: Deploy to Cloudflare, your own server (`npx` one-liner, single
  executable, optional Docker), or hosted by us. Docs stay Astro Starlight, built static in CI and
  served by Caddy at `surfingdog.ai/docs`.
- **Telemetry is counts only.** An instance's ping carries its software version, runtime, and the
  number of items created in the last 24 hours per type. No content, no identities, no amounts.
  One settings switch, "share anonymous activity counts with the network", on by default and
  explained in the wizard. The dashboard sums pings; receipts and reviews come from the network's
  own tables.
- **Networks are pluggable.** Settings → Directory and network holds a list of networks, each
  `{url, enabled, share: {listing, counts, receipts, reviews}}`, default
  `https://network.surfingdog.ai`. An instance may join none, one or several; the manifest's
  `review_services` reflects the choice; the MIT spec lets anyone run a network.
- **Own-server deployment is first class.** The Node/Bun target ships with the same care as the
  Cloudflare button: one command, a single executable, a documented backup path (Litestream or
  nightly snapshots), and the same conformance tests.

## Why
The public face should show the network is alive and make the first step obvious. Businesses that
will not use Cloudflare or our hosting must still be first-class. One network run by us must not
be a lock-in: the value is the open receipt and review format, not the host.

## Consequences
the first release gains a minimal Go app: the ping endpoint with counters, the dashboard, hosted sign-up and
the deploy paths. The full directory, reviews and reputation stay a later release. The map's `HOST` moves
to `map.surfingdog.ai` when the dashboard takes the root.
