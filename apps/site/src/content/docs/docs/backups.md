---
title: Backups
description: What to keep (one SQLite file and one secret key), the nightly backups, a restore, and Litestream for copies within seconds.
---

Everything an inbox holds is in one SQLite file: requests, threads, settings, keys, receipts, and the secrets it keeps sealed. Two things restore it whole:

1. **A backup of the database.** A copy made by the inbox itself, never a copy of the file while it runs, which can be caught halfway through a write.
2. **`INBOX_SECRET_KEY`.** The sealed secrets (calendar and payment connections, webhook secrets, the key that signs receipts) open only with it. Without it a backup restores every request and setting, and those connections have to be made again. Keep it apart from the backups, in a password manager.

A backup on the same disk as the inbox protects from mistakes, not from losing the server: copy backups somewhere else too.

## On your own server

The installer makes a backup every night at about 03:30, server time, and keeps the last seven. Any time:

```bash
sudo inbox backup
```

Each is one file in `/opt/inbox/data/backups`, named by its time (`inbox-20261020T033012Z.db`), readable by its owner only. The inbox writes it while it keeps serving (`VACUUM INTO`), checks it, and only then gives it its name. `sudo inbox update` makes one before every update, and `sudo inbox restore` one before every restore.

To copy them off the server, any tool that copies files will do. For example, every night after the backup, with [rclone](https://rclone.org) set up for your storage:

```bash
# /etc/cron.d/inbox-offsite (or a systemd timer): the backups to your own storage, at 04:30
30 4 * * * root rclone copy /opt/inbox/data/backups yourstorage:inbox-backups --max-age 48h
```

### Restoring

```bash
sudo inbox restore /opt/inbox/data/backups/inbox-20261020T033012Z.db
```

It looks at the file first (that it is an inbox's database, sound, and from this version or an older one), says what it holds, and asks. Then it makes a backup of the inbox as it is now, stops it, puts the backup in its place and starts it. If the inbox does not start on it, it puts back what was there. A backup from an older version is brought up to date when the inbox starts; one from a newer version is refused until you update.

On a new server: run the installer with the same address, put your `INBOX_SECRET_KEY` in `/opt/inbox/.env` in place of the one it generated, `sudo inbox restart`, then restore.

### With Docker or Compose of your own

```bash
docker exec inbox node /opt/inbox/server.mjs backup /opt/inbox/data/backups/inbox-$(date -u +%Y%m%dT%H%M%SZ).db
docker exec inbox node /opt/inbox/server.mjs check-db /opt/inbox/data/backups/<file>   # before a restore
```

To restore by hand: stop the container, replace `inbox.db` in the data folder with the backup (and delete `inbox.db-wal` and `inbox.db-shm` beside it), give it to uid 10001, and start the container.

## Litestream

[Litestream](https://litestream.io) copies the database to S3-compatible storage within seconds of every change, so a lost server loses at most those seconds. It runs beside the inbox, as a second line next to the nightly backups. On a server the installer set up:

```bash
cd /opt/inbox
curl -fsSLO https://raw.githubusercontent.com/surfingdogai/inbox/main/deploy/litestream/docker-compose.litestream.yml
curl -fsSLO https://raw.githubusercontent.com/surfingdogai/inbox/main/deploy/litestream/litestream.yml
curl -fsSL https://raw.githubusercontent.com/surfingdogai/inbox/main/deploy/litestream/litestream.env.example -o litestream.env
sudo chmod 600 litestream.env      # then fill it in: the bucket, its endpoint, and a key for that bucket only
sudo docker compose -f docker-compose.yml -f docker-compose.litestream.yml up -d
```

Its keys stay in `litestream.env`, apart from the inbox's own settings. To restore from it, into a file the inbox then restores from:

```bash
sudo docker compose -f docker-compose.yml -f docker-compose.litestream.yml run --rm litestream \
  restore -o /opt/inbox/data/from-litestream.db /opt/inbox/data/inbox.db
sudo inbox restore /opt/inbox/data/from-litestream.db
```

## On a platform

Fly.io and Render snapshot their volumes and disks daily, and DigitalOcean can back up a whole Droplet; the [platforms page](/docs/platforms/) says how each keeps its data. The inbox's own `backup` command works on each of them, and Litestream does too.

## On Cloudflare

On Workers the database is D1, and D1 keeps its own history: [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) restores it to any minute of the last 30 days (7 on the free plan).

```bash
npx wrangler d1 time-travel info surfingdog-inbox
npx wrangler d1 time-travel restore surfingdog-inbox --timestamp=2026-10-20T03:30:00Z
npx wrangler d1 export surfingdog-inbox --remote --output=inbox.sql     # a copy to keep elsewhere
```

## Taking your data with you

Apart from backups, the owner can download everything the inbox holds from the owner app, wherever it runs: a copy without who is signed in or any secret, to take to another inbox.
