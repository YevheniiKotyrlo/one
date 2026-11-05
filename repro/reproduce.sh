#!/usr/bin/env bash
# Started by a container's PID 1, as `docker run <image> npm run dev` starts it, `one dev` exits 0 at once and prints
# nothing; with one more process between it and PID 1 it serves. Run this script as that PID 1:
#   docker run --rm node:26 bash -c 'npm install --global bun@1.4.4 && git clone --depth 1 --branch repro/dev-under-pid-1 https://github.com/YevheniiKotyrlo/one.git /one && exec bash /one/repro/reproduce.sh'
# repro/ installs one from npm, as a new app does, at the versions repro/bun.lock pins.
# Exits 1 while the `one dev` this script starts exits, 0 once it serves, and 2 when a setup step fails or this script
# is not PID 1.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")"
if [ "$$" != 1 ]; then echo "run this as a container's PID 1, as the command at the top of this file does" >&2; exit 2; fi
bun install
mkdir -p tmp
export NO_COLOR=1
servers=()
trap 'kill "${servers[@]}" 2> /dev/null || true' EXIT

# Starts one dev in the background as the words after the port say, and reports whether it serves within 60 s.
serve() {
  local port=$1
  shift
  "$@" > "tmp/dev-$port.log" 2>&1 &
  local server=$!
  servers+=("$server")
  for attempt in $(seq 1 60); do
    if ! kill -0 "$server" 2> /dev/null; then
      local status=0
      wait "$server" || status=$?
      echo "exited with $status after about $attempt s, printing $(wc -l < "tmp/dev-$port.log") lines"
      return 1
    fi
    if [ "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "http://localhost:$port/" || true)" = 200 ]; then
      echo "GET / -> 200"
      return 0
    fi
    sleep 1
  done
  echo "neither served nor exited within 60 s"
  return 2
}

status=0
serve 8201 bunx one dev --port 8201 > tmp/outcome-8201.txt || status=$?
serve 8202 bash -c 'bunx one dev --port 8202; true' > tmp/outcome-8202.txt || true

one_version=$(node -p "require('one/package.json').version")
summary=("this script: PID $$, one $one_version")
summary+=("\$ bunx one dev --port 8201 &" "$(cat tmp/outcome-8201.txt)")
summary+=("\$ bash -c 'bunx one dev --port 8202; true' &" "$(cat tmp/outcome-8202.txt)")

echo
printf '%s\n' "${summary[@]}"
case $status in
  0) exit 0 ;;
  1) exit 1 ;;
  *) exit 2 ;;
esac
