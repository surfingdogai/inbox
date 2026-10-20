---
title: Run it yourself
description: One command on a server of your own, the Docker image on a platform you use, or Cloudflare Workers. Then updates that roll back on their own.
---

The inbox is open source (MIT), and the same software runs three ways. Each gives the business its own inbox at its own address, such as `inbox.yourbusiness.com`.

| | What you need | What you get |
| --- | --- | --- |
| [One command on your server](#one-command-on-your-server) | An Ubuntu or Debian server, and one DNS record | HTTPS, updates that roll back, a backup every night |
| [Docker, or a platform you use](#docker-or-a-platform-you-use) | Docker, or Coolify, Fly.io, Render, Railway or a DigitalOcean Droplet | The image `ghcr.io/surfingdogai/inbox`, amd64 and arm64 |
| [Cloudflare Workers](#cloudflare-workers) | A Cloudflare account | D1, a queue and a cron, nothing to keep running |

The inbox keeps its data in one SQLite file (on Cloudflare, a D1 database), so every way runs one copy of it, on a disk that lasts.

## One command on your server

On a fresh Ubuntu (22.04 or newer) or Debian (12 or newer) server, amd64 or arm64, with 512 MB of memory or more:

1. Where your domain's DNS is, add an **A record** for the inbox's address, such as `inbox.yourbusiness.com`, pointing at the server's IP address. If the DNS is at Cloudflare, leave the record **DNS only** (grey cloud), so the server can get its own certificate.
2. On the server:

```bash
curl -fsSL https://surfingdog.ai/install.sh | sudo sh
```

It asks two things, the address and the owner's email, then:

- installs Docker from Docker's own repository, if it is missing;
- checks that the address points at this server, and says what to change if it does not;
- writes `/opt/inbox`: the settings in `.env` (readable by root only, with a secret key it generates), a Compose file, and Caddy's site file. The data goes in `/opt/inbox/data`;
- starts the inbox behind [Caddy](https://caddyserver.com), which gets the HTTPS certificate from Let's Encrypt and renews it;
- installs the `inbox` command, and a backup every night that keeps the last seven.

It sends nothing about you or your server anywhere. It downloads Docker's packages (only when Docker is missing), the inbox's image and Caddy's, and reads the newest release's number from GitHub. The script is one file you can read first: [install.sh](/install.sh), its checksum at [install.sh.sha256](/install.sh.sha256), its source in [deploy/](https://github.com/surfingdogai/inbox/tree/main/deploy). To check it before it runs:

```bash
curl -fsSLO https://surfingdog.ai/install.sh && curl -fsSL https://surfingdog.ai/install.sh.sha256 | sha256sum -c && sudo sh install.sh
```

Without questions, for a script or your AI:

```bash
curl -fsSL https://surfingdog.ai/install.sh | sudo sh -s -- --domain inbox.yourbusiness.com --email you@yourbusiness.com --yes
```

Run it again whenever you like. It keeps the data, the secret key and the version, and changes only what you change: `--domain` for a new address, `--email` for the owner's address (which lets only the first account in), `--version` for a release other than the newest. `--help` lists the rest.

### Then

1. **Sign in.** Open `https://inbox.yourbusiness.com/login` and enter the owner's email. Until email is set up, the sign-in email stays on the server: `sudo inbox sign-in` shows its code and link.
2. **Email.** `sudo inbox email` chooses how the inbox sends: through Cloudflare Email Service or Resend, from an address on your domain. Email in is a separate step: [install.md](/install.md), Step 2.
3. **The rest**, from your business's hours to its own site pointing at the inbox: give your AI [install.md](/install.md) from Step 2, or follow it yourself.

Keep a copy of `/opt/inbox/.env` somewhere safe, apart from the server. Its `INBOX_SECRET_KEY` opens what the database keeps sealed, and a backup restores fully only with it.

### The inbox command

```bash
sudo inbox status            # what runs, its version and health, its backups, whether email is set up
sudo inbox update            # the newest release; `sudo inbox update 0.2.0` for that one
sudo inbox rollback          # back to the version before the last update, with the data as it was then
sudo inbox backup            # a full copy of the database now, in /opt/inbox/data/backups
sudo inbox restore <file>    # the inbox as that backup holds it
sudo inbox sign-in           # the last sign-in email's code and link, while email is not set up
sudo inbox owner-key laptop  # a new owner API key, shown once
sudo inbox email             # how the inbox sends email
sudo inbox logs [caddy]      # the inbox's log, or Caddy's
```

### Updates

`sudo inbox update` downloads the new image while the inbox keeps serving, then stops the inbox, makes a backup, and starts the new version, which brings the database up to date on its own. If the new version does not answer within three minutes, it is rolled back: the version of before, on the backup made a moment earlier, so nothing is lost. What the new version said is kept beside the backups. Each release's notes are on [GitHub](https://github.com/surfingdogai/inbox/releases); `sudo inbox status` says when a newer one is out. The last five backups made before an update are kept.

### Behind a proxy you already run

The installer's Caddy needs ports 80 and 443. If the server already serves websites through nginx, Apache or a Caddy of its own, the installer stops and names it, before it writes anything. Run the inbox with Docker on its own and point your proxy at it instead. The settings go in a file of their own, as in [deploy/.env.example](https://github.com/surfingdogai/inbox/blob/main/deploy/.env.example), and the data folder belongs to the image's user:

```bash
sudo mkdir -p /opt/inbox/data && sudo chown 10001:10001 /opt/inbox/data
sudo docker run -d --name inbox --restart unless-stopped -p 127.0.0.1:8787:8787 \
  -v /opt/inbox/data:/opt/inbox/data --env-file /opt/inbox/.env \
  -e INBOX_PUBLIC_URL=https://inbox.yourbusiness.com ghcr.io/surfingdogai/inbox:latest
```

Have your proxy send `inbox.yourbusiness.com` to `127.0.0.1:8787` and drop any `CF-Connecting-IP` a caller sends, as the [install guide's Caddy block](/install.md) does: the inbox limits callers by it when it is there. Updates are then `docker pull` and a new container, with a backup first ([Backups](/docs/backups/)).

### Taking it down

`cd /opt/inbox && sudo docker compose down` stops it and keeps the data. To remove it for good, after a last backup copied elsewhere: `sudo systemctl disable --now inbox-backup.timer`, then remove `/opt/inbox`, `/usr/local/bin/inbox` and the two `inbox-backup` units in `/etc/systemd/system`.

## Docker, or a platform you use

The image is `ghcr.io/surfingdogai/inbox`, for amd64 and arm64, built and smoke-tested by GitHub Actions on every release. It runs as an unprivileged user (uid 10001), keeps the database in `/opt/inbox/data`, and has a health check on `/healthz`. Tags: the version (`0.1.0`), its minor line (`0.1`) and `latest`.

```bash
docker run -d --name inbox -p 8787:8787 -v inbox-data:/opt/inbox/data \
  -e INBOX_OWNER_EMAIL=you@yourbusiness.com -e INBOX_SECRET_KEY="$(openssl rand -base64 32)" \
  ghcr.io/surfingdogai/inbox:latest
```

Every setting is in the [Quickstart](/docs/quickstart/#your-own-server). Commands run inside the container: `docker exec inbox node /opt/inbox/server.mjs create-owner-key laptop`.

**Docker Compose with HTTPS**: [deploy/docker-compose.yml](https://github.com/surfingdogai/inbox/blob/main/deploy/docker-compose.yml) runs the inbox and Caddy, the data in `./data`. It is the file the installer writes, and its [README](https://github.com/surfingdogai/inbox/tree/main/deploy) has the three steps to run it by hand.

**On a platform**: [Coolify, Fly.io, Render, Railway and DigitalOcean](/docs/platforms/), each with what it needs and what it cannot do.

**Without Docker**: every release has `inbox-server.tar.gz`, the Node build (one file and the owner app, for Node 22.16, 24 or 26), with `SHA256SUMS`. [install.md](/install.md), path B, has the systemd unit and the Caddy block to go with it.

## Cloudflare Workers

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/surfingdogai/inbox) copies the repository to your GitHub or GitLab account, creates the D1 database and the queue, and deploys. What to have ready, and what to do after, is in the [Quickstart](/docs/quickstart/#deploy-to-cloudflare); by hand, it is path A of [install.md](/install.md). Backups there are D1's own [Time Travel](/docs/backups/#on-cloudflare).
