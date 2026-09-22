#!/usr/bin/env bash
# Publish @surfingdog/sdk to npm.
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
DRY="${1:-}"

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

say "typecheck, tests on both runtimes, lint…"
pnpm typecheck >/dev/null
pnpm test:node >/dev/null
pnpm test:workers >/dev/null
pnpm exec biome check packages apps/inbox >/dev/null
ok "green"

say "build…"
pnpm --filter "$NAME" build >/dev/null
[ -f "$PKG/dist/index.js" ] && [ -f "$PKG/dist/index.d.ts" ] || die "dist is missing after the build"

say "what would ship:"
(cd "$PKG" && npm pack --dry-run 2>&1 | sed -n '/Tarball Contents/,/Tarball Details/p' | head -30)

if [ "$DRY" = "--dry" ]; then
  ok "dry run only; nothing was published"
  exit 0
fi

say "publishing $NAME@$VERSION as $WHO…"
(cd "$PKG" && npm publish --access public)
ok "published: https://www.npmjs.com/package/$NAME"
echo
echo "Next: the webhooks docs page can lead with"
echo "  npm install $NAME"
