# Contributing

Thank you for helping. Surfing Dog Inbox is MIT licensed, and contributions are welcome under the
same licence.

## Before you start

- **A bug:** open an issue with what you did, what you expected and what happened. Say how you run it
  (our hosting, the installer, Docker, Workers) and the version (`/healthz` shows it).
- **A connection to a system you use** (a booking, shop, property or payments system): ask for it in
  an issue. We build integrations when businesses ask for them, so a request is how one starts.
- **A bigger change:** open an issue first. Read the [decision records](docs/adr/) that touch it; they
  explain why things work the way they do.
- **A security problem:** don't open an issue. See [SECURITY.md](SECURITY.md).

## Working on it

You need Node (22.16 or later) and pnpm 11 (`npm i -g pnpm@11`).

```bash
pnpm install
pnpm dev               # the server on Node, http://localhost:8787
pnpm test              # every test, on Node and on Workers
./scripts/verify.sh    # everything CI runs
```

- Keep a change to one thing, with tests for what it changes. Tests run on both runtimes unless a
  file ends in `.node.test.ts` or `.workers.test.ts`.
- `pnpm check` (Biome) checks formatting and lint, and `pnpm typecheck` the types; both must pass.
- A change to the database adds a migration in `packages/core/drizzle` and runs
  `node packages/core/scripts/embed-migrations.mjs`.
- Words people read (the owner app, emails to customers, the site) are plain and short, in the
  business's voice.

## Pull requests

Describe what changes for the person using the inbox, and how you tested it. A maintainer reviews
every pull request; CI must pass before it is merged.
