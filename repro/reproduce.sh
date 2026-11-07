#!/usr/bin/env bash
# Native bundling leaves Rolldown's own output, dist/__virtual-native-entry.js, beside what One writes to build.outDir
# (out/ in this app): `one build --platform android` does, and so does `one dev` when it bundles for Android.
# The Android build also prints the MODULE_LEVEL_DIRECTIVE warnings that the web build filters out.
# Exits 1 while dist/ is written or the Android build prints those warnings, 0 once neither happens, and 2 when a
# setup step fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
bun install
bun run build
cd repro
rm -rf dist out tmp
mkdir -p tmp

listing() {
  local entries='' entry
  if [ ! -d "$1" ]; then
    echo "$1/: missing"
    return
  fi
  for entry in "$1"/*; do
    if [ -e "$entry" ]; then entries+="${entry##*/} "; fi
  done
  echo "$1/: $entries"
}
directive_warnings() { grep -c '\[MODULE_LEVEL_DIRECTIVE\]' "$1" || true; }
written=0
summary=()

NO_COLOR=1 bunx one build 2>&1 | tee tmp/build-web.log
NO_COLOR=1 bunx one build --platform android 2>&1 | tee tmp/build-android.log
summary+=('$ one build --platform android')
out_listing=$(listing out)
dist_listing=$(listing dist)
summary+=("$out_listing" "$dist_listing")
if [ -f dist/__virtual-native-entry.js ]; then
  written=1
  comparison=$(node - << 'JS'
const { readFileSync } = require("node:fs")
const bundle = readFileSync("out/android.js")
const entry = readFileSync("dist/__virtual-native-entry.js")
console.log(`out/android.js ${bundle.length} bytes, dist/__virtual-native-entry.js ${entry.length} bytes, identical: ${bundle.equals(entry)}`)
JS
  )
  summary+=("$comparison")
fi
web_warnings=$(directive_warnings tmp/build-web.log)
android_warnings=$(directive_warnings tmp/build-android.log)
summary+=("[MODULE_LEVEL_DIRECTIVE] warnings: one build $web_warnings, one build --platform android $android_warnings")

rm -rf dist
port=8123
get() { curl -s --max-time "$2" -o "$3" -w '%{http_code}' "http://localhost:$port$1" || true; }
answer=$(get / 5 tmp/response.txt)
if [ "$answer" != 000 ]; then echo "port $port is in use" >&2; exit 2; fi
[ -f app/routes.d.ts ] && route_types=kept || route_types=generated
NO_COLOR=1 bunx one dev --port "$port" > tmp/dev.log 2>&1 &
server=$!
trap 'kill "$server" 2> /dev/null || true; [ "$route_types" = kept ] || rm -f app/routes.d.ts' EXIT
for ((second = 0; second < 120; second++)); do
  if ! kill -0 "$server" 2> /dev/null; then
    cat tmp/dev.log
    echo "one dev exited" >&2
    exit 2
  fi
  answer=$(get / 30 tmp/response.txt)
  [ "$answer" = 000 ] || break
  sleep 1
done
answer=$(get / 30 tmp/response.txt)
[ "$answer" != 000 ] || { cat tmp/dev.log; echo "one dev does not answer on port $port" >&2; exit 2; }
bundle='/index.bundle?platform=android'
bundle_status=$(get "$bundle" 600 tmp/android-dev.bundle)
summary+=("\$ one dev, then GET $bundle -> $bundle_status")
[ "$bundle_status" = 200 ] || { cat tmp/dev.log; echo "the Android bundle request answered $bundle_status" >&2; exit 2; }
dist_listing=$(listing dist)
summary+=("$dist_listing")
[ -f dist/__virtual-native-entry.js ] && written=1

echo
printf '%s\n' "${summary[@]}"
findings=()
[ "$written" = 0 ] || findings+=('Rolldown writes dist/')
[ "$android_warnings" = 0 ] || findings+=("the Android build prints $android_warnings MODULE_LEVEL_DIRECTIVE warnings")
if [ "${#findings[@]}" = 0 ]; then
  echo 'native bundling writes no dist/ and prints no MODULE_LEVEL_DIRECTIVE warning'
  exit 0
fi
if [ "${#findings[@]}" = 2 ]; then echo "${findings[0]}, and ${findings[1]}"; else echo "${findings[0]}"; fi
exit 1
