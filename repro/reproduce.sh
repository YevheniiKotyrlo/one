#!/usr/bin/env bash
# Run from the repository root with Node 26.11 or later on PATH.
set -u
bun install
[ -d packages/one/dist/esm ] || bun run build
cd repro
echo "node $(node --version), undici $(node -p 'process.versions.undici')"
bunx one build > build.log 2>&1
echo "one build exit code: $?"
node ../packages/one/run.mjs serve --port 3123 > serve.log 2>&1 &
server=$!
status() { curl -s -o curl-response.txt -w '%{http_code}' "http://localhost:3123$1"; }
for attempt in $(seq 1 60); do [ "$(status /)" = 200 ] && break; sleep 1; done
echo "GET / -> $(status /)"
echo "GET /assets/index_1_vxrn_loader.js (the loader a client navigation to / fetches) -> $(status /assets/index_1_vxrn_loader.js)"
kill "$server"
grep -m1 -A6 'TypeError' serve.log
