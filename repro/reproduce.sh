#!/usr/bin/env bash
# `one build` prints Rolldown's INVALID_OPTION warning for the client build's `codeSplitting.minSize`, which has no `groups`.
# Exits 1 while it does, 0 once it does not, and 2 when a setup step fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
bun install
bun run build
cd repro
mkdir -p tmp
NO_COLOR=1 bunx one build 2>&1 | tee tmp/build.log

echo
node -p "'vite ' + require('vite/package.json').version + ', rolldown ' + require(require.resolve('rolldown/package.json', { paths: [require.resolve('vite')] })).version"
echo 'INVALID_OPTION lines in the output of one build:'
grep INVALID_OPTION tmp/build.log | sed $'s/\033\\[[0-9;]*m//g' || exit 0
exit 1
