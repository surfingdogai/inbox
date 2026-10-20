#!/bin/sh
# Surfing Dog Inbox: install it on your own server, with HTTPS, in one command.
#
#   curl -fsSL https://surfingdog.ai/install.sh | sudo sh
#
# For a fresh Ubuntu or Debian server, amd64 or arm64, that a subdomain of your business's domain
# points at (an A record such as inbox.yourbusiness.com → this server). In order, it:
#
#   1. checks the system, and installs Docker from Docker's own apt repository if it is missing;
#   2. asks two things: the address your inbox answers at, and the owner's email address;
#   3. checks that the address points at this server;
#   4. writes /opt/inbox: the settings (.env, readable by root only, with a secret key it generates),
#      a Compose file, and Caddy's site file; your data goes in /opt/inbox/data;
#   5. starts the inbox behind Caddy, which gets the HTTPS certificate on its own;
#   6. installs the `inbox` command (status, update, backup, restore) and a nightly backup;
#   7. tells you the next step: signing in, then email.
#
# Run it again whenever you like: it keeps your data, your secret key and your version, and changes
# only what you change. `sudo inbox update` moves to a new version, and rolls back if it does not
# start.
#
# No telemetry: it sends nothing about you or your server anywhere. What it downloads: Docker's
# packages (download.docker.com, only when Docker is missing), the inbox's image (ghcr.io) and
# Caddy's (Docker Hub), and it reads the newest release's number from github.com. Caddy then asks
# Let's Encrypt for your certificate.
#
# Without questions, for a script or your AI:
#   curl -fsSL https://surfingdog.ai/install.sh | sudo sh -s -- --domain inbox.example.com --email you@example.com --yes
#
# Its checksum is at https://surfingdog.ai/install.sh.sha256, and each release attaches this file
# with SHA256SUMS. Source: https://github.com/surfingdogai/inbox/tree/main/deploy (MIT).
#
# Nothing runs until the last line of this file has arrived: a download cut short does nothing.
# shellcheck disable=SC3043  # `local` is in every sh this runs on (dash, bash, busybox).

set -eu

DIR=/opt/inbox
DOMAIN=""
EMAIL=""
VERSION=""
IMAGE=""
IMAGE_FILE=""
TLS=""
YES=0
SKIP_DNS=0
CADDY_IMAGE="caddy:2-alpine"
INBOX_UID=10001
RELEASES="https://github.com/surfingdogai/inbox/releases"
OS_RELEASE="${SDI_OS_RELEASE:-/etc/os-release}"
BIN_DIR="${SDI_BIN_DIR:-/usr/local/bin}"
SYSTEMD_DIR="${SDI_SYSTEMD_DIR:-/etc/systemd/system}"
EXISTING=0
HTTPS=0

if [ -t 1 ]; then
  B=$(printf '\033[1m') D=$(printf '\033[2m') G=$(printf '\033[32m') Y=$(printf '\033[33m') R=$(printf '\033[31m') N=$(printf '\033[0m')
else
  B='' D='' G='' Y='' R='' N=''
fi
say() { printf '%s\n' "$*"; }
step() { printf '\n%s%s%s\n' "$B" "$*" "$N"; }
ok() { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
note() { printf '%s%s%s\n' "$D" "$*" "$N"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*" >&2; }
die() {
  printf '%s✗%s %s\n' "$R" "$N" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install Surfing Dog Inbox on this server, with HTTPS.

  curl -fsSL https://surfingdog.ai/install.sh | sudo sh -s -- [options]

  --domain <host>       the address the inbox answers at, like inbox.yourbusiness.com
  --email <address>     the owner's email: only it can sign in the first time
  --yes                 ask nothing (needs --domain and --email on a first install)
  --version <x.y.z>     a release other than the newest
  --dir <path>          where it lives (default /opt/inbox)
  --skip-dns-check      go on even when the address does not point here yet
  --tls internal        Caddy's own certificate instead of Let's Encrypt's: for a test or a private network
  --image <name>        another image than ghcr.io/surfingdogai/inbox
  --image-file <path>   load the image from a file (docker save) instead of downloading it
EOF
}

# --- asking -----------------------------------------------------------------------------------------

tty_ok() { [ -r /dev/tty ] && [ -w /dev/tty ] && (: </dev/tty) 2>/dev/null; }

# choose "question" "first" "second"…: sets CHOICE to the number picked (1 when Enter is pressed).
choose() {
  local question="$1" i=1 answer
  shift
  printf '%s\n' "$question" >/dev/tty
  for option in "$@"; do
    printf '  %s%s)%s %s\n' "$B" "$i" "$N" "$option" >/dev/tty
    i=$((i + 1))
  done
  while :; do
    printf 'Choose 1-%s [1]: ' "$#" >/dev/tty
    read -r answer </dev/tty || answer=""
    answer=${answer:-1}
    case "$answer" in
      *[!0-9]* | '') ;;
      *) if [ "$answer" -ge 1 ] && [ "$answer" -le "$#" ]; then
        CHOICE=$answer
        return 0
      fi ;;
    esac
  done
}

# ask "question" [default]: sets ANSWER.
ask() {
  if [ -n "${2:-}" ]; then printf '%s [%s]: ' "$1" "$2" >/dev/tty; else printf '%s: ' "$1" >/dev/tty; fi
  read -r ANSWER </dev/tty || ANSWER=""
  ANSWER=${ANSWER:-${2:-}}
}

# --- values -----------------------------------------------------------------------------------------

# normalize_domain TEXT: a hostname from what was typed or pasted (a URL, capitals, a trailing dot).
normalize_domain() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's#^[[:space:]]*##' -e 's#[[:space:]]*$##' \
    -e 's#^[a-z]*://##' -e 's#[/?].*$##' -e 's#:[0-9]*$##' -e 's#\.$##'
}

# valid_domain HOST: a public hostname, at least two labels, letters, digits and hyphens.
valid_domain() {
  case "$1" in '' | *[!a-z0-9.-]* | .* | *. | *..* | -* | *- | *-.* | *.-*) return 1 ;; esac
  case "$1" in *.*) ;; *) return 1 ;; esac
  [ "${#1}" -le 253 ] || return 1
  printf '%s' "$1" | awk -F. '{ for (i = 1; i <= NF; i++) if (length($i) > 63) exit 1; if ($NF ~ /^[0-9]+$/) exit 1 }'
}

# is_bare_domain HOST: two labels, such as example.com, which is most often a business's website.
is_bare_domain() { [ "$(printf '%s' "$1" | awk -F. '{ print NF }')" = 2 ]; }

valid_email() {
  case "$1" in *[[:space:]]* | *,* | *'"'* | *"'"* | *'<'* | *'>'*) return 1 ;; esac
  printf '%s' "$1" | grep -Eq '^[^@]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'
}

valid_version() { case "$1" in '' | *[!A-Za-z0-9._-]*) return 1 ;; *) return 0 ;; esac }

# A new secret key: 32 random bytes, base64.
new_secret() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }

# --- the settings file ------------------------------------------------------------------------------

env_get() {
  if [ -f "$DIR/.env" ]; then sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1; fi
}

env_set() {
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$DIR/.env" >"$DIR/.env.new"
  chmod 600 "$DIR/.env.new"
  mv "$DIR/.env.new" "$DIR/.env"
}

# --- the system -------------------------------------------------------------------------------------

need_root() {
  [ "$(id -u)" = 0 ] && return 0
  die "Run it as root: curl -fsSL https://surfingdog.ai/install.sh | sudo sh"
}

# os_family: ubuntu or debian (what Docker's apt repository calls it), from /etc/os-release.
os_family() {
  [ -r "$OS_RELEASE" ] || return 1
  local id like ubuntu
  id=$(sed -n 's/^ID=//p' "$OS_RELEASE" | tr -d '"')
  like=$(sed -n 's/^ID_LIKE=//p' "$OS_RELEASE" | tr -d '"')
  ubuntu=$(sed -n 's/^UBUNTU_CODENAME=//p' "$OS_RELEASE" | tr -d '"')
  case "$id" in
    ubuntu | debian) printf '%s' "$id" ;;
    *) if [ -n "$ubuntu" ]; then printf ubuntu; else case " $like " in *" debian "*) printf debian ;; *) return 1 ;; esac fi ;;
  esac
}

# os_codename: the release Docker's repository is keyed by (for an Ubuntu derivative, Ubuntu's own).
os_codename() {
  local ubuntu
  ubuntu=$(sed -n 's/^UBUNTU_CODENAME=//p' "$OS_RELEASE" | tr -d '"')
  if [ "$(os_family)" = ubuntu ] && [ -n "$ubuntu" ]; then printf '%s' "$ubuntu"; else sed -n 's/^VERSION_CODENAME=//p' "$OS_RELEASE" | tr -d '"'; fi
}

os_name() { sed -n 's/^PRETTY_NAME=//p' "$OS_RELEASE" | tr -d '"'; }

# arch: amd64 or arm64, or nothing for anything else.
arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf amd64 ;;
    aarch64 | arm64) printf arm64 ;;
    *) ;;
  esac
}

check_system() {
  local family
  family=$(os_family) || die "This installer is for Ubuntu and Debian. On another system, run the Compose file in deploy/ by hand: https://surfingdog.ai/docs/run-it-yourself/"
  [ -n "$(arch)" ] || die "This server is $(uname -m); the inbox's image is for amd64 and arm64."
  command -v systemctl >/dev/null 2>&1 || die "This system has no systemd, which Docker's packages need here."
  local mem
  mem=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0)
  if [ "${mem:-0}" -gt 0 ] && [ "$mem" -lt 400 ]; then warn "This server has ${mem} MB of memory; the inbox wants 512 MB or more."; fi
  local parent="$DIR" free
  while [ ! -d "$parent" ]; do parent=$(dirname "$parent"); done
  free=$(df -Pk "$parent" | awk 'NR == 2 { print int($4 / 1024) }')
  if [ "${free:-0}" -lt 1024 ]; then warn "Only ${free} MB free on the disk for $DIR; the images and the data want 1 GB or more."; fi
  ok "$(os_name) on $(arch) ($family)"
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
}

ensure_tools() {
  local missing=""
  command -v curl >/dev/null 2>&1 || missing="$missing curl"
  if [ -z "$(ls /etc/ssl/certs 2>/dev/null)" ]; then missing="$missing ca-certificates"; fi
  command -v ss >/dev/null 2>&1 || missing="$missing iproute2"
  command -v ip >/dev/null 2>&1 || case "$missing" in *iproute2*) ;; *) missing="$missing iproute2" ;; esac
  [ -z "$missing" ] && return 0
  say "Installing$missing…"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  # shellcheck disable=SC2086  # the names, one by one
  apt_install $missing
}

has_compose() { docker compose version >/dev/null 2>&1; }

install_docker() {
  local family codename
  family=$(os_family)
  codename=$(os_codename)
  [ -n "$codename" ] || die "Could not tell which release of $family this is, to install Docker. Install Docker yourself (docs.docker.com/engine/install), then run this again."
  say "Installing Docker from download.docker.com ($family $codename)…"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  apt_install ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$family/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$family" "$codename" >/etc/apt/sources.list.d/docker.list
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  apt_install docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker >/dev/null 2>&1
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    install_docker
  elif ! has_compose; then
    say "Installing Docker Compose…"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
    apt_install docker-compose-plugin 2>/dev/null || apt_install docker-compose-v2 2>/dev/null ||
      die "Docker is here without Compose v2, and neither docker-compose-plugin nor docker-compose-v2 installs. Install Compose (docs.docker.com/compose/install), then run this again."
  fi
  if ! docker info >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || true
    docker info >/dev/null 2>&1 || die "Docker is installed but not running: systemctl status docker says why."
  fi
  has_compose || die "Docker Compose v2 does not answer: docker compose version"
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), $(docker compose version --short 2>/dev/null | sed 's/^/Compose /')"
}

# --- the address ------------------------------------------------------------------------------------

# Addresses the name resolves to, one per line.
resolve() { getent ahosts "$1" 2>/dev/null | awk '{ print $1 }' | sort -u; }

# Addresses on this server's own interfaces, one per line, loopback left out.
local_addresses() {
  ip -o addr show 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }' | grep -Ev '^(127\.|::1$)' | sort -u
}

is_private() {
  case "$1" in
    10.* | 192.168.* | 127.* | 169.254.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) return 0 ;;
    100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) return 0 ;;
    fc* | fd* | fe80:* | ::1) return 0 ;;
    *) return 1 ;;
  esac
}

# What to point the record at: this server's public addresses, if its interfaces have any.
public_addresses() { local_addresses | while read -r a; do is_private "$a" || printf '%s\n' "$a"; done; }

# dns_verdict "RESOLVED" "LOCAL": none (no record), here (it points at this server), or elsewhere.
dns_verdict() {
  [ -n "$1" ] || {
    printf none
    return 0
  }
  for a in $1; do
    for l in $2; do [ "$a" = "$l" ] && {
      printf here
      return 0
    }; done
  done
  printf elsewhere
}

# Through NAT, the server does not hold its public address: then the name is asked for over HTTP,
# and a token that only this run knows has to come back. Needs port 80 free.
probe_http() {
  local token got
  token=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
  docker run -d --rm --name inbox-dns-probe -p 80:80 "$CADDY_IMAGE" \
    caddy respond --listen :80 --body "$token" >/dev/null 2>&1 || return 1
  sleep 2
  got=$(curl -fsS --max-time 8 "http://$DOMAIN/.well-known/surfingdog-inbox-probe" 2>/dev/null || true)
  docker rm -f inbox-dns-probe >/dev/null 2>&1 || true
  [ "$got" = "$token" ]
}

# On a second run the inbox itself answers at the address.
inbox_answers() {
  local k=""
  [ "$TLS" = internal ] && k=-k
  curl -fsS $k --max-time 8 "https://$DOMAIN/healthz" 2>/dev/null | grep -q '"ok":true'
}

check_dns() {
  if [ "$SKIP_DNS" = 1 ]; then
    note "Not checking where $DOMAIN points (--skip-dns-check)."
    return 0
  fi
  while :; do
    local resolved locals verdict pub
    resolved=$(resolve "$DOMAIN")
    locals=$(local_addresses)
    verdict=$(dns_verdict "$resolved" "$locals")
    if [ "$verdict" = here ]; then
      ok "$DOMAIN points at this server ($(printf '%s' "$resolved" | tr '\n' ' ' | sed 's/ $//'))"
      for a in $resolved; do is_private "$a" && [ "$TLS" = acme ] &&
        warn "$a is a private address: a public certificate needs $DOMAIN to be reachable from the internet (--tls internal on a private network)."; done
      return 0
    fi
    if [ "$verdict" = elsewhere ]; then
      if inbox_answers || probe_http; then
        ok "$DOMAIN reaches this server"
        return 0
      fi
    fi
    pub=$(public_addresses | tr '\n' ' ' | sed 's/ $//')
    pub=${pub:-"this server's public IP address"}
    if [ "$verdict" = none ]; then
      warn "$DOMAIN has no DNS record yet. Where your domain's DNS is, add an A record: $DOMAIN → $pub"
    else
      warn "$DOMAIN points at $(printf '%s' "$resolved" | tr '\n' ' ' | sed 's/ $//'), not at this server ($pub)."
      note "If the record is proxied (such as Cloudflare's orange cloud), set it to DNS only, so the certificate can be issued."
    fi
    if [ "$YES" = 1 ] || ! tty_ok; then
      die "Fix the record and run this again, or add --skip-dns-check to go on without it."
    fi
    choose "Then:" "Check again" "Go on anyway: the certificate comes once the record is right" "Stop here"
    case "$CHOICE" in
      1) continue ;;
      2) return 0 ;;
      *) die "Stopped. Nothing was installed yet." ;;
    esac
  done
}

ask_domain() {
  if [ -z "$DOMAIN" ]; then
    if [ "$YES" = 1 ] || ! tty_ok; then die "Which address? Run it with --domain inbox.yourbusiness.com (and --email)."; fi
    say ""
    say "Your inbox answers at a subdomain of your business's domain, such as inbox.yourbusiness.com."
    while :; do
      ask "Its address"
      DOMAIN=$(normalize_domain "$ANSWER")
      valid_domain "$DOMAIN" && break
      warn "That is not an address like inbox.yourbusiness.com."
    done
    if is_bare_domain "$DOMAIN"; then
      choose "$DOMAIN is a whole domain. The inbox at:" "inbox.$DOMAIN (your website stays as it is)" "$DOMAIN itself (only if nothing else answers there)"
      [ "$CHOICE" = 1 ] && DOMAIN="inbox.$DOMAIN"
    fi
  fi
  DOMAIN=$(normalize_domain "$DOMAIN")
  valid_domain "$DOMAIN" || die "'$DOMAIN' is not an address like inbox.yourbusiness.com."
}

ask_email() {
  if [ -z "$EMAIL" ]; then
    if [ "$YES" = 1 ] || ! tty_ok; then die "Whose email? Run it with --email you@yourbusiness.com."; fi
    while :; do
      ask "The owner's email address (only it can sign in the first time)"
      EMAIL=$(printf '%s' "$ANSWER" | tr -d '[:space:]')
      valid_email "$EMAIL" && break
      warn "That is not an email address."
    done
  fi
  valid_email "$EMAIL" || die "'$EMAIL' is not an email address."
}

# On a second run: keep what is there, or change it.
existing_install() {
  [ -f "$DIR/.env" ] || return 0
  EXISTING=1
  local had_domain had_email
  had_domain=$(env_get INBOX_DOMAIN)
  had_email=$(env_get INBOX_OWNER_EMAIL)
  [ -n "$(env_get INBOX_SECRET_KEY)" ] || die "$DIR/.env has no INBOX_SECRET_KEY. It is what opens the data: put it back from your copy, then run this again."
  if [ -z "$DOMAIN" ] && [ -z "$EMAIL" ] && [ "$YES" = 0 ] && tty_ok; then
    say ""
    choose "An inbox is installed here: https://$had_domain, owner $had_email." \
      "Keep it as it is, and bring its files up to date" \
      "Change its address or the owner's email" \
      "Stop here"
    case "$CHOICE" in
      1) ;;
      2)
        ask "Its address" "$had_domain"
        DOMAIN=$(normalize_domain "$ANSWER")
        ask "The owner's email address" "$had_email"
        EMAIL=$ANSWER
        ;;
      *) die "Stopped. Nothing changed." ;;
    esac
  fi
  DOMAIN=${DOMAIN:-$had_domain}
  EMAIL=${EMAIL:-$had_email}
  # The certificate stays as it was set, unless --tls says otherwise.
  [ -n "$TLS" ] || TLS=$(env_get INBOX_TLS)
  if [ -n "$EMAIL" ] && [ "$EMAIL" != "$had_email" ]; then
    note "The owner's email only lets the first account in. Once someone has signed in, change it in Settings → Keys."
  fi
}

# --- versions ---------------------------------------------------------------------------------------

latest_version() {
  curl -fsSI --max-time 10 "$RELEASES/latest" 2>/dev/null |
    tr -d '\r' | sed -n 's#^[Ll]ocation:.*/tag/v\{0,1\}\([^/[:space:]]*\)$#\1#p' | tail -n 1
}

resolve_version() {
  if [ -n "$VERSION" ]; then
    VERSION=${VERSION#v}
  elif [ "$EXISTING" = 1 ] && [ -n "$(env_get INBOX_VERSION)" ]; then
    VERSION=$(env_get INBOX_VERSION)
  else
    VERSION=$(latest_version)
    VERSION=${VERSION:-latest}
  fi
  valid_version "$VERSION" || die "'$VERSION' is not a version."
}

# --- ports ------------------------------------------------------------------------------------------

# port_holder PORT: the name of what listens on it, other than Docker's own proxy; nothing when free.
port_holder() {
  ss -Hltnp "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | grep -v '^docker-proxy$' | head -n 1
}

check_ports() {
  for port in 80 443; do
    local holder
    holder=$(port_holder "$port")
    [ -z "$holder" ] || die "Port $port is taken by $holder. Caddy, in front of the inbox, needs 80 and 443: stop $holder, or put the inbox behind it instead (https://surfingdog.ai/docs/run-it-yourself/#behind-a-proxy-you-already-run)."
  done
}

# --- the files --------------------------------------------------------------------------------------

# write_file PATH MODE: the text on stdin, put in place whole (never half-written).
write_file() {
  cat >"$1.new"
  chmod "$2" "$1.new"
  mv "$1.new" "$1"
}

write_settings() {
  if [ ! -f "$DIR/.env" ]; then
    local key
    key=$(new_secret)
    write_file "$DIR/.env" 600 <<EOF
# Surfing Dog Inbox's settings. Readable by root only. Keep a copy somewhere safe, apart from this
# server: INBOX_SECRET_KEY opens what the database keeps sealed, and a backup restores fully only with it.
INBOX_DOMAIN=$DOMAIN
INBOX_OWNER_EMAIL=$EMAIL
INBOX_SECRET_KEY=$key
INBOX_VERSION=$VERSION
EOF
  fi
  chmod 600 "$DIR/.env"
  env_set INBOX_DOMAIN "$DOMAIN"
  env_set INBOX_OWNER_EMAIL "$EMAIL"
  env_set INBOX_VERSION "$VERSION"
  [ -n "$IMAGE" ] && env_set INBOX_IMAGE "$IMAGE"
  env_set INBOX_TLS "$TLS"
  return 0
}

write_kit() {
  write_file "$DIR/docker-compose.yml" 644 <<'SDI_KIT_EOF'
@@EMBED deploy/docker-compose.yml@@
SDI_KIT_EOF
  write_file "$DIR/Caddyfile" 644 <<'SDI_KIT_EOF'
@@EMBED deploy/Caddyfile@@
SDI_KIT_EOF
  sed "s#^INBOX_DIR=\"\${INBOX_DIR:-/opt/inbox}\"#INBOX_DIR=\"\${INBOX_DIR:-$DIR}\"#" <<'SDI_KIT_EOF' | write_file "$BIN_DIR/inbox" 755
@@EMBED deploy/inbox@@
SDI_KIT_EOF
}

write_backup_timer() {
  [ -d "$SYSTEMD_DIR" ] || return 0
  write_file "$SYSTEMD_DIR/inbox-backup.service" 644 <<EOF
[Unit]
Description=Back up Surfing Dog Inbox
After=docker.service

[Service]
Type=oneshot
ExecStart=$BIN_DIR/inbox backup --auto --quiet
EOF
  write_file "$SYSTEMD_DIR/inbox-backup.timer" 644 <<'EOF'
[Unit]
Description=Back up Surfing Dog Inbox every night, keeping the last seven

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now inbox-backup.timer >/dev/null 2>&1 || warn "The nightly backup could not be switched on: systemctl status inbox-backup.timer"
}

write_files() {
  install -d -m 755 "$DIR"
  install -d -m 700 "$DIR/data" "$DIR/caddy"
  install -d -m 700 "$DIR/caddy/data" "$DIR/caddy/config"
  chown "$INBOX_UID:$INBOX_UID" "$DIR/data"
  write_settings
  write_kit
  write_backup_timer
  ok "Wrote $DIR (settings, Compose file, Caddy) and $BIN_DIR/inbox"
}

# --- running ----------------------------------------------------------------------------------------

load_image() {
  [ -n "$IMAGE_FILE" ] || return 0
  [ -f "$IMAGE_FILE" ] || die "There is no file $IMAGE_FILE."
  say "Loading the image from $IMAGE_FILE…"
  docker load -i "$IMAGE_FILE" >/dev/null
}

pull_images() {
  say "Downloading the images…"
  INBOX_DIR="$DIR" docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" pull -q --ignore-pull-failures >/dev/null 2>&1 || true
  local name="${IMAGE:-$(env_get INBOX_IMAGE)}"
  docker image inspect "${name:-ghcr.io/surfingdogai/inbox}:$VERSION" >/dev/null 2>&1 ||
    die "Could not download ${name:-ghcr.io/surfingdogai/inbox}:$VERSION. Is this server online? The releases: $RELEASES"
}

https_answers() {
  local k=""
  [ "$TLS" = internal ] && k=-k
  curl -fsS $k --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz" 2>/dev/null | grep -q '"ok":true'
}

start() {
  say "Starting the inbox and Caddy…"
  INBOX_DIR="$DIR" "$BIN_DIR/inbox" up 180
  ok "The inbox answers"
  local waited=0
  while [ "$waited" -lt 90 ]; do
    https_answers && {
      ok "https://$DOMAIN answers, with its certificate"
      HTTPS=1
      return 0
    }
    sleep 3
    waited=$((waited + 3))
  done
  HTTPS=0
  warn "https://$DOMAIN does not answer yet. Caddy keeps trying for the certificate; sudo inbox logs caddy says why."
}

summary() {
  local latest
  say ""
  if [ "$HTTPS" = 1 ]; then
    say "${B}Surfing Dog Inbox is running at https://$DOMAIN${N}"
  else
    say "${B}Surfing Dog Inbox is installed${N}, and answers at https://$DOMAIN once its certificate is issued."
  fi
  say ""
  say "Next:"
  say "  1. Sign in. Open https://$DOMAIN/login and enter $EMAIL."
  if [ -z "$(env_get MAIL_FROM)" ]; then
    say "     Email is not set up yet, so the sign-in email stays on this server:"
    say "       sudo inbox sign-in"
    say "  2. Set up email, so the inbox can send sign-in links and replies:"
    say "       sudo inbox email"
  else
    say "  2. Email goes out from $(env_get MAIL_FROM)."
  fi
  say "  3. Let your AI set up the rest (email in, your business, your site):"
  say "       https://surfingdog.ai/install.md, from Step 2"
  say ""
  say "Your data is in $DIR/data, backed up every night to $DIR/data/backups."
  say "Keep a copy of $DIR/.env somewhere safe, apart from this server: its secret key opens the data."
  say "  sudo inbox status | update | backup | restore | help"
  if [ "$EXISTING" = 1 ]; then
    latest=$(latest_version)
    if [ -n "$latest" ] && [ "$latest" != "$VERSION" ] && [ "$VERSION" != latest ]; then
      say ""
      say "A newer release is out ($latest; this is $VERSION): sudo inbox update"
    fi
  fi
  return 0
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) DOMAIN="${2:-}" && shift ;;
      --domain=*) DOMAIN="${1#*=}" ;;
      --email) EMAIL="${2:-}" && shift ;;
      --email=*) EMAIL="${1#*=}" ;;
      --version) VERSION="${2:-}" && shift ;;
      --version=*) VERSION="${1#*=}" ;;
      --dir) DIR="${2:-}" && shift ;;
      --dir=*) DIR="${1#*=}" ;;
      --image) IMAGE="${2:-}" && shift ;;
      --image=*) IMAGE="${1#*=}" ;;
      --image-file) IMAGE_FILE="${2:-}" && shift ;;
      --image-file=*) IMAGE_FILE="${1#*=}" ;;
      --tls) TLS="${2:-}" && shift ;;
      --tls=*) TLS="${1#*=}" ;;
      --yes | -y) YES=1 ;;
      --skip-dns-check) SKIP_DNS=1 ;;
      --help | -h)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "Unknown option: $1"
        ;;
    esac
    shift
  done
  case "$TLS" in '' | acme | internal) ;; *) die "--tls is acme (the default) or internal." ;; esac
  case "$DIR" in /*) ;; *) die "--dir is a full path, like /opt/inbox." ;; esac
  if [ -n "$IMAGE" ]; then case "$IMAGE" in *[!A-Za-z0-9./:_-]* | *:*:*) die "--image is a name like ghcr.io/surfingdogai/inbox, without a version." ;; esac fi
}

main() {
  parse_args "$@"
  say "${B}Surfing Dog Inbox${N}, on your own server"
  need_root
  step "Checking this server"
  check_system
  ensure_tools
  existing_install
  TLS=${TLS:-acme}
  ask_domain
  ask_email
  if [ "$EXISTING" = 0 ] && [ "$YES" = 0 ] && tty_ok; then
    choose "Install the inbox at https://$DOMAIN, with $EMAIL as its owner?" "Yes, install it" "Stop here"
    [ "$CHOICE" = 1 ] || die "Stopped. Nothing was installed."
  fi
  step "Docker"
  ensure_docker
  load_image
  step "The address"
  check_ports
  check_dns
  step "Installing"
  resolve_version
  write_files
  pull_images
  start
  summary
}

# Tests source this file with SDI_INSTALL_LIB=1 to call its functions one by one.
if [ "${SDI_INSTALL_LIB:-}" != 1 ]; then main "$@"; fi
