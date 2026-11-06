#!/usr/bin/env bash
# With native.bundler 'metro', `one dev` refuses to start until the app installs babel-preset-expo, and then no process
# loads it. repro/ is an app on one from npm with @vxrn/vite-plugin-metro and without babel-preset-expo;
# repro/run-in-docker.sh runs this script in Docker's node:26 image. The script starts `one dev` and requests the Android
# bundle; where One refuses, it installs babel-preset-expo without saving it, starts `one dev` again with trace-loads.mjs
# preloaded into every Node process, requests the bundle, and counts the processes that loaded One's Metro transformer
# and those that loaded babel-preset-expo.
# Exits 1 while One refuses to start without babel-preset-expo and no process loads it once it is there, 0 once One
# serves the bundle without it or a process loads it, and 2 when a setup step fails or the trace reaches no Metro worker.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")"
bun install
rm -rf tmp && mkdir tmp
export NO_COLOR=1
bundle_url='http://localhost:8201/index.bundle?platform=android&dev=true&minify=false&modulesOnly=false&runModule=true'
server=
trap '[ -z "$server" ] || kill -- "-$server" 2> /dev/null || true' EXIT

# Starts one dev in a process group of its own, with bash between it and this script, and prints how it ends: the
# Android bundle's status once it answers, or how it exited.
serve() {
  setsid bash -c 'node node_modules/one/run.mjs dev --port 8201; exit $?' > "$1" 2>&1 &
  server=$!
  local _ status code
  for _ in $(seq 1 180); do
    if ! kill -0 "$server" 2> /dev/null; then
      status=0
      wait "$server" || status=$?
      server=
      echo "exited with $status"
      return
    fi
    if curl -s --max-time 5 -o /dev/null http://localhost:8201/; then
      code=$(curl -s --max-time 900 -o tmp/android.bundle -w '%{http_code}' "$bundle_url" || true)
      echo "GET the Android bundle -> $code"
      return
    fi
    sleep 1
  done
  echo "neither answered nor exited within 180 s"
}
stop() {
  if [ -n "$server" ]; then
    kill -- "-$server" 2> /dev/null || true
    wait "$server" 2> /dev/null || true
    server=
  fi
}

one_version=$(node -p "require('one/package.json').version")
plugin_version=$(node -p "require('@vxrn/vite-plugin-metro/package.json').version")
summary=("one $one_version, @vxrn/vite-plugin-metro $plugin_version")

serve tmp/dev-without-preset.log > tmp/outcome-without-preset.txt
stop
without=$(< tmp/outcome-without-preset.txt)
refusal=$(grep -m1 -o '\[one\] Metro requires babel-preset-expo[^.]*\.' tmp/dev-without-preset.log || true)
summary+=("\$ one dev, without babel-preset-expo" "$without${refusal:+: $refusal}")
if [ "$without" = "GET the Android bundle -> 200" ]; then
  echo
  printf '%s\n' "${summary[@]}"
  exit 0
fi
if [ -z "$refusal" ]; then
  cat tmp/dev-without-preset.log >&2
  echo "one dev ended without the babel-preset-expo refusal" >&2
  exit 2
fi

bun add --dev --no-save babel-preset-expo@58.0.24 > tmp/add-preset.log 2>&1
preset_version=$(node -p "require('babel-preset-expo/package.json').version")
touch tmp/loads.log
export LOAD_TRACE_LOG="$PWD/tmp/loads.log" NODE_OPTIONS="--import=file://$PWD/trace-loads.mjs"
serve tmp/dev-with-preset.log > tmp/outcome-with-preset.txt
stop
unset NODE_OPTIONS
with=$(< tmp/outcome-with-preset.txt)
processes=$(grep -c ' started ' tmp/loads.log || true)
workers=$(grep -c ' transformer ' tmp/loads.log || true)
loads=$(grep -c ' loaded ' tmp/loads.log || true)
summary+=("\$ one dev, with babel-preset-expo $preset_version and every Node process tracing its loads" "$with")
summary+=("Node processes: $processes; that loaded One's Metro transformer: $workers; that loaded babel-preset-expo: $loads")

echo
printf '%s\n' "${summary[@]}"
if [ "$with" != "GET the Android bundle -> 200" ] || [ "$workers" -eq 0 ]; then exit 2; fi
if [ "$loads" -gt 0 ]; then exit 0; fi
exit 1
