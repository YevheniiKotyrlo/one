#!/usr/bin/env bash
# With Node 26.11 or later on PATH, `one serve` answers the request for the root route's loader module with 500.
# Exits 1 while it does, 0 once it does not, and 2 when a setup step fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
bun install
bun run build
cd repro
mkdir -p tmp
NO_COLOR=1 bunx one build 2>&1 | tee tmp/build.log

port=3123
get() { curl -s --max-time 10 -o tmp/response.txt -w '%{http_code}' "http://localhost:$port$1" || true; }
if [ "$(get /)" != 000 ]; then echo "port $port is in use" >&2; exit 2; fi
node ../packages/one/run.mjs serve --port "$port" > tmp/serve.log 2>&1 &
server=$!
trap 'kill "$server" 2> /dev/null || true' EXIT
for attempt in $(seq 1 60); do
  kill -0 "$server" 2> /dev/null || { cat tmp/serve.log; echo "one serve exited" >&2; exit 2; }
  [ "$(get /)" = 200 ] && break
  sleep 1
done
[ "$(get /)" = 200 ] || { cat tmp/serve.log; echo "one serve does not answer / with 200" >&2; exit 2; }

key=$(node -p "require('./dist/buildInfo.json').constants.CACHE_KEY")
loader="/assets/_${key}_vxrn_loader.js"
loader_status=$(get "$loader")
echo
echo "node $(node --version), undici $(node -p 'process.versions.undici')"
echo "GET / -> $(get /)"
echo "GET $loader -> $loader_status"
grep -m1 -A6 TypeError tmp/serve.log || true
[ "$loader_status" != 500 ] || exit 1
