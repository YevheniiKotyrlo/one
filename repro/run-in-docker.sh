#!/usr/bin/env bash
# Runs repro/reproduce.sh with this script's arguments in Docker's node:26 image, with Docker's init as PID 1, on a copy
# of this checkout's files (what git tracks and the new files it does not ignore), and exits as reproduce.sh does when it
# exits 0 or 1, read from the status it leaves in a folder mounted from this host; 2 when a step before it fails, it
# leaves no status, or it exits any other way.
set -Eeuo pipefail
trap 'echo "failed: $BASH_COMMAND" >&2; exit 2' ERR
cd "$(dirname "$0")/.."
revision=$(git rev-parse HEAD)
changed=$(git status --porcelain | wc -l)
checkout="checkout at $revision"
[ "$((changed))" -eq 0 ] || checkout="$checkout, $((changed)) files changed since"
scratch=$(mktemp -d)
# Removes the scratch folder without changing the exit status.
exit_status=0
trap 'exit_status=$?; set +e; trap - ERR; rm -rf "$scratch" 2> /dev/null; exit "$exit_status"' EXIT
archive=$scratch/checkout.tar
git ls-files -z --cached --others --exclude-standard | tar --null --ignore-failed-read -T - -cf "$archive"
mkdir "$scratch/status"
# docker mounts a folder by a path of its host's own shape, which Git Bash on Windows needs spelled out.
status_folder=$(cd "$scratch/status" && { pwd -W 2> /dev/null || pwd; })
docker pull --quiet node:26 > /dev/null
run_status=0
docker run --rm -i --init -v "$status_folder:/status" -e CHECKOUT="$checkout" node:26 bash -c '
  set -Eeuo pipefail
  trap "echo \"failed: \$BASH_COMMAND\" >&2; exit 2" ERR
  mkdir /one
  tar -C /one -xf -
  npm install --global --silent bun@1.4.4 > /tmp/npm-install.log 2>&1 || { cat /tmp/npm-install.log >&2; exit 2; }
  . /etc/os-release
  node_version=$(node --version)
  bun_version=$(bun --version)
  echo "$PRETTY_NAME, node $node_version, bun $bun_version, $CHECKOUT"
  status=0
  bash /one/repro/reproduce.sh "$@" || status=$?
  echo "$status" > /status/reproduce
  exit "$status"
' run-in-docker "$@" < "$archive" || run_status=$?
if [ ! -s "$scratch/status/reproduce" ]; then
  echo "reproduce.sh left no exit status (docker run ended with $run_status)" >&2
  exit 2
fi
reproduce_status=$(cat "$scratch/status/reproduce")
case $reproduce_status in
  0 | 1) exit "$reproduce_status" ;;
  *)
    echo "reproduce.sh exited $reproduce_status" >&2
    exit 2
    ;;
esac
