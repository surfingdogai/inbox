#!/bin/sh
# Surfing Dog Inbox: install it on your own server, with HTTPS, in one command.
#
#   curl -fsSL https://surfingdog.ai/install.sh | sudo sh
#
# For a fresh Ubuntu or Debian server, amd64 or arm64, that a subdomain of your business's domain
# points at (an A record such as inbox.yourbusiness.com → this server). In order, it:
#
#   1. checks the system, and asks two things: the address your inbox answers at, and the owner's
#      email address;
#   2. checks, before it installs anything, that ports 80 and 443 are free, that the address has a
#      DNS record, and which release is the newest;
#   3. installs Docker from Docker's own apt repository if it is missing, and checks that the address
#      leads to this server;
#   4. writes /opt/inbox: the settings (.env, readable by root only, with a secret key it generates),
#      a Compose file, and Caddy's site file; your data goes in /opt/inbox/data;
#   5. starts the inbox behind Caddy, which gets the HTTPS certificate on its own;
#   6. installs the `inbox` command (status, update, backup, restore) and a nightly backup;
#   7. tells you the next step: your first sign-in, then email.
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
# The same Caddy as the Compose file's, pinned: it answers the address check before anything is installed.
CADDY_IMAGE="caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f"
INBOX_UID=10001
RELEASES="https://github.com/surfingdogai/inbox/releases"
OS_RELEASE="${SDI_OS_RELEASE:-/etc/os-release}"
BIN_DIR="${SDI_BIN_DIR:-/usr/local/bin}"
SYSTEMD_DIR="${SDI_SYSTEMD_DIR:-/etc/systemd/system}"
EXISTING=0
HTTPS=0
# A --version for an inbox already installed here: `inbox update` moves to it, with a backup and a rollback.
WANT_VERSION=""
# The addresses the name points at that are not this server's own: the probe says where they lead.
DNS_OTHERS=""
PROBE_TOKEN=""

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
  chmod 644 /etc/apt/sources.list.d/docker.list
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

one_line() { printf '%s' "$1" | tr '\n' ' ' | sed 's/ $//'; }

# dns_verdict "RESOLVED" "LOCAL": none (no record), here (every address it points at is this
# server's own), or else the addresses that are not, space-separated. Let's Encrypt may check any of
# them (IPv6 first), so one stale AAAA record elsewhere is enough to fail the certificate.
dns_verdict() {
  local others="" a l mine
  [ -n "$1" ] || {
    printf none
    return 0
  }
  for a in $1; do
    mine=0
    for l in $2; do if [ "$a" = "$l" ]; then mine=1; fi; done
    [ "$mine" = 1 ] || others="$others $a"
  done
  if [ -z "$others" ]; then printf here; else printf '%s' "${others# }"; fi
}

# dns_stop_or_ask STOPPED: with no one to ask, stops with STOPPED; else asks, and sets CHOICE
# (1 check again, 2 go on anyway).
dns_stop_or_ask() {
  if [ "$YES" = 1 ] || ! tty_ok; then
    die "$1 Fix the record and run this again, or add --skip-dns-check to go on without it."
  fi
  choose "Then:" "Check again" "Go on anyway: the certificate comes once the record is right" "Stop here"
  [ "$CHOICE" != 3 ] || die "$1"
}

# Before anything is installed: the record is there, and where it points. When every address is
# this server's own, that settles it; addresses that are not (behind NAT a server does not hold its
# public address) are left in DNS_OTHERS for the probe, which needs Docker.
check_dns_local() {
  local resolved verdict pub
  DNS_OTHERS=""
  if [ "$SKIP_DNS" = 1 ]; then
    note "Not checking where $DOMAIN points (--skip-dns-check)."
    return 0
  fi
  while :; do
    resolved=$(resolve "$DOMAIN")
    verdict=$(dns_verdict "$resolved" "$(local_addresses)")
    case "$verdict" in
      here)
        ok "$DOMAIN points at this server ($(one_line "$resolved"))"
        for a in $resolved; do if is_private "$a" && [ "$TLS" = acme ]; then
          warn "$a is a private address: a public certificate needs $DOMAIN to be reachable from the internet (--tls internal on a private network)."
        fi; done
        return 0
        ;;
      none)
        pub=$(public_addresses | tr '\n' ' ' | sed 's/ $//')
        warn "$DOMAIN has no DNS record yet. Where your domain's DNS is, add an A record: $DOMAIN → ${pub:-"this server's public IP address"}"
        dns_stop_or_ask "Stopped. Nothing was installed."
        [ "$CHOICE" = 1 ] || return 0
        ;;
      *)
        DNS_OTHERS=$verdict
        return 0
        ;;
    esac
  done
}

# The probe: a token only this run knows, answered over plain HTTP at the address. On a first install
# a throwaway Caddy answers it on port 80; on a second run the inbox's own Caddy does, from the file
# $DIR/probe/token, so the check also passes while the inbox holds port 80.
probe_stop() { docker rm -f inbox-dns-probe >/dev/null 2>&1 || true; }

probe_start() {
  PROBE_TOKEN=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
  if [ -d "$DIR/probe" ]; then printf '%s' "$PROBE_TOKEN" | write_file "$DIR/probe/token" 644; fi
  [ -z "$(ss -Hltn "sport = :80" 2>/dev/null)" ] || return 0
  probe_stop
  trap probe_stop EXIT
  trap 'probe_stop; exit 130' INT TERM
  docker run -d --rm --name inbox-dns-probe -p 80:80 "$CADDY_IMAGE" \
    caddy respond --listen :80 --body "$PROBE_TOKEN" >/dev/null 2>&1 || return 0
  sleep 2
}

probe_end() {
  probe_stop
  trap - EXIT INT TERM
  rm -f "$DIR/probe/token" 2>/dev/null || true
}

# probe_address ADDRESS: 0 when the token comes back from that address, 2 when Cloudflare's proxy
# answers there instead of this server, 1 otherwise.
probe_address() {
  local target out
  case "$1" in *:*) target="[$1]" ;; *) target="$1" ;; esac
  out=$(curl -sS -D - --max-time 8 --resolve "$DOMAIN:80:$target" "http://$DOMAIN/.well-known/surfingdog-inbox-probe" 2>/dev/null | tr -d '\r') || true
  if printf '%s\n' "$out" | grep -Eqi '^(cf-ray:|server:[[:space:]]*cloudflare)'; then return 2; fi
  [ -n "$PROBE_TOKEN" ] && [ "$(printf '%s\n' "$out" | sed '1,/^$/d')" = "$PROBE_TOKEN" ]
}

# With Docker here: each address the name points at that is not this server's own must lead here.
check_dns_remote() {
  local bad rc proxied resolved verdict pub
  [ -n "$DNS_OTHERS" ] || return 0
  while :; do
    bad=""
    proxied=0
    probe_start
    for a in $DNS_OTHERS; do
      rc=0
      probe_address "$a" || rc=$?
      [ "$rc" = 0 ] || bad="$bad $a"
      [ "$rc" != 2 ] || proxied=1
    done
    probe_end
    if [ -z "$bad" ]; then
      ok "$DOMAIN reaches this server ($(one_line "$DNS_OTHERS"))"
      return 0
    fi
    pub=$(public_addresses | tr '\n' ' ' | sed 's/ $//')
    if [ "$proxied" = 1 ]; then
      warn "$DOMAIN goes through Cloudflare's proxy (the orange cloud). Set its record to DNS only (grey cloud), so this server gets its own certificate and the inbox sees each visitor's own address."
    else
      warn "$DOMAIN points at${bad}, not at this server (${pub:-its public IP address}). Every A and AAAA record for it must point here: Let's Encrypt may check any of them."
    fi
    dns_stop_or_ask "Stopped. Docker is installed; the inbox is not."
    [ "$CHOICE" = 1 ] || return 0
    while :; do
      resolved=$(resolve "$DOMAIN")
      verdict=$(dns_verdict "$resolved" "$(local_addresses)")
      case "$verdict" in
        here)
          ok "$DOMAIN points at this server ($(one_line "$resolved"))"
          return 0
          ;;
        none)
          warn "$DOMAIN has no DNS record now."
          dns_stop_or_ask "Stopped. Docker is installed; the inbox is not."
          [ "$CHOICE" = 1 ] || return 0
          ;;
        *)
          DNS_OTHERS=$verdict
          break
          ;;
      esac
    done
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

# The version to install. An inbox already here keeps its own; a --version other than it is left in
# WANT_VERSION for `inbox update`, which backs up first and rolls back if it does not start (and
# refuses to go back to an older version, which could not read the newer database).
resolve_version() {
  local had
  had=$(env_get INBOX_VERSION)
  if [ -n "$VERSION" ]; then
    VERSION=${VERSION#v}
    valid_version "$VERSION" || die "'$VERSION' is not a version."
    if [ "$EXISTING" = 1 ] && [ -n "$had" ] && [ "$VERSION" != "$had" ]; then
      WANT_VERSION=$VERSION
      VERSION=$had
    fi
  elif [ "$EXISTING" = 1 ] && [ -n "$had" ]; then
    VERSION=$had
  else
    VERSION=$(latest_version)
    [ -n "$VERSION" ] || die "Could not read the newest release from $RELEASES. If this server reaches github.com, no release is published yet; name one with --version."
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
# Surfing Dog Inbox on one server: the inbox, and Caddy in front of it, which gets the HTTPS
# certificate on its own and renews it. The settings are in .env beside this file; the data is in
# ./data, one SQLite file you can copy.
#
#   cp .env.example .env            then set INBOX_DOMAIN, INBOX_OWNER_EMAIL and INBOX_SECRET_KEY
#   mkdir -p data probe && sudo chown 10001:10001 data
#   docker compose up -d
#
# The installer (surfingdog.ai/install.sh) writes this same file to /opt/inbox and does those steps
# for you; `sudo inbox update` brings it up to date with each release. Only Caddy is reachable from
# outside, on 80 and 443; the inbox listens inside. Both images are pinned: a release changes them.
name: inbox

services:
  inbox:
    image: ${INBOX_IMAGE:-ghcr.io/surfingdogai/inbox}:${INBOX_VERSION:?set INBOX_VERSION in .env, like 0.2.0}
    restart: unless-stopped
    init: true
    env_file: .env
    environment:
      INBOX_PUBLIC_URL: https://${INBOX_DOMAIN:?set INBOX_DOMAIN in .env}
    volumes:
      - ./data:/opt/inbox/data
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "5"

  caddy:
    image: caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
    restart: unless-stopped
    depends_on:
      - inbox
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    environment:
      INBOX_DOMAIN: ${INBOX_DOMAIN}
      INBOX_TLS: ${INBOX_TLS:-acme}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./probe:/srv/probe:ro
      - ./caddy/data:/data
      - ./caddy/config:/config
    # The one container the internet reaches: no root file system to write to, and of root's
    # powers only binding ports 80 and 443.
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    security_opt:
      - no-new-privileges:true
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
SDI_KIT_EOF
  write_file "$DIR/Caddyfile" 644 <<'SDI_KIT_EOF'
# Caddy in front of the inbox: HTTPS at INBOX_DOMAIN, with a certificate from Let's Encrypt that it
# gets and renews on its own. It keeps no access log. INBOX_TLS=internal uses Caddy's own certificate
# authority instead, for a test or a private network, where no public certificate can be had.

# A public certificate, and browsers told to come back over HTTPS only (for a year).
(tls-acme) {
	header Strict-Transport-Security "max-age=31536000"
}

(tls-internal) {
	tls internal
}

{$INBOX_DOMAIN} {
	import tls-{$INBOX_TLS:acme}

	# The inbox limits each caller by the address Caddy connected from (the first X-Forwarded-For,
	# which Caddy sets itself). A CF-Connecting-IP sent by a caller would let it pass for anyone, so
	# it is dropped here.
	reverse_proxy inbox:8787 {
		header_up -CF-Connecting-IP
	}
}

# Over plain HTTP: the installer's address check (a token it writes to ./probe/token for that run
# only), and everything else sent on to HTTPS. Caddy answers Let's Encrypt's own checks here too.
http://{$INBOX_DOMAIN} {
	handle /.well-known/surfingdog-inbox-probe {
		root * /srv/probe
		rewrite * /token
		file_server
	}
	handle {
		redir https://{host}{uri} 308
	}
}
SDI_KIT_EOF
  # The `inbox` command, set to this directory and to where it is installed (its updates rewrite it
  # there). Written whole or not at all: a sed that failed would leave an empty command behind.
  cat >"$BIN_DIR/inbox.kit" <<'SDI_KIT_EOF'
#!/bin/sh
# inbox: look after the Surfing Dog Inbox on this server. The installer puts it at
# /usr/local/bin/inbox; it works on the Compose project in /opt/inbox (INBOX_DIR changes that).
#
#   sudo inbox status            what runs, its version, its health, its backups
#   sudo inbox update [version]  the newest release (or that version), undone if it does not start
#   sudo inbox backup            a full copy of the database, now, while it serves
#   sudo inbox restore <file>    replace the inbox with that backup
#   sudo inbox help              everything else
#
# It talks to Docker on this machine and, for `status` and `update`, to GitHub, to read which release
# is the newest and to download that release's kit. `email` asks Cloudflare which accounts a token
# you give it can use. It sends nothing anywhere else.
#
# It runs as root, and never writes into the inbox's data folder itself: that folder belongs to the
# inbox's container (uid 10001), so whatever goes in there, a backup put back or a file to restore,
# is written by a one-off container of the inbox, as that user. Its own notes and update logs are in
# $INBOX_DIR/state, root's alone.
# shellcheck disable=SC3043  # `local` is in every sh this runs on (dash, bash, busybox).
# shellcheck disable=SC2016  # the scripts for the inbox's container are single-quoted: their $1 is theirs.
set -eu

INBOX_DIR="${INBOX_DIR:-/opt/inbox}"
INBOX_BIN="${INBOX_BIN:-/usr/local/bin/inbox}"
RELEASES="https://github.com/surfingdogai/inbox/releases"
KEEP_UPDATE_BACKUPS=5
KEEP_DAILY_BACKUPS=7
KEEP_SAFETY_BACKUPS=5
KEEP_LOGS=5
ENV_FILE="$INBOX_DIR/.env"
DATA="$INBOX_DIR/data"
BACKUPS="$DATA/backups"
STATE="$INBOX_DIR/state"
LITESTREAM="$INBOX_DIR/docker-compose.litestream.yml"
# The same folders as the inbox's container sees them.
INSIDE=/opt/inbox/data

if [ -t 1 ]; then
  B=$(printf '\033[1m') D=$(printf '\033[2m') G=$(printf '\033[32m') Y=$(printf '\033[33m') R=$(printf '\033[31m') N=$(printf '\033[0m')
else
  B='' D='' G='' Y='' R='' N=''
fi
say() { printf '%s\n' "$*"; }
ok() { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
note() { printf '%s%s%s\n' "$D" "$*" "$N"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*" >&2; }
die() {
  printf '%s✗%s %s\n' "$R" "$N" "$*" >&2
  exit 1
}

# --- asking -----------------------------------------------------------------------------------------

YES=0
tty_ok() { [ -r /dev/tty ] && [ -w /dev/tty ] && (: </dev/tty) 2>/dev/null; }

# confirm "question": yes when --yes was given, else the person's answer (default no).
confirm() {
  [ "$YES" = 1 ] && return 0
  tty_ok || die "$1 Run it again with --yes to go ahead without a question."
  printf '%s [y/N] ' "$1" >/dev/tty
  local answer
  read -r answer </dev/tty || answer=""
  case "$answer" in y | Y | yes | Yes | YES) return 0 ;; *) return 1 ;; esac
}

# choose "question" "first" "second"…: sets CHOICE to the number picked (1 when Enter is pressed).
choose() {
  local question="$1" i=1 answer
  shift
  tty_ok || die "$question (no terminal to ask on)"
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
  tty_ok || die "$1 (no terminal to ask on)"
  if [ -n "${2:-}" ]; then printf '%s [%s]: ' "$1" "$2" >/dev/tty; else printf '%s: ' "$1" >/dev/tty; fi
  read -r ANSWER </dev/tty || ANSWER=""
  ANSWER=${ANSWER:-${2:-}}
}

# ask_secret "question": sets ANSWER, without showing what is typed.
ask_secret() {
  tty_ok || die "$1 (no terminal to ask on)"
  printf '%s: ' "$1" >/dev/tty
  stty -echo </dev/tty 2>/dev/null || true
  read -r ANSWER </dev/tty || ANSWER=""
  stty echo </dev/tty 2>/dev/null || true
  printf '\n' >/dev/tty
}

# --- the settings file ------------------------------------------------------------------------------

env_get() {
  if [ -f "$ENV_FILE" ]; then sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; fi
}

# env_set KEY VALUE: one line KEY=VALUE, in place of any before, the file kept readable by root only.
env_set() {
  case "$2" in *"
"*) die "a value for $1 cannot span lines" ;; esac
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" >"$ENV_FILE.new"
  chmod 600 "$ENV_FILE.new"
  mv "$ENV_FILE.new" "$ENV_FILE"
}

env_unset() {
  K="$1" awk 'index($0, ENVIRON["K"] "=") != 1' "$ENV_FILE" >"$ENV_FILE.new"
  chmod 600 "$ENV_FILE.new"
  mv "$ENV_FILE.new" "$ENV_FILE"
}

# --- Docker -----------------------------------------------------------------------------------------

# The Compose project, with Litestream's file beside it when it is there (docs/backups), so nothing
# here ever leaves Litestream out, or stops it by mistake.
dc() {
  if [ -f "$LITESTREAM" ]; then
    docker compose --project-directory "$INBOX_DIR" -f "$INBOX_DIR/docker-compose.yml" -f "$LITESTREAM" "$@"
  else
    docker compose --project-directory "$INBOX_DIR" -f "$INBOX_DIR/docker-compose.yml" "$@"
  fi
}

need_install() {
  if [ ! -f "$INBOX_DIR/docker-compose.yml" ] || [ ! -f "$ENV_FILE" ]; then
    die "No inbox is installed in $INBOX_DIR. Install one: curl -fsSL https://surfingdog.ai/install.sh | sudo sh"
  fi
  [ "$(id -u)" = 0 ] || die "Run it as root: sudo inbox $COMMAND"
  command -v docker >/dev/null 2>&1 || die "Docker is not installed here."
  # Root reads these folders; it must never be led out of them.
  if [ -L "$DATA" ] || [ -L "$BACKUPS" ]; then
    die "$BACKUPS is a symbolic link, or a folder above it is. The inbox command works only on the real folders: find out what made the link, and put the folder back."
  fi
  install -d -m 700 "$STATE"
}

# lock [wait]: one inbox command that changes things at a time (the nightly backup waits its turn).
lock() {
  command -v flock >/dev/null 2>&1 || return 0
  exec 9>"$INBOX_DIR/.lock"
  if [ "${1:-}" = wait ]; then
    flock -w 900 9 || die "Another inbox command has been running for 15 minutes; no backup was made."
  else
    flock -n 9 || die "Another inbox command is running. Try again when it is done."
  fi
}

# image [VERSION]: the image the inbox runs, at that version or the one in .env.
image() {
  local name version
  name=$(env_get INBOX_IMAGE)
  version=${1:-$(env_get INBOX_VERSION)}
  printf '%s:%s' "${name:-ghcr.io/surfingdogai/inbox}" "${version:-latest}"
}

is_number() { case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac }

container() { dc ps -q inbox 2>/dev/null | head -n 1; }

running() {
  local id
  id=$(container)
  [ -n "$id" ] && [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" = true ]
}

# as_inbox SCRIPT [ARG…]: a shell script run by a one-off container of the inbox, as the inbox's own
# user, with the data folder at /opt/inbox/data. Its standard input is this command's.
as_inbox() {
  local script="$1"
  shift
  dc run --rm --no-deps -T --entrypoint sh inbox -c "$script" sh "$@"
}

# The inbox stopped (and Litestream with it, which must never copy a database being swapped), and
# started again. Once it was stopped, it is started again however this command ends.
STOPPED=0
stop_inbox() {
  if [ -f "$LITESTREAM" ]; then dc stop litestream >/dev/null 2>&1 || true; fi
  dc stop inbox >/dev/null 2>&1
  STOPPED=1
}
start_inbox() {
  dc up -d inbox >/dev/null 2>&1 || true
  if [ -f "$LITESTREAM" ]; then dc up -d litestream >/dev/null 2>&1 || true; fi
  STOPPED=0
}
on_exit() {
  if [ "$STOPPED" = 1 ]; then
    STOPPED=0
    warn "Starting the inbox again."
    start_inbox
  fi
}

# caddy_up: Caddy running on the Caddyfile as it is now. A file put in place is a new file, which a
# running container does not see, so Caddy is made anew when the file changed since it last started.
caddy_up() {
  local sum
  sum=$(cksum <"$INBOX_DIR/Caddyfile")
  if [ -f "$STATE/caddyfile.sum" ] && [ "$sum" != "$(cat "$STATE/caddyfile.sum")" ]; then
    dc up -d --force-recreate --no-deps caddy >/dev/null 2>&1 || return 1
  else
    dc up -d --no-deps caddy >/dev/null 2>&1 || return 1
  fi
  printf '%s\n' "$sum" >"$STATE/caddyfile.sum"
}

# The inbox's own /healthz, asked from inside its container: it says the version and that the
# database answers.
healthz() {
  dc exec -T inbox node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(async (r)=>{process.stdout.write(await r.text());process.exit(r.ok?0:1)},()=>process.exit(1))" 2>/dev/null
}

version_of() { sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }

# wait_healthy SECONDS: until /healthz answers ok; gives up early when the container keeps restarting.
wait_healthy() {
  local limit="$1" waited=0 id restarts
  while [ "$waited" -lt "$limit" ]; do
    if healthz >/dev/null; then return 0; fi
    id=$(container)
    if [ -n "$id" ]; then
      restarts=$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || echo 0)
      [ "${restarts:-0}" -ge 3 ] && return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# The newest release's version, read from where GitHub's "latest" link leads. Empty when unknown.
latest_version() {
  curl -fsSI --max-time 10 "$RELEASES/latest" 2>/dev/null |
    tr -d '\r' | sed -n 's#^[Ll]ocation:.*/tag/v\{0,1\}\([^/[:space:]]*\)$#\1#p' | tail -n 1
}

stamp() { date -u +%Y%m%dT%H%M%SZ; }

# prune DIR PATTERN KEEP: keeps the newest KEEP entries of DIR whose names match, deletes the older ones.
prune() {
  # shellcheck disable=SC2010  # the names are ours: <kind>-<UTC time>…, no spaces or newlines
  ls -1 "$1" 2>/dev/null | grep -E "$2" | sort -r | awk -v keep="$3" 'NR > keep' |
    while read -r old; do rm -rf -- "${1:?}/$old"; done
}

human_size() { du -h "$1" 2>/dev/null | awk '{ print $1 }'; }

# --- backups ----------------------------------------------------------------------------------------

# make_backup NAME: data/backups/NAME, a full copy made by the inbox itself (which makes the folder
# too): from the running container, or, when it is stopped, by a one-off container of the same
# version. Says why and returns non-zero when it could not.
make_backup() {
  local inside="$INSIDE/backups/$1" said
  if running; then
    said=$(dc exec -T inbox node /opt/inbox/server.mjs backup "$inside" 2>&1 >/dev/null) || {
      printf '%s\n' "$said" >&2
      return 1
    }
  else
    said=$(dc run --rm --no-deps -T inbox node /opt/inbox/server.mjs backup "$inside" 2>&1 >/dev/null) || {
      printf '%s\n' "$said" >&2
      return 1
    }
  fi
  [ -s "$BACKUPS/$1" ] || {
    warn "The backup was not written."
    return 1
  }
}

cmd_backup() {
  need_install
  local auto=0 quiet=0 name
  for arg in "$@"; do
    case "$arg" in
      --auto) auto=1 ;;
      --quiet) quiet=1 ;;
      *) die "inbox backup takes no '$arg' (only --auto and --quiet)" ;;
    esac
  done
  if [ "$auto" = 1 ]; then lock wait; else lock; fi
  if [ "$auto" = 1 ]; then name="inbox-$(stamp)-daily.db"; else name="inbox-$(stamp).db"; fi
  make_backup "$name" || die "The backup failed; the inbox runs on as it was."
  [ "$auto" = 1 ] && prune "$BACKUPS" '^inbox-.*-daily\.db$' "$KEEP_DAILY_BACKUPS"
  [ "$quiet" = 1 ] || {
    ok "Backed up to $BACKUPS/$name ($(human_size "$BACKUPS/$name"))"
    note "It is on this server's disk. Copy it somewhere else too, with the secret key in $ENV_FILE: it opens what the backup keeps sealed."
  }
}

# check_db PATH: the inbox's own look at a database file in its data folder (PATH as the container
# sees it), as JSON, or nothing when it cannot look.
check_db() {
  dc run --rm --no-deps -T inbox node /opt/inbox/server.mjs check-db "$1" 2>/dev/null || true
}

json_field() { sed -n "s/.*\"$1\":\([^,}]*\).*/\1/p" | tr -d '"'; }

# stage_database PATH: a copy of PATH (as the container sees it) beside the database, ready to take
# its place. The inbox can keep running meanwhile.
stage_database() {
  as_inbox 'cp -- "$1" /opt/inbox/data/inbox.db.new && chmod 600 /opt/inbox/data/inbox.db.new' "$1"
}

# swap_database: the staged copy is the database from now on. The inbox must be stopped: its
# write-ahead log belongs to the database it replaces, and goes with it.
swap_database() {
  as_inbox 'cd /opt/inbox/data && test -s inbox.db.new && rm -f inbox.db-wal inbox.db-shm && mv -f inbox.db.new inbox.db'
}

# put_back BACKUP: the database is that backup (its name in data/backups) from now on, the inbox
# stopped for the swap and started again.
put_back() {
  stage_database "$INSIDE/backups/$1" || return 1
  stop_inbox
  swap_database || return 1
  start_inbox
}

cmd_restore() {
  need_install
  local file="" force=0
  for arg in "$@"; do
    case "$arg" in
      --yes) YES=1 ;;
      --force) force=1 ;;
      -*) die "inbox restore takes no '$arg'" ;;
      *) file="$arg" ;;
    esac
  done
  [ -n "$file" ] || die "Which backup? sudo inbox restore $BACKUPS/<file>  (ls $BACKUPS lists them)"
  [ -f "$file" ] || die "There is no file $file."
  lock
  # The inbox reads the file from inside its data folder, as a copy it writes itself, so the backup
  # is never touched.
  local copy report current theirs why
  copy=".restore-$(stamp).db"
  as_inbox 'cat >"/opt/inbox/data/$1" && chmod 600 "/opt/inbox/data/$1"' "$copy" <"$file" ||
    die "The inbox could not take a copy of $file to look at."
  report=$(check_db "$INSIDE/$copy")
  drop_copy() { as_inbox 'rm -f "/opt/inbox/data/$1"' "$copy" >/dev/null 2>&1 || true; }
  if [ "$(printf '%s' "$report" | json_field ok)" != true ]; then
    drop_copy
    why=$(printf '%s' "$report" | json_field problem)
    die "That file is not one to restore from: ${why:-the inbox could not read it}."
  fi
  current=$(check_db "$INSIDE/inbox.db" | json_field migration)
  theirs=$(printf '%s' "$report" | json_field migration)
  if [ "$force" = 0 ] && is_number "$current" && is_number "$theirs" && [ "$theirs" -gt "$current" ]; then
    drop_copy
    die "That backup was made by a newer version of the inbox than this one. Update first (sudo inbox update), then restore it."
  fi
  say "That backup holds $(printf '%s' "$report" | json_field items) requests. Restoring it replaces everything the inbox holds now."
  note "A backup of the inbox as it is now is made first."
  confirm "Restore it?" || {
    drop_copy
    die "Nothing changed."
  }
  local safety
  safety="inbox-$(stamp)-before-restore.db"
  make_backup "$safety" || {
    drop_copy
    die "The backup of the inbox as it is now failed, so nothing changed."
  }
  stage_database "$INSIDE/$copy" || {
    drop_copy
    die "The inbox could not copy that backup into place; nothing changed."
  }
  stop_inbox
  swap_database || die "The backup could not be put in place; the inbox starts again on what it held."
  drop_copy
  start_inbox
  if wait_healthy 120; then
    prune "$BACKUPS" '^inbox-.*-before-restore\.db$' "$KEEP_SAFETY_BACKUPS"
    ok "Restored from $file. The inbox as it was before is in $BACKUPS/$safety."
  else
    warn "The inbox did not start on that backup; putting back what it held before."
    put_back "$safety" || die "Could not put $BACKUPS/$safety back. Restore it: sudo inbox restore $BACKUPS/$safety"
    wait_healthy 120 || warn "It does not answer yet either: sudo inbox logs"
    die "Restore undone. Nothing was lost: the inbox holds what it held before."
  fi
}

# --- updates ----------------------------------------------------------------------------------------

# is_release VERSION: a version number (0.2.0), not a name such as latest.
is_release() { case "$1" in [0-9]*.[0-9]*) return 0 ;; *) return 1 ;; esac }

# older A B: A is an older version than B.
# A pre-release comes before its release: 0.2.0-rc.1 is older than 0.2.0 (sort -V puts a '~' first).
older() {
  local a b
  a=$(printf '%s' "$1" | sed 's/-/~/')
  b=$(printf '%s' "$2" | sed 's/-/~/')
  [ "$a" != "$b" ] && [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n 1)" = "$a" ]
}

# fetch_kit VERSION INTO: that release's kit (the Compose file, Caddy's file and this command) in
# INTO/inbox-selfhost, checked against the release's SHA256SUMS. Non-zero when the release has no kit
# to download; it stops outright when a download does not match its checksum.
fetch_kit() {
  local base="$RELEASES/download/v$1"
  curl -fsSL --max-time 60 "$base/SHA256SUMS" -o "$2/SHA256SUMS" 2>/dev/null || return 1
  curl -fsSL --max-time 300 "$base/inbox-selfhost.tar.gz" -o "$2/inbox-selfhost.tar.gz" 2>/dev/null || return 1
  (cd "$2" && grep ' inbox-selfhost\.tar\.gz$' SHA256SUMS >kit.sum && sha256sum -c kit.sum >/dev/null 2>&1) ||
    die "The kit of $1 does not match the checksum in its SHA256SUMS. Nothing changed."
  tar -xzf "$2/inbox-selfhost.tar.gz" -C "$2" || return 1
  [ -s "$2/inbox-selfhost/docker-compose.yml" ] && [ -s "$2/inbox-selfhost/Caddyfile" ] && [ -s "$2/inbox-selfhost/inbox" ]
}

# save_kit INTO: the kit as it is now, to put back with a rollback.
save_kit() {
  install -d -m 700 "$1"
  cp "$INBOX_DIR/docker-compose.yml" "$INBOX_DIR/Caddyfile" "$1/"
  if [ -f "$INBOX_BIN" ]; then cp "$INBOX_BIN" "$1/inbox"; fi
}

# install_kit FROM: the Compose file, Caddy's file and this command from FROM, each put in place
# whole. This command is set to this directory and this place, as the installer set it.
install_kit() {
  local f
  for f in docker-compose.yml Caddyfile; do
    cp "$1/$f" "$INBOX_DIR/$f.new"
    chmod 644 "$INBOX_DIR/$f.new"
    mv "$INBOX_DIR/$f.new" "$INBOX_DIR/$f"
  done
  [ -f "$1/inbox" ] && [ -d "$(dirname "$INBOX_BIN")" ] || return 0
  sed -e "s#^INBOX_DIR=\"\${INBOX_DIR:-/opt/inbox}\"#INBOX_DIR=\"\${INBOX_DIR:-$INBOX_DIR}\"#" \
    -e "s#^INBOX_BIN=\"\${INBOX_BIN:-/usr/local/bin/inbox}\"#INBOX_BIN=\"\${INBOX_BIN:-$INBOX_BIN}\"#" \
    "$1/inbox" >"$INBOX_BIN.new"
  if grep -q '^INBOX_DIR=' "$INBOX_BIN.new"; then
    chmod 755 "$INBOX_BIN.new"
    mv "$INBOX_BIN.new" "$INBOX_BIN"
  else
    rm -f "$INBOX_BIN.new"
    warn "The new inbox command was not readable; this one stays."
  fi
}

cmd_update() {
  need_install
  local target="" force=0
  for arg in "$@"; do
    case "$arg" in
      --yes) YES=1 ;;
      --force) force=1 ;;
      -*) die "inbox update takes no '$arg'" ;;
      *) target="${arg#v}" ;;
    esac
  done
  lock
  local from
  from=$(env_get INBOX_VERSION)
  from=${from:-latest}
  if [ -z "$target" ]; then
    target=$(latest_version)
    [ -n "$target" ] || die "Could not read the newest release from $RELEASES. Name one: sudo inbox update 0.2.0"
  fi
  case "$target" in *[!A-Za-z0-9._-]*) die "'$target' is not a version." ;; esac
  if [ "$target" = "$from" ] && [ "$from" != latest ] && running; then
    ok "Already on $target."
    return 0
  fi
  # An older version may not read a database a newer one changed. The way back is the rollback,
  # which puts back the data from before the update too.
  if [ "$force" = 0 ] && is_release "$from" && is_release "$target" && older "$target" "$from"; then
    die "$target is older than $from, and may not read the database $from left. To go back to the version before the last update, with its data: sudo inbox rollback. (--force goes ahead anyway.)"
  fi

  say "Downloading $(image "$target")…"
  if ! INBOX_VERSION="$target" dc pull -q inbox >/dev/null 2>&1; then
    docker image inspect "$(image "$target")" >/dev/null 2>&1 ||
      die "Could not download $(image "$target"). Nothing changed."
    note "Not downloaded; the copy already on this server is used."
  fi
  # That release's kit: the Compose file and Caddy's file it was tested with, and this command.
  local fresh="$STATE/kit-new-$$" kit=""
  rm -rf "$STATE"/kit-new-*
  install -d -m 700 "$fresh"
  if fetch_kit "$target" "$fresh"; then
    kit="$fresh/inbox-selfhost"
    docker compose --project-directory "$INBOX_DIR" -f "$kit/docker-compose.yml" pull -q caddy >/dev/null 2>&1 || true
  else
    note "No kit came with $target from $RELEASES; it runs with the files this server has."
  fi

  # Stopped first, so nothing is written between the backup and the new version: a rollback then
  # loses nothing.
  local backup saved
  backup="inbox-$(stamp)-before-$target.db"
  saved="$STATE/kit-$(stamp)-$from"
  stop_inbox
  if ! make_backup "$backup"; then
    rm -rf "$fresh"
    start_inbox
    die "The backup failed, so nothing changed: $from runs again."
  fi
  save_kit "$saved"
  printf 'version=%s\nbackup=%s\nkit=%s\n' "$from" "$backup" "$saved" >"$STATE/last-update"
  if [ -n "$kit" ]; then install_kit "$kit"; fi
  rm -rf "$fresh"

  env_set INBOX_VERSION "$target"
  start_inbox
  if wait_healthy 180; then
    caddy_up || warn "Caddy did not start again: sudo inbox logs caddy"
    prune "$BACKUPS" '^inbox-.*-before-[0-9].*\.db$' "$KEEP_UPDATE_BACKUPS"
    prune "$STATE" '^kit-[0-9]' "$KEEP_UPDATE_BACKUPS"
    local says
    says=$(healthz | version_of)
    [ -z "$says" ] || [ "$says" = "$target" ] || says=" (it reports $says)"
    [ "$says" = "$target" ] && says=""
    ok "Updated: $from → $target$says. The data as it was before is in $BACKUPS/$backup."
    return 0
  fi

  local log
  log="$STATE/update-$(stamp)-$target.log"
  dc logs --no-color --tail 300 inbox >"$log" 2>&1 || true
  chmod 600 "$log"
  prune "$STATE" '^update-.*\.log$' "$KEEP_LOGS"
  warn "$target did not start. Going back to $from, with the data as it was."
  roll_back "$from" "$backup" "$saved"
  die "Back on $from; nothing was lost. What $target said is in $log. If it had sent anything (an email, a webhook) before it stopped, $from may send it again."
}

# roll_back VERSION BACKUP KIT: that version again, on that backup, with that kit.
roll_back() {
  stage_database "$INSIDE/backups/$2" || die "Could not copy $BACKUPS/$2 into place. sudo inbox logs says why."
  stop_inbox
  if [ -d "$3" ]; then install_kit "$3"; fi
  swap_database || die "Could not put $BACKUPS/$2 in place. sudo inbox logs says why."
  env_set INBOX_VERSION "$1"
  start_inbox
  caddy_up || true
  wait_healthy 180 || die "$1 does not answer either. sudo inbox logs says why; the backup is $BACKUPS/$2."
}

cmd_rollback() {
  need_install
  for arg in "$@"; do case "$arg" in --yes) YES=1 ;; *) die "inbox rollback takes no '$arg'" ;; esac done
  lock
  [ -f "$STATE/last-update" ] || die "There is no update to roll back."
  local version backup kit
  version=$(sed -n 's/^version=//p' "$STATE/last-update")
  backup=$(sed -n 's/^backup=//p' "$STATE/last-update")
  kit=$(sed -n 's/^kit=//p' "$STATE/last-update")
  [ -f "$BACKUPS/$backup" ] || die "The backup made before the last update ($backup) is gone."
  say "This goes back to $version, with the data as it was before the last update. What came in since is lost."
  confirm "Roll back?" || die "Nothing changed."
  local safety
  safety="inbox-$(stamp)-before-rollback.db"
  make_backup "$safety" || die "The backup of the inbox as it is now failed, so nothing changed."
  roll_back "$version" "$backup" "$kit"
  rm -f "$STATE/last-update"
  prune "$BACKUPS" '^inbox-.*-before-rollback\.db$' "$KEEP_SAFETY_BACKUPS"
  ok "Back on $version. The inbox as it was just now is in $BACKUPS/$safety."
}

# --- looking ----------------------------------------------------------------------------------------

cmd_status() {
  need_install
  local domain health version latest newest count
  domain=$(env_get INBOX_DOMAIN)
  say "${B}Surfing Dog Inbox${N}  https://$domain"
  if health=$(healthz); then
    version=$(printf '%s' "$health" | version_of)
    ok "Running $version (image $(image)), and its database answers."
  else
    warn "It does not answer. sudo inbox logs says why."
  fi
  latest=$(latest_version)
  if [ -n "$latest" ] && [ -n "${version:-}" ] && older "$version" "$latest"; then
    say "  The newest release is $latest: sudo inbox update"
  fi
  say "  Data     $DATA ($(human_size "$DATA"))"
  count=$(find "$BACKUPS" -maxdepth 1 -name 'inbox-*.db' 2>/dev/null | wc -l | tr -d ' ')
  # shellcheck disable=SC2010
  newest=$(ls -1 "$BACKUPS" 2>/dev/null | grep -E '^inbox-.*\.db$' | sort -r | head -n 1)
  if [ "$count" -gt 0 ]; then say "  Backups  $count, the newest $BACKUPS/$newest"; else say "  Backups  none yet: sudo inbox backup"; fi
  if systemctl is-enabled inbox-backup.timer >/dev/null 2>&1; then note "  A backup is made every night, and the last $KEEP_DAILY_BACKUPS are kept."; fi
  if [ -n "$(env_get MAIL_FROM)" ]; then say "  Email    from $(env_get MAIL_FROM)"; else say "  Email    not set up: sudo inbox email"; fi
}

# last_sign_in OWNER: the newest sign-in email for OWNER in the inbox's log, whole. The Node server
# writes it as `mail to <owner>: Sign in to …` with its lines indented when no email service is set
# (the console stands in for one), or as `sign-in email for <owner> written here, not sent: …` when
# there is no address to send from at all.
last_sign_in() {
  dc logs --no-color --no-log-prefix --since 24h inbox 2>/dev/null | awk -v owner="$1" '
    index($0, "mail to " owner ": Sign in to ") == 1 || index($0, "sign-in email for " owner " written here, not sent:") == 1 { buf = $0; grab = 1; next }
    grab { buf = buf "\n" $0; if ($0 ~ /work once, for 15 minutes/) { last = buf; grab = 0 } }
    END { print last }'
}

# ask_sign_in OWNER: the inbox asked for a sign-in email for OWNER, as /login asks for one.
ask_sign_in() {
  dc exec -T inbox node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/auth/magic-link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:process.argv[1]})}).then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))" "$1" >/dev/null 2>&1
}

cmd_sign_in() {
  need_install
  local domain owner block before i pattern
  domain=$(env_get INBOX_DOMAIN)
  owner=$(env_get INBOX_OWNER_EMAIL)
  owner=${owner%%,*}
  if [ -n "$(env_get MAIL_FROM)" ]; then
    say "Email is set up, so sign-in emails go to $owner. Ask for one at https://$domain/login, and look in that inbox (and its spam folder)."
    return 0
  fi
  # With no email set up, a new sign-in email is asked for, and read from the log the inbox writes it to.
  before=$(last_sign_in "$owner")
  block=$before
  if ask_sign_in "$owner"; then
    i=0
    while [ "$i" -lt 10 ]; do
      block=$(last_sign_in "$owner")
      [ "$block" = "$before" ] || break
      sleep 1
      i=$((i + 1))
    done
  fi
  if [ -z "$block" ]; then
    die "No sign-in email came. sudo inbox status says whether the inbox runs; then open https://$domain/login, enter $owner, and run this again."
  fi
  # Only a link to this inbox itself is shown.
  pattern=$(printf '%s' "$domain" | sed 's/\./\\./g')
  printf '%s\n' "$block" | sed -n -e 's/^[[:space:]]*\(Your sign-in code: [0-9]*\)$/\1/p' \
    -e "s#^[[:space:]]*\(https://$pattern/auth/verify?token=[^[:space:]]*\)\$#Or open: \1#p"
  note "It works once, for 15 minutes. Each sign-in email is newer than the one before."
}

cmd_owner_key() {
  need_install
  local name="${1:-cli}"
  case "$name" in *[!A-Za-z0-9._-]*) die "A key's name is letters, digits, dots and dashes." ;; esac
  dc exec -T inbox node /opt/inbox/server.mjs create-owner-key "$name" 2>/dev/null | tail -n 1
  note "Shown once. Keep it like a password; revoke it in Settings → Keys."
}

# node_json SCRIPT: SCRIPT run by the inbox's own Node, with what came on standard input in `input`.
node_json() {
  local js="let input='';process.stdin.on('data',(d)=>{input+=d}).on('end',()=>{$1})"
  if running; then
    dc exec -T inbox node -e "$js"
  else
    dc run --rm --no-deps -T --entrypoint node inbox -e "$js"
  fi
}

# cloudflare_accounts TOKEN: the Cloudflare accounts the token can use, one per line, as <id><TAB><name>.
# The token goes to curl on its standard input, never on a command line another user could read.
cloudflare_accounts() {
  printf 'header = "Authorization: Bearer %s"\n' "$1" |
    curl -fsS --max-time 15 -K - "https://api.cloudflare.com/client/v4/accounts?per_page=50" 2>/dev/null |
    node_json 'const j=JSON.parse(input);for(const a of j.result??[])if(/^[0-9a-f]{32}$/.test(a.id))console.log(a.id+"\t"+String(a.name).replace(/[\t\n]/g," "))' 2>/dev/null
}

# pick_account TOKEN: sets ACCOUNT to the Cloudflare account to send from: the token's only one, the
# one chosen from its accounts, or, when they cannot be read, the ID typed in.
pick_account() {
  local accounts count names
  accounts=$(cloudflare_accounts "$1" || true)
  count=$(printf '%s' "$accounts" | grep -c . || true)
  if [ "$count" = 1 ]; then
    ACCOUNT=$(printf '%s' "$accounts" | cut -f 1)
    say "Account: $(printf '%s' "$accounts" | cut -f 2)"
  elif [ "$count" -gt 1 ]; then
    names=$(printf '%s\n' "$accounts" | cut -f 2)
    local IFS='
'
    set -f
    # shellcheck disable=SC2086  # one name per line
    choose "Which Cloudflare account sends?" $names
    set +f
    ACCOUNT=$(printf '%s\n' "$accounts" | sed -n "${CHOICE}p" | cut -f 1)
  else
    note "Could not list the token's accounts, so its ID is needed: the 32 letters and digits after dash.cloudflare.com/ in the dashboard's address."
    ask "The Cloudflare account ID"
    ACCOUNT=$(printf '%s' "$ANSWER" | tr -d '[:space:]')
  fi
  case "$ACCOUNT" in '' | *[!0-9a-f]*) die "That is not a Cloudflare account ID. Nothing changed." ;; esac
}

cmd_email() {
  need_install
  lock
  local domain from_default provider current from
  domain=$(env_get INBOX_DOMAIN)
  # inbox.example.com sends from inbox@example.com unless the owner says otherwise.
  case "$domain" in *.*.*) from_default="inbox@${domain#*.}" ;; *) from_default="inbox@$domain" ;; esac
  current=$(env_get MAIL_FROM)
  if [ "${1:-}" = --off ]; then
    provider=3
  else
    choose "How does the inbox send email?" \
      "Through Cloudflare Email Service (its domain onboarded there)" \
      "Through Resend (its domain verified there)" \
      "It doesn't: sign-in emails stay in the log (sudo inbox sign-in)"
    provider=$CHOICE
  fi
  case "$provider" in
    1)
      ask "The address it sends from" "${current:-$from_default}"
      from="$ANSWER"
      ask_secret "An API token that can send email (Email Sending: Edit)"
      if [ -z "$from" ] || [ -z "$ANSWER" ]; then die "Both are needed. Nothing changed."; fi
      case "$ANSWER" in *[!A-Za-z0-9_-]*) die "That is not an API token. Nothing changed." ;; esac
      local token="$ANSWER"
      pick_account "$token"
      env_set MAIL_FROM "$from"
      env_set CLOUDFLARE_ACCOUNT_ID "$ACCOUNT"
      env_set CLOUDFLARE_EMAIL_TOKEN "$token"
      env_unset RESEND_API_KEY
      ;;
    2)
      ask "The address it sends from" "${current:-$from_default}"
      from="$ANSWER"
      ask_secret "Your Resend API key"
      if [ -z "$from" ] || [ -z "$ANSWER" ]; then die "Both are needed. Nothing changed."; fi
      env_set MAIL_FROM "$from"
      env_set RESEND_API_KEY "$ANSWER"
      env_unset CLOUDFLARE_ACCOUNT_ID
      env_unset CLOUDFLARE_EMAIL_TOKEN
      ;;
    *)
      env_unset MAIL_FROM
      env_unset RESEND_API_KEY
      env_unset CLOUDFLARE_ACCOUNT_ID
      env_unset CLOUDFLARE_EMAIL_TOKEN
      ;;
  esac
  dc up -d inbox >/dev/null 2>&1
  wait_healthy 120 || die "The inbox does not answer after the change: sudo inbox logs"
  if [ -n "$(env_get MAIL_FROM)" ]; then
    ok "It sends from $(env_get MAIL_FROM). Ask for a sign-in email at https://$domain/login to try it."
  else
    ok "It sends no email. sudo inbox sign-in shows a sign-in email's code and link."
  fi
}

# up: start (or bring in line with the files) and wait until it answers. The installer calls it.
cmd_up() {
  need_install
  lock
  local said
  # Compose's progress lines are noise here; what it says is shown only when it fails.
  if ! said=$(dc up -d 2>&1); then
    printf '%s\n' "$said" >&2
    die "Docker Compose could not start it. Above is what it said."
  fi
  caddy_up || die "Caddy did not start: sudo inbox logs caddy"
  wait_healthy "${1:-180}" || {
    dc logs --no-color --tail 40 inbox >&2 || true
    die "The inbox did not start. Above is what it said; sudo inbox logs shows more."
  }
}

cmd_logs() {
  need_install
  dc logs --tail 200 -f "${1:-inbox}"
}

usage() {
  cat <<EOF
inbox: look after the Surfing Dog Inbox in $INBOX_DIR.

  status              what runs, its version, its health, its backups
  update [version]    the newest release, or that one; undone if it does not start
  rollback            the previous version and its data (what came in since is lost)
  backup              a full copy of the database now, in $BACKUPS
  restore <file>      replace the inbox with that backup (a backup of now is made first)
  sign-in             a sign-in code and link, while email is not set up
  owner-key [name]    a new owner API key, shown once
  email               how the inbox sends email
  logs [caddy]        the inbox's log (or Caddy's), as it is written
  restart             start it again, with the settings in $ENV_FILE
  stop | start

Run each with sudo. Docs: https://surfingdog.ai/docs/run-it-yourself/
EOF
}

main() {
  COMMAND="${1:-help}"
  [ $# -gt 0 ] && shift
  trap on_exit EXIT
  trap 'exit 130' INT TERM HUP
  case "$COMMAND" in
    status) cmd_status ;;
    update | upgrade) cmd_update "$@" ;;
    rollback) cmd_rollback "$@" ;;
    backup) cmd_backup "$@" ;;
    restore) cmd_restore "$@" ;;
    sign-in | signin | login) cmd_sign_in ;;
    owner-key | key) cmd_owner_key "$@" ;;
    email | mail) cmd_email "$@" ;;
    logs | log) cmd_logs "$@" ;;
    up) cmd_up "$@" ;;
    restart)
      need_install
      lock
      dc up -d --force-recreate inbox >/dev/null 2>&1
      wait_healthy 120 || die "It does not answer after the restart: sudo inbox logs"
      ok "Restarted, with the settings in $ENV_FILE."
      ;;
    stop)
      need_install
      lock
      dc stop >/dev/null
      ok "Stopped. sudo inbox start starts it again."
      ;;
    start)
      cmd_up
      ok "Running."
      ;;
    version | --version | -v)
      need_install
      say "$(image) $(healthz | version_of)"
      ;;
    help | --help | -h) usage ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

# Tests source this file with SDI_INBOX_LIB=1 to call its functions one by one.
if [ "${SDI_INBOX_LIB:-}" != 1 ]; then main "$@"; fi
SDI_KIT_EOF
  sed -e "s#^INBOX_DIR=\"\${INBOX_DIR:-/opt/inbox}\"#INBOX_DIR=\"\${INBOX_DIR:-$DIR}\"#" \
    -e "s#^INBOX_BIN=\"\${INBOX_BIN:-/usr/local/bin/inbox}\"#INBOX_BIN=\"\${INBOX_BIN:-$BIN_DIR/inbox}\"#" \
    "$BIN_DIR/inbox.kit" >"$BIN_DIR/inbox.new"
  rm -f "$BIN_DIR/inbox.kit"
  grep -q "^INBOX_DIR=\"\${INBOX_DIR:-$DIR}\"\$" "$BIN_DIR/inbox.new" || die "Could not write $BIN_DIR/inbox."
  chmod 755 "$BIN_DIR/inbox.new"
  mv "$BIN_DIR/inbox.new" "$BIN_DIR/inbox"
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
  install -d -m 755 "$DIR" "$DIR/probe"
  # data is the inbox's (uid 10001); state is root's own (the `inbox` command's notes and update
  # logs), apart from data, so nothing the inbox's container could write is ever written as root.
  install -d -m 700 "$DIR/data" "$DIR/state" "$DIR/caddy"
  install -d -m 700 "$DIR/caddy/data" "$DIR/caddy/config"
  chown -h "$INBOX_UID:$INBOX_UID" "$DIR/data"
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

# The first sign-in, while email is not set up: the inbox is asked for the owner's sign-in email,
# as /login would, and its link and code are read from where it wrote them.
sign_in_lines() {
  local out code link
  [ "$HTTPS" = 1 ] || return 1
  out=$(INBOX_DIR="$DIR" "$BIN_DIR/inbox" sign-in 2>/dev/null) || return 1
  code=$(printf '%s\n' "$out" | sed -n 's/^Your sign-in code: //p' | tail -n 1)
  link=$(printf '%s\n' "$out" | sed -n 's/^Or open: //p' | tail -n 1)
  [ -n "$code" ] && [ -n "$link" ] || return 1
  say "  1. Sign in. It works once, for 15 minutes:"
  say "       $link"
  say "     or the code $code at https://$DOMAIN/login. sudo inbox sign-in gives a new one later."
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
  if [ -z "$(env_get MAIL_FROM)" ]; then
    sign_in_lines || {
      say "  1. Sign in. Open https://$DOMAIN/login and enter $EMAIL. Email is not set up yet, so the"
      say "     sign-in email stays on this server, and this shows its code and link:"
      say "       sudo inbox sign-in"
    }
    say "  2. Set up email, so the inbox can send sign-in links and replies:"
    say "       sudo inbox email"
  else
    say "  1. Sign in. Open https://$DOMAIN/login and enter $EMAIL."
    say "  2. Email goes out from $(env_get MAIL_FROM)."
  fi
  say "  3. Let your AI set up the rest (email in, your business, your site). Give it this line:"
  say "       My Surfing Dog Inbox is installed at https://$DOMAIN with the one-command installer. Follow https://surfingdog.ai/install.md from Step 1, and ask me before anything that costs money or changes DNS."
  say ""
  say "Your data is in $DIR/data, backed up every night to $DIR/data/backups."
  say "Keep a copy of the inbox's secret key apart from this server (sudo grep INBOX_SECRET_KEY $DIR/.env shows it): it opens the data."
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
  case "$DIR" in *[!A-Za-z0-9/._-]*) die "--dir is letters, digits, / . _ and -, like /opt/inbox." ;; esac
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
  # What can be checked without Docker is checked before Docker is installed.
  step "The address"
  check_ports
  check_dns_local
  resolve_version
  step "Docker"
  ensure_docker
  load_image
  check_dns_remote
  step "Installing"
  write_files
  pull_images
  start
  if [ -n "$WANT_VERSION" ]; then
    step "Updating to $WANT_VERSION"
    INBOX_DIR="$DIR" "$BIN_DIR/inbox" update "$WANT_VERSION" --yes
    VERSION=$WANT_VERSION
  fi
  summary
}

# Tests source this file with SDI_INSTALL_LIB=1 to call its functions one by one.
if [ "${SDI_INSTALL_LIB:-}" != 1 ]; then main "$@"; fi
