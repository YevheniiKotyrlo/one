#!/usr/bin/env bash
# `one` is an ES module package ("type": "module"), so under moduleResolution node16 or nodenext TypeScript needs each
# relative import in its declarations to name its file extension, and they name none. The script builds the workspace,
# installs repro/ in a folder outside it from the workspace's packed packages (use-workspace-packages.mjs), and
# type-checks vite.config.ts there with tsconfig.nodenext.json (module and moduleResolution NodeNext, Node's types). It
# prints how many of one's declaration files the program reads, the errors tsc reports for relative imports without an
# extension in them (TS2834, TS2835), and how many other errors it reports in one's declarations.
# Exits 1 while tsc reports a relative import without an extension in one's declarations; 0 once it reports none; 2 when
# a step before the check fails, tsc cannot check the program, the program reads none of one's declarations, or
# vite.config.ts fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
platform=$(uname -sr)
node_version=$(node --version)
bun_version=$(bun --version)
cd "$(dirname "$0")/.."
revision=$(git rev-parse --short HEAD)
echo "$platform, node $node_version, bun $bun_version, one checkout at $revision"
bun install
bun run build
workspace=$(mktemp -d "${TMPDIR:-/tmp}/nodenext.XXXXXX")
# Node and bun on Windows take the folder as Windows names it.
if command -v cygpath > /dev/null; then workspace=$(cygpath -m "$workspace"); fi
exit_status=0
trap 'exit_status=$?; set +e; trap - ERR; rm -rf "$workspace" 2> /dev/null; exit "$exit_status"' EXIT
app=$workspace/app
mkdir "$app"
tar -C repro --exclude=./node_modules --exclude=./tmp --exclude=./android --exclude=./ios --exclude=./yarn.lock -cf - . \
  | tar -C "$app" -xf -
node repro/use-workspace-packages.mjs "$app"
cd "$app"
bun install
typescript_version=$(./node_modules/.bin/tsc --version | tr -d '\r')

tsc_status=0
./node_modules/.bin/tsc -p tsconfig.nodenext.json --pretty false 2>&1 | tr -d '\r' > "$workspace/diagnostics" \
  || tsc_status=$?
if [ "$tsc_status" -gt 2 ] || grep -qE 'error TS(5|6)[0-9]{3}' "$workspace/diagnostics"; then
  cat "$workspace/diagnostics"
  echo "tsc cannot check tsconfig.nodenext.json (exit $tsc_status)"
  exit 2
fi
./node_modules/.bin/tsc -p tsconfig.nodenext.json --listFilesOnly | tr -d '\r' > "$workspace/files"
one_files=$(grep -c '/node_modules/one/' "$workspace/files" || true)
config_errors=$(grep -E '^vite\.config\.ts\([0-9]+,[0-9]+\): error TS' "$workspace/diagnostics" || true)
one_errors=$(grep -E '^node_modules/one/[^(]*\([0-9]+,[0-9]+\): error TS' "$workspace/diagnostics" || true)
extension_errors=$(printf '%s' "$one_errors" | grep -E ': error TS283[45]: ' || true)
extension_count=$(printf '%s' "$extension_errors" | grep -c . || true)
other_count=$(printf '%s' "$one_errors" | grep -vcE ': error TS283[45]: ' || true)

echo
echo "$typescript_version"
echo "\$ tsc -p tsconfig.nodenext.json   (vite.config.ts, module and moduleResolution NodeNext)"
echo "one's declaration files it reads: $one_files"
echo "relative imports without an extension in one's declarations: $extension_count"
[ -z "$extension_errors" ] || printf '%s\n' "$extension_errors"
echo "other errors in one's declarations: $other_count"
[ -z "$config_errors" ] || printf '%s\n' "$config_errors"

if [ "$one_files" -eq 0 ]; then
  echo "the program reads none of one's declarations"
  exit 2
fi
if [ -n "$config_errors" ]; then
  echo "vite.config.ts fails"
  exit 2
fi
if [ "$extension_count" -eq 0 ]; then
  echo "one's declarations import no relative path without an extension under nodenext"
  exit 0
fi
echo "one's declarations import $extension_count relative paths without an extension, which nodenext cannot resolve"
exit 1
