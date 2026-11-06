#!/usr/bin/env bash
# Runs this checkout's repro/reproduce.sh in Docker's node:26 image, with Docker's init as PID 1, on a copy of repro/
# without its node_modules, and exits as it does; 2 when a step before it fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")"
source_folder=$(pwd -W 2> /dev/null || pwd)
revision=$(git rev-parse HEAD)
changed=$(git status --porcelain -- . | wc -l)
checkout="repro/ at $revision"
[ "$((changed))" -eq 0 ] || checkout="$checkout, $((changed)) files changed since"
docker pull --quiet node:26 > /dev/null
exec docker run --rm --init -e CHECKOUT="$checkout" -v "$source_folder:/source:ro" node:26 bash -c '
  set -Eeuo pipefail
  trap "echo \"failed: \$BASH_COMMAND\" >&2; exit 2" ERR
  npm install --global --silent bun@1.4.4 > /tmp/npm-install.log 2>&1 || { cat /tmp/npm-install.log >&2; exit 2; }
  mkdir /repro
  tar -C /source --exclude=./node_modules --exclude=./tmp -cf - . | tar -C /repro -xf -
  . /etc/os-release
  node_version=$(node --version)
  bun_version=$(bun --version)
  echo "$PRETTY_NAME, node $node_version, bun $bun_version, $CHECKOUT"
  exec bash /repro/reproduce.sh
'
