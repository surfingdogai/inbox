# ADR-026 — The self-host kit: an image, a Compose file, a one-command installer and releases

**Status:** accepted, 20 October 2026.

## Context

Running the inbox yourself meant cloning the repository, installing pnpm, building, and writing a
systemd unit and a Caddy block by hand (install.md, path B), or building the Docker image yourself.
That is fine for a developer and an AI with a shell, and a wall for a small business with a server.
The hosted inbox now comes first everywhere; running it yourself has to be as short as it can be,
and as safe to keep running: updates, backups, a restore.

## Decision

1. **One image, published.** `ghcr.io/surfingdogai/inbox`, for amd64 and arm64, built by the
   `release` workflow from the repository's `Dockerfile` on every version tag (`v0.1.0`; a pre-release
   `v0.2.0-rc.1` gets no `latest`). The tag must be the version the code says (`packages/core`'s
   `VERSION`, `apps/inbox/package.json`); `/healthz` reports it. Small: the JavaScript is built once on
   the builder's platform and the last stage is `node:24-alpine` (pinned by digest) with one file and
   the owner app.
   Non-root: uid 10001, fixed, so a host folder can be given to it. A health check on `/healthz`
   (every 2 s while it starts), the data a volume at `/opt/inbox/data`. Each release is pushed by
   digest alone, smoke-tested on both architectures (`deploy/test/smoke-image.sh`), and only then
   tagged (version, minor, `latest`); the GitHub Release is made once an anonymous pull works. Build
   provenance is attested, with an SBOM. Every action in the release workflow is pinned by commit,
   and Dependabot proposes new ones, as it does the image's bases and Caddy.
2. **Root only to hand itself the data folder.** Some platforms mount volumes that belong to root
   (Fly.io, Render, Railway). The image's entry (`apps/inbox/docker/start.mjs`) gives the data folder to
   uid 10001 when it is started as root (each link given itself, never followed, and only inside
   `/opt/inbox/data`), then becomes that user before the server loads; started as anyone else on a
   folder it cannot write, it stops with the one line that fixes it. The server never runs as root.
   It ends cleanly on TERM: no new requests, the running job finished, the database closed.
3. **Compose with Caddy, the data on disk.** `deploy/docker-compose.yml`: the inbox (read-only root,
   no capabilities, no new privileges, logs capped) and Caddy, which gets and renews the certificate
   and sends HSTS (read-only root too, and of root's powers only binding ports). Both images pinned.
   The data is `./data`, one SQLite file to copy. Only Caddy listens outside. Caddy drops a caller's
   `CF-Connecting-IP`, as install.md's block does. Behind a platform's proxy that passes the header
   through, `INBOX_CLIENT_ADDRESS_HEADER` names the header that proxy sets itself (`fly-client-ip`,
   `x-real-ip`), or `socket`.
4. **A one-command installer, for Ubuntu and Debian.** `curl -fsSL https://surfingdog.ai/install.sh |
   sudo sh`: it asks only the address and the owner's email (a whole domain gets the choice of
   `inbox.<it>` first). Before it installs anything it checks that ports 80 and 443 are free, that the
   address has a DNS record, and which release is the newest. Then it installs Docker from Docker's
   own apt repository if it is missing, and checks that every address the name points at leads to the
   server (its own interfaces, else a token only that run knows, served on port 80; a record through
   Cloudflare's proxy is refused), writes `/opt/inbox`, starts it, waits for HTTPS, and ends with the
   owner's first sign-in and the line to give their AI. It is idempotent: a second run keeps the data,
   the secret key, the version and the certificate mode, hands a `--version` to `inbox update`, and
   refuses to make a new key over a settings file that lost its own. It sends nothing anywhere. It is
   one file, built from `deploy/install.sh` and the kit files it carries (`scripts/build-install.mjs`),
   served with its checksum, attached to every release. Nothing runs until its last line has arrived.
5. **The `inbox` command, and updates that roll back.** `update` downloads first (the image, and the
   release's kit checked against its `SHA256SUMS`), then stops the inbox, makes a backup with the
   inbox's own `backup` command (never migrating: a backup before an update is the old version's
   database), puts the new kit in place, starts the new version and waits for `/healthz`; if it does
   not answer, the old version and kit come back on that backup. It refuses an older version
   (`rollback` is the way back, with its data). `rollback` does the same on request. `restore` looks
   at the file first (`check-db`: SQLite, sound, an inbox's, not from a newer version), backs up what
   is there, and puts it back if the inbox does not start. Root never writes into the data folder: a
   one-off container of the inbox, as uid 10001, copies and swaps the database, and the command's own
   notes and logs are in `state/`, root's alone. Once it stopped the inbox, it starts it again however
   it ends; one such command runs at a time; Litestream, when it is there, is stopped for a swap. A
   backup every night, seven kept. `sign-in` asks the inbox for a sign-in email and reads it from the
   log while email is not set up; `email` asks for a provider's key without showing it, so the person
   types it, not their AI, and lists the Cloudflare accounts the token can use rather than ask for an ID.
6. **Platforms, only where a database file survives.** Each pins the version, so a redeploy never
   updates the database unasked. Coolify (a named volume), Fly.io (one machine, one volume), Render
   (a disk: paid instances only, a deploy is a few seconds offline, automatic deploys off), Railway
   (a volume, `RAILWAY_RUN_UID=0`; no template until someone publishes one from a Railway account),
   and a DigitalOcean Droplet through the installer. Not DigitalOcean App Platform: it has no disk that
   lasts between deploys, and the docs say so rather than offer something that loses the database.
7. **Backups are the file and the key.** A backup restores an inbox whole only with its
   `INBOX_SECRET_KEY`; every page that mentions backups says to keep the key apart from them.
   Litestream is optional, beside the nightly backups, with its keys in a file of their own.

## Consequences

- The installer is tested three ways: against stand-ins for the system's commands on every test run
  (`deploy/test/*.node.test.ts`), by the `self-host` workflow for real in a systemd container of a
  fresh Ubuntu 24.04 and Debian 12 (install, sign-in, a second run, a broken update rolled back, an
  update, a rollback, a restore, Docker restarting, the address check's token through Caddy), and the
  image on amd64 and arm64 machines.
- Release order: the site says the image and `install.sh` exist, so the first version tag is pushed,
  its release workflow passes and the package `ghcr.io/surfingdogai/inbox` is made public **before**
  the site that says so is deployed. Until a release exists, the installer finds no version and stops,
  before it installs anything, with the releases' address.
- Each release bumps the version the kit's platform files and the docs pin; the release workflow and
  the tests refuse a tag those files do not name.
- The Node build stays (install.md, path B3), now also as `inbox-server.tar.gz` on each release, for a
  server without Docker.
