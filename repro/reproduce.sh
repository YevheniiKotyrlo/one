#!/usr/bin/env bash
# On a Node checkNodeVersion is written to reject, such as 20.11 (Docker's node:20.11.1), `one build` and `one dev` should
# stop with its "One requires Node" line, naming a Node above the one running. Both fail loading modules that import
# `styleText` from node:util first, the check parses `v20` as NaN, and its line names 20.11, the Node it refuses.
# repro/run-in-docker.sh runs it in Docker's node:20.11.1 image. repro/ installs one from npm at the versions
# repro/bun.lock pins; set `one` in repro/package.json to try another release.
# Exits 1 while either command ends without One's line naming a Node above the one running, 0 once both print it, and 2
# when a setup step fails, timeout is missing or the Node on PATH is one the check accepts.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")"
node_version=$(node -p 'process.versions.node')
IFS=. read -r major minor _ <<< "$node_version"
if [ "$major" -gt 20 ] || { [ "$major" -eq 20 ] && [ "$minor" -ge 12 ]; }; then
  echo "node $node_version is one checkNodeVersion accepts; run this on Node 20.11, as repro/run-in-docker.sh does" >&2
  exit 2
fi
command -v timeout > /dev/null || { echo "this needs timeout, from GNU coreutils, as repro/run-in-docker.sh has it" >&2; exit 2; }
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

# Succeeds where a log holds One's line and the first version on it is above the Node running.
refuses_this_node() {
  local line
  line=$(grep -m1 -o 'One requires Node.*' "$1") || return 1
  node -e '
    const [line, running] = process.argv.slice(1)
    const named = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(line)
    if (named === null) process.exit(1)
    const required = named.slice(1).map((part) => Number(part ?? 0))
    const current = running.split(".").map(Number)
    const difference = required.map((part, index) => part - current[index]).find((part) => part !== 0) ?? 0
    process.exit(difference > 0 ? 0 : 1)
  ' "$line" "$node_version"
}

summary=("node $node_version, one $one_version, rolldown $rolldown_version")
build_status=0
bunx one build > tmp/build.log 2>&1 || build_status=$?
summary+=("\$ one build" "$(report "$build_status" tmp/build.log)")

dev_status=0
timeout 30 bunx one dev --port 8201 > tmp/dev.log 2>&1 || dev_status=$?
[ "$dev_status" != 124 ] || dev_status="none, running after 30 s"
summary+=("\$ one dev --port 8201" "$(report "$dev_status" tmp/dev.log)")

echo
printf '%s\n' "${summary[@]}"
refuses_this_node tmp/build.log && refuses_this_node tmp/dev.log && exit 0
exit 1
