#!/usr/bin/env bash
# With Node 20.11 on PATH (Docker's node:20.11.1), `one build` should stop with checkNodeVersion's "One requires Node"
# line. It fails loading its build module instead, and the check, which parses `v20` as NaN, never prints.
# repro/ installs one from npm, as a new app does, at the versions repro/bun.lock pins.
# Exits 1 while `one build` fails without a "One requires Node" line, 0 once it prints one or succeeds, and 2 when a
# setup step fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")"
bun install
mkdir -p tmp
status=0
NO_COLOR=1 bunx one build > tmp/build.log 2>&1 || status=$?
version() { node -p "require('$1/package.json').version"; }
echo
echo "node $(node --version), one $(version one), vite $(version vite), rolldown $(version rolldown) (engines.node $(node -p "require('rolldown/package.json').engines.node"))"
echo "\$ one build"
echo "exit code: $status"
grep -m1 -E 'One requires Node|ERROR' tmp/build.log || true
[ "$status" != 0 ] || exit 0
grep -q 'One requires Node' tmp/build.log && exit 0
exit 1
