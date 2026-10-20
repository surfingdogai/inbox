#!/bin/sh
# The image's smoke test: small, non-root, healthy, its doors answer, its commands work, it stops at
# once, it runs on a read-only root, and a data folder it cannot write to is either fixed (started
# as root, it hands itself to uid 10001) or named in a clear error. CI runs it on every build.
#
#   deploy/test/smoke-image.sh ghcr.io/surfingdogai/inbox:ci [max size in MB]
set -eu

IMAGE="${1:?usage: smoke-image.sh <image> [max MB]}"
MAX_MB="${2:-200}"
N="inbox-smoke-$$"
PORT=18787
TMP=$(mktemp -d)

cleanup() {
  for c in "$N" "$N-ro" "$N-bad" "$N-root"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker volume rm "$N-data" >/dev/null 2>&1 || true
  # The folder the image took for uid 10001: removed from inside, as root.
  docker run --rm --user 0 -v "$TMP:/t" --entrypoint sh "$IMAGE" -c 'rm -rf /t/*' >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { printf '✓ %s\n' "$*"; }
fail() {
  printf '✗ %s\n' "$*" >&2
  for c in "$N" "$N-ro" "$N-bad" "$N-root"; do docker logs "$c" 2>&1 | tail -n 20 | sed "s/^/  $c: /" >&2 || true; done
  exit 1
}

# wait_healthy NAME: until Docker's own health check says healthy (the image checks every 2 s at first).
wait_healthy() {
  i=0
  while [ "$i" -lt 90 ]; do
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}} {{.State.Status}}' "$1" 2>/dev/null || echo "gone gone")
    case "$status" in
      healthy*) return 0 ;;
      *exited | *dead | gone*) return 1 ;;
    esac
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# server_uid NAME: the uid the inbox's own process runs as, as the host sees it.
server_uid() { docker top "$1" -o uid,args | awk '/start\.mjs/ { print $1; exit }'; }

get() { curl -fsS --max-time 10 "http://127.0.0.1:$PORT$1"; }

# --- the image itself
mb=$(($(docker image inspect -f '{{.Size}}' "$IMAGE") / 1024 / 1024))
[ "$mb" -le "$MAX_MB" ] || fail "the image is $mb MB, more than $MAX_MB"
pass "$mb MB"
[ "$(docker image inspect -f '{{.Config.User}}' "$IMAGE")" = "10001:10001" ] || fail "the image does not run as 10001:10001"
docker image inspect -f '{{json .Config.Healthcheck}}' "$IMAGE" | grep -q healthz || fail "no health check"
docker image inspect -f '{{json .Config.Volumes}}' "$IMAGE" | grep -q '/opt/inbox/data' || fail "no data volume"
pass "runs as 10001:10001, with a health check and a data volume"

# --- a plain run, the data in a named volume
docker run -d --name "$N" -p "127.0.0.1:$PORT:8787" -v "$N-data:/opt/inbox/data" "$IMAGE" >/dev/null
wait_healthy "$N" || fail "never healthy"
get /healthz | grep -q '"ok":true' || fail "/healthz"
get /healthz | grep -q '"db":"ok"' || fail "/healthz without its database"
get /.well-known/agent-inbox.json | grep -q '"instance"' || fail "the manifest"
get /openapi.json | grep -q '"openapi"' || fail "/openapi.json"
get / | grep -qi '<!doctype html' || fail "the owner app"
get /login | grep -qi '<!doctype html' || fail "/login"
[ "$(server_uid "$N")" = 10001 ] || fail "the server does not run as uid 10001"
pass "healthy; the manifest, OpenAPI and the owner app answer; the server runs as uid 10001"

key=$(docker exec "$N" node /opt/inbox/server.mjs create-owner-key smoke 2>/dev/null)
case "$key" in sdi_own_*) ;; *) fail "create-owner-key printed '$key'" ;; esac
curl -fsS --max-time 10 -o /dev/null -H "authorization: Bearer $key" "http://127.0.0.1:$PORT/v1/owner/settings" ||
  fail "the owner key opens nothing"
docker exec "$N" node /opt/inbox/server.mjs backup /opt/inbox/data/smoke.db | grep -q '"ok":true' || fail "backup"
docker exec "$N" node /opt/inbox/server.mjs check-db /opt/inbox/data/smoke.db | grep -q '"owner":false' || fail "check-db"
pass "create-owner-key, backup and check-db"

zone=$(docker exec "$N" node -e "process.stdout.write(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tokyo',hour:'2-digit',hourCycle:'h23'}).format(new Date(0)))")
[ "$zone" = 09 ] || fail "time zones: Tokyo at 00:00 UTC came out as '$zone'"
pass "time zones"

started=$(date +%s)
docker stop -t 20 "$N" >/dev/null
took=$(($(date +%s) - started))
[ "$took" -le 5 ] || fail "docker stop took $took s: TERM is not handled"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$N")" = 0 ] || fail "it stopped with $(docker inspect -f '{{.State.ExitCode}}' "$N")"
pass "stops at once on TERM, with 0"

# --- hardened, as the Compose file runs it: a read-only root, no capabilities, the same data
docker run -d --name "$N-ro" -p "127.0.0.1:$PORT:8787" --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true -v "$N-data:/opt/inbox/data" "$IMAGE" >/dev/null
wait_healthy "$N-ro" || fail "never healthy on a read-only root"
curl -fsS --max-time 10 -o /dev/null -H "authorization: Bearer $key" "http://127.0.0.1:$PORT/v1/owner/settings" ||
  fail "the data did not survive a new container"
docker rm -f "$N-ro" >/dev/null
pass "read-only root, no capabilities, and the data kept across containers"

# --- a folder it cannot write to: a clear error, or, started as root, fixed
mkdir -p "$TMP/data"
chmod 755 "$TMP/data"
docker run -d --name "$N-bad" -v "$TMP/data:/opt/inbox/data" "$IMAGE" >/dev/null
i=0
while [ "$(docker inspect -f '{{.State.Status}}' "$N-bad")" != exited ] && [ "$i" -lt 30 ]; do
  sleep 1
  i=$((i + 1))
done
[ "$(docker inspect -f '{{.State.ExitCode}}' "$N-bad")" = 1 ] || fail "it did not stop on a folder it cannot write to"
docker logs "$N-bad" 2>&1 | grep -q "The inbox cannot write to /opt/inbox/data" || fail "no clear error for that folder"
pass "a folder it cannot write to: a clear error"

docker run -d --name "$N-root" --user 0 -p "127.0.0.1:$PORT:8787" -v "$TMP/data:/opt/inbox/data" "$IMAGE" >/dev/null
wait_healthy "$N-root" || fail "never healthy when started as root"
[ "$(stat -c %u "$TMP/data")" = 10001 ] || fail "the folder was not given to uid 10001"
[ "$(stat -c %u "$TMP/data/inbox.db")" = 10001 ] || fail "the database does not belong to uid 10001"
[ "$(server_uid "$N-root")" = 10001 ] || fail "started as root, the server still runs as uid $(server_uid "$N-root")"
pass "started as root: the folder is given to uid 10001, and the server runs as it"

printf '\nThe image passed: %s\n' "$IMAGE"
