#!/bin/sh
# The installer, for real, on a disposable server: a systemd container of a fresh Ubuntu or Debian
# (deploy/test/vm/Dockerfile). In it the installer installs Docker from Docker's repository, checks
# the address, writes /opt/inbox, starts the inbox behind Caddy with HTTPS, and the `inbox` command
# then signs in, makes keys, backs up, rolls back a broken update, updates, rolls back on request,
# restores, and survives Docker restarting. Its certificate is Caddy's own (--tls internal): the
# server has no public address for Let's Encrypt to reach.
#
#   deploy/test/installer-vm.sh <base image, like ubuntu:24.04> <the inbox image, saved with docker save>
#
# The image file holds ghcr.io/surfingdogai/inbox:ci.
set -eu

BASE="${1:?usage: installer-vm.sh <base image> <image.tar>}"
TAR="${2:?usage: installer-vm.sh <base image> <image.tar>}"
VM="inbox-vm-$$"
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)

cleanup() {
  docker rm -f "$VM" >/dev/null 2>&1 || true
  docker volume rm "$VM-docker" "$VM-containerd" >/dev/null 2>&1 || true
}
trap cleanup EXIT

pass() { printf '✓ %s\n' "$*"; }
fail() {
  printf '✗ %s\n' "$*" >&2
  docker exec "$VM" sh -c 'cd /opt/inbox 2>/dev/null && docker compose logs --no-color --tail 40' >&2 2>&1 || true
  exit 1
}
on() { docker exec "$VM" sh -c "$1"; }

docker build -q -t inbox-test-vm --build-arg "BASE=$BASE" "$HERE/vm" >/dev/null
# Docker inside keeps its images on volumes of the runner's own disk: overlayfs cannot stack on the
# container's own overlay root, and a real server's disk is no overlay either.
docker run -d --name "$VM" --hostname vm --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  -v "$VM-docker:/var/lib/docker" -v "$VM-containerd:/var/lib/containerd" inbox-test-vm >/dev/null
i=0
until state=$(docker exec "$VM" systemctl is-system-running 2>/dev/null) || [ "$state" = degraded ]; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || fail "systemd did not come up ($state)"
  sleep 1
done
pass "$BASE with systemd ($state)"

docker cp "$ROOT/apps/site/public/install.sh" "$VM:/root/install.sh"
docker cp "$TAR" "$VM:/root/inbox-image.tar"
on 'command -v curl docker' && fail "the server is not fresh: curl or docker is there already"
IP=$(on "hostname -I | awk '{ print \$1 }'")
on "echo '$IP inbox.test' >>/etc/hosts"

# 1. An address with no record: it stops before writing anything (and Docker is installed by then).
if on 'sh /root/install.sh --domain nowhere.invalid --email owner@example.com --yes --tls internal' >/tmp/vm-out 2>&1; then
  fail "it installed for an address with no DNS record"
fi
grep -q "nowhere.invalid has no DNS record yet" /tmp/vm-out || fail "no word about the missing record: $(cat /tmp/vm-out)"
on 'test ! -e /opt/inbox/.env' || fail "it wrote settings before the address was checked"
on 'systemctl is-active docker' >/dev/null || fail "Docker was not installed and started"
pass "refuses an address with no record, before writing anything; Docker installed from Docker's repository"

# 2. The install.
on 'sh /root/install.sh --domain inbox.test --email owner@example.com --yes --tls internal --version ci --image-file /root/inbox-image.tar' ||
  fail "the install failed"
on 'curl -fsS -k https://inbox.test/healthz' | grep -q '"ok":true' || fail "https://inbox.test/healthz"
[ "$(on 'stat -c "%a %u" /opt/inbox/.env')" = "600 0" ] || fail ".env is not 600 and root's"
[ "$(on 'stat -c "%a %u" /opt/inbox/data')" = "700 10001" ] || fail "data is not 700 and uid 10001's"
on 'systemctl is-enabled inbox-backup.timer' >/dev/null || fail "no nightly backup"
on 'inbox status' | grep -q 'and its database answers' || fail "inbox status"
pass "installed: https answers, the settings are root's only, the data is the inbox's, a backup every night"

# 3. Signing in, with no email set up: the code is in the log.
on "curl -fsS -k -X POST https://inbox.test/auth/magic-link -H 'content-type: application/json' -d '{\"email\":\"owner@example.com\"}'" >/dev/null
on 'inbox sign-in' | grep -Eq 'Your sign-in code: [0-9]{6}' || fail "inbox sign-in shows no code"
KEY=$(on 'inbox owner-key ci' | head -n 1)
case "$KEY" in sdi_own_*) ;; *) fail "inbox owner-key printed '$KEY'" ;; esac
opens() { on "curl -sS -k -o /dev/null -w '%{http_code}' -H 'authorization: Bearer $1' https://inbox.test/v1/owner/settings" 2>/dev/null || true; }
[ "$(opens "$KEY")" = 200 ] || fail "the owner key opens nothing"
pass "the sign-in code from the log, and an owner key that works"

# 4. A second run changes nothing it should keep.
SECRET=$(on 'grep ^INBOX_SECRET_KEY= /opt/inbox/.env | sha256sum')
on 'sh /root/install.sh --yes' >/dev/null || fail "the second run failed"
[ "$(on 'grep ^INBOX_SECRET_KEY= /opt/inbox/.env | sha256sum')" = "$SECRET" ] || fail "the second run changed the secret key"
on 'grep -qx INBOX_TLS=internal /opt/inbox/.env' || fail "the second run changed the certificate"
[ "$(opens "$KEY")" = 200 ] || fail "the key stopped working after a second run"
pass "a second run keeps the key, the certificate and the data"

# 5. A backup, then an update that does not start: rolled back, nothing lost.
on 'inbox backup' >/dev/null || fail "inbox backup"
BACKUP=$(on 'ls -1 /opt/inbox/data/backups/inbox-*.db | tail -n 1')
# A version that exits at once, made without a builder (the installer installs none).
on 'docker create --name broken ghcr.io/surfingdogai/inbox:ci >/dev/null &&
  docker commit --change "CMD [\"node\", \"-e\", \"process.exit(3)\"]" broken ghcr.io/surfingdogai/inbox:0.0.0-broken >/dev/null &&
  docker rm broken >/dev/null' 
if on 'inbox update 0.0.0-broken' >/tmp/vm-out 2>&1; then fail "an update that does not start was kept"; fi
grep -q "Rolled back to ci; nothing was lost" /tmp/vm-out || fail "no rollback: $(cat /tmp/vm-out)"
on 'grep -qx INBOX_VERSION=ci /opt/inbox/.env' || fail "the version was not put back"
[ "$(opens "$KEY")" = 200 ] || fail "the key stopped working after the rollback"
pass "an update that does not start is rolled back, with the data as it was"

# 6. An update that starts, and a rollback on request.
on 'docker tag ghcr.io/surfingdogai/inbox:ci ghcr.io/surfingdogai/inbox:0.0.1-ci'
on 'inbox update 0.0.1-ci' | grep -q 'Updated: ci → 0.0.1-ci' || fail "inbox update 0.0.1-ci"
on 'grep -qx INBOX_VERSION=0.0.1-ci /opt/inbox/.env' || fail "the version was not changed"
[ "$(opens "$KEY")" = 200 ] || fail "the key stopped working after the update"
on 'inbox rollback --yes' | grep -q 'Back on ci' || fail "inbox rollback"
pass "an update that starts, and a rollback on request"

# 7. A restore puts the inbox back as the backup held it: a key made after it opens nothing.
LATER=$(on 'inbox owner-key later' | head -n 1)
[ "$(opens "$LATER")" = 200 ] || fail "the later key opens nothing"
on "inbox restore $BACKUP --yes" >/dev/null || fail "inbox restore"
[ "$(opens "$LATER")" = 401 ] || fail "after the restore, a key made after the backup still opens it"
[ "$(opens "$KEY")" = 200 ] || fail "after the restore, the key from before the backup opens nothing"
pass "a restore puts back the inbox the backup held"

# 8. Docker restarts (as at a reboot): the inbox comes back on its own.
on 'systemctl restart docker'
i=0
until on 'curl -fsS -k https://inbox.test/healthz' 2>/dev/null | grep -q '"ok":true'; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || fail "the inbox did not come back after Docker restarted"
  sleep 2
done
pass "back on its own after Docker restarts"

printf '\nThe installer passed on %s.\n' "$BASE"
