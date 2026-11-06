#!/usr/bin/env bash
# In Metro mode, a `one dev` start with nothing changed transforms every module again and writes a new entry for each
# to Metro's file store. repro/ is an app on this checkout's one and @vxrn/vite-plugin-metro (`workspace:*`) with
# native.bundler 'metro'; repro/run-in-docker.sh runs this script in Docker's node:26 image. The script builds the
# workspace, installs repro/ in a folder outside it from the workspace's packed packages (use-workspace-packages.mjs),
# and starts `one dev` four times, the last two with ONE_CACHE_KEY set; each start requests the Android bundle once,
# and the script prints how many entries Metro's file store ($TMPDIR/metro-cache, Metro's default) gained meanwhile.
# Exits 1 while the second start writes more than 1 in 100 of the entries the first wrote, 0 once it writes no more,
# and 2 when a step fails, a request gets no bundle, or the first start writes no entry.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
bun install
bun run build
server=
workspace=$(mktemp -d)
trap '[ -z "$server" ] || kill -- "-$server" 2> /dev/null || true; rm -rf "$workspace"' EXIT
app=$workspace/app
mkdir "$app"
tar -C repro --exclude=./node_modules --exclude=./tmp --exclude=./yarn.lock -cf - . | tar -C "$app" -xf -
node repro/use-workspace-packages.mjs "$app"
cd "$app"
bun install
mkdir tmp "$workspace/tmpdir"
export NO_COLOR=1 TMPDIR=$workspace/tmpdir
store=$TMPDIR/metro-cache
bundle_url='http://localhost:8201/index.bundle?platform=android&dev=true&minify=false&modulesOnly=false&runModule=true'

# Starts one dev in a process group of its own, with bash between it and this script, reads its output until it says it
# is running, requests the Android bundle once, stops it, and sets `written` to the entries the store gained or
# rewrote meanwhile and `summary` to one line saying so. The first argument names the start.
start() {
  local name=$1 line='' output answer status seconds total
  touch "tmp/$name.marker"
  mkfifo "tmp/$name.fifo"
  setsid bash -c 'node node_modules/one/run.mjs dev --port 8201; exit $?' > "tmp/$name.fifo" 2>&1 &
  server=$!
  exec {output}< "tmp/$name.fifo"
  while IFS= read -r -t 600 line <&"$output"; do
    printf '%s\n' "$line" >> "tmp/$name.log"
    [[ $line != *'Server running on'* ]] || break
  done
  if [[ $line != *'Server running on'* ]]; then
    cat "tmp/$name.log" >&2
    echo "one dev did not say it was running ($name)" >&2
    exit 2
  fi
  cat <&"$output" >> "tmp/$name.log" &
  exec {output}<&-
  answer=$(curl -s --max-time 900 -o "tmp/$name.bundle.js" -w '%{http_code} %{time_total}' "$bundle_url" || true)
  status=${answer%% *}
  printf -v seconds '%.2f' "${answer#* }"
  kill -- "-$server" 2> /dev/null || true
  wait "$server" || true
  server=
  if [ "$status" != 200 ] || ! grep -q '__d(' "tmp/$name.bundle.js"; then
    cat "tmp/$name.log" >&2
    echo "$name: the bundle request got no bundle (HTTP status $status)" >&2
    exit 2
  fi
  written=0
  total=0
  if [ -d "$store" ]; then
    written=$(find "$store" -type f -newer "tmp/$name.marker" | wc -l)
    total=$(find "$store" -type f | wc -l)
  fi
  summary="$name: GET the Android bundle -> $status in ${seconds} s; Metro's file store: $written entries written, $total in all"
}

metro_version=$(node -p "require('metro/package.json').version")
echo
echo "one and @vxrn/vite-plugin-metro, packed from the checkout; metro $metro_version"
unset ONE_CACHE_KEY
start 'start 1'
first_written=$written
echo "$summary"
start 'start 2'
second_written=$written
echo "$summary"
export ONE_CACHE_KEY=12345678
echo "with ONE_CACHE_KEY=$ONE_CACHE_KEY:"
start 'start 3'
echo "$summary"
start 'start 4'
echo "$summary"

if [ "$first_written" -eq 0 ]; then
  echo "the first start wrote no entry to $store" >&2
  exit 2
fi
[ "$((second_written * 100))" -gt "$first_written" ] || exit 0
exit 1
