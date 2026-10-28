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
- **A network from day one.** A new inbox joins the networks its policy names (`join_networks`;
  absent, network.surfingdog.ai; empty, none) with its first settings, listed in their directories,
  with listing, counts and receipts and with keys for first-time customers off. They are held off
  while it is only at its setup address and come on the moment it is live at the business's own
  name; the owner can switch them off, before then too, and that choice survives the inbox going
  back to its setup address and live again. An inbox made before this is left as it was until the
  operator joins it on purpose: `POST /admin/v1/tenants/{id}/networks/join`, or `join-networks`.
- **Plans and the spam filter.** The policy's `plan` (`free` or `pro`; absent, Free) says what an
  inbox has. Pro includes the spam filters, on from the start and read by Gemini through Google's
  Gemini API on the operator's own key, `HOSTED_SPAM_GEMINI_KEY` (from a Google Cloud project with
  billing on, so the paid tier's terms apply), in the shards' environment only (unset, no model is
  asked and Settings says the AI check isn't on yet); `HOSTED_SPAM_MODEL` names another Gemini model
  (`gemini-3.1-flash-lite` unless set), `HOSTED_SPAM_DAILY_TOKENS` the runtime's daily ceiling. Each
  check is sent with `store: false`, so the project's own request logs never keep it. The policy's `spam` block may stop
  the AI for an inbox (`ai: false`) or set its caps (150 checks a day, 1,500 a month by default),
  which the ledger keeps across every shard.
- **Known spam, shared.** The ledger also keeps the fingerprints of known spam the inboxes share,
  keyed with a key derived from its own: never a message, an address or a name. Every inbox reads
  them, and a match alone only labels. Pro inboxes live at their own domain report spam to them; any
  inbox that is not read-only, Free too, reports a Not spam on a match, which only ever lowers it. A
  fingerprint counts once inboxes of three other owners, with accounts a week old, reported one like
  it within a fortnight (distinct owners and distinct inboxes both); all is forgotten after 30 days.
  The owner is the policy's `owner_account.id` when the control plane sends one, so one account's
  inboxes count once, else the inbox's own tenant id: never `owner_email`, which an owner can change,
  and each new address would be a new reporter. `owner_account.created_at` dates the account; without
  it the owner is dated from when this runtime first opened the inbox.
- **Per machine, for now.** The ledger is one file on the machine the shards run on. The runtime's
  daily token ceiling (`HOSTED_SPAM_DAILY_TOKENS`) and the shared list are therefore per runtime:
  with a second machine, each has its own ceiling (the service-wide ceiling is that many times the
  setting) and its own list, and inboxes on different machines share nothing. An inbox's day and
  month caps hold because an inbox runs on one machine at a time. Moving both to the control plane
  is the step before a second machine.

Every name, socket, key and directory comes from the environment; see `src/config.ts`.

```sh
pnpm --filter @surfingdog/hosted build      # dist/hosted.mjs
node dist/hosted.mjs router                 # the router
node dist/hosted.mjs shard 0                # one shard (0 … HOSTED_SHARDS-1)
node dist/hosted.mjs all                    # the router and every shard, restarted when one ends
node dist/hosted.mjs migrate-check <file>   # brings a copy of an inbox's file to this release's schema, or fails
node dist/hosted.mjs maintenance-off <id>   # lets an inbox out of maintenance
node dist/hosted.mjs join-networks <id>     # joins an inbox made before day-one joining (with a shard's settings)
```

Run `migrate-check` on a copy of every inbox's file before restarting a shard on a new release: a
migration is never tried first on a live inbox.

Signed calls (`X-SD-Time`, `X-SD-Nonce`, `X-SD-Sig`) use the configured key string's own bytes as
the HMAC key, so every side signs the same way whatever the string looks like. The fixed vectors in
`test/admin.node.test.ts` are the ones a caller should check its own signer against.
