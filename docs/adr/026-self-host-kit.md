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
   the builder's platform and the last stage is `node:24-alpine` with one file and the owner app.
   Non-root: uid 10001, fixed, so a host folder can be given to it. A health check on `/healthz`
   (every 2 s while it starts), the data a volume at `/opt/inbox/data`. Each release is smoke-tested
   on both architectures (`deploy/test/smoke-image.sh`) before the GitHub Release is made, with build
   provenance attested and an SBOM.
2. **Root only to hand itself the data folder.** Some platforms mount volumes that belong to root
   (Fly.io, Render, Railway). The image's entry (`apps/inbox/docker/start.mjs`) gives the data folder to
   uid 10001 when it is started as root, then becomes that user before the server loads; started as
   anyone else on a folder it cannot write, it stops with the one line that fixes it. The server never
   runs as root.
3. **Compose with Caddy, the data on disk.** `deploy/docker-compose.yml`: the inbox (read-only root,
   no capabilities, no new privileges, logs capped) and Caddy, which gets and renews the certificate.
   The data is `./data`, one SQLite file to copy. Only Caddy listens outside. Caddy drops a caller's
   `CF-Connecting-IP`, as install.md's block does.
4. **A one-command installer, for Ubuntu and Debian.** `curl -fsSL https://surfingdog.ai/install.sh |
   sudo sh`: it installs Docker from Docker's own apt repository if it is missing, asks only the
   address and the owner's email (a whole domain gets the choice of `inbox.<it>` first), checks the
   address points at the server before writing anything (its own interfaces, else a token served on
   port 80 through NAT), writes `/opt/inbox`, starts it, waits for HTTPS, and says the next step. It is
   idempotent: a second run keeps the data, the secret key, the version and the certificate mode, and
   refuses to make a new key over a settings file that lost its own. It sends nothing anywhere. It is
   one file, built from `deploy/install.sh` and the kit files it carries (`scripts/build-install.mjs`),
   served with its checksum, attached to every release. Nothing runs until its last line has arrived.
5. **The `inbox` command, and updates that roll back.** `update` downloads first, then stops the
   inbox, makes a backup with the inbox's own `backup` command (never migrating: a backup before an
   update is the old version's database), starts the new version and waits for `/healthz`; if it does
   not answer, the old version comes back on that backup. `rollback` does the same on request.
   `restore` looks at the file first (`check-db`: SQLite, sound, an inbox's, not from a newer
   version), backs up what is there, and puts it back if the inbox does not start. A backup every
   night, seven kept. `sign-in` reads the sign-in email from the log while email is not set up;
   `email` asks for a provider's key without showing it, so the person types it, not their AI.
6. **Platforms, only where a database file survives.** Coolify (a named volume), Fly.io (one machine,
   one volume), Render (a disk: paid instances only, and a deploy is a few seconds offline), Railway
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
  update, a rollback, a restore, Docker restarting), and the image on amd64 and arm64 machines.
- Release order: the site says the image and `install.sh` exist, so the first version tag is pushed,
  its release workflow passes and the package `ghcr.io/surfingdogai/inbox` is made public **before**
  the site that says so is deployed. Until a release exists, the installer finds no version and stops
  with the releases' address.
- The Node build stays (install.md, path B3), now also as `inbox-server.tar.gz` on each release, for a
  server without Docker.
