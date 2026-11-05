#!/usr/bin/env bash
# On a Node checkNodeVersion is written to reject, such as 20.11 (Docker's node:20.11.1), `one build` and `one dev` should
# stop with its "One requires Node" line. Both fail loading modules that import `styleText` from node:util first, and
# the check parses `v20` as NaN. repro/ installs one from npm at the versions repro/bun.lock pins; set `one` in
# repro/package.json to try another release.
# Exits 1 while either command ends without a "One requires Node" line, 0 once both print it, and 2 when a setup step
# fails or the Node on PATH is one the check accepts.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")"
node_version=$(node -p 'process.versions.node')
IFS=. read -r major minor _ <<< "$node_version"
if [ "$major" -gt 20 ] || { [ "$major" -eq 20 ] && [ "$minor" -ge 12 ]; }; then
  echo "node $node_version is one checkNodeVersion accepts; run this on Node 20.11, as Docker's node:20.11.1 image has it" >&2
  exit 2
fi
bun install
mkdir -p tmp
export NO_COLOR=1
one_version=$(node -p "require('one/package.json').version")
rolldown_version=$(node -p "require('rolldown/package.json').version")

# Prints how a command ended: its exit code, its first error or One's version line, and the files its stack names.
report() {
  echo "exit code: $1"
  grep -m1 -E 'One requires Node|does not provide an export|Error' "$2" | sed 's/^ *//' || true
  grep -o -E '(node_modules/(one|rolldown)/[^ )]+:[0-9]+)' "$2" | head -3 | sed 's/^/at /' || true
}

summary=("node $node_version, one $one_version, rolldown $rolldown_version")
status=0
bunx one build > tmp/build.log 2>&1 || status=$?
summary+=("\$ one build" "$(report "$status" tmp/build.log)")

bunx one dev --port 8201 > tmp/dev.log 2>&1 &
server=$!
trap 'kill "$server" 2> /dev/null || true' EXIT
dev_status="none, running after 30 s"
for attempt in $(seq 1 30); do
  if ! kill -0 "$server" 2> /dev/null; then
    dev_status=0
    wait "$server" || dev_status=$?
    break
  fi
  sleep 1
done
summary+=("\$ one dev --port 8201" "$(report "$dev_status" tmp/dev.log)")

echo
printf '%s\n' "${summary[@]}"
grep -q 'One requires Node' tmp/build.log && grep -q 'One requires Node' tmp/dev.log && exit 0
exit 1
