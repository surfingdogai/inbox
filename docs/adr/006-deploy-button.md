# ADR-006 — The Deploy to Cloudflare button

**Status:** accepted (21 Sep 2026). What the button runs was run for real on 24 Sep 2026 (see below).

## Decision
Keep one monorepo with **one `wrangler.jsonc` at the repo root** (the app's scripts and the Vitest
plugin point at it with `--config`), `main` and `assets` under `apps/inbox`, and a root
`.dev.vars.example` for the secrets the button prompts for. The button URL is
`https://deploy.workers.cloudflare.com/?url=https://github.com/surfingdogai/inbox`. Run the button for real as soon as the repo is public. If the
button chokes on the workspace, publish a CI-generated, prebuilt `inbox-deploy` template repo per
release (also the source of the `npx` tarball).

## Why
The button (`deploy.workers.cloudflare.com/?url=<repo>`) auto-provisions KV, D1, R2, Hyperdrive,
Vectorize, Secrets Store, Durable Objects, Workers AI and Queues from the wrangler config, but not
Email Routing, Email Sending or Workflows; it needs a public GitHub/GitLab repo; a subdirectory
is treated as the repo root and must carry its own dependencies.

## Consequences
The wizard's email step handles routing after deploy. The button flow is part of the first release's
"done when": a fresh deploy reaches a confirmed sandbox booking in under ten minutes.

## Run for real (24 Sep 2026)
From a clean copy of the repository: install, the build, `wrangler deploy` under a new name with
its own D1 and queue, then sign-in, setup, bookings over REST and MCP, and receipts. What that
changed:

- **No R2.** Nothing stored files in it, and the button made people switch it on. It is gone.
- **Email out is the `send_email` binding** plus `MAIL_FROM`, which the button asks for. Before,
  there was no binding, so the sign-in link reached nobody (the log showed only its subject); with
  one added by hand it went out from `inbox@localhost` and was refused.
- **Signing in never depends on email.** When the inbox has no address to send from (no
  `MAIL_FROM`), the sign-in email goes to the Worker's logs. Only people who can read the account's
  logs see it. It works once, for 15 minutes. (Narrowed on 12 Oct 2026, ADR-004: a send that fails,
  such as from a domain not onboarded, puts only the reason in the log, never the link.)
- **No address to type.** The button cannot know the Worker's URL before it exists. The owner's
  first sign-in over https saves that address as the Inbox address in Settings, and receipts, links
  in emails and networks use it when `INBOX_PUBLIC_URL` is not set.
- **The build is the owner app only** (`npm run build`), not the whole repository with the website.

Still to do: press the button itself on the public repository once these changes are on `main`,
from a fresh account on the free plan, to see the `send_email` binding deploy there too.

## Checked again (20 Oct 2026), without pressing it

Against Cloudflare's current deploy-button and Workers Builds documentation, and by running what the
button runs on a clean copy of `main`, with its tools: pnpm 10.11.1 (Workers Builds' default), which
hands itself to the pnpm 11.3.0 that `packageManager` names; the root `build` script; then
`wrangler deploy --dry-run`.

- **It builds and bundles.** The install and the build pass, and the dry run reads the owner app's
  61 files and binds `DB` (D1), `JOBS` (the queue), `EMAIL` (send_email) and `ASSETS`. The Worker is
  3,851 KiB (836 KiB gzipped), under the free plan's 3 MB limit, which counts the compressed size;
  `wrangler check startup` measures about 70 ms.
- **What the button provisions** is what the file names: the D1 database (the zeros are the
  placeholder ID the documentation asks for) and the queue, both free-plan resources since Queues
  joined the free plan (Feb 2026). Migrations run on the first request, so no deploy step is needed.
  The secrets come from `.dev.vars.example`, their descriptions from `package.json`.
- **Node**: Workers Builds now uses Node 24 by default, inside the inbox's `engines`.
- **Not verified without pressing it:** that a `send_email` binding with no destination deploys on a
  free-plan account with no Email Routing on any zone. Cloudflare's pricing says sending to verified
  addresses is free on every plan, which suggests it does. The first person to press it on a new
  free account settles it; if it refuses, the fix is to move the binding out of the template and
  have the email step add it.
- **Cosmetic, removed:** `vars.INBOX_ENV = "development"` showed in every deployed Worker's settings,
  and nothing read it; it is gone from `wrangler.jsonc`.

Nothing else in the root `wrangler.jsonc` or the build needed changing.
