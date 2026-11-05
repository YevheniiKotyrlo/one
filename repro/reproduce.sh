#!/usr/bin/env bash
# Started by a container's PID 1, as `docker run <image> npm run dev` starts it, `one dev` exits 0 at startup and prints
# nothing; with one more process between it and PID 1 it serves. repro/run-in-docker.sh runs this script as the PID 1 of
# Docker's node:26 image. repro/ installs one from npm at the versions repro/bun.lock pins; set `one` in
# repro/package.json to try another release.
# Exits 1 while the `one dev` this script starts does not serve and the one it starts under `bash -c` does, 0 once both
# serve, and 2 when a setup step fails, this script is not PID 1, or the one under `bash -c` does not serve.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")"
if [ "$$" != 1 ]; then echo "run this as a container's PID 1, as repro/run-in-docker.sh does" >&2; exit 2; fi
bun install
mkdir -p tmp
export NO_COLOR=1
servers=()
trap 'kill "${servers[@]}" 2> /dev/null || true' EXIT

# Starts one dev in the background, a child of this shell, as the words after the port say, and prints how it ends.
serve() {
  local port=$1
  shift
  "$@" > "tmp/dev-$port.log" 2>&1 &
  local server=$!
  servers+=("$server")
  for _ in $(seq 1 60); do
    if ! kill -0 "$server" 2> /dev/null; then
      local status=0 lines
      wait "$server" || status=$?
      lines=$(wc -l < "tmp/dev-$port.log")
      echo "exited with $status before serving, printing $lines lines"
      return
    fi
    if [ "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "http://localhost:$port/" || true)" = 200 ]; then
      echo "GET / -> 200"
      return
    fi
    sleep 1
  done
  echo "neither served nor exited within 60 s"
}

# The first one dev is this shell's child, so PID 1 is its grandparent; under `bash -c`, whose second command keeps bash
# from replacing itself with bunx, PID 1 is one process further up.
serve 8201 bunx one dev --port 8201 > tmp/outcome-8201.txt
serve 8202 bash -c 'bunx one dev --port 8202; exit $?' > tmp/outcome-8202.txt
first=$(cat tmp/outcome-8201.txt)
second=$(cat tmp/outcome-8202.txt)
one_version=$(node -p "require('one/package.json').version")

echo
echo "this script: PID $$, one $one_version"
echo "\$ bunx one dev --port 8201 &"
echo "$first"
echo "\$ bash -c 'bunx one dev --port 8202; exit \$?' &"
echo "$second"
[ "$second" = "GET / -> 200" ] || exit 2
[ "$first" = "GET / -> 200" ] && exit 0
exit 1
