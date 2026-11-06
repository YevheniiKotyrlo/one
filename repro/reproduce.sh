#!/usr/bin/env bash
# In Metro mode, a `one dev` start with nothing changed transforms every module again and writes a new entry for each
# to Metro's file store. repro/ is an app on this checkout's one and @vxrn/vite-plugin-metro (`workspace:*`) with
# native.bundler 'metro', whose app/index.tsx renders process.env.VITE_REPRO_LABEL; repro/run-in-docker.sh runs this
# script in Docker's node:26 image. The script builds the workspace, installs repro/ in a folder outside it from the
# workspace's packed packages (use-workspace-packages.mjs), and starts `one dev` five times: twice, twice more with
# ONE_CACHE_KEY set, and once more with VITE_REPRO_LABEL changed. Each start requests the Android bundle once and stops
# the server, and the script prints how many entries Metro's file store ($TMPDIR/metro-cache, Metro's default) gained
# meanwhile and whether the bundle holds VITE_REPRO_LABEL's value.
# Exits 1 while the second start writes more than 1 in 100 of the entries the first wrote and the second start with
# ONE_CACHE_KEY pinned writes no more than that; 0 once the second start writes no more than that and the start after
# VITE_REPRO_LABEL changes holds its new value and not the earlier one; and 2 when a step fails, a request gets no
# bundle, the first start writes no entry or lacks the label, the starts with ONE_CACHE_KEY pinned miss too, or a reused
# store keeps the earlier label.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
bun install
bun run build
server=
workspace=$(mktemp -d)
# Ends a server still running and removes the workspace without changing the exit status.
exit_status=0
trap 'exit_status=$?; set +e; trap - ERR; [ -z "$server" ] || kill -KILL -- "-$server" 2> /dev/null; rm -rf "$workspace" 2> /dev/null; exit "$exit_status"' EXIT
app=$workspace/app
mkdir "$app"
tar -C repro --exclude=./node_modules --exclude=./tmp --exclude=./yarn.lock -cf - . | tar -C "$app" -xf -
node repro/use-workspace-packages.mjs "$app"
cd "$app"
bun install
mkdir tmp "$workspace/tmpdir"
unset ONE_CACHE_KEY METRO_RESET_CACHE
first_label=repro-label-one
second_label=repro-label-two
export NO_COLOR=1 TMPDIR=$workspace/tmpdir VITE_REPRO_LABEL=$first_label
store=$TMPDIR/metro-cache
bundle_url='http://localhost:8201/index.bundle?platform=android&dev=true&minify=false&modulesOnly=false&runModule=true'

# Starts one dev as the leader of a process group of its own, reads its output until it says it is running, requests
# the Android bundle once, stops the group with SIGTERM and waits for one dev to exit (60 s at most). Sets `written` to
# the entries the store gained or rewrote meanwhile, `labelled` to whether the bundle holds VITE_REPRO_LABEL's value,
# `stale` to whether it still holds the earlier value the second argument names, and `summary` to one line saying so.
# The first argument names the start.
start() {
  local name=$1 earlier_label=${2:-} line='' output answer status seconds total holds timer finished=
  touch "tmp/$name.marker"
  mkfifo "tmp/$name.fifo"
  setsid node node_modules/one/run.mjs dev --port 8201 > "tmp/$name.fifo" 2>&1 &
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
  sleep 60 &
  timer=$!
  wait -n -p finished "$server" "$timer" || true
  if [ "$finished" != "$server" ]; then
    echo "$name: one dev did not exit within 60 s of SIGTERM" >&2
    exit 2
  fi
  kill "$timer" 2> /dev/null || true
  wait "$timer" 2> /dev/null || true
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
  if grep -qF -- "$VITE_REPRO_LABEL" "tmp/$name.bundle.js"; then
    labelled=yes
    holds=holds
  else
    labelled=no
    holds=lacks
  fi
  summary="$name: Metro's file store: $written entries written, $total in all; the Android bundle, $status in $seconds s, $holds $VITE_REPRO_LABEL"
  stale=no
  if [ -n "$earlier_label" ]; then
    if grep -qF -- "$earlier_label" "tmp/$name.bundle.js"; then
      stale=yes
      summary="$summary and still $earlier_label"
    else
      summary="$summary, not $earlier_label"
    fi
  fi
}

# Whether a start that wrote as many entries as the second argument reused the store an earlier start that wrote as
# many as the first filled: it wrote no more than 1 in 100 of them.
reused() {
  [ "$(($2 * 100))" -le "$1" ]
}

metro_version=$(node -p "require('metro/package.json').version")
echo
echo "one and @vxrn/vite-plugin-metro, packed from the checkout; metro $metro_version"
echo "with VITE_REPRO_LABEL=$VITE_REPRO_LABEL, which app/index.tsx renders:"
start 'start 1'
first_written=$written
first_labelled=$labelled
echo "$summary"
start 'start 2'
second_written=$written
echo "$summary"
export ONE_CACHE_KEY=12345678
echo "with ONE_CACHE_KEY=$ONE_CACHE_KEY too:"
start 'start 3'
third_written=$written
echo "$summary"
start 'start 4'
fourth_written=$written
echo "$summary"
export VITE_REPRO_LABEL=$second_label
echo "with VITE_REPRO_LABEL=$VITE_REPRO_LABEL:"
start 'start 5' "$first_label"
fifth_labelled=$labelled
fifth_stale=$stale
echo "$summary"

if [ "$first_written" -eq 0 ]; then
  echo "the first start wrote no entry to $store" >&2
  exit 2
fi
if [ "$first_labelled" != yes ]; then
  echo "start 1's bundle lacks VITE_REPRO_LABEL's value $first_label" >&2
  exit 2
fi
if reused "$first_written" "$second_written"; then
  if [ "$fifth_labelled" != yes ]; then
    echo "start 5's bundle lacks VITE_REPRO_LABEL's new value $second_label" >&2
    exit 2
  fi
  if [ "$fifth_stale" = yes ]; then
    echo "start 5's bundle still holds VITE_REPRO_LABEL's earlier value $first_label" >&2
    exit 2
  fi
  exit 0
fi
if [ "$third_written" -eq 0 ]; then
  echo "start 3, the first with ONE_CACHE_KEY pinned, wrote no entry" >&2
  exit 2
fi
if ! reused "$third_written" "$fourth_written"; then
  echo "with ONE_CACHE_KEY pinned, start 4 still wrote $fourth_written of the $third_written entries start 3 wrote" >&2
  exit 2
fi
exit 1
