---
title: On a platform
description: Surfing Dog Inbox on Coolify, Fly.io, Render, Railway and a DigitalOcean Droplet, with what each needs, and why DigitalOcean App Platform is not on the list.
---

The inbox keeps its data in one SQLite file. A platform runs it well when it gives the container a disk that lasts across deploys and restarts, and runs exactly one copy of it: a second copy would have a database of its own. Each platform below does, in the way described; where one does not, it says so.

All of them run the same image, `ghcr.io/surfingdogai/inbox`, with the same settings as anywhere ([Quickstart](/docs/quickstart/#your-own-server)): `INBOX_OWNER_EMAIL` and `INBOX_SECRET_KEY` to start, then `INBOX_PUBLIC_URL` once the inbox answers at your own address. Generate the key (`openssl rand -base64 32`) and keep a copy somewhere safe, apart from the platform. And give the inbox an address on your own domain, such as `inbox.yourbusiness.com`: agents and checkers start from the business's domain, and an address on the platform's domain is one they don't credit.

| | Disk | One copy | One click | Cost |
| --- | --- | --- | --- | --- |
| [Coolify](#coolify) | A named volume | Yes | A Compose file to paste | Your server |
| [Fly.io](#flyio) | A volume, snapshotted daily | One machine | `fly launch` from the folder | Fly's machine and volume |
| [Render](#render) | A disk, snapshotted daily | One instance | The Blueprint button | A paid instance: disks are not on the free one |
| [Railway](#railway) | A volume | One replica | Steps, below | Railway's usage |
| [DigitalOcean](#digitalocean) | The Droplet's own | Yes | A first-boot script | The Droplet |

## Coolify

Coolify runs on your own server and puts its own proxy, with a certificate, in front of what it runs.

1. **New resource → Docker Compose Empty**, and paste [deploy/coolify/docker-compose.yml](https://github.com/surfingdogai/inbox/blob/main/deploy/coolify/docker-compose.yml). Or **Public Repository**, `https://github.com/surfingdogai/inbox`, with the Compose file at `/deploy/coolify/docker-compose.yml`.
2. Set the inbox's domain to `https://inbox.yourbusiness.com`, and point that name's DNS at the Coolify server.
3. Fill in `INBOX_OWNER_EMAIL`, and deploy. Coolify generates `INBOX_SECRET_KEY` once and keeps it; copy it from the environment variables somewhere safe.

The data is in the `inbox-data` volume. Coolify's scheduled backups cover databases it runs itself, not this file: run `docker exec <container> node /opt/inbox/server.mjs backup /opt/inbox/data/inbox-$(date -u +%Y%m%dT%H%M%SZ).db` on a schedule (each backup is a new file; the command never overwrites one), or [Litestream](/docs/backups/#litestream). To update, change `INBOX_VERSION` (or keep `latest`) and redeploy.

## Fly.io

One machine, with one volume mounted at `/opt/inbox/data`. Fly volumes belong to root, so [deploy/fly/Dockerfile](https://github.com/surfingdogai/inbox/blob/main/deploy/fly/Dockerfile) starts the image as root once: it gives the volume to the inbox's own user and runs as that user from then on.

```bash
git clone https://github.com/surfingdogai/inbox && cd inbox/deploy/fly
fly launch --copy-config --no-deploy       # pick a name and a region; no database is needed
fly secrets set INBOX_OWNER_EMAIL=you@yourbusiness.com INBOX_SECRET_KEY="$(openssl rand -base64 32)"
fly deploy
fly certs add inbox.yourbusiness.com       # then add the DNS record it names
fly secrets set INBOX_PUBLIC_URL=https://inbox.yourbusiness.com
```

[fly.toml](https://github.com/surfingdogai/inbox/blob/main/deploy/fly/fly.toml) keeps the machine running (the inbox works between requests: rules, reminders, a network's hourly ping) and checks `/healthz`. Never scale it past one machine. Fly keeps a daily snapshot of the volume, 14 days here. To update, pin the version in the Dockerfile's `FROM` line and `fly deploy`.

## Render

[Deploy to Render](https://render.com/deploy?repo=https://github.com/surfingdogai/inbox) reads [render.yaml](https://github.com/surfingdogai/inbox/blob/main/render.yaml): a web service from the image, a 1 GB disk at `/opt/inbox/data`, a health check on `/healthz`, and `INBOX_SECRET_KEY` generated for you. It asks for `INBOX_OWNER_EMAIL`.

What to know first: Render gives disks only to paid instances, so the Blueprint uses the Starter plan, not the free one. A service with a disk runs one instance, and a deploy stops the old one before the new one starts, so it is offline for those seconds. Render snapshots the disk daily. Add your domain under **Settings → Custom Domains**, then set `INBOX_PUBLIC_URL` to it. Render's disks belong to root, so [deploy/render/Dockerfile](https://github.com/surfingdogai/inbox/blob/main/deploy/render/Dockerfile) does as Fly's does.

## Railway

There is no Railway template to press yet; from the image it takes a minute:

1. **New project → Deploy a Docker image**: `ghcr.io/surfingdogai/inbox:latest`.
2. **Add a volume** to the service, mounted at `/opt/inbox/data`.
3. **Variables**: `INBOX_OWNER_EMAIL`, `INBOX_SECRET_KEY` (generated, kept), and `RAILWAY_RUN_UID=0`. Railway's volumes belong to root, and this starts the container as root once: the image gives the volume to its own user and runs as that user from then on.
4. **Settings → Networking**: a custom domain, `inbox.yourbusiness.com`, with the CNAME it names. Then `INBOX_PUBLIC_URL=https://inbox.yourbusiness.com`.

Keep it at one replica. Railway restarts it on the same volume; for copies elsewhere, use [Litestream](/docs/backups/#litestream).

## DigitalOcean

**App Platform cannot run the inbox**: its containers have no disk that lasts between deploys, and the inbox's database is a file, so every deploy would start it empty. A **Droplet** runs it with the [one-command installer](/docs/run-it-yourself/#one-command-on-your-server):

1. Create a Droplet: Ubuntu 24.04, 1 GB is plenty. Under **Advanced options → Add initialization scripts**, paste [deploy/digitalocean/cloud-init.yml](https://github.com/surfingdogai/inbox/blob/main/deploy/digitalocean/cloud-init.yml) with your address and email in it.
2. Point the address's A record at the Droplet's IP. A Reserved IP lets you add the record before the Droplet exists.

The installer runs once, at first boot, and the certificate comes as soon as the record points there. Or create the Droplet as it is, and run the one command over SSH. DigitalOcean's own backups of the Droplet are an option on top of the inbox's nightly ones.

## Cloudflare Workers

Not a container: the same code on Workers, with D1. [Run it yourself → Cloudflare Workers](/docs/run-it-yourself/#cloudflare-workers).
