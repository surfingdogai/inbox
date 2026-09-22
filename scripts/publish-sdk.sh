#!/usr/bin/env bash
# Publish @surfingdog/sdk to npm, by hand.
#
# The normal path is not this script. It is the release-sdk workflow in .github/workflows, which
# publishes from CI with no token anywhere when a tag `sdk-v<version>` is pushed. This script is
# the fallback for a machine with npm signed in, and for the very first publish, which has to
# exist before npmjs.com will let the repository be authorised as its trusted publisher.
#
#   ~/surfingdog-inbox/scripts/publish-sdk.sh          # asks for the token, then publishes
#   ~/surfingdog-inbox/scripts/publish-sdk.sh --dry    # everything except the publish
#
# NODE_AUTH_TOKEN may be set in the environment instead, for CI. Do not put it on the command
# line: a placeholder in angle brackets is shell redirection, and a real one lands in history.
#
# The token is read from the environment and never written to disk: the .npmrc this script
# creates contains the literal string ${NODE_AUTH_TOKEN}, which npm expands in memory, and the
# file is removed on exit whichever way the script ends. Nothing here stores, logs or echoes the
# token, and it is not passed on a command line where `ps` would show it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/packages/sdk"
DRY=""; NOW=""
for arg in "$@"; do
  case "$arg" in
    --dry) DRY="--dry" ;;
    --now) NOW="1" ;;
    *) die "unknown option: $arg (use --dry or --now)" ;;
  esac
done

say() { printf '\033[1;36m→\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# Who we are, before anything slow runs. An `npm login` already in place is used as it stands;
# otherwise the token is asked for. It is never taken on the command line: a placeholder in
# angle brackets is shell redirection, so `NODE_AUTH_TOKEN=<your token> ...` fails before the
# script starts, and a real one typed there lands in shell history and is visible to `ps`.
NPMRC=""
cleanup() { [ -n "$NPMRC" ] && rm -f "$NPMRC"; }
trap cleanup EXIT INT TERM

whoami_now() { (cd "$PKG" && npm whoami 2>/dev/null) || true; }

WHO="$(whoami_now)"
if [ -z "$WHO" ] && [ -z "${NODE_AUTH_TOKEN:-}" ]; then
  say "not signed in to npm."
  printf 'npm token (input hidden, from npmjs.com → Access Tokens): '
  read -rs NODE_AUTH_TOKEN
  echo
  export NODE_AUTH_TOKEN
fi

if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
  # The file holds the placeholder; npm expands it from the environment. The token never lands
  # on disk, and the file goes on every exit path.
  NPMRC="$PKG/.npmrc"
  printf '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n' > "$NPMRC"
  WHO="$(whoami_now)"
fi

# Fail on the credential now rather than after a minute of tests.
[ -n "$WHO" ] || die "npm does not accept that token. Generate a fresh one at npmjs.com → Access Tokens (Classic → Automation, or Granular with publish rights on @surfingdog)."
ok "signed in to npm as $WHO"

cd "$ROOT"
VERSION="$(node -p "require('$PKG/package.json').version")"
NAME="$(node -p "require('$PKG/package.json').name")"

say "checks before anything is sent…"
git diff --quiet && git diff --cached --quiet || die "the working tree is dirty; commit first so the tag matches what ships"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "on branch $BRANCH; publish from main"

# The version in the source must match the manifest, or a consumer reading SDK_VERSION is lied to.
SRC_VERSION="$(grep -oE 'SDK_VERSION = "[^"]+"' "$PKG/src/index.ts" | grep -oE '[0-9][^"]*')"
[ "$SRC_VERSION" = "$VERSION" ] || die "package.json says $VERSION but SDK_VERSION says $SRC_VERSION"

if curl -sf -o /dev/null "https://registry.npmjs.org/$(node -p "encodeURIComponent('$NAME')")/$VERSION"; then
  die "$NAME@$VERSION is already published; bump the version in packages/sdk/package.json and src/index.ts"
fi

if [ -n "$NOW" ]; then
  say "--now: skipping typecheck, tests and lint (CI is green for this commit)"
else
  say "typecheck, tests on both runtimes, lint…"
  pnpm typecheck >/dev/null
  pnpm test:node >/dev/null
  pnpm test:workers >/dev/null
  pnpm exec biome check packages apps/inbox >/dev/null
  ok "green"
fi

say "build…"
pnpm --filter "$NAME" build >/dev/null
[ -f "$PKG/dist/index.js" ] && [ -f "$PKG/dist/index.d.ts" ] || die "dist is missing after the build"

say "what would ship:"
(cd "$PKG" && npm pack --dry-run 2>&1 | sed -n '/Tarball Contents/,/Tarball Details/p' | head -30)

if [ "$DRY" = "--dry" ]; then
  ok "dry run only; nothing was published"
  exit 0
fi

# An account with two-factor on must present a one-time code at publish time as well as at
# login; without it npm answers 403 "Two-factor authentication ... is required to publish".
# The code is asked for last, right before the publish, because it is only good for thirty
# seconds and the tests take longer than that. A token in the environment does not need one.
# One prompt takes either answer: a six-digit code from an authenticator, or a granular token
# with "bypass two-factor" ticked. The input is shown, not hidden: hiding it meant a paste that
# went wrong could not be seen, and the whole run was lost. The token is dug out of whatever was
# pasted, so a whole "export NODE_AUTH_TOKEN=npm_..." line works too. Three attempts before
# giving up, because the tests before this point took longer than a retry deserves.
OTP=""
if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
  attempt=0
  while [ -z "$OTP" ] && [ -z "${NODE_AUTH_TOKEN:-}" ]; do
    attempt=$((attempt + 1))
    printf 'paste your npm token (npm_...) or a six-digit code: '
    read -r ANSWER
    TOKEN_IN="$(printf '%s' "$ANSWER" | grep -oE 'npm_[A-Za-z0-9_-]{20,}' | head -n1 || true)"
    CODE_IN="$(printf '%s' "$ANSWER" | grep -oE '(^|[^0-9])[0-9]{6}([^0-9]|$)' | grep -oE '[0-9]{6}' | head -n1 || true)"
    if [ -n "$TOKEN_IN" ]; then
      export NODE_AUTH_TOKEN="$TOKEN_IN"
      NPMRC="$PKG/.npmrc"
      printf '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n' > "$NPMRC"
      WHO="$(whoami_now)"
      if [ -n "$WHO" ]; then
        ok "token accepted (${TOKEN_IN:0:8}…${TOKEN_IN: -4}, ${#TOKEN_IN} chars), publishing as $WHO"
      else
        no "npm rejected that token (${TOKEN_IN:0:8}…${TOKEN_IN: -4}, ${#TOKEN_IN} chars)"
        unset NODE_AUTH_TOKEN; rm -f "$NPMRC"; NPMRC=""
      fi
    elif [ -n "$CODE_IN" ]; then
      OTP="$CODE_IN"
      ok "code accepted"
    else
      no "I got ${#ANSWER} characters and none of it looks like npm_… or six digits: '$(printf '%s' "$ANSWER" | cut -c1-40)'"
    fi
    [ -n "$OTP" ] || [ -n "${NODE_AUTH_TOKEN:-}" ] || [ "$attempt" -lt 3 ] || die "three tries; nothing was published"
  done
fi

say "publishing $NAME@$VERSION as ${WHO}..."
if [ -n "$OTP" ]; then
  (cd "$PKG" && npm publish --access public --otp="$OTP")
else
  (cd "$PKG" && npm publish --access public)
fi
ok "published: https://www.npmjs.com/package/$NAME"
echo
echo "Next: the webhooks docs page can lead with"
echo "  npm install $NAME"
