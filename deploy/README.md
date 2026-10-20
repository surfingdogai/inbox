# Run it yourself

Everything here runs the same image, `ghcr.io/surfingdogai/inbox` (amd64 and arm64), built from this
repository's `Dockerfile` on each release. The full guide is at
[surfingdog.ai/docs/run-it-yourself](https://surfingdog.ai/docs/run-it-yourself/).

## One command, on a server of your own

A fresh Ubuntu or Debian server, and a subdomain of your business's domain pointed at it:

```bash
curl -fsSL https://surfingdog.ai/install.sh | sudo sh
```

It asks for the address and the owner's email, checks that ports 80 and 443 are free and that the
address has a DNS record before it installs anything, installs Docker if it is missing, checks the
address leads to the server, and starts the inbox behind Caddy with HTTPS. Read it first if you like: it
is one file, [`apps/site/public/install.sh`](../apps/site/public/install.sh), built from
[`install.sh`](install.sh) and the files beside it by `node scripts/build-install.mjs`. Its checksum is
at `https://surfingdog.ai/install.sh.sha256`, and every release attaches it with `SHA256SUMS` and a
build provenance attestation (`gh attestation verify install.sh -R surfingdogai/inbox`). It sends
nothing about you anywhere.

Then `sudo inbox status | update | backup | restore | help` ([`inbox`](inbox)).

## Docker Compose, by hand

```bash
cp .env.example .env              # INBOX_DOMAIN, INBOX_OWNER_EMAIL, INBOX_SECRET_KEY (openssl rand -base64 32)
mkdir -p data probe && sudo chown 10001:10001 data
docker compose up -d
```

[`docker-compose.yml`](docker-compose.yml) runs the inbox and [Caddy](Caddyfile), which gets the
certificate. The data is `./data/inbox.db`, one SQLite file.

## A platform you already use

| | |
| --- | --- |
| [Coolify](coolify/docker-compose.yml) | Docker Compose, with Coolify's own proxy and certificate |
| [Fly.io](fly/fly.toml) | one machine, one volume |
| [Render](../render.yaml) | a Blueprint with a disk (paid instances only) |
| Railway | the image, a volume, `RAILWAY_RUN_UID=0` and `INBOX_CLIENT_ADDRESS_HEADER=x-real-ip`: see the guide |
| [DigitalOcean](digitalocean/cloud-init.yml) | a Droplet that runs the installer at first boot; App Platform cannot keep a database file |

The inbox's data is one SQLite file, so each runs exactly one copy of it, on a disk that lasts.

## Backups

`sudo inbox backup` writes a full copy, made by the inbox while it serves; the installer makes one every
night and keeps seven. [Litestream](litestream/) is the optional second line, to S3-compatible
storage. [surfingdog.ai/docs/backups](https://surfingdog.ai/docs/backups/).

## Tests

`deploy/test`: the installer and `inbox` against stand-ins for the system's commands (`pnpm test:node`),
the image's smoke test (`smoke-image.sh`), and the installer for real in a systemd container
(`installer-vm.sh`). The `self-host` workflow runs all three.
