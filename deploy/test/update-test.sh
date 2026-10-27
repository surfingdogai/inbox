#!/bin/sh
# The update check, one phase at a time (.github/workflows/update-test.yml runs each as a step): an
# inbox installed with one release's own installer, given real data through its own doors, updated to
# another release with `inbox update` as a self-hoster does it, rolled back, and updated again; every
# record is read back after each move and held against the read-back from before.
#
#   FROM=0.1.0 TO=0.2.0-rc.1 deploy/test/update-test.sh <phase>
#
# The phases, in order: install, seed, update, rollback, again, final (only when TO is a
# pre-release: the release after it is not refused), summary. WORK is the folder that keeps what one
# phase leaves for the next. For a disposable Ubuntu or Debian machine with Docker and ports 80 and
# 443 free: it writes /opt/inbox, /usr/local/bin/inbox and a line in /etc/hosts, as the installer
# does. Its certificate is Caddy's own (--tls internal), for a name only this machine knows.
# shellcheck disable=SC2016  # the scripts for the inbox's container are single-quoted: their $ is theirs.
set -eu

FROM="${FROM:?set FROM to the release installed first, like 0.1.0}"
TO="${TO:?set TO to the release it updates to, like 0.2.0-rc.1}"
WORK="${WORK:-/tmp/update-test}"
DOMAIN="${DOMAIN:-inbox.test}"
PHASE="${1:?usage: update-test.sh install | seed | update | rollback | again | final | summary}"
BASE="https://$DOMAIN"
RELEASES="https://github.com/surfingdogai/inbox/releases/download"
SOURCE="https://raw.githubusercontent.com/surfingdogai/inbox"
IMAGE="ghcr.io/surfingdogai/inbox"
DIR=/opt/inbox
HERE=$(cd "$(dirname "$0")" && pwd)
CA="$WORK/caddy-root.crt"
KEY="$WORK/owner-key"
SUMMARY="$WORK/summary.md"
# The owner app's own script, in its index.html.
APP_SCRIPT='s#.*<script type="module" crossorigin src="\(/assets/[^"]*\.js\)".*#\1#p'
export NODE_EXTRA_CA_CERTS="$CA"

for v in "$FROM" "$TO"; do
  case "$v" in '' | *[!A-Za-z0-9._-]*)
    echo "'$v' is not a version" >&2
    exit 2
    ;;
  esac
done
mkdir -p "$WORK"
chmod 700 "$WORK"

pass() {
  printf '✓ %s\n' "$*"
  printf -- '- ✓ %s\n' "$*" >>"$SUMMARY"
}
fail() {
  printf '✗ %s\n' "$*" >&2
  printf -- '- ✗ **%s**\n' "$*" >>"$SUMMARY"
  [ -z "${GITHUB_ACTIONS:-}" ] || printf '::error::%s\n' "$*"
  dc logs --no-color --tail 60 inbox >&2 2>&1 || true
  exit 1
}
# root COMMAND…: as root, through sudo when this is not root already.
root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
dc() { root docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" "$@"; }
data() { node "$HERE/update-data.mjs" "$@"; }
get() { curl -fsS --max-time 20 --cacert "$CA" "$@"; }

# health VERSION: /healthz, through Caddy and HTTPS, says that version and that its database answers.
health() {
  h=$(get "$BASE/healthz") || fail "$BASE/healthz does not answer"
  printf '%s' "$h" | grep -q "\"version\":\"$1\"" || fail "/healthz says $h, not version $1"
  printf '%s' "$h" | grep -q '"db":"ok"' || fail "/healthz says $h: its database does not answer"
}

# migrations: the database's migrations table, one "version name applied_at" a line.
migrations() {
  dc exec -T inbox node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.INBOX_DB, { readOnly: true });
    for (const m of db.prepare("SELECT version, name, applied_at FROM migrations ORDER BY version").all())
      console.log(`${m.version} ${m.name} ${m.applied_at}`);
  ' 2>/dev/null
}

# check_db FILE: the inbox's own look at a database file in its data folder, as JSON.
check_db() { dc exec -T inbox node /opt/inbox/server.mjs check-db "/opt/inbox/data/$1" 2>/dev/null; }
field() { sed -n "s/.*\"$1\":\([^,}]*\).*/\1/p" | tr -d '"'; }

# owner_app: the owner app's index answers at /login and the script it loads is served; APP is that
# script's path.
owner_app() {
  page=$(get "$BASE/login") || fail "the owner app's index, $BASE/login, does not answer"
  printf '%s' "$page" | grep -qi '<!doctype html' || fail "$BASE/login is not a page"
  printf '%s' "$page" | grep -q '<title>Surfing Dog Inbox</title>' || fail "$BASE/login is not the owner app"
  APP=$(printf '%s' "$page" | sed -n "$APP_SCRIPT" | head -n 1)
  [ -n "$APP" ] || fail "the owner app's index loads no script"
  type=$(get -o /dev/null -w '%{content_type}' "$BASE$APP") || fail "the owner app's script $APP does not load"
  case "$type" in *javascript*) ;; *) fail "the owner app's script $APP comes as $type" ;; esac
}

# kit_sums: checksums of the kit as it is installed here, to hold against after a rollback.
kit_sums() { root sha256sum "$DIR/docker-compose.yml" "$DIR/Caddyfile" /usr/local/bin/inbox; }

phase_install() {
  : >"$SUMMARY"
  curl -fsSL "$RELEASES/v$FROM/install.sh" -o "$WORK/install.sh" || fail "the release $FROM has no install.sh"
  curl -fsSL "$RELEASES/v$FROM/SHA256SUMS" -o "$WORK/SHA256SUMS" || fail "the release $FROM has no SHA256SUMS"
  (cd "$WORK" && grep ' install\.sh$' SHA256SUMS | sha256sum -c - >/dev/null) ||
    fail "the installer of $FROM does not match its SHA256SUMS"
  grep -q " $DOMAIN\$" /etc/hosts || echo "$(hostname -I | awk '{ print $1 }') $DOMAIN" | root tee -a /etc/hosts >/dev/null
  if ! root sh "$WORK/install.sh" --domain "$DOMAIN" --email owner@example.com --yes --tls internal --version "$FROM" \
    >"$WORK/install.log" 2>&1; then
    cat "$WORK/install.log" >&2
    fail "the installer of $FROM failed"
  fi
  grep -E '^(✓|!)' "$WORK/install.log" || true
  root cat "$DIR/caddy/data/caddy/pki/authorities/local/root.crt" >"$CA" || fail "Caddy made no certificate authority"
  health "$FROM"
  key=$(root inbox owner-key update-test | head -n 1)
  [ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$key"
  case "$key" in sdi_own_*) ;; *) fail "inbox owner-key printed no key" ;; esac
  (umask 077 && printf '%s\n' "$key" >"$KEY")
  pass "Installed $FROM with its own installer (install.sh from the v$FROM release, checked against its SHA256SUMS), behind Caddy with HTTPS; /healthz says $FROM and db ok; an owner key from \`inbox owner-key\`"
}

phase_seed() {
  data seed "$BASE" "$KEY" "$WORK/records.json" || fail "the data could not be put in"
  pass "Data through the inbox's own doors: a business profile, a service, a product and opening hours (owner API); a customer's booking for two, another's order of three and a third's message (public API, the terms confirmed as a customer's agent does); the owner confirmed the booking, accepted the order and replied on two; the booking and the order got their signed receipts"
  data read "$BASE" "$KEY" "$WORK/records.json" "$WORK/before.json" || fail "the data could not be read back"
  migrations >"$WORK/migrations-before.txt" || fail "could not read the migrations"
  check_db inbox.db >"$WORK/db-before.json" || fail "check-db could not look at the database"
  kit_sums >"$WORK/kit-before.txt"
  owner_app
  printf '%s\n' "$APP" >"$WORK/app-before.txt"
  pass "Read back on $FROM: $(wc -l <"$WORK/migrations-before.txt" | tr -d ' ') migrations, $(field items <"$WORK/db-before.json") items; the owner app loads $APP"
}

# phase_update NAME: `sudo inbox update TO`, and everything that must hold after it.
phase_update() {
  name=$1
  [ "$name" = update ] || printf -- '- **Updated once more, after the rollback:**\n' >>"$SUMMARY"
  started=$(($(date +%s) * 1000))
  if ! root inbox update "$TO" >"$WORK/$name.log" 2>&1; then
    cat "$WORK/$name.log" >&2
    fail "sudo inbox update $TO failed"
  fi
  cat "$WORK/$name.log"
  grep -q "Updated: $FROM → $TO" "$WORK/$name.log" || fail "inbox update did not say Updated: $FROM → $TO"
  health "$TO"
  root inbox status | grep -q "Running $TO (image $IMAGE:$TO), and its database answers" ||
    fail "inbox status does not say it runs $TO: $(root inbox status 2>&1 | head -n 3)"
  root grep -qx "INBOX_VERSION=$TO" "$DIR/.env" || fail ".env does not say INBOX_VERSION=$TO"
  running=$(root docker inspect -f '{{.Config.Image}}' "$(dc ps -q inbox)")
  [ "$running" = "$IMAGE:$TO" ] || fail "the inbox's container runs $running"
  pass "\`sudo inbox update $TO\`: it says Updated: $FROM → $TO; /healthz says $TO and db ok, through Caddy; \`inbox status\` says Running $TO; .env and the container are on $IMAGE:$TO"

  # The kit of that release, put in place: its Compose file, Caddy's file and the inbox command.
  mkdir -p "$WORK/kit-$TO"
  (cd "$WORK/kit-$TO" &&
    curl -fsSL "$RELEASES/v$TO/SHA256SUMS" -o SHA256SUMS &&
    curl -fsSL "$RELEASES/v$TO/inbox-selfhost.tar.gz" -o inbox-selfhost.tar.gz &&
    grep ' inbox-selfhost\.tar\.gz$' SHA256SUMS | sha256sum -c - >/dev/null &&
    tar -xzf inbox-selfhost.tar.gz) || fail "the kit of $TO could not be downloaded and checked"
  kit="$WORK/kit-$TO/inbox-selfhost"
  root cmp -s "$DIR/docker-compose.yml" "$kit/docker-compose.yml" || fail "the Compose file is not $TO's"
  root cmp -s "$DIR/Caddyfile" "$kit/Caddyfile" || fail "Caddy's file is not $TO's"
  cmp -s /usr/local/bin/inbox "$kit/inbox" || fail "the inbox command is not $TO's"
  pass "The kit of $TO (checked against its SHA256SUMS) is what runs: the Compose file, Caddy's file and the \`inbox\` command"

  # The migrations: exactly those the new version ships, the old ones untouched, the new ones now.
  migrations >"$WORK/migrations-$name.txt" || fail "could not read the migrations"
  curl -fsSL "$SOURCE/v$TO/packages/core/src/schema/migrations.generated.ts" |
    sed -n 's/^ *name: "\([0-9]\{4\}_[a-z0-9_]*\)",$/\1/p' >"$WORK/migrations-of-$TO.txt"
  [ -s "$WORK/migrations-of-$TO.txt" ] || fail "could not read the migrations $TO ships"
  awk '{ print $2 }' "$WORK/migrations-$name.txt" | diff - "$WORK/migrations-of-$TO.txt" >&2 ||
    fail "the database's migrations are not the ones $TO ships"
  had=$(wc -l <"$WORK/migrations-before.txt" | tr -d ' ')
  head -n "$had" "$WORK/migrations-$name.txt" | diff - "$WORK/migrations-before.txt" >&2 ||
    fail "the migrations applied before the update changed"
  tail -n +"$((had + 1))" "$WORK/migrations-$name.txt" >"$WORK/migrations-new.txt"
  awk -v t="$started" '$3 < t { exit 1 }' "$WORK/migrations-new.txt" || fail "a new migration was applied before the update"
  new=$(awk '{ print $2 }' "$WORK/migrations-new.txt" | tr '\n' ' ' | sed 's/ $//')
  pass "Migrations: the database has the $(wc -l <"$WORK/migrations-$name.txt" | tr -d ' ') that $TO ships, in order; the $had of $FROM untouched, and $(wc -l <"$WORK/migrations-new.txt" | tr -d ' ') applied during the update: ${new:-none}"

  # Every record, as the owner and as each customer read it.
  data read "$BASE" "$KEY" "$WORK/records.json" "$WORK/after-$name.json" || fail "the data could not be read back on $TO"
  if ! data compare "$WORK/before.json" "$WORK/after-$name.json" "$WORK/compare-$name.md"; then
    fail "the data did not read back identical on $TO (the table below says what changed)"
  fi
  pass "Every record reads back identical on $TO: the booking, the order and the message as the owner and as each customer see them (state, totals, customer, events, thread, receipts), the profile, services, products, hours, item list, event stream, receipts and keys; both receipts still verify against the keys it publishes; the owner key still opens it"

  # The owner app: the index this version ships, and its script.
  owner_app
  shipped=$(root docker run --rm --entrypoint cat "$IMAGE:$TO" /opt/inbox/client/index.html | sed -n "$APP_SCRIPT" | head -n 1)
  [ "$APP" = "$shipped" ] || fail "the owner app's index loads $APP, but $TO's own loads $shipped"
  pass "The owner app: $BASE/login is its index, and loads $APP, $TO's own"

  # The backup the update took first, which a rollback puts back.
  backup=$(sed -n 's#.*The data as it was before is in .*/backups/\(inbox-[^ /]*\.db\)\.$#\1#p' "$WORK/$name.log")
  [ -n "$backup" ] || fail "inbox update named no backup"
  root test -s "$DIR/data/backups/$backup" || fail "the backup $backup is not there"
  root grep -qx "backup=$backup" "$DIR/state/last-update" || fail "state/last-update does not name $backup"
  report=$(check_db "backups/$backup") || fail "check-db does not take the backup: $report"
  [ "$(printf '%s' "$report" | field ok)" = true ] || fail "the backup is not sound: $report"
  [ "$(printf '%s' "$report" | field migration)" = "$(field migration <"$WORK/db-before.json")" ] ||
    fail "the backup is not the database from before the update: $report"
  [ "$(printf '%s' "$report" | field items)" = "$(field items <"$WORK/db-before.json")" ] ||
    fail "the backup does not hold the items from before the update: $report"
  pass "The update's backup: data/backups/$backup ($(root du -h "$DIR/data/backups/$backup" | awk '{ print $1 }')), a sound database at $FROM's migration $(field migration <"$WORK/db-before.json") with its $(field items <"$WORK/db-before.json") items, named in state/last-update for a rollback"
}

phase_rollback() {
  if ! root inbox rollback --yes >"$WORK/rollback.log" 2>&1; then
    cat "$WORK/rollback.log" >&2
    fail "sudo inbox rollback failed"
  fi
  cat "$WORK/rollback.log"
  grep -q "Back on $FROM" "$WORK/rollback.log" || fail "inbox rollback did not say Back on $FROM"
  health "$FROM"
  root grep -qx "INBOX_VERSION=$FROM" "$DIR/.env" || fail ".env does not say INBOX_VERSION=$FROM"
  kit_sums | diff - "$WORK/kit-before.txt" >&2 || fail "the kit is not $FROM's again"
  migrations | diff - "$WORK/migrations-before.txt" >&2 || fail "the migrations are not those from before the update"
  data read "$BASE" "$KEY" "$WORK/records.json" "$WORK/after-rollback.json" || fail "the data could not be read back on $FROM"
  data compare "$WORK/before.json" "$WORK/after-rollback.json" "$WORK/compare-rollback.md" ||
    fail "the data did not read back identical after the rollback"
  safety=$(sed -n 's#.*The inbox as it was just now is in .*/backups/\(inbox-[^ /]*\.db\)\.$#\1#p' "$WORK/rollback.log")
  if [ -z "$safety" ] || ! root test -s "$DIR/data/backups/$safety"; then
    fail "the rollback kept no copy of the inbox as it was"
  fi
  pass "\`sudo inbox rollback --yes\`: back on $FROM with its kit, the database from before the update (its $(wc -l <"$WORK/migrations-before.txt" | tr -d ' ') migrations), every record identical; the inbox as it was on $TO kept in data/backups/$safety"
}

# phase_final: from a pre-release, the release it leads to must not be refused as older. The image of
# that release does not exist yet, so the pre-release's own stands in for it, under its name.
phase_final() {
  final=${TO%%-*}
  if [ "$final" = "$TO" ]; then
    echo "$TO is not a pre-release: nothing to check."
    return 0
  fi
  root docker image inspect "$IMAGE:$final" >/dev/null 2>&1 || root docker tag "$IMAGE:$TO" "$IMAGE:$final"
  if root inbox update "$final" >"$WORK/final.log" 2>&1; then
    cat "$WORK/final.log"
    pass "From the pre-release $TO, \`sudo inbox update $final\` goes ahead"
    return 0
  fi
  cat "$WORK/final.log" >&2
  said=$(grep -m 1 'older than' "$WORK/final.log" | sed 's/^[^A-Za-z0-9]*//' || true)
  printf -- '- ⚠ **From the pre-release %s, `sudo inbox update %s` is refused%s.** The `inbox` command orders versions with `sort -V`, which puts %s before %s; anyone on %s needs `--force` to reach %s.\n' \
    "$TO" "$final" "${said:+: \"$said\"}" "$final" "$TO" "$TO" "$final" >>"$SUMMARY"
  [ -z "${GITHUB_ACTIONS:-}" ] || printf '::warning::From %s, sudo inbox update %s is refused: %s\n' "$TO" "$final" "$said"
  exit 1
}

# phase_summary: the result, then each check as it went. STATUS is the job's status, when it has one.
phase_summary() {
  touch "$SUMMARY"
  if grep -q '✗' "$SUMMARY" || [ "${STATUS:-success}" != success ]; then
    result="failed"
  elif ! grep -q 'Updated once more' "$SUMMARY"; then
    result="did not finish"
  elif grep -q '⚠' "$SUMMARY"; then
    result="passed, with a warning"
  else
    result="passed"
  fi
  {
    printf '### Update with data, %s → %s: %s\n\n' "$FROM" "$TO" "$result"
    cat "$SUMMARY"
    for f in update rollback again; do
      [ -f "$WORK/compare-$f.md" ] || continue
      case "$f" in update) after="the update" ;; rollback) after="the rollback" ;; *) after="the second update" ;; esac
      printf '\n<details><summary>The records, read back after %s</summary>\n\n' "$after"
      cat "$WORK/compare-$f.md"
      printf '\n</details>\n'
    done
  } >"$WORK/summary-final.md"
  cat "$WORK/summary-final.md"
  [ -z "${GITHUB_STEP_SUMMARY:-}" ] || cat "$WORK/summary-final.md" >>"$GITHUB_STEP_SUMMARY"
}

case "$PHASE" in
  install) phase_install ;;
  seed) phase_seed ;;
  update) phase_update update ;;
  rollback) phase_rollback ;;
  again) phase_update again ;;
  final) phase_final ;;
  summary) phase_summary ;;
  *)
    echo "usage: update-test.sh install | seed | update | rollback | again | final | summary" >&2
    exit 2
    ;;
esac
