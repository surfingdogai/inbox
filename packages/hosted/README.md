# @surfingdog/hosted

Many inboxes on one machine, for whoever runs Surfing Dog Inbox for other people. Node only.

- **Router.** Every request reaches it over a local socket. It finds the inbox by the name asked
  for: a setup address one label under a parent name, or a name of the business's own that points
  here. It applies the rules for the inbox's state and passes the rest to the shard that holds it.
- **Setup address.** It only ever serves the inbox's owner: their app and sign-in. Agent doors,
  the manifest and the customer's pages answer 404. Every answer is `noindex`. Once the inbox is
  live at the business's own name, the owner's pages there move (308) and nothing else is served.
- **Shards.** Each shard keeps one SQLite file per inbox, the ones in use open up to a cap, and
  runs jobs only for the inboxes that have one due. A watchdog thread ends a shard whose event loop
  is stuck and records which inbox was running. An inbox that stalls its shard three times in an
  hour is put into maintenance.
- **Ledger.** One file shared by the shards holds what no single inbox can see: each recipient's
  email today across every inbox, addresses nobody writes to, paused senders and monthly counts.
- **Admin API.** A signed API over a local socket lets the operator's control plane do the rest:
  create an inbox, apply a setup plan, test its doors, hand the owner over, change its policy, read
  its usage and remove it once closed.

Every name, socket, key and directory comes from the environment; see `src/config.ts`.

```sh
pnpm --filter @surfingdog/hosted build      # dist/hosted.mjs
node dist/hosted.mjs router                 # the router
node dist/hosted.mjs shard 0                # one shard (0 … HOSTED_SHARDS-1)
node dist/hosted.mjs all                    # the router and every shard, restarted when one ends
node dist/hosted.mjs migrate-check <file>   # brings a copy of an inbox's file to this release's schema, or fails
node dist/hosted.mjs maintenance-off <id>   # lets an inbox out of maintenance
```

Run `migrate-check` on a copy of every inbox's file before restarting a shard on a new release: a
migration is never tried first on a live inbox.

Signed calls (`X-SD-Time`, `X-SD-Nonce`, `X-SD-Sig`) use the configured key string's own bytes as
the HMAC key, so every side signs the same way whatever the string looks like. The fixed vectors in
`test/admin.node.test.ts` are the ones a caller should check its own signer against.
