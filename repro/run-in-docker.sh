#!/usr/bin/env bash
# Runs repro/reproduce.sh in Docker's node:26 image, with Docker's init as PID 1, on a copy of this checkout's files
# (what git tracks and the new files it does not ignore), and exits as it does; 2 when a step before it fails.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
revision=$(git rev-parse HEAD)
changed=$(git status --porcelain | wc -l)
checkout="checkout at $revision"
[ "$((changed))" -eq 0 ] || checkout="$checkout, $((changed)) files changed since"
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
git ls-files -z --cached --others --exclude-standard | tar --null --ignore-failed-read -T - -cf "$archive"
docker pull --quiet node:26 > /dev/null
status=0
docker run --rm -i --init -e CHECKOUT="$checkout" node:26 bash -c '
  set -Eeuo pipefail
  trap "echo \"failed: \$BASH_COMMAND\" >&2; exit 2" ERR
  mkdir /one
  tar -C /one -xf -
  npm install --global --silent bun@1.4.4 > /tmp/npm-install.log 2>&1 || { cat /tmp/npm-install.log >&2; exit 2; }
  . /etc/os-release
  node_version=$(node --version)
  bun_version=$(bun --version)
  echo "$PRETTY_NAME, node $node_version, bun $bun_version, $CHECKOUT"
  exec bash /one/repro/reproduce.sh
' < "$archive" || status=$?
exit "$status"
