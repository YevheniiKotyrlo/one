#!/usr/bin/env bash
# With native.bundler 'metro', `one dev` refuses to start until the app installs babel-preset-expo, and then no process
# loads it. repro/ is an app on this checkout's one and @vxrn/vite-plugin-metro (`workspace:*`), without
# babel-preset-expo; repro/run-in-docker.sh runs this script in Docker's node:26 image. The script builds the workspace,
# installs repro/ in a folder outside it from the workspace's packed packages (use-workspace-packages.mjs), starts
# `one dev` and requests the Android bundle. Where One asks for babel-preset-expo, it installs the preset without saving
# it, starts `one dev` again with trace-loads.mjs preloaded into every Node process and worker thread, requests the
# bundle, and counts the processes that loaded One's Metro transformer and those that loaded babel-preset-expo.
# Exits 1 while One asks the app for babel-preset-expo and no process loads it once it is there, 0 once One serves the
# bundle without asking for it or a process loads it, and 2 when a step fails or the run ends another way.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
bun install
bun run build
server=
drain=
workspace=$(mktemp -d)
trap '[ -z "$server" ] || kill -- "-$server" 2> /dev/null || true; rm -rf "$workspace"' EXIT
app=$workspace/app
mkdir "$app"
tar -C repro --exclude=./node_modules --exclude=./tmp --exclude=./yarn.lock -cf - . | tar -C "$app" -xf -
node repro/use-workspace-packages.mjs "$app"
cd "$app"
bun install
mkdir tmp
export NO_COLOR=1
bundle_url='http://localhost:8201/index.bundle?platform=android&dev=true&minify=false&modulesOnly=false&runModule=true'

# Starts one dev in a process group of its own, with bash between it and this script, its output in the log the first
# argument names; reads that output until one dev says it is running or the output ends, and prints how it ended: the
# Android bundle's status, or how one dev exited.
serve() {
  local log=$1 line='' status=0 code output
  rm -f tmp/dev.fifo
  mkfifo tmp/dev.fifo
  setsid bash -c 'node node_modules/one/run.mjs dev --port 8201; exit $?' > tmp/dev.fifo 2>&1 &
  server=$!
  exec {output}< tmp/dev.fifo
  while IFS= read -r -t 600 line <&"$output"; do
    printf '%s\n' "$line" >> "$log"
    [[ $line != *'Server running on'* ]] || break
  done
  if [[ $line != *'Server running on'* ]]; then
    exec {output}<&-
    if kill -0 "$server" 2> /dev/null; then
      echo "one dev printed nothing for 600 s, neither saying it was running nor exiting"
      return
    fi
    wait "$server" || status=$?
    server=
    echo "exited with $status"
    return
  fi
  cat <&"$output" >> "$log" &
  drain=$!
  exec {output}<&-
  code=$(curl -s --max-time 900 -o tmp/android.bundle -w '%{http_code}' "$bundle_url" || true)
  echo "GET the Android bundle -> $code"
}
stop() {
  if [ -n "$server" ]; then
    kill -- "-$server" 2> /dev/null || true
    wait "$server" 2> /dev/null || true
    server=
  fi
  if [ -n "$drain" ]; then
    kill "$drain" 2> /dev/null || true
    wait "$drain" 2> /dev/null || true
    drain=
  fi
}
count_processes() {
  { grep -- "$1" tmp/loads.log || true; } | cut -d ' ' -f 1 | sort -u | wc -l
}

summary=("one and @vxrn/vite-plugin-metro, packed from the checkout")

serve tmp/dev-without-preset.log > tmp/outcome-without-preset.txt
stop
without=$(< tmp/outcome-without-preset.txt)
# The first line that asks the app for babel-preset-expo: one naming it with "requires", "install" or "missing".
asks=$({ grep 'babel-preset-expo' tmp/dev-without-preset.log || true; } | { grep -m 1 -E '\brequires?\b|\b[Ii]nstall|\bmissing\b' || true; } | sed 's/^ *//')
summary+=("\$ one dev, without babel-preset-expo" "$without")
if [ -z "$asks" ]; then
  echo
  printf '%s\n' "${summary[@]}"
  [ "$without" != "GET the Android bundle -> 200" ] || exit 0
  cat tmp/dev-without-preset.log >&2
  echo "one dev ended without asking for babel-preset-expo" >&2
  exit 2
fi
summary+=("$asks")

preset=babel-preset-expo@58.0.24
bun add --dev --no-save "$preset" > tmp/add-preset.log 2>&1 || { cat tmp/add-preset.log >&2; exit 2; }
touch tmp/loads.log
export LOAD_TRACE_LOG="$PWD/tmp/loads.log" NODE_OPTIONS="--import=file://$PWD/trace-loads.mjs"
serve tmp/dev-with-preset.log > tmp/outcome-with-preset.txt
stop
unset NODE_OPTIONS
with=$(< tmp/outcome-with-preset.txt)
processes=$(count_processes ' thread=0 started ')
workers=$(count_processes ' transformer ')
loads=$(count_processes ' loaded ')
summary+=("\$ one dev, with $preset and trace-loads.mjs in every Node process" "$with")
summary+=("Node processes: $((processes)); that loaded One's Metro transformer: $((workers)); that loaded babel-preset-expo: $((loads))")

echo
printf '%s\n' "${summary[@]}"
if [ "$with" != "GET the Android bundle -> 200" ] || [ "$((workers))" -eq 0 ]; then exit 2; fi
if [ "$((loads))" -gt 0 ]; then exit 0; fi
exit 1
