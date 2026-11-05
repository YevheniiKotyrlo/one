#!/usr/bin/env bash
# Run from the repository root with Node 26.11 or later on PATH.
set -u
bun install
[ -d packages/one/dist/esm ] || bun run build
cd repro
mkdir -p tmp
echo "node $(node --version), undici $(node -p 'process.versions.undici')"
bunx one build > tmp/build.log 2>&1
echo "one build exit code: $?"
node ../packages/one/run.mjs serve --port 3123 > tmp/serve.log 2>&1 &
server=$!
status() { curl -s -o tmp/curl-response.txt -w '%{http_code}' "http://localhost:3123$1"; }
for attempt in $(seq 1 60); do [ "$(status /)" = 200 ] && break; sleep 1; done
echo "GET / -> $(status /)"
echo "GET /assets/_1_vxrn_loader.js (the loader request a client navigation to / sends) -> $(status /assets/_1_vxrn_loader.js)"
kill "$server"
grep -m1 -A6 TypeError tmp/serve.log || echo "tmp/serve.log holds no TypeError"
