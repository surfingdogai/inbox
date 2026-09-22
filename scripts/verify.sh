#!/usr/bin/env bash
# Everything CI runs, in the order CI runs it, failing on the first thing that fails.
#
#   ./scripts/verify.sh
#
# This exists because checking by eye does not work: a `biome check | tail -1` showed the
# reassuring summary line while an error sat above it, and a commit went to main red. Exit codes
# do not have that problem.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
step() { printf '\033[1;36m→\033[0m %s\n' "$*"; }
step "types for the worker bindings"; pnpm --filter @surfingdog/inbox types >/dev/null
step "lint and format, whole repo"; pnpm check
step "typecheck"; pnpm typecheck >/dev/null
step "client build"; pnpm --filter @surfingdog/inbox build:client >/dev/null
step "sdk build"; pnpm --filter @surfingdog/sdk build >/dev/null
step "tests on node"; pnpm test:node 2>&1 | grep -E "Test Files|Tests "
step "tests on workers"; pnpm test:workers 2>&1 | grep -E "Test Files|Tests "
step "kit"; pnpm kit >/dev/null
printf '\033[1;32m✓\033[0m green, the same way CI is green\n'
