#!/usr/bin/env bash
# Native bundling leaves Rolldown's own output, dist/__virtual-native-entry.js, beside what One writes to build.outDir
# (out/ in this app): `one build --platform android` does, and so does `one dev` when it bundles for Android.
# The Android build also prints the MODULE_LEVEL_DIRECTIVE warnings that the web build filters out.
# Exits 1 while dist/ is written, 0 once it is not, and 2 when a setup step fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
bun install
bun run build
cd repro
rm -rf dist out tmp
mkdir -p tmp

listing() { if [ -d "$1" ]; then echo "$1/: $(ls "$1" | tr '\n' ' ')"; else echo "$1/: missing"; fi; }
directive_warnings() { grep -c '\[MODULE_LEVEL_DIRECTIVE\]' "$1" || true; }
written=0
summary=()

NO_COLOR=1 bunx one build 2>&1 | tee tmp/build-web.log
NO_COLOR=1 bunx one build --platform android 2>&1 | tee tmp/build-android.log
summary+=('$ one build --platform android')
summary+=("$(listing out)")
summary+=("$(listing dist)")
if [ -f dist/__virtual-native-entry.js ]; then
  written=1
  summary+=("$(node -e '
const { readFileSync } = require("node:fs")
const bundle = readFileSync("out/android.js")
const entry = readFileSync("dist/__virtual-native-entry.js")
console.log(`out/android.js ${bundle.length} bytes, dist/__virtual-native-entry.js ${entry.length} bytes, identical: ${bundle.equals(entry)}`)
')")
fi
summary+=("[MODULE_LEVEL_DIRECTIVE] warnings: one build $(directive_warnings tmp/build-web.log), one build --platform android $(directive_warnings tmp/build-android.log)")

rm -rf dist
port=8123
get() { curl -s --max-time "$2" -o "$3" -w '%{http_code}' "http://localhost:$port$1" || true; }
if [ "$(get / 5 tmp/response.txt)" != 000 ]; then echo "port $port is in use" >&2; exit 2; fi
[ -f app/routes.d.ts ] && route_types=kept || route_types=generated
NO_COLOR=1 bunx one dev --port "$port" > tmp/dev.log 2>&1 &
server=$!
trap 'kill "$server" 2> /dev/null || true; [ "$route_types" = kept ] || rm -f app/routes.d.ts' EXIT
for attempt in $(seq 1 120); do
  kill -0 "$server" 2> /dev/null || { cat tmp/dev.log; echo "one dev exited" >&2; exit 2; }
  [ "$(get / 30 tmp/response.txt)" != 000 ] && break
  sleep 1
done
bundle=/index.bundle?platform=android
summary+=("\$ one dev, then GET $bundle -> $(get "$bundle" 600 tmp/android-dev.bundle)")
summary+=("$(listing dist)")
[ -f dist/__virtual-native-entry.js ] && written=1

echo
printf '%s\n' "${summary[@]}"
[ "$written" = 0 ] || exit 1
