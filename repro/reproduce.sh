#!/usr/bin/env bash
# In Metro mode, a syntax error reaches the app as a bundle answer that names no file, line 0 and no column, so React
# Native's Android red box shows the raw answer. repro/ is an app on this checkout's one and @vxrn/vite-plugin-metro
# (`workspace:*`) with native.bundler 'metro', whose app/index.tsx has a syntax error on line 4; repro/run-in-docker.sh
# runs this script in Docker's node:26 image. The script builds the workspace, installs repro/ in a folder outside it
# from the workspace's packed packages (use-workspace-packages.mjs), starts `one dev`, requests the Android bundle and
# prints what Metro's answer says about the error's place (read-answer.mjs).
# Exits 1 while the answer to that syntax error lacks the file, the line or the column, 0 once it names app/index.tsx,
# line 4 and a column, and 2 when a step fails or the answer is not that syntax error.
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
mkdir tmp
export NO_COLOR=1
bundle_url='http://localhost:8201/index.bundle?platform=android&dev=true&minify=false&modulesOnly=false&runModule=true'

# one dev in a process group of its own, with bash between it and this script; its output is read until it says it is
# running or the output ends.
mkfifo tmp/dev.fifo
setsid bash -c 'node node_modules/one/run.mjs dev --port 8201; exit $?' > tmp/dev.fifo 2>&1 &
server=$!
exec {output}< tmp/dev.fifo
line=''
while IFS= read -r -t 600 line <&"$output"; do
  printf '%s\n' "$line" >> tmp/dev.log
  [[ $line != *'Server running on'* ]] || break
done
if [[ $line != *'Server running on'* ]]; then
  cat tmp/dev.log >&2
  echo "one dev did not say it was running" >&2
  exit 2
fi
cat <&"$output" >> tmp/dev.log &
exec {output}<&-
status=$(curl -s --max-time 900 -o tmp/answer.json -w '%{http_code}' "$bundle_url" || true)
if [ ! -s tmp/answer.json ]; then
  cat tmp/dev.log >&2
  echo "the bundle request got no answer (HTTP status $status)" >&2
  exit 2
fi

metro_version=$(node -p "require('metro/package.json').version")
broken_line=$(sed -n 4p app/index.tsx)
echo
echo "one and @vxrn/vite-plugin-metro, packed from the checkout; metro $metro_version"
echo "app/index.tsx line 4: ${broken_line#  }"
echo "\$ one dev; GET the Android bundle -> $status"
verdict=0
node read-answer.mjs tmp/answer.json "$status" || verdict=$?
exit "$verdict"
