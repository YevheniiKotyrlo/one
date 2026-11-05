#!/usr/bin/env bash
# Runs repro/reproduce.sh as the PID 1 of Docker's node:26 image, at this checkout's revision of the
# repro/dev-under-pid-1 branch of https://github.com/YevheniiKotyrlo/one, and exits as it does; 2 when a step before it
# fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
revision=$(git rev-parse HEAD)
docker pull --quiet node:26 > /dev/null
exec docker run --rm -e REVISION="$revision" node:26 bash -c '
  set -Eeuo pipefail
  trap "exit 2" ERR
  npm install --global --silent bun@1.4.4 > /dev/null 2>&1
  git clone --quiet --depth 1 --branch repro/dev-under-pid-1 https://github.com/YevheniiKotyrlo/one.git /one
  cd /one
  [ "$(git rev-parse HEAD)" = "$REVISION" ]
  . /etc/os-release
  node_version=$(node --version)
  bun_version=$(bun --version)
  echo "$PRETTY_NAME, node $node_version, bun $bun_version, https://github.com/YevheniiKotyrlo/one.git at $REVISION"
  exec bash repro/reproduce.sh
'
