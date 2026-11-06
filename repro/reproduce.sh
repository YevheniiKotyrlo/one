#!/usr/bin/env bash
# In Metro mode, a syntax error reaches the app as a bundle response that names no file, line 0 and no column, so React
# Native's red box cannot read it as an error at a place. repro/ is an app on one from npm with native.bundler 'metro';
# repro/run-in-docker.sh runs this script in Docker's node:26 image. The script starts `one dev`, requests the Android
# bundle, swaps app/index.tsx for a copy with a syntax error on line 4, requests the bundle again until Metro answers
# with an error, prints what that answer says about the error's place, and puts app/index.tsx back.
# Exits 1 while the answer lacks the file, the line or the column, 0 once it names app/index.tsx, line 4 and a column,
# and 2 when a setup step fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")"
bun install
rm -rf tmp && mkdir tmp
export NO_COLOR=1
bundle_url='http://localhost:8201/index.bundle?platform=android&dev=true&minify=false&modulesOnly=false&runModule=true'
cp app/index.tsx tmp/index.tsx.original
server=
cleanup() {
  [ -z "$server" ] || kill -- "-$server" 2> /dev/null || true
  if ! cmp -s tmp/index.tsx.original app/index.tsx; then cp tmp/index.tsx.original tmp/index.tsx.staged && mv -f tmp/index.tsx.staged app/index.tsx; fi
}
trap cleanup EXIT

# one dev in a process group of its own, with bash between it and this script.
setsid bash -c 'node node_modules/one/run.mjs dev --port 8201; exit $?' > tmp/dev.log 2>&1 &
server=$!
for _ in $(seq 1 180); do
  kill -0 "$server" 2> /dev/null || { cat tmp/dev.log >&2; echo "one dev exited" >&2; exit 2; }
  curl -s --max-time 5 -o /dev/null http://localhost:8201/ && break
  sleep 1
done
before=$(curl -s --max-time 900 -o tmp/bundle-before.txt -w '%{http_code}' "$bundle_url" || true)
[ "$before" = 200 ] || { cat tmp/dev.log >&2; echo "the Android bundle answered $before before the edit" >&2; exit 2; }

cat > tmp/index.tsx.broken << 'EOF'
import { Text } from 'react-native'

export default function Index() {
  const greeting = ;
  return <Text>{greeting}</Text>
}
EOF
cp tmp/index.tsx.broken tmp/index.tsx.staged && mv -f tmp/index.tsx.staged app/index.tsx
after=
for _ in $(seq 1 60); do
  after=$(curl -s --max-time 900 -o tmp/bundle-after.txt -w '%{http_code}' "$bundle_url" || true)
  [ "$after" = 200 ] || break
  sleep 1
done
[ "$after" = 500 ] || { echo "the Android bundle answered $after after the edit" >&2; exit 2; }
place=$(node -e "
const body = JSON.parse(require('node:fs').readFileSync('tmp/bundle-after.txt', 'utf8'))
const shown = (value) => (value === undefined ? 'none' : JSON.stringify(value))
console.log('type ' + body.type + ', name ' + body.name + ', filename ' + shown(body.filename) + ', lineNumber ' + shown(body.lineNumber) + ', column ' + shown(body.column))
console.log('message: ' + body.message.split('\n')[0])
")
verdict=$(node -e "
const body = JSON.parse(require('node:fs').readFileSync('tmp/bundle-after.txt', 'utf8'))
const placed = typeof body.filename === 'string' && /app[\\\\/]index\.tsx$/.test(body.filename) && body.lineNumber === 4 && Number.isInteger(body.column)
console.log(placed ? 'placed' : 'unplaced')
")
one_version=$(node -p "require('one/package.json').version")
plugin_version=$(node -p "require('@vxrn/vite-plugin-metro/package.json').version")
metro_version=$(node -p "require('metro/package.json').version")
broken_line=$(sed -n 4p tmp/index.tsx.broken)
cleanup

echo
echo "one $one_version, @vxrn/vite-plugin-metro $plugin_version, metro $metro_version"
echo "\$ one dev; GET the Android bundle -> $before"
echo "app/index.tsx line 4: ${broken_line#  }"
echo "GET the Android bundle -> $after"
echo "$place"
[ "$verdict" = placed ] && exit 0
exit 1
